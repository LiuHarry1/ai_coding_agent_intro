import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("desktop", {
  isDesktop: true,
  pickWorkspace: () => ipcRenderer.invoke("pick-workspace"),
  getAgentUrl: () => ipcRenderer.invoke("get-agent-url"),
});
