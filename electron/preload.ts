/**
 * The bridge, and the whole of it.
 *
 * The renderer gets these functions and nothing else — no `require`, no
 * `process`, no filesystem. Every entry here is a named operation the main
 * process validates on arrival, rather than a general channel the page could
 * shape into one. That is deliberate: model output is untrusted text, it is
 * rendered in this window, and the distance between "renders a string" and
 * "runs a command" should be a wall rather than a habit.
 */
import { contextBridge, ipcRenderer } from "electron";

/** Subscribe to a main→renderer stream; returns the unsubscribe. */
function on(channel: string, fn: (payload: any) => void): () => void {
  const handler = (_e: unknown, payload: any) => fn(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("molt", {
  state: () => ipcRenderer.invoke("app:state"),
  theme: (name: string) => ipcRenderer.invoke("app:theme", name),

  pickWorkspace: () => ipcRenderer.invoke("workspace:pick"),
  openSession: (opts: { cwd: string; model: string; baseUrl: string; apiKey?: string }) =>
    ipcRenderer.invoke("session:open", opts),

  saveKey: (provider: string, key: string) => ipcRenderer.invoke("auth:save", provider, key),
  saveEndpoint: (baseUrl: string, model: string) =>
    ipcRenderer.invoke("auth:endpoint", baseUrl, model),
  storedEndpoint: () => ipcRenderer.invoke("auth:stored"),
  listModels: (current?: { url: string; key?: string }) =>
    ipcRenderer.invoke("models:list", current),
  endpoints: () => ipcRenderer.invoke("endpoints:list"),
  addEndpoint: (url: string, model?: string) => ipcRenderer.invoke("endpoints:add", url, model),
  forgetEndpoint: (url: string) => ipcRenderer.invoke("endpoints:forget", url),
  setModel: (opts: { model: string; baseUrl?: string; apiKey?: string }) =>
    ipcRenderer.invoke("session:model", opts),
  setAutonomy: (level: string) => ipcRenderer.invoke("session:autonomy", level),
  command: (name: string, arg: string) => ipcRenderer.invoke("command:run", name, arg),
  reset: () => ipcRenderer.invoke("session:reset"),
  initBar: () => ipcRenderer.invoke("bar:init"),

  run: (text: string, ask = false, criteria?: unknown) =>
    ipcRenderer.invoke("session:run", text, ask, criteria),
  draftCriteria: (task: string) => ipcRenderer.invoke("criteria:draft", task),
  interview: (opts: unknown) => ipcRenderer.invoke("interview:turn", opts),
  applyBar: (adds: unknown) => ipcRenderer.invoke("bar:apply", adds),
  cancel: () => ipcRenderer.send("session:cancel"),
  answerConfirm: (id: string, ok: boolean) => ipcRenderer.send("confirm:reply", id, ok),

  receipts: () => ipcRenderer.invoke("receipts:list"),
  receipt: (file: string) => ipcRenderer.invoke("receipts:read", file),
  journal: () => ipcRenderer.invoke("journal:read"),
  stats: () => ipcRenderer.invoke("session:stats"),
  verify: () => ipcRenderer.invoke("integrity:verify"),

  onEvent: (fn: (ev: any) => void) => on("engine:event", fn),
  onConfirm: (fn: (req: { id: string; name: string; detail: string }) => void) =>
    on("confirm:request", fn),
  onIdle: (fn: () => void) => on("session:idle", fn),
});
