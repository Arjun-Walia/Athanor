// Bridge between the frameless window and the page. The page checks for
// window.athanorDesktop to know it is inside the app (ui/src/shell.jsx).
const { contextBridge, ipcRenderer } = require("electron");

const config = ipcRenderer.sendSync("app:config");
let fullscreen = false;
const listeners = new Set();

ipcRenderer.on("win:fullscreen", (_event, value) => {
  fullscreen = Boolean(value);
  listeners.forEach((fn) => fn(fullscreen));
});

ipcRenderer.invoke("win:isFullscreen").then((value) => {
  fullscreen = Boolean(value);
});

contextBridge.exposeInMainWorld("athanorDesktop", {
  platform: config.platform,
  version: config.version,
  // The cluster to try when no local node answers.
  defaultBase: config.defaultBase,
  minimize() {
    ipcRenderer.send("win:minimize");
  },
  close() {
    ipcRenderer.send("win:close");
  },
  toggleFullscreen() {
    return ipcRenderer.invoke("win:fullscreen");
  },
  isFullscreen() {
    return fullscreen;
  },
  onFullscreen(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
});
