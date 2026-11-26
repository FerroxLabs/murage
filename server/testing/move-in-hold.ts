// Test-only: stands the macOS folder question in for. A listing of a folder named Downloads blocks its calling thread
// (as the OS does to the open) until the release file appears, or forever when `release` is false. The same hold is set in the
// main thread (where the server must never list Downloads) and in the worker the server reads folders on (move-in-found.ts).
// The marker file gets one line per listing that reached a hold, so a green run is not a skipped listing.
export function moveInHoldSource({ release, exportFixture }: { release: boolean; exportFixture: boolean }): string {
  const wait = release
    ? `while (!heldFs.existsSync(HELD_RELEASE)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);`
    : `for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);`;
  const body = (where: string) => `
    const heldFs = require("node:fs");
    const HELD_MARKER = process.env.MURAGE_DATA_DIR + "/downloads-listing-entered";
    const HELD_RELEASE = process.env.MURAGE_DATA_DIR + "/downloads-listing-released";
    const isHeld = (dir) => require("node:path").basename(String(dir)) === "Downloads";
    const hold = () => { heldFs.appendFileSync(HELD_MARKER, "${where}\\n"); ${wait} };
    const heldReaddirSync = heldFs.readdirSync;
    heldFs.readdirSync = function (dir, ...rest) { if (isHeld(dir)) hold(); return heldReaddirSync.call(this, dir, ...rest); };
    const heldReaddir = heldFs.promises.readdir;
    heldFs.promises.readdir = async function (dir, ...rest) { if (isHeld(dir)) hold(); return heldReaddir.call(this, dir, ...rest); };
    const heldOpendir = heldFs.opendirSync;
    heldFs.opendirSync = function (dir, ...rest) { if (isHeld(dir)) hold(); return heldOpendir.call(this, dir, ...rest); };
  `;
  return `
import { createRequire as heldRequire } from "node:module";
import { syncBuiltinESMExports as heldSyncExports } from "node:module";
import { homedir as heldHome } from "node:os";
import { join as heldJoin } from "node:path";
const require = heldRequire(import.meta.url);
const heldDownloads = heldJoin(heldHome(), "Downloads");
require("node:fs").mkdirSync(heldDownloads, { recursive: true });
${exportFixture ? `require("node:fs").writeFileSync(heldJoin(heldDownloads, "grok-bot-export.json"), JSON.stringify({ name: "Fixture Helper", instructions: "Help with the fixture.", skills: [], routines: [] }));` : ""}
${body("main")}
heldSyncExports();
globalThis[Symbol.for("murage.moveIn.probePrelude")] = ${JSON.stringify(body("worker"))};
`;
}
