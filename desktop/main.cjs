// Athanor desktop: a frameless window around the dashboard.
//
// The built UI (ui-dist, copied from ui/dist by scripts/prepare-ui.cjs) is
// served from a loopback HTTP server inside the app, so the page has a real
// origin and fetch, history and blob URLs behave as they do in a browser.
// The dashboard itself decides which cluster to talk to: a local node first,
// then the public one (see ui/src/app/useCluster.js). ATHANOR_BASE overrides
// that default.
const { app, BrowserWindow, Menu, ipcMain, session, shell } = require("electron");
const http = require("http");
const fs = require("fs");
const path = require("path");

const APP_ID = "cfd.athanor.desktop";
const PUBLIC_BASE = "https://www.athanor.cfd";

// Packaged: ui-dist inside the asar. Development: ui-dist next to this
// file, or the repo's ui/dist if that has not been prepared yet.
const UI_CANDIDATES = [
  process.env.ATHANOR_UI && path.resolve(process.env.ATHANOR_UI),
  path.join(__dirname, "ui-dist"),
  path.join(__dirname, "..", "ui", "dist"),
].filter(Boolean);
const UI_ROOT = UI_CANDIDATES.find((dir) => fs.existsSync(path.join(dir, "index.html"))) || UI_CANDIDATES[0];

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".map": "application/json",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src *",
  "frame-ancestors 'none'",
].join("; ");

function safeJoin(root, urlPath) {
  let rel = "/";
  try {
    rel = decodeURIComponent(urlPath.split("?")[0]);
  } catch {
    return null;
  }
  const file = path.resolve(root, `.${rel}`);
  const base = path.resolve(root);
  if (file !== base && !file.startsWith(base + path.sep)) return null;
  return file;
}

function sendFile(res, file, fallback) {
  fs.readFile(file, (err, data) => {
    if (err) {
      if (fallback && file !== fallback) {
        sendFile(res, fallback, null);
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("UI is not built. From the repo root, run: npm --prefix ui run build && npm --prefix desktop run prepare-ui");
      return;
    }
    const ext = path.extname(file);
    const headers = { "Content-Type": TYPES[ext] || "application/octet-stream", "Content-Security-Policy": CSP };
    headers["Cache-Control"] = ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable";
    res.writeHead(200, headers);
    res.end(data);
  });
}

function startStatic(root) {
  const index = path.join(root, "index.html");
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const file = safeJoin(root, req.url || "/");
      if (!file) {
        res.writeHead(403);
        res.end();
        return;
      }
      fs.stat(file, (err, st) => {
        if (!err && st.isFile()) {
          sendFile(res, file, null);
          return;
        }
        if (!err && st.isDirectory()) {
          sendFile(res, path.join(file, "index.html"), index);
          return;
        }
        sendFile(res, index, null);
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

// --- window state -----------------------------------------------------------

const stateFile = () => path.join(app.getPath("userData"), "window.json");

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), "utf8"));
  } catch {
    return {};
  }
}

function saveState(patch) {
  try {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify({ ...loadState(), ...patch }));
  } catch {
    // Not fatal: the next launch just starts from the defaults.
  }
}

let win = null;
let origin = null;

function isMac() {
  return process.platform === "darwin";
}

function applicationMenu() {
  // A menu gives the standard shortcuts (copy, paste, quit, reload) on every
  // platform; the window itself stays frameless and the bar is hidden.
  const template = [
    ...(isMac() ? [{ role: "appMenu" }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "Athanor on GitHub", click: () => shell.openExternal("https://github.com/Arjun-Walia/Athanor") },
        { label: "Public cluster", click: () => shell.openExternal(PUBLIC_BASE) },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

async function createWindow() {
  const dev = process.env.ATHANOR_DEV_URL;
  let url = dev;
  if (!url) {
    const server = await startStatic(UI_ROOT);
    const { port } = server.address();
    origin = `http://127.0.0.1:${port}`;
    url = `${origin}/app`;
  }

  const state = loadState();
  win = new BrowserWindow({
    width: state.width || 1440,
    height: state.height || 900,
    minWidth: 720,
    minHeight: 520,
    show: false,
    title: "Athanor",
    backgroundColor: "#f4f1e6",
    autoHideMenuBar: true,
    // macOS keeps its traffic lights (hidden inset); other platforms draw
    // their own controls in the page.
    ...(isMac() ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 18, y: 18 } } : { frame: false, thickFrame: false }),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.once("ready-to-show", () => {
    if (state.fullscreen ?? !isMac()) {
      win.setFullScreen(true);
    } else {
      win.maximize();
    }
    win.show();
  });

  const remember = () => {
    if (!win || win.isDestroyed()) return;
    const [width, height] = win.getSize();
    saveState({ width, height, fullscreen: win.isFullScreen() });
  };
  win.on("resize", remember);
  win.on("enter-full-screen", () => {
    remember();
    win.webContents.send("win:fullscreen", true);
  });
  win.on("leave-full-screen", () => {
    remember();
    win.webContents.send("win:fullscreen", false);
  });
  win.on("closed", () => {
    win = null;
  });

  // Links to other sites (GitHub, a node's direct URL) open in the system
  // browser; the window itself only ever shows the bundled UI.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) shell.openExternal(target);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, target) => {
    if (origin && target.startsWith(origin)) return;
    if (dev && target.startsWith(dev)) return;
    event.preventDefault();
    if (/^https?:/i.test(target)) shell.openExternal(target);
  });

  await win.loadURL(url);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.whenReady().then(() => {
    app.setName("Athanor");
    if (process.platform === "win32") app.setAppUserModelId(APP_ID);
    Menu.setApplicationMenu(applicationMenu());
    // Deny every permission prompt: the dashboard needs none.
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    return createWindow();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on("window-all-closed", () => app.quit());
}

// --- IPC from the preload ----------------------------------------------------

ipcMain.on("app:config", (event) => {
  event.returnValue = {
    platform: process.platform,
    version: app.getVersion(),
    defaultBase: process.env.ATHANOR_BASE || PUBLIC_BASE,
  };
});

ipcMain.on("win:minimize", () => {
  if (!win) return;
  if (win.isFullScreen()) win.setFullScreen(false);
  win.minimize();
});

ipcMain.on("win:close", () => win?.close());

ipcMain.handle("win:fullscreen", () => {
  if (!win) return false;
  const next = !win.isFullScreen();
  win.setFullScreen(next);
  if (!next) win.maximize();
  return next;
});

ipcMain.handle("win:isFullscreen", () => Boolean(win?.isFullScreen()));
