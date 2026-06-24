/**
 * app.js — STEP → STL converter
 *
 * Uses opencascade.js (WASM build of OpenCASCADE) to convert STEP files
 * to binary STL entirely in the browser. No server, no upload.
 *
 * opencascade.js CDN:
 *   https://cdn.jsdelivr.net/npm/opencascade.js@2.0.0-beta.0/dist/
 */

// ── opencascade.js loader ────────────────────────────────────────────────────
const OC_VERSION  = '2.0.0-beta.0';
const OC_BASE_URL = `https://cdn.jsdelivr.net/npm/opencascade.js@${OC_VERSION}/dist/`;

let ocPromise = null;

function loadOpenCascade() {
  if (ocPromise) return ocPromise;

  ocPromise = new Promise((resolve, reject) => {
    // Inject the opencascade.js main script
    const script = document.createElement('script');
    script.src = OC_BASE_URL + 'opencascade.js';
    script.onload = () => {
      log('info', 'Loading OpenCASCADE kernel (first run may take ~10 s)…');
      // opencascade.js exposes a global `opencascade` initialiser
      window.opencascade({
        locateFile: (file) => OC_BASE_URL + file,
      }).then(oc => {
        log('success', '✓ OpenCASCADE ready');
        resolve(oc);
      }).catch(reject);
    };
    script.onerror = () => reject(new Error('Failed to load opencascade.js from CDN'));
    document.head.appendChild(script);
  });

  return ocPromise;
}

// ── STEP → STL conversion ────────────────────────────────────────────────────
async function convertStepToStl(oc, fileBuffer, filename) {
  const stepName = '/' + filename;
  const stlName  = '/' + filename.replace(/\.(step|stp)$/i, '.stl');

  // Write the STEP file into OC's virtual FS
  oc.FS.createDataFile('/', filename, new Uint8Array(fileBuffer), true, true, true);

  // Read it back with STEP reader
  const reader = new oc.STEPControl_Reader_1();
  const readResult = reader.ReadFile(stepName);

  if (readResult !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) {
    oc.FS.unlink(stepName);
    throw new Error('STEP reader failed — file may be corrupt or unsupported');
  }

  reader.TransferRoots(new oc.Message_ProgressRange_1());

  const shape = reader.OneShape();

  // Write STL
  const writer = new oc.StlAPI_Writer();
  // Set to binary STL and a reasonable mesh deflection
  writer.ASCIIMode = false;
  const meshingResult = new oc.BRepMesh_IncrementalMesh_2(
    shape,
    0.1,      // linear deflection (mm) — adjust for coarser/finer mesh
    false,
    0.5,      // angular deflection (rad)
    false
  );
  meshingResult.Perform(new oc.Message_ProgressRange_1());

  writer.Write(shape, stlName, new oc.Message_ProgressRange_1());

  // Read back the STL bytes from OC's virtual FS
  const stlData = oc.FS.readFile(stlName, { encoding: 'binary' });

  // Clean up virtual FS
  oc.FS.unlink(stepName);
  oc.FS.unlink(stlName);

  return stlData; // Uint8Array
}

