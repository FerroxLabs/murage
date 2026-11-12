// Early RC check and direct release mutations share the same mandatory gate.
import { assertSignalReleaseReady } from './signal-release-prerequisites.mjs';

try {
  console.log(assertSignalReleaseReady());
} catch (error) {
  console.error(`RC REFUSED: ${error.message}`);
  process.exitCode = 1;
}
