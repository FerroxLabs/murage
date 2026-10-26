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
window.setBackupProgress = function (step, skin) {
  const n = Math.max(0, Math.min(4, Number(step) || 0));
  if (skin === "light" || skin === "dark") document.documentElement.dataset.skin = skin;
  for (const item of document.querySelectorAll("#steps li")) {
    const number = Number(item.dataset.step);
    item.className = number < n ? "done" : number === n ? "active" : "";
  }
  document.getElementById("fill").style.width = Math.max(6, n * 25) + "%";
  document.getElementById("bar").setAttribute("aria-valuenow", String(n));
  document.getElementById("status").textContent = n >= 4 ? "Almost done." : "";
};
