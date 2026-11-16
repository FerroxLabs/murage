import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDir } from "../server/testing/cleanup.ts";
import { createConnectorNoticeReceipts } from "./connector-notice-receipts.mjs";
test("a shown connector incident stays deduplicated across desktop restart and is scoped to its home", async () => {
  const dir = mkdtempSync(join(tmpdir(), "connector-receipts-"));
  try {
    const file = join(dir, "receipts.json");
    const first = createConnectorNoticeReceipts(file);
    assert.equal(first.has("local", "incident"), false);
    first.delivered("local", "incident");
    const restarted = createConnectorNoticeReceipts(file);
    assert.equal(restarted.has("local", "incident"), true);
    assert.equal(restarted.has("another-home", "incident"), false);
    assert.equal(restarted.has("local", "new-incident"), false);
  } finally { await removeTempDir(dir); }
});
