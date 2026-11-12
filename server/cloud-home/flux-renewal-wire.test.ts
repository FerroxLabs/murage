// SPDX-License-Identifier: AGPL-3.0-or-later
// B4 hole 11: the renewal wire schema is defined once (shared/flux-renewal-wire.ts, zod) and mirrored in
// the root poller (deploy/cloud-home/murage-control, Python). This test fails if the two drift:
// same field lists, same patterns, and the same accept/refuse answer on every vector below.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ackResponse, FLUX_RENEWAL_WIRE, renewalDueResponse, subkeyResponse } from "../../shared/flux-renewal-wire.ts";

const program = fileURLToPath(new URL("../../deploy/cloud-home/murage-control", import.meta.url));
const script = `import importlib.machinery,importlib.util,json,sys
l=importlib.machinery.SourceFileLoader("wire_fixture",sys.argv[1]);spec=importlib.util.spec_from_loader(l.name,l);m=importlib.util.module_from_spec(spec);l.exec_module(m)
vectors=json.loads(sys.stdin.read())
def ok(fn,value):
    try: fn(value); return True
    except ValueError: return False
print(json.dumps({"wire":m.FLUX_RENEWAL_WIRE,"answers":{k:[ok(getattr(m,fn),v) for v in rows] for k,(fn,rows) in vectors.items()}}))`;

const KEY = `sk-flux-home-${"k".repeat(30)}`;
const OP = "renew:home-1:3:7";
const sub = (patch: Record<string, unknown>) => ({ key: KEY, generation: 2, expiresAt: "2026-11-09T12:00:00.000Z", capUsd: 30, ...patch });
const without = (name: string) => { const value = sub({}) as Record<string, unknown>; delete value[name]; return value; };
const vectors = {
  renewalDue: ["valid_renewal_due", renewalDueResponse, [
    { due: false }, { due: true, op_id: OP }, { due: true }, { due: false, op_id: OP }, { due: true, op_id: null },
    { due: true, op_id: "renew:home-1:0:7" }, { due: true, op_id: "other:home-1:3:7" }, { due: "true", op_id: OP }, { due: true, op_id: OP, extra: 1 }, {}, [], "x",
  ]],
  subkey: ["valid_subkey", subkeyResponse, [
    sub({}), sub({ expiresAt: "2026-11-09T12:00:00Z" }), sub({ capUsd: 0 }), sub({ capUsd: 12.5 }),
    sub({ key: `sk-flux-${"p".repeat(30)}` }), sub({ key: "sk-flux-home-short" }), sub({ key: 5 }),
    sub({ generation: 0 }), sub({ generation: 1.5 }), sub({ generation: true }), sub({ generation: "2" }),
    sub({ expiresAt: "2026-11-09 12:00:00" }), sub({ expiresAt: "2026-11-09T12:00:00+01:00" }), sub({ expiresAt: 1790000000 }),
    sub({ capUsd: -1 }), sub({ capUsd: "30" }), sub({ capUsd: true }),
    without("key"), without("generation"), without("expiresAt"), without("capUsd"),
    sub({ key_alias: "a" }), { key: KEY, key_alias: "a", generation: 2, expires_at: "2026-11-09T12:00:00Z", cap_microcents: 1 },
  ]],
  ack: ["valid_ack_response", ackResponse, [{ acked: true }, { acked: false }, { acked: "true" }, {}, { acked: true, extra: 1 }]],
} as const;

describe("hole 11: the renewal wire schema cannot drift between TypeScript and Python", () => {
  const run = spawnSync("python3", ["-I", "-c", script, program], {
    input: JSON.stringify(Object.fromEntries(Object.entries(vectors).map(([name, [fn, , rows]]) => [name, [fn, rows]]))), encoding: "utf8", timeout: 15_000,
  });
  const python = (run.status === 0 ? JSON.parse(run.stdout) : null) as { wire: unknown; answers: Record<string, boolean[]> } | null;
  it("hole 11: the Python mirror loads", () => { expect(run.status, run.stderr).toBe(0); });
  it("hole 11: both sides name the same fields and patterns", () => {
    expect(python!.wire).toEqual(JSON.parse(JSON.stringify(FLUX_RENEWAL_WIRE)));
  });
  it.each(Object.keys(vectors))("hole 11: %s - zod and Python accept and refuse exactly the same payloads", name => {
    const [, schema, rows] = vectors[name as keyof typeof vectors];
    const expected = rows.map(row => schema.safeParse(row).success);
    expect(python!.answers[name]).toEqual(expected);
    expect(expected.some(Boolean) && expected.some(value => !value)).toBe(true); // the vectors really cover both outcomes
  });
});
