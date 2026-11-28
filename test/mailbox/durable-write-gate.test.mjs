import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";

const gate = new URL("./durable-write-gate.mjs", import.meta.url).href;
const durable = new URL("../../electron/durable-write.mjs", import.meta.url).href;
const child = `
  import fs from "node:fs";
  const [gate, durable, file, side] = process.argv.slice(1);
  const { durableWriteGate } = await import(gate);
  const { writeFileDurable } = await import(durable);
  writeFileDurable(durableWriteGate(fs, file, side), file, '{"first":2,"second":2}');
`;

for (const [side, expected] of [["before", { first: 1, second: 1 }], ["after", { first: 2, second: 2 }]]) {
  test(`H2 kills ${side} the real durable rename`, () => {
    const directory = mkdtempSync(join(tmpdir(), "mail-rename-"));
    try {
      const path = join(directory, "fixture.json");
      writeFileSync(path, '{"first":1,"second":1}');
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", child, gate, durable, path, side], {
        encoding: "utf8",
      });
      assert.equal(result.signal, "SIGKILL", result.stderr);
      assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), expected);
    } finally {
      safeWipeSync(directory);
    }
  });
}
