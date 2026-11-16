// Null G0 omits Signal; otherwise RC checks and release mutations require the full gate.
import { assertSignalReleaseReady } from './signal-release-prerequisites.mjs';

try {
  console.log(assertSignalReleaseReady());
} catch (error) {
  console.error(`RC REFUSED: ${error.message}`);
  process.exitCode = 1;
}
