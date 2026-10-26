// Driven by the main process with real stages of the first backup (1 to 4).
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
