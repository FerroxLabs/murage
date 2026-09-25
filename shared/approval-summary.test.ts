// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { APPROVAL_SUMMARY_MAX, approvalSummary } from "./approval-summary";

// Linux customer pass, 0.1.60: an approval card showed a here-doc command
// cut at 200 characters, mid-word ("with open('notes/pi"), with nothing to
// say it was cut. The owner is being asked to allow the whole command.
it("keeps a long command whole on the card", () => {
  const command = `cd /home/tester/m60/data/workspaces/${"a".repeat(36)}/threads/${"b".repeat(36)} && \\\ncat >> notes/log.md <<EOF\n$(date)\nEOF\npython3 - <<'PYEOF'\nwith open('notes/pipeline.md', 'a') as f:\n    f.write('rm trash\\n')\nPYEOF`;
  expect(command.length).toBeGreaterThan(200);
  expect(approvalSummary(command)).toBe(command);
});

it("bounds a runaway command and says it was cut", () => {
  const out = approvalSummary("x".repeat(APPROVAL_SUMMARY_MAX + 50));
  expect(out.length).toBe(APPROVAL_SUMMARY_MAX + 1);
  expect(out.endsWith("…")).toBe(true);
});
