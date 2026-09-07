// One implementation shared with the packaged desktop supervisor. The server
// bundle inlines this JavaScript module; standalone Node needs no Electron.
export { acquireDataDirLeaseForProcess, dataDirLeasePaths } from "../electron/data-dir-lease.mjs";
