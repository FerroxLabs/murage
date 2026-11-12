import { renameSync } from "node:fs";
const transient = new Set(["EPERM", "EACCES", "EBUSY"]);
export const windowsRenameDenied = error => process.platform === "win32" && transient.has(error?.code);
export function renameWithRetrySync(from, to, { rename = renameSync, platform = process.platform, attempts = 20, pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { rename(from, to); return; }
    catch (error) {
      if (platform !== "win32" || !transient.has(error?.code) || attempt >= attempts) throw error;
      pause(10);
    }
  }
}
