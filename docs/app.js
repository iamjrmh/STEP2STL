/**
 * STEP2STL — app.js
 * Converts .step/.stp files to binary STL in the browser.
 *
 * Library: opencascade.js v1.1.1 (stable, no bundler required)
 *   JS:   https://unpkg.com/opencascade.js@1.1.1/dist/opencascade.wasm.js
 *   WASM: https://unpkg.com/opencascade.js@1.1.1/dist/opencascade.wasm.wasm
 *
 * Folder drag-and-drop uses webkitGetAsEntry() to traverse recursively.
 */

'use strict';

// ── OpenCascade loader ───────────────────────────────────────────────────────
const OC_JS   = 'https://unpkg.com/opencascade.js@1.1.1/dist/opencascade.wasm.js';
const OC_WASM = 'https://unpkg.com/opencascade.js@1.1.1/dist/opencascade.wasm.wasm';

let ocPromise = null;

function loadOpenCascade() {
  if (ocPromise) return ocPromise;
  ocPromise = new Promise((resolve, reject) => {
    const script  = document.createElement('script');
    script.src    = OC_JS;
    script.onload = () => {
      log('dim', '  Initialising WASM kernel…');
      // v1.1.1 exposes a global `opencascade` factory function
      window.opencascade({
        locateFile: (f) => f.endsWith('.wasm') ? OC_WASM : f,
      }).then(oc => {
        log('success', '✓ OpenCASCADE kernel ready');
        resolve(oc);
      }).catch(err => reject(new Error('WASM init failed: ' + err.message)));
    };
    script.onerror = () => reject(new Error(
      'Could not load opencascade.js from unpkg — check your internet connection'
    ));
    document.head.appendChild(script);
  });
  return ocPromise;
}

// ── STEP → binary STL ───────────────────────────────────────────────────────
function convertStepToStl(oc, arrayBuffer, filename) {
  const stepPath = '/' + filename;
  const stlPath  = '/' + filename.replace(/\.(step|stp)$/i, '.stl');

  oc.FS.createDataFile('/', filename, new Uint8Array(arrayBuffer), true, true, true);

  const reader = new oc.STEPControl_Reader_1();
  const status = reader.ReadFile(stepPath);

  if (status !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) {
    try { oc.FS.unlink(stepPath); } catch (_) {}
    throw new Error('STEP reader returned error — file may be malformed');
  }

  reader.TransferRoots(new oc.Message_ProgressRange_1());
  const shape = reader.OneShape();

  // Mesh the shape
  new oc.BRepMesh_IncrementalMesh_2(shape, 0.1, false, 0.5, false)
    .Perform(new oc.Message_ProgressRange_1());

  // Write binary STL
  const writer = new oc.StlAPI_Writer();
  writer.ASCIIMode = false;
  writer.Write(shape, stlPath, new oc.Message_ProgressRange_1());

  const stlBytes = oc.FS.readFile(stlPath, { encoding: 'binary' });

  try { oc.FS.unlink(stepPath); } catch (_) {}
  try { oc.FS.unlink(stlPath);  } catch (_) {}

  return stlBytes; // Uint8Array
}

// ── Folder drag-and-drop ─────────────────────────────────────────────────────
function readEntry(entry) {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file(f => resolve([f]), () => resolve([]));
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const all = [];
      function readAll() {
        reader.readEntries(async (entries) => {
          if (!entries.length) {
            const nested = await Promise.all(all.map(readEntry));
            resolve(nested.flat());
          } else {
            all.push(...entries);
            readAll();
          }
        }, () => resolve([]));
      }
      readAll();
    } else {
      resolve([]);
    }
  });
}

async function getFilesFromDataTransfer(dt) {
  const files = [];
  // Modern API — supports folders
  if (dt.items && dt.items.length && dt.items[0].webkitGetAsEntry) {
    const promises = [];
    for (const item of dt.items) {
      const entry = item.webkitGetAsEntry();
      if (entry) promises.push(readEntry(entry));
    }
    const results = await Promise.all(promises);
    files.push(...results.flat());
  } else {
    // Fallback — plain file list (no folders)
    files.push(...Array.from(dt.files));
  }
  return files;
}

