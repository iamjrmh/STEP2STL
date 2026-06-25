# STEP2STL

**Convert `.step` / `.stp` files to `.stl` directly in your browser — no installs, no uploads, no server.**

→ **[Open STEP2STL](https://YOUR-USERNAME.github.io/YOUR-REPO/)** *(update this link after deploying)*

---

## What it does

Drop a folder or individual `.step` / `.stp` files onto the page. Hit **Convert & Download ZIP**. You get back a `.zip` containing:

```
your_part.stl          ← converted STL file(s)
originals/
  your_part.step       ← original STEP files, moved here
```

That's it. Your files never leave your computer.

---

## How to use it

### Drag & drop a folder
Drag any folder from your file explorer directly onto the drop zone. The site will scan it recursively for all `.step` and `.stp` files.

### Pick individual files
Click **browse files** (or anywhere on the drop zone) to open a file picker and select one or more `.step` / `.stp` files.

### Convert
Once your files are queued, click **Convert & Download ZIP**. The first conversion takes around 10–15 seconds while the CAD kernel loads — this is a one-time download (~6 MB of WebAssembly) and is cached by your browser after that.

---

## How it works

STEP2STL uses **[opencascade.js](https://github.com/donalffons/opencascade.js)** — a WebAssembly port of the [OpenCASCADE](https://www.opencascade.com/) geometry kernel, the same engine used by FreeCAD, Salome, and many professional CAD tools. The conversion runs entirely on your CPU inside the browser tab.

- **No server** — nothing is sent anywhere
- **No install** — just a URL
- **No sign-up** — open and use

---

## Supported files

| Input | Output |
|-------|--------|
| `.step` | `.stl` (binary) |
| `.stp`  | `.stl` (binary) |

Multi-body and assembly STEP files are supported. The mesh resolution is set to a general-purpose default (0.1 mm linear deflection, 0.5 rad angular deflection), which works well for most 3D printing and review use cases.

---

## Browser compatibility

Works in any modern browser with WebAssembly support:

| Browser | Support |
|---------|---------|
| Chrome / Edge 89+ | ✅ |
| Firefox 89+ | ✅ |
| Safari 15+ | ✅ |
| Mobile Chrome / Safari | ✅ (large files may be slow) |

---

## Running locally

No build step needed. Just open `docs/index.html` via a local server (required for WASM to load):

```bash
# Python
cd docs
python -m http.server 8080

# Node (npx)
npx serve docs
```

Then open `http://localhost:8080`.

---

## Deploying to GitHub Pages

1. Push this repo to GitHub
2. Go to **Settings → Pages**
3. Set **Source** to `Deploy from a branch`, branch `main`, folder `/docs`
4. Save — your site will be live at `https://YOUR-USERNAME.github.io/YOUR-REPO/`

---

## License

MIT
