import { randomUUID } from "node:crypto";

const actions = new Set(["state", "choose-backup", "backup", "restore", "rollback", "retry", "diagnostics", "review-installation", "activate"]);
const code = value => typeof value === "string" && /^[A-Z][A-Z0-9_]{0,100}$/.test(value) ? value : "RECOVERY_OPERATION_FAILED";
const controllerErrors = new Set(["UNTRUSTED_RECOVERY_SENDER", "INVALID_RECOVERY_REQUEST", "INVALID_RECOVERY_PREVIEW", "RECOVERY_SELECTION_EXPIRED", "RECOVERY_OWNERSHIP_REQUIRED"]);

/** Failure-window-only controller. Renderer input never supplies a path,
 * command or hash. The host owns dialogs, selection and process authority. */
export function createInstallationRecoveryController(host) {
  let busy = false;
  let selection = null;
  let activationReview = null;
  let result = null;
  let error = null;
  const authorize = event => {
    if (!host.isTrustedSender(event)) throw new Error("UNTRUSTED_RECOVERY_SENDER");
  };
  const state = () => ({ busy, available: host.isAvailable(), selection: selection ? { id: selection.id, name: selection.name, snapshotId: selection.preview.snapshotId, sha256: selection.preview.sha256, omittedCount: selection.preview.omittedCount, missingCount: selection.preview.missingCount } : null, review: activationReview ? { id: activationReview.id, snapshotId: activationReview.report.snapshotId, files: activationReview.report.files, bytes: activationReview.report.bytes } : null, result, error, activationAvailable: !!activationReview });

  return {
    async handle(event, input) {
      authorize(event);
      if (!input || typeof input !== "object" || Array.isArray(input) || !actions.has(input.action) || Object.keys(input).some(key => key !== "action" && !(input.action === "restore" && key === "selectionId") && !(input.action === "activate" && key === "reviewId"))) throw new Error("INVALID_RECOVERY_REQUEST");
      if (input.action === "state") return state();
      if (busy) return { ...state(), error: "RECOVERY_BUSY" };
      if (!host.isAvailable() && !["diagnostics", "retry"].includes(input.action)) return { ...state(), error: "RECOVERY_OWNERSHIP_REQUIRED" };
      busy = true; error = null; result = null;
      if (input.action !== "activate") activationReview = null;
      try {
        if (input.action === "review-installation") {
          const report = await host.run("review", {});
          authorize(event);
          if (report.operation !== "review" || report.activationAvailable !== true || !/^[a-f0-9]{64}$/.test(report.reviewHash)) throw new Error("INVALID_RECOVERY_PREVIEW");
          activationReview = { id: randomUUID(), report };
          selection = null;
        } else if (input.action === "activate") {
          if (!activationReview || input.reviewId !== activationReview.id) throw new Error("RECOVERY_SELECTION_EXPIRED");
          const chosen = activationReview;
          if (await host.confirm(event, "activate")) {
            authorize(event);
            if (!host.isAvailable()) throw new Error("RECOVERY_OWNERSHIP_REQUIRED");
            activationReview = null;
            result = await host.run("activate", { reviewHash: chosen.report.reviewHash });
            if (result.status !== "reviewed-engines-disabled") throw new Error("INVALID_RECOVERY_PREVIEW");
            await host.retry();
          }
        } else if (input.action === "choose-backup") {
          selection = null;
          const chosen = await host.chooseBackup(event);
          authorize(event);
          if (chosen) {
            const preview = await host.run("plan-restore", { archive: chosen.path });
            authorize(event);
            if (!preview.ok || preview.operation !== "plan-restore" || !/^[a-f0-9]{64}$/.test(preview.sha256) || typeof preview.snapshotId !== "string" || preview.activationAvailable !== false) throw new Error("INVALID_RECOVERY_PREVIEW");
            selection = { id: randomUUID(), path: chosen.path, name: chosen.name, preview };
          }
        } else if (input.action === "backup") {
          const destination = await host.chooseDestination(event);
          authorize(event);
          if (destination) {
            if (!host.isAvailable()) throw new Error("RECOVERY_OWNERSHIP_REQUIRED");
            result = await host.run("backup", { output: destination });
          }
        } else if (input.action === "restore") {
          if (!selection || input.selectionId !== selection.id) throw new Error("RECOVERY_SELECTION_EXPIRED");
          const chosen = selection;
          if (await host.confirm(event, "restore", chosen.name)) {
            authorize(event);
            if (!host.isAvailable()) throw new Error("RECOVERY_OWNERSHIP_REQUIRED");
            selection = null;
            result = await host.run("restore", { archive: chosen.path, sha256: chosen.preview.sha256 });
          }
        } else if (input.action === "rollback") {
          if (await host.confirm(event, "rollback")) {
            authorize(event);
            if (!host.isAvailable()) throw new Error("RECOVERY_OWNERSHIP_REQUIRED");
            selection = null;
            result = await host.run("rollback", {});
          }
        } else if (input.action === "retry") {
          await host.retry();
        } else if (input.action === "diagnostics") {
          await host.openDiagnostics();
        }
      } catch (failure) {
        error = failure?.code ? code(failure.code) : controllerErrors.has(failure?.message) ? failure.message : "RECOVERY_OPERATION_FAILED";
      } finally { busy = false; }
      return state();
    },
  };
}
