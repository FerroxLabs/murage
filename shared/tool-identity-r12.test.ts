import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as identity from "./tool-identity.ts";
import * as tripwire from "../server/drivers/acp/tool-tripwire.ts";
import { HERMES_ASK_FREE_TOOLS } from "../server/drivers/acp/hermes.ts";

const fixture = (name: string) => readFileSync(new URL(`../server/testing/fixtures/tool-identity-r1.2/${name}`, import.meta.url));
const traces = fixture("hermes_traces.jsonl").toString().trim().split("\n").map(line => JSON.parse(line));
const reference = spawnSync("python3", ["-I", "-B", fileURLToPath(new URL("../server/testing/fixtures/tool-identity-r1.2/reference.py", import.meta.url))], { encoding: "utf8" });
// An unavailable oracle fails an assertion, never silently skips parity.
const outcomes = new Map<string, any>(reference.status === 0 ? reference.stdout.trim().split("\n").map(line => { const row = JSON.parse(line); return [row.id, row.outcome]; }) : []);
const port = identity as unknown as Record<string, (...args: any[]) => any>;
const runner = tripwire as unknown as { runHermesTrace: (trace: any) => any };
describe("r1.2 reference fixtures", () => {
  it("loads byte-identical JSONL and TSV (SHA-256)", () => {
    expect(createHash("sha256").update(fixture("hermes_traces.jsonl")).digest("hex")).toBe("b1c99df61d4943a0d1bad58bff648d908dfe95dc2e5882dff237eaa8337d0625");
    expect(createHash("sha256").update(fixture("judge_expected.tsv")).digest("hex")).toBe("bca5ba97c9d70a49ea7c8d274969b8ec17d79f87b274383c0870c9e405097134");
    expect(traces).toHaveLength(104);
    expect(createHash("sha256").update(fixture("hermes_fsm.py")).digest("hex")).toBe("fbcd5429849e40ba096585e354938dcbed8be10a418ed3c0207bf3c47f0b5f41");
    expect(reference.status, reference.stderr).toBe(0);
    expect(outcomes.size).toBe(104);
  });
  it("C1 has exactly the seven non-default pinned kinds", () => {
    expect(HERMES_ASK_FREE_TOOLS).toEqual(["read_file", "search_files", "skills_list", "skill_view", "vision_analyze", "web_search", "web_extract"]);
  });
  it("canonical matches Python code-point ordering", () => {
    expect(identity.canonicalJson({ "\ue000": 1, "😀": 2 })).toBe('{"":1,"😀":2}');
  });
  it("classify_ask rejects extra raw keys and accepts empty terminal input", () => {
    expect(port.classifyAsk).toBeTypeOf("function");
    const rawInput = {command: "<terminal> (plugin approval rule)", description: JSON.stringify({murage: 1,v:1,tool:"terminal",truncated:false,input:{}})};
    expect(port.classifyAsk!({rawInput}, "0.22.2")).toEqual({type:"hook",key:"hermes/hermes/terminal",name:"terminal",input:{}});
    expect(port.classifyAsk!({rawInput:{...rawInput,extra:true}}, "0.22.2")).toEqual({type:"unproven"});
  });
});
describe("r1.2 trace parity (including I*, U-*, BIND-*)", () => {
  for (const trace of traces.filter(t => t.engine !== "codex")) {
    it(trace.id, () => {
      expect(runner.runHermesTrace).toBeTypeOf("function");
      const actual = runner.runHermesTrace(trace);
      for (const field of ["result", "trip_at", "sent", "overlay", "performed"]) expect(actual[field], field).toEqual(outcomes.get(trace.id)?.[field]);
      expect(actual.result).toBe(trace.expect.result);
      if ("trip_at" in trace.expect) expect(actual.trip_at).toBe(trace.expect.trip_at);
      if (trace.expect.sent) expect(actual.sent).toMatchObject(trace.expect.sent);
      if (trace.category === "must-accept") {
        expect(actual.performed).toEqual(trace.expect.performs);
        expect(actual.unperformed).toEqual([]);
      }
    });
  }
});

describe("r1.2 Codex same-id pairing", () => {
  for (const trace of traces.filter(t => t.engine === "codex")) it(trace.id, () => {
    const hooks = new Map<string, any>(trace.hooks.map((h: any) => [h.tool_use_id, h]));
    const ctx = { mounts: trace.ctx.mounts.map((name: string) => ({ engineName: name, mountId: `custom:${name}`, provenance: "custom" as const })) };
    const bad = trace.items.filter((item: any) => {
      const h = hooks.get(item.id);
      const hook = identity.toolIdentity("codex", h ?? {}, ctx);
      const action = identity.toolIdentity("codex", item, { ...ctx, codexHook: h });
      return !hook.proven || !action.proven || hook.key !== action.key;
    }).map((item: any) => item.id);
    expect({result: bad.length ? "reject" : "accept", bad}).toEqual(outcomes.get(trace.id));
    expect(bad.length ? "reject" : "accept").toBe(trace.expect.result);
  });
});
