const { app, BrowserWindow, Menu, ipcMain } = require("electron");
const http = require("http");
const fs = require("fs");
const path = require("path");

const UI_ROOT = path.resolve(__dirname, process.env.ATHANOR_UI || path.join("..", "ui", "dist"));

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
      res.end("UI is not built. From the repo root, run: npm --prefix ui run build");
      return;
    }
    const ext = path.extname(file);
    const headers = { "Content-Type": TYPES[ext] || "application/octet-stream" };
    if (ext === ".html") headers["Cache-Control"] = "no-cache";
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

let win;

function leaveFullscreen() {
  if (!win) return;
  if (win.isFullScreen()) win.setFullScreen(false);
  win.maximize();
}

async function createWindow() {
  const dev = process.env.ATHANOR_DEV_URL;
  let url = dev;
  if (!url) {
    const server = await startStatic(UI_ROOT);
    const { port } = server.address();
    url = `http://127.0.0.1:${port}/app`;
  }

  win = new BrowserWindow({
    width: 1440,
    height: 900,
    frame: false,
    fullscreen: true,
    roundedCorners: false,
    thickFrame: false,
    backgroundColor: "#f4f1e6",
    autoHideMenuBar: true,
    title: "Athanor",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once("ready-to-show", () => {
    win.show();
    win.setFullScreen(true);
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
    Menu.setApplicationMenu(null);
    app.setName("athanor");
    return createWindow();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on("window-all-closed", () => app.quit());
}

ipcMain.on("win:minimize", () => {
  if (win?.isFullScreen()) leaveFullscreen();
  win?.minimize();
});

ipcMain.on("win:close", () => win?.close());

ipcMain.handle("win:fullscreen", () => {
  if (!win) return false;
  if (win.isFullScreen()) {
    leaveFullscreen();
    return false;
  }
  win.setFullScreen(true);
  return true;
});
