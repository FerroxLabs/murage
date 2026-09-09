const byId = id => document.getElementById(id);
const buttons = [...document.querySelectorAll("button[data-action]")];
let current = null, pending = false;
const errors = {
  RECOVERY_OWNERSHIP_REQUIRED: "Another process may still own this installation. Close it, then retry startup.",
  RECOVERY_SELECTION_EXPIRED: "Choose and inspect the backup again before restoring.",
  ARCHIVE_HASH_CHANGED: "The backup changed after inspection. Choose it again.",
  INVALID_INSTALLATION_RECORDS: "A saved record needs repair. The original files have been preserved.",
  DESTINATION_EXISTS: "Choose a new filename. Existing backups are never overwritten.",
  RESTORE_REVIEW_REQUIRED: "The restored installation is paused for recovery review.",
  NO_RESTORE_TO_ROLL_BACK: "No retained restore transaction was found for this installation.",
  RECOVERY_BUSY: "A recovery operation is already in progress.",
  REVIEW_STATE_CHANGED: "The installation changed after review. Review it again before opening.",
  RESTORE_WORK_NOT_PAUSED: "Some work is still enabled. Keep the installation stopped and inspect recovery diagnostics.",
};
function render(state) {
  current = state;
  document.documentElement.dataset.skin = state.context?.skin === "light" ? "light" : "dark";
  byId("reason").textContent = state.context?.reason || "Startup needs attention. Your installation data remains preserved.";
  byId("location").textContent = state.context?.dataDirectory || "Installation ownership is unavailable.";
  const ownership = state.context?.ownership;
  byId("ownership").hidden = !ownership;
  if (ownership) {
    const kinds = { primary: "App ownership", child: "Background server ownership", reaper: "Recovery ownership" };
    byId("ownership-summary").textContent = (kinds[ownership.claimKind] || "Ownership inspection") +
      ". Recorded computer: " + (ownership.recordedHost || "unavailable") +
      ". Current computer: " + (ownership.currentHost || "unavailable") +
      ". Status: " + (ownership.code || "No blocker observed; startup must still verify ownership") + ".";
  }
  const error = state.error ? (errors[state.error] || "The operation could not complete. Keep retained files and check diagnostics.") + " (" + state.error + ")" : "";
  byId("error").textContent = error;
  byId("error").hidden = !error;
  byId("preview").hidden = !state.selection;
  byId("activation-review").hidden = !state.review;
  if (state.review) byId("activation-summary").textContent = "Reviewed " + state.review.files + " files. Engines are disabled, schedules are paused, and connections use fresh storage.";
  if (state.selection) {
    byId("backup-name").textContent = state.selection.name;
    byId("backup-summary").textContent = "Excluded entries: " + (state.selection.omittedCount ?? 0) + ". Components absent from this snapshot: " + (state.selection.missingCount ?? 0) + ". Connections will need review.";
    byId("snapshot").textContent = state.selection.snapshotId;
    byId("hash").textContent = state.selection.sha256;
  }
  for (const button of buttons) button.disabled = pending || state.busy || (!state.available && !["retry","diagnostics"].includes(button.dataset.action)) || (button.dataset.action === "restore" && !state.selection) || (button.dataset.action === "activate" && !state.review);
  if (pending || state.busy) byId("status").textContent = "Working on the selected operation. Large backups may take several minutes.";
  else if (error) byId("status").textContent = "";
  else if (state.result?.ok) byId("status").textContent = state.result.status === "reviewed-engines-disabled" ? "Review approved. Restarting with engines and schedules disabled." : state.result.status === "restored-review-required" ? "Restore completed and remains paused. Previous data: " + state.result.previousDataDir : state.result.status === "rolled-back" ? "Previous installation restored. Candidate retained at: " + (state.result.retainedCandidate || "see receipt") : "Backup saved: " + state.result.path;
  else byId("status").textContent = state.selection ? "Backup inspected. No installation data has been changed." : "";
}
async function action(name) {
  if (pending) return;
  pending = true;
  if (current) render(current);
  try {
    const state = await window.murageRecovery.action(name, name === "restore" ? current?.selection?.id : name === "activate" ? current?.review?.id : undefined);
    pending = false; render(state);
  } catch {
    pending = false;
    render({ ...(current || {}), error: "RECOVERY_OPERATION_FAILED", busy: false });
  }
}
for (const button of buttons) button.addEventListener("click", () => void action(button.dataset.action));
void action("state");
