const byId = id => document.getElementById(id);
const buttons = [...document.querySelectorAll("button[data-action]")];
let current = null, pending = false;
const recoveryMessage = code => globalThis.murageRecoveryMessages.sentence(code);
function render(state) {
  current = state;
  document.documentElement.dataset.skin = state.context?.skin === "light" ? "light" : "dark";
  byId("page-heading").textContent=state.context?.backupMode?"Backup mode":"Recover this installation";
  byId("encrypted-backup").hidden=!state.encryptedAvailable;
  byId("reason").textContent = state.context?.reason || "Murage needs your attention before it can start. Your data is kept as it is.";
  byId("location").textContent = state.context?.dataDirectory || "Murage can't see its data folder right now.";
  const ownership = state.context?.ownership;
  byId("ownership").hidden = !ownership;
  if (ownership) {
    const kinds = { primary: "The app", child: "The background server", reaper: "Recovery" };
    byId("ownership-summary").textContent = (kinds[ownership.claimKind] || "Murage") +
      " last used this folder on a computer named " + (ownership.recordedHost || "(unknown)") +
      ". This computer is named " + (ownership.currentHost || "(unknown)") + ".";
  }
  // Only the sentence is shown; the code stays in diagnostics and in a
  // data attribute for support tools.
  const error = state.error ? recoveryMessage(state.error) : "";
  byId("error").textContent = error;
  if (state.error) byId("error").dataset.code = state.error; else delete byId("error").dataset.code;
  byId("error").hidden = !error;
  byId("preview").hidden = !state.selection;
  byId("separate-recovery").hidden = !state.separateAvailable;
  byId("capture-recovery").hidden = !state.captureAvailable;
  byId("retained-destination").hidden = !state.retainedDataDirectory;
  byId("retained-destination").textContent = state.retainedDataDirectory ? "Separate recovery files retained at: " + state.retainedDataDirectory : "";
  byId("separate-destination").hidden = !state.selection?.separate;
  byId("separate-destination").textContent = state.selection?.separate ? "The restored copy goes into a new folder: " + state.selection.destination + ". Your current data stays as it is. Murage restarts there so you can review it." : "";
  byId("restore").hidden = !!state.selection?.separate||!!state.selection?.encrypted;
  byId("restore-separate").hidden = !state.selection?.separate||!!state.selection?.encrypted;
  byId("restore-encrypted-new").hidden=!state.selection?.encrypted;
  byId("activation-review").hidden = !state.review;
  if (state.review) byId("activation-summary").textContent = "Checked " + state.review.files + " files. AI engines and schedules stay off until you turn them on, and messaging apps need connecting again.";
  if (state.selection) {
    byId("backup-name").textContent = state.selection.name;
    byId("backup-summary").textContent = state.selection.encrypted?"Encrypted backup from Murage. It holds your settings, bots, conversations, files and channel history. Sign-ins to AI engines and messaging apps are not restored; you connect those again.":"Older unencrypted recovery file. Some items were left out of it (" + (state.selection.omittedCount ?? 0) + "), and connections need setting up again after the restore.";
    byId("snapshot").textContent = state.selection.snapshotId;
    byId("hash").textContent = state.selection.sha256;
  }
  for (const button of buttons) {
    const action = button.dataset.action;
    if(action==="retry")button.textContent=state.context?.backupMode?"Return to workspace":"Retry startup";
    const separate = ["choose-separate-backup", "restore-separate"].includes(action);
    button.disabled = pending || state.busy || (action === "capture-separate" ? !state.captureAvailable : separate ? !state.separateAvailable : !state.available && !["retry","diagnostics"].includes(action)) ||
      (action.includes("encrypted")&&!state.encryptedAvailable)||(action==="restore-encrypted-new"&&!state.selection?.encrypted)||
      (action === "restore" && (!state.selection || state.selection.separate)) || (action === "restore-separate" && !state.selection?.separate) || (action === "activate" && !state.review);
  }
  if (pending || state.busy) byId("status").textContent = "Working on it. A large backup can take several minutes.";
  else if (error) byId("status").textContent = "";
  else if (state.result?.ok) byId("status").textContent = state.result.operation==="backup-encrypted"?"Backup saved and checked: "+state.result.path:state.result.operation==="restore-encrypted-new"?"Restored. Murage is restarting so you can review the restored copy; your current data stays as it is.":state.result.status === "reviewed-engines-disabled" ? "Approved. Murage is restarting with AI engines and schedules off." : state.result.status === "restored-review-required" ? "Restored, and paused until you review it. Your previous data is kept at: " + state.result.previousDataDir : state.result.status === "rolled-back" ? "Your previous data is back. The restored copy is kept at: " + (state.result.retainedCandidate || "the recovery folder") : "Backup saved: " + state.result.path;
  else byId("status").textContent = state.selection ? "Backup checked. Nothing has been changed yet." : "";
}
async function action(name) {
  if (pending) return;
  pending = true;
  if (current) render(current);
  try {
    const state = await window.murageRecovery.action(name, ["restore", "restore-separate", "restore-encrypted-new"].includes(name) ? current?.selection?.id : name === "activate" ? current?.review?.id : undefined);
    pending = false; render(state);
  } catch {
    pending = false;
    render({ ...(current || {}), error: "RECOVERY_OPERATION_FAILED", busy: false });
  }
}
for (const button of buttons) button.addEventListener("click", () => void action(button.dataset.action));
void action("state");
