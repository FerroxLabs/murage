// Driven by the main process with real stages of the backup (1 to 4).
// The heading is chosen by the kind the main process opened the page with
// (electron/backup-progress-window.mjs), so it is right on the first paint.
(function () {
  const HEADINGS = { first: "Setting up your first backup", backup: "Backing up your workspace", update: "Backing up before the update" };
  let kind = "backup";
  try { kind = new URLSearchParams(window.location.search).get("kind") || "backup"; } catch { /* the default heading stays */ }
  const heading = Object.hasOwn(HEADINGS, kind) ? HEADINGS[kind] : HEADINGS.backup;
  document.title = heading;
  const apply = () => { const node = document.getElementById("heading"); if (node) node.textContent = heading; };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply); else apply();
})();
// The bar's start for each step; the worker's notes move it on from there (backup-progress-window.mjs).
const BACKUP_BAR_STARTS = [6, 12, 25, 60, 100];
let backupBarPercent = 0;
function moveBackupBar(percent) {
  backupBarPercent = Math.max(backupBarPercent, Math.max(0, Math.min(100, Number(percent) || 0)));
  document.getElementById("fill").style.width = backupBarPercent + "%";
}
const gigabytes = bytes => (bytes / 1e9).toFixed(1);
const counted = (view, verb) => Number.isSafeInteger(view.done) && Number.isSafeInteger(view.total) && view.total > 0 ? `${verb} ${gigabytes(view.done)} of ${gigabytes(view.total)} GB` : null;
const BACKUP_DETAIL = {
  copy: () => "Copying your database",
  prepare: () => "Getting your files ready",
  encrypt: view => counted(view, "Encrypting") ?? "Encrypting your backup",
  check: view => counted(view, "Checking") ?? "Checking your backup",
};
window.setBackupDetail = function (view) {
  if (!view || !Object.hasOwn(BACKUP_DETAIL, view.phase)) return;
  const text = BACKUP_DETAIL[view.phase](view);
  document.getElementById("detail").textContent = text;
  document.getElementById("bar").setAttribute("aria-valuetext", text);
  moveBackupBar(view.percent);
};
window.setBackupProgress = function (step, skin) {
  const n = Math.max(0, Math.min(4, Number(step) || 0));
  if (skin === "light" || skin === "dark") document.documentElement.dataset.skin = skin;
  for (const item of document.querySelectorAll("#steps li")) {
    const number = Number(item.dataset.step);
    item.className = number < n ? "done" : number === n ? "active" : "";
  }
  moveBackupBar(BACKUP_BAR_STARTS[n]);
  if (n >= 4) { document.getElementById("detail").textContent = ""; document.getElementById("bar").removeAttribute("aria-valuetext"); }
  document.getElementById("bar").setAttribute("aria-valuenow", String(n));
  document.getElementById("status").textContent = n >= 4 ? "Almost done." : "";
};