// ── ZIP builder (dependency-free) ───────────────────────────────────────────
(function buildZipModule() {
  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c;
    }
    return t;
  })();

  function crc32(data) {
    let c = 0xffffffff;
    for (let i = 0; i < data.length; i++) c = CRC[(c ^ data[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function u16(n) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, true); return b; }
  function u32(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; }
  function cat(...a) {
    const t = a.reduce((s, x) => s + x.length, 0), o = new Uint8Array(t); let off = 0;
    for (const x of a) { o.set(x, off); off += x.length; }
    return o;
  }

  window.buildZip = function(stlFiles, origFiles) {
    const enc = new TextEncoder();
    const entries = [
      ...stlFiles.map(f  => ({ path: f.name,              data: f.data })),
      ...origFiles.map(f => ({ path: 'originals/' + f.name, data: f.data })),
    ];

    const locals = [], centrals = [];
    let off = 0;

    for (const e of entries) {
      const p = enc.encode(e.path), crc = crc32(e.data), sz = e.data.length;
      const lh = cat(
        new Uint8Array([0x50,0x4b,0x03,0x04]),
        u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(crc), u32(sz), u32(sz),
        u16(p.length), u16(0), p
      );
      const cd = cat(
        new Uint8Array([0x50,0x4b,0x01,0x02]),
        u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(crc), u32(sz), u32(sz),
        u16(p.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(off), p
      );
      locals.push(cat(lh, e.data));
      centrals.push(cd);
      off += lh.length + sz;
    }

    const cdData = cat(...centrals);
    const eocd = cat(
      new Uint8Array([0x50,0x4b,0x05,0x06]),
      u16(0), u16(0), u16(entries.length), u16(entries.length),
      u32(cdData.length), u32(off), u16(0)
    );
    return cat(...locals, cdData, eocd);
  };
})();

// ── Download helper ──────────────────────────────────────────────────────────
function downloadBlob(data, name, mime) {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
}

// ── UI wiring ────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const dropzone    = $('dropzone');
const fileInput   = $('fileInput');
const browseBtn   = $('browseBtn');
const queueEl     = $('queue');
const queueCount  = $('queueCount');
const fileListEl  = $('fileList');
const convertBtn  = $('convertBtn');
const clearBtn    = $('clearBtn');
const logPanel    = $('logPanel');
const logBody     = $('logBody');
const logClearBtn = $('logClearBtn');
const scanLine    = $('scanLine');

let fileQueue = [];

function log(type, msg) {
  logPanel.hidden = false;
  const el = document.createElement('span');
  el.className = 'log-line ' + type;
  el.textContent = msg;
  logBody.appendChild(el);
  logBody.scrollTop = logBody.scrollHeight;
}

function fmt(bytes) {
  if (bytes < 1024)    return bytes + ' B';
  if (bytes < 1048576) return (bytes/1024).toFixed(1) + ' KB';
  return (bytes/1048576).toFixed(1) + ' MB';
}

function renderQueue() {
  fileListEl.innerHTML = '';
  if (!fileQueue.length) { queueEl.hidden = true; return; }
  queueEl.hidden = false;
  queueCount.textContent = fileQueue.length + ' file' + (fileQueue.length !== 1 ? 's' : '');
  fileQueue.forEach((f, i) => {
    const li = document.createElement('li');
    li.id = 'fi-' + i;
    li.innerHTML = `
      <span class="file-name" title="${f.name}">${f.name}</span>
      <span class="file-size">${fmt(f.size)}</span>
      <span class="file-status pending" id="fs-${i}">pending</span>
      <button class="file-remove" data-i="${i}" title="Remove">×</button>`;
    fileListEl.appendChild(li);
  });
  fileListEl.querySelectorAll('.file-remove').forEach(b =>
    b.addEventListener('click', () => { fileQueue.splice(+b.dataset.i, 1); renderQueue(); })
  );
}

function setStatus(i, type, text) {
  const el = $('fs-' + i);
  if (el) { el.className = 'file-status ' + type; el.textContent = text; }
}

function addFiles(newFiles) {
  const existing = new Set(fileQueue.map(f => f.name));
  let added = 0;
  for (const f of newFiles) {
    if (/\.(step|stp)$/i.test(f.name) && !existing.has(f.name)) {
      fileQueue.push(f);
      existing.add(f.name);
      added++;
    }
  }
  if (!added && newFiles.length) log('warn', '⚠ No new .step/.stp files found in selection');
  renderQueue();
}

// Drag & Drop
dropzone.addEventListener('dragover', e => {
  e.preventDefault();
  dropzone.classList.add('drag-over');
  scanLine.style.animationPlayState = 'running';
});

dropzone.addEventListener('dragleave', () => {
  dropzone.classList.remove('drag-over');
  scanLine.style.animationPlayState = 'paused';
});

dropzone.addEventListener('drop', async e => {
  e.preventDefault();
  dropzone.classList.remove('drag-over');
  scanLine.style.animationPlayState = 'paused';
  const files = await getFilesFromDataTransfer(e.dataTransfer);
  addFiles(files);
});

dropzone.addEventListener('click', e => { if (e.target !== browseBtn) fileInput.click(); });
dropzone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
browseBtn.addEventListener('click', e => { e.stopPropagation(); fileInput.click(); });
fileInput.addEventListener('change', () => { addFiles(Array.from(fileInput.files)); fileInput.value = ''; });

clearBtn.addEventListener('click', () => { fileQueue = []; renderQueue(); });
logClearBtn.addEventListener('click', () => { logBody.innerHTML = ''; logPanel.hidden = true; });

// Convert
convertBtn.addEventListener('click', async () => {
  if (!fileQueue.length) return;
  convertBtn.disabled = true;
  clearBtn.disabled   = true;

  log('head', `── Converting ${fileQueue.length} file(s) ──`);
  log('dim',  '  Loading OpenCASCADE (first run ~10 s, then cached)…');

  let oc;
  try {
    oc = await loadOpenCascade();
  } catch (err) {
    log('error', '✗ ' + err.message);
    convertBtn.disabled = false;
    clearBtn.disabled   = false;
    return;
  }

  const stlResults = [], origBuffers = [];
  let ok = 0, fail = 0;

  for (let i = 0; i < fileQueue.length; i++) {
    const file = fileQueue[i];
    setStatus(i, 'working', 'converting…');
    log('info', '  → ' + file.name);
    try {
      const buf     = await file.arrayBuffer();
      const stlData = convertStepToStl(oc, buf, file.name);
      const stlName = file.name.replace(/\.(step|stp)$/i, '.stl');
      stlResults.push({ name: stlName, data: stlData });
      origBuffers.push({ name: file.name, data: new Uint8Array(buf) });
      setStatus(i, 'done', '✓ done');
      log('success', `  ✓ ${stlName} (${fmt(stlData.length)})`);
      ok++;
    } catch (err) {
      setStatus(i, 'error', '✗ error');
      log('error', `  ✗ ${file.name}: ${err.message}`);
      fail++;
    }
  }

  log('head', `── ${ok} converted, ${fail} failed ──`);

  if (stlResults.length) {
    log('dim', '  Building ZIP…');
    const zip = window.buildZip(stlResults, origBuffers);
    const name = stlResults.length === 1
      ? stlResults[0].name.replace('.stl', '') + '_step2stl.zip'
      : 'step2stl_output.zip';
    downloadBlob(zip, name, 'application/zip');
    log('success', `✓ Downloaded: ${name}`);
    log('dim',     '  STL files at root · originals in originals/');
  }

  convertBtn.disabled = false;
  clearBtn.disabled   = false;
  fileQueue = [];
  renderQueue();
});
