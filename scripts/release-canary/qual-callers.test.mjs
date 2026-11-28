// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ENTRIES, CALLER_NOT_BUILT } from "./qual-entries.mjs";
import { openQual, requireQualGate } from "./qual.mjs";

// W18: each B6 entry is driven as entry({gate, caller}); both spies append to one ordered call log.
const spies = (gateExit) => {
  const log = [];
  return {
    log,
    gate: async () => { log.push("gate"); return { exit: gateExit }; },
    caller: async () => { log.push("caller"); return 17; },
  };
};

for (const [name, entry] of Object.entries(ENTRIES)) {
  it(`W18 ${name}: gate exit 2 never reaches the caller`, async () => {
    const s = spies(2);
    expect(await entry({ gate: s.gate, caller: s.caller })).toBe(2);
    expect(s.log).toEqual(["gate"]);
  });
  it(`W18 ${name}: gate exit 0 calls the caller exactly once, after the gate, and returns its exit`, async () => {
    const s = spies(0);
    expect(await entry({ gate: s.gate, caller: s.caller })).toBe(17);
    expect(s.log).toEqual(["gate", "caller"]);
  });
}

it("W18 the default caller is CALLER_NOT_BUILT and never satisfies the pass path", async () => {
  const s = spies(0);
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(line);
  try { expect(await ENTRIES.pre({ gate: s.gate })).toBe(2); } finally { console.log = original; }
  expect(lines).toEqual(["CALLER_NOT_BUILT"]);
  expect(CALLER_NOT_BUILT).toBeTypeOf("function");
});

it("W18 (c) the REAL heartbeat gate refuses drift and UNVERIFIED snapshots and reads no replica", async () => {
  const base = mkdtempSync(join(tmpdir(), "canary-hb-"));
  const unreachable = openQual({ roots: [join(base, "no-mac"), join(base, "no-hz")], fences: {} });
  const good = {
    ruleset: { target: "tag", enforcement: "active", conditions: { ref_name: { include: ["~ALL"], exclude: [] } },
      bypass_actors: [{ actor_id: 42, actor_type: "Integration", bypass_mode: "always" }],
      rules: [{ type: "creation" }, { type: "update" }, { type: "deletion" }] },
    immutableReleases: true, ownerId: 7, principals: [{ kind: "user", id: 7, permission: "admin" }],
    orgBasePermission: "read", orgRulesets: [], deployKeys: [], installations: [],
  };
  const run = async (snapshot) => {
    const calls = [];
    const exit = await ENTRIES.heartbeat({
      gate: (args) => requireQualGate(args, { fetchSnapshot: async () => snapshot, appId: 42, qual: unreachable }),
      caller: async () => { calls.push("heartbeat-write"); return 0; },
    });
    return { exit, calls };
  };
  expect(await run({ ...good, immutableReleases: false })).toEqual({ exit: 2, calls: [] });
  const { immutableReleases: _drop, ...unverified } = good;
  expect(await run(unverified)).toEqual({ exit: 2, calls: [] });
  expect(await run(good)).toEqual({ exit: 0, calls: ["heartbeat-write"] });
});
