const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("athanorDesktop", {
  minimize() {
    ipcRenderer.send("win:minimize");
  },
  close() {
    ipcRenderer.send("win:close");
  },
  toggleFullscreen() {
    return ipcRenderer.invoke("win:fullscreen");
  },
});