// ── Zip builder (no dependency) ──────────────────────────────────────────────
// Tiny CRC32 + ZIP writer — produces a valid ZIP with "originals/" subfolder
function buildZip(stlFiles, originalFiles) {
  /**
   * stlFiles:      [{ name: 'part.stl',          data: Uint8Array }]
   * originalFiles: [{ name: 'part.step',          data: Uint8Array }]
   * Output: Uint8Array of a valid .zip
   */

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c;
    }
    return t;
  })();

  function crc32(data) {
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function strBytes(s) { return new TextEncoder().encode(s); }

  function u16(n) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, true); return b; }
  function u32(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; }

  function concat(...arrays) {
    const total = arrays.reduce((s, a) => s + a.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const a of arrays) { out.set(a, off); off += a.length; }
    return out;
  }

  const entries = [
    ...stlFiles.map(f => ({ path: f.name, data: f.data })),
    ...originalFiles.map(f => ({ path: 'originals/' + f.name, data: f.data })),
  ];

  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  for (const entry of entries) {
    const pathBytes = strBytes(entry.path);
    const crc       = crc32(entry.data);
    const size      = entry.data.length;

    // Local file header (signature 0x04034b50)
    const localHeader = concat(
      new Uint8Array([0x50, 0x4b, 0x03, 0x04]), // signature
      u16(20),          // version needed
      u16(0),           // flags
      u16(0),           // compression (stored)
      u16(0), u16(0),   // mod time, mod date
      u32(crc),
      u32(size),        // compressed size
      u32(size),        // uncompressed size
      u16(pathBytes.length),
      u16(0),           // extra field length
      pathBytes,
    );

    // Central directory header (signature 0x02014b50)
    const centralHeader = concat(
      new Uint8Array([0x50, 0x4b, 0x01, 0x02]), // signature
      u16(20),          // version made by
      u16(20),          // version needed
      u16(0),           // flags
      u16(0),           // compression
      u16(0), u16(0),   // mod time, mod date
      u32(crc),
      u32(size),
      u32(size),
      u16(pathBytes.length),
      u16(0),           // extra
      u16(0),           // comment
      u16(0),           // disk start
      u16(0),           // internal attr
      u32(0),           // external attr
      u32(offset),      // local header offset
      pathBytes,
    );

    localHeaders.push(concat(localHeader, entry.data));
    centralHeaders.push(centralHeader);
    offset += localHeader.length + size;
  }

  const centralDir    = concat(...centralHeaders);
  const centralOffset = offset;
  const centralSize   = centralDir.length;
  const count         = entries.length;

  // End of central directory record
  const endRecord = concat(
    new Uint8Array([0x50, 0x4b, 0x05, 0x06]), // signature
    u16(0),           // disk number
    u16(0),           // disk with CD start
    u16(count),       // entries on this disk
    u16(count),       // total entries
    u32(centralSize),
    u32(centralOffset),
    u16(0),           // comment length
  );

  return concat(...localHeaders, centralDir, endRecord);
}

// ── Download helper ──────────────────────────────────────────────────────────
function downloadBlob(data, filename, mime) {
  const blob = new Blob([data], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}

// ── UI helpers ───────────────────────────────────────────────────────────────
const dropzone   = document.getElementById('dropzone');
const fileInput  = document.getElementById('fileInput');
const browseBtn  = document.getElementById('browseBtn');
const queue      = document.getElementById('queue');
const queueCount = document.getElementById('queueCount');
const fileList   = document.getElementById('fileList');
const convertBtn = document.getElementById('convertBtn');
const clearBtn   = document.getElementById('clearBtn');
const logPanel   = document.getElementById('logPanel');
const logBody    = document.getElementById('logBody');
const logClearBtn = document.getElementById('logClearBtn');
const scanLine   = document.getElementById('scanLine');

let fileQueue = []; // Array of File objects

function log(type, message) {
  logPanel.hidden = false;
  const line = document.createElement('span');
  line.className = 'log-line ' + type;
  line.textContent = message;
  logBody.appendChild(line);
  logBody.scrollTop = logBody.scrollHeight;
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function renderQueue() {
  fileList.innerHTML = '';
  if (fileQueue.length === 0) {
    queue.hidden = true;
    return;
  }
  queue.hidden = false;
  queueCount.textContent = fileQueue.length + ' file' + (fileQueue.length !== 1 ? 's' : '');

  fileQueue.forEach((file, i) => {
    const li = document.createElement('li');
    li.id = 'file-item-' + i;
    li.innerHTML = `
      <span class="file-name" title="${file.name}">${file.name}</span>
      <span class="file-size">${formatSize(file.size)}</span>
      <span class="file-status pending" id="status-${i}">pending</span>
      <button class="file-remove" data-idx="${i}" title="Remove">×</button>
    `;
    fileList.appendChild(li);
  });

  fileList.querySelectorAll('.file-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      fileQueue.splice(parseInt(btn.dataset.idx), 1);
      renderQueue();
    });
  });
}

function setFileStatus(idx, type, text) {
  const el = document.getElementById('status-' + idx);
  if (el) { el.className = 'file-status ' + type; el.textContent = text; }
}

