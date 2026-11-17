// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { walTransformPlugin } from "./testing/wal-transform-vite.mjs";
import { transformWalSource } from "./testing/wal-transform.mjs";

it("D0-enforce-pre: the adapter transforms raw TypeScript before Vite", () => {
  expect(walTransformPlugin().enforce, "raw TypeScript anchors require pre ordering").toBe("pre");
});

it("W-prod-untouched writable target (Vitest adapter)", () => {
  const dir = mkdtempSync(join(tmpdir(), "wal-transform-write-"));
  try {
    mkdirSync(join(dir, "server"));
    const file = join(dir, "server/wal-maintenance.ts");
    const source = readFileSync("server/wal-maintenance.ts", "utf8");
    writeFileSync(file, source);
    expect(transformWalSource(file, source)).not.toBe(source);
    expect(readFileSync(file, "utf8") === source, "the writable input stayed byte-identical after transformation").toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
