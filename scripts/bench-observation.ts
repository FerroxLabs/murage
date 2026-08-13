import { ObservationCoordinator } from "../server/computer-observation.ts";

// Stable fixture: old strategy sends a full screenshot after every read. The
// new policy captures after each deterministic action but only sends an image
// when pixels change; repeated reads without actions reuse the observation.
const frames = ["initial", "initial", "after-click", "after-click", "after-submit", "after-submit", "after-submit"];
const oldSent = frames.length;
const coordinator = new ObservationCoordinator();
for (const [index, frame] of frames.entries()) {
  if (index === 0 || index === 2 || index === 4) coordinator.noteAction();
  if (coordinator.needsCapture()) coordinator.observeFrame(frame, null);
}
const metrics = coordinator.metrics;
const reduction = ((1 - metrics.screenshotsSentToModel / oldSent) * 100).toFixed(1);
console.log("Computer observation benchmark (offline deterministic fixture)");
console.log(`Screenshot observations sent to model: ${oldSent} → ${metrics.screenshotsSentToModel} (${reduction}% reduction)`);
console.log(`Screenshots captured: ${metrics.screenshotsCaptured}; stable reads reused: ${frames.length - metrics.screenshotsCaptured}`);
console.log("Reliability note: every deterministic action still triggers one fresh capture; unchanged pixels suppress only redundant vision payloads.");
