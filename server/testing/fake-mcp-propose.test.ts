// SPDX-License-Identifier: AGPL-3.0-or-later
// Proposal fixture producer and test consumer owner: r2-owner-limit-projects-z.
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { proposeThroughMcp } from "./fake-mcp-propose.ts";

it("a failed proposal MCP launch rejects its request instead of leaving a timer", async () => {
  await expect(proposeThroughMcp({ command: join(tmpdir(), "missing-proposal-cli") }, "")).rejects.toThrow(/ENOENT/);
});
it("a proposal MCP peer exiting without a reply rejects the pending request", async () => {
  await expect(proposeThroughMcp({ command: process.execPath, args: ["-e", "process.exit(0)"] }, "")).rejects.toThrow("MCP process exited before replying");
});
