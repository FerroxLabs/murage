import { describe, expect, it } from "vitest";

import { ensureHired, parseHireBody, type HireBot, type HireDeps, type HireSelection } from "./setup-hire.ts";

const SHAPES = {
  "starter-solo-business": { agents: ["business-planner", "draft-partner"], routines: [{ key: "weekly-business-review", agent: "business-planner" }] },
  "starter-business-team": { agents: ["team-coordinator", "delivery-partner", "review-partner"], routines: [{ key: "weekly-team-review", agent: "team-coordinator" }] },
} as const;

function fake(opts: { failOn?: string } = {}) {
  const bots: HireBot[] = [];
  const calls: Array<{ profileId: string; selection: HireSelection }> = [];
  const deps: HireDeps = {
    bots: () => bots,
    shape: (profileId) => SHAPES[profileId],
    importAgents: async (profileId, selection) => {
      if (opts.failOn === profileId) throw new Error("refused");
      calls.push({ profileId, selection });
      for (const key of selection.agents) bots.push({ id: `${profileId}/${key}`, installedPackage: { id: profileId }, packageImportReceipt: { agentKey: key } });
    },
  };
  return { deps, calls, bots };
}
const ask = (profileId: string, key: string) => ({ profileId: profileId as "starter-solo-business", key });

describe("D11 hire imports exactly what is missing", () => {
  it("routines travel with their owner, one package at a time", async () => {
    const { deps, calls } = fake();
    const hired = await ensureHired([ask("starter-business-team", "review-partner"), ask("starter-solo-business", "business-planner"), ask("starter-solo-business", "draft-partner")], deps);
    expect(calls.map((call) => call.profileId)).toEqual(["starter-solo-business", "starter-business-team"]);
    expect(calls[0].selection).toEqual({ agents: ["business-planner", "draft-partner"], skills: [], instructions: [], routines: ["weekly-business-review"] });
    expect(calls[1].selection.routines).toEqual([]);
    expect(hired).toHaveLength(3);
  });
});

describe("D12b and D12c resume and repeat", () => {
  it("a failure on package two then a retry imports only package two", async () => {
    const first = fake({ failOn: "starter-business-team" });
    const agents = [ask("starter-solo-business", "business-planner"), ask("starter-business-team", "review-partner")];
    await expect(ensureHired(agents, first.deps)).rejects.toThrow();
    expect(first.bots).toHaveLength(1);
    const retry: HireDeps = { ...first.deps, importAgents: async (profileId, selection) => { first.calls.push({ profileId, selection }); first.bots.push({ id: "b2", installedPackage: { id: profileId }, packageImportReceipt: { agentKey: selection.agents[0] } }); } };
    first.calls.length = 0;
    await ensureHired(agents, retry);
    expect(first.calls.map((call) => call.profileId)).toEqual(["starter-business-team"]);
  });
  it("a repeat call imports nothing and returns the same list", async () => {
    const { deps, calls } = fake();
    const agents = [ask("starter-solo-business", "draft-partner")];
    const one = await ensureHired(agents, deps);
    const two = await ensureHired(agents, deps);
    expect(calls).toHaveLength(1);
    expect(two).toEqual(one);
  });
  it("two presses at once import once", async () => {
    const { deps, calls } = fake();
    const agents = [ask("starter-solo-business", "draft-partner")];
    await Promise.all([ensureHired(agents, deps), ensureHired(agents, deps)]);
    expect(calls).toHaveLength(1);
  });
});

describe("D12d the business job after hiring", () => {
  it("imports nothing when the pair is hired, and only the missing agent plus its routines otherwise", async () => {
    const both = fake();
    await ensureHired([ask("starter-solo-business", "business-planner"), ask("starter-solo-business", "draft-partner")], both.deps);
    await ensureHired([ask("starter-solo-business", "business-planner"), ask("starter-solo-business", "draft-partner")], both.deps);
    expect(both.calls).toHaveLength(1);
    const partial = fake();
    await ensureHired([ask("starter-solo-business", "business-planner")], partial.deps);
    await ensureHired([ask("starter-solo-business", "business-planner"), ask("starter-solo-business", "draft-partner")], partial.deps);
    expect(partial.calls[1].selection).toEqual({ agents: ["draft-partner"], skills: [], instructions: [], routines: [] });
  });
});

describe("D12f refusals", () => {
  it("refuses keys outside the starter packages, writing nothing", async () => {
    const { deps, calls } = fake();
    await expect(ensureHired([ask("starter-solo-business", "nope")], deps)).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(0);
    expect(parseHireBody({ agents: [{ profileId: "starter-personal-home", key: "x" }] }).ok).toBe(false);
    expect(parseHireBody({ agents: [] }).ok).toBe(false);
    expect(parseHireBody({}).ok).toBe(false);
  });
});