function addFiles(newFiles) {
  const existing = new Set(fileQueue.map(f => f.name));
  let added = 0;
  for (const file of newFiles) {
    if (/\.(step|stp)$/i.test(file.name) && !existing.has(file.name)) {
      fileQueue.push(file);
      existing.add(file.name);
      added++;
    }
  }
  if (added === 0 && newFiles.length > 0) {
    log('warn', '⚠ No new .step/.stp files found in selection');
  }
  renderQueue();
}

// ── Drag & Drop ──────────────────────────────────────────────────────────────
dropzone.addEventListener('dragover', e => {
  e.preventDefault();
  dropzone.classList.add('drag-over');
  scanLine.style.opacity = '1';
  scanLine.style.animationPlayState = 'running';
});

dropzone.addEventListener('dragleave', () => {
  dropzone.classList.remove('drag-over');
  scanLine.style.opacity = '0';
  scanLine.style.animationPlayState = 'paused';
});

dropzone.addEventListener('drop', e => {
  e.preventDefault();
  dropzone.classList.remove('drag-over');
  scanLine.style.opacity = '0';
  scanLine.style.animationPlayState = 'paused';
  addFiles(Array.from(e.dataTransfer.files));
});

dropzone.addEventListener('click', (e) => {
  if (e.target !== browseBtn) fileInput.click();
});

dropzone.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});

browseBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  fileInput.click();
});

fileInput.addEventListener('change', () => {
  addFiles(Array.from(fileInput.files));
  fileInput.value = '';
});

// ── Clear ────────────────────────────────────────────────────────────────────
clearBtn.addEventListener('click', () => {
  fileQueue = [];
  renderQueue();
});

logClearBtn.addEventListener('click', () => {
  logBody.innerHTML = '';
  logPanel.hidden = true;
});

// ── Convert ──────────────────────────────────────────────────────────────────
convertBtn.addEventListener('click', async () => {
  if (fileQueue.length === 0) return;

  convertBtn.disabled = true;
  clearBtn.disabled   = true;

  log('head', `── Starting conversion of ${fileQueue.length} file(s) ──`);

  let oc;
  try {
    oc = await loadOpenCascade();
  } catch (err) {
    log('error', '✗ Could not load OpenCASCADE: ' + err.message);
    convertBtn.disabled = false;
    clearBtn.disabled   = false;
    return;
  }

  const stlResults      = [];
  const originalBuffers = [];
  let ok = 0, fail = 0;

  for (let i = 0; i < fileQueue.length; i++) {
    const file = fileQueue[i];
    setFileStatus(i, 'working', 'converting…');
    log('info', `  → ${file.name}`);

    try {
      const buffer = await file.arrayBuffer();
      const stlData = await convertStepToStl(oc, buffer, file.name);

      const stlName = file.name.replace(/\.(step|stp)$/i, '.stl');
      stlResults.push({ name: stlName, data: stlData });
      originalBuffers.push({ name: file.name, data: new Uint8Array(buffer) });

      setFileStatus(i, 'done', '✓ done');
      log('success', `  ✓ ${stlName} (${formatSize(stlData.length)})`);
      ok++;
    } catch (err) {
      setFileStatus(i, 'error', '✗ error');
      log('error', `  ✗ ${file.name}: ${err.message}`);
      fail++;
    }
  }

  log('head', `── Done: ${ok} converted, ${fail} failed ──`);

  if (stlResults.length > 0) {
    log('info', '  Building ZIP (STLs + originals/ subfolder)…');

    const zipData = buildZip(stlResults, originalBuffers);
    const zipName = stlResults.length === 1
      ? stlResults[0].name.replace('.stl', '') + '_converted.zip'
      : 'step_to_stl_output.zip';

    downloadBlob(zipData, zipName, 'application/zip');
    log('success', `✓ Downloaded: ${zipName}`);
    log('info',    '  ZIP contains: STL files at root, originals in originals/ subfolder');
  }

  convertBtn.disabled = false;
  clearBtn.disabled   = false;
  fileQueue = [];
  renderQueue();
});
