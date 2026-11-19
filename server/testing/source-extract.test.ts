// Owner: sc-safety fixture contract; product owners retain index authority.
import { afterEach, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDirSync } from "./cleanup.ts";
const extractor = existsSync(new URL("./source-extract.ts", import.meta.url)) ? await import("./source-extract.ts") : undefined;
const extractFunction: typeof import("./source-extract.ts").extractFunction = (...args) => {
  expect(extractor?.extractFunction, "the source extraction contract must exist before fixture construction").toBeTypeOf("function");
  return extractor!.extractFunction(...args);
};
const portsApi = existsSync(new URL("./index-ports.ts", import.meta.url)) ? await import("./index-ports.ts") : undefined;
const freshIndexPorts = () => { expect(portsApi?.freshIndexPorts).toBeTypeOf("function"); return portsApi!.freshIndexPorts(); };
const storeFixtureApi = existsSync(new URL("./execution-store-fixture.ts", import.meta.url)) ? await import("./execution-store-fixture.ts") : undefined;
const executionStoreFixture = () => { expect(storeFixtureApi?.executionStoreFixture).toBeTypeOf("function"); return storeFixtureApi!.executionStoreFixture(); };
import { setExecutionStore } from "../execution-audience.ts";
import * as executionAudience from "../execution-audience.ts";
const EXECUTION_STORE_KEYS = executionAudience.EXECUTION_STORE_KEYS ?? [];
import { redactSecretsInText } from "../redact.ts";
const file = new URL("../index.ts", import.meta.url);
const dirs: string[] = [];
afterEach(() => { setExecutionStore(undefined); dirs.splice(0).forEach(dir => removeTempDirSync(dir)); });
it("H-SCOPE-1 T-SCOPE-COMPLETE internal dispatch resolves every free name", async () => {
  const unit = extractFunction({ file, text: `import { ownToolGate } from "./outside-own.ts";
    const internalTurnOwners = new Map();
    function issueDecisionAuthority() { return internalTurnOwners; }
    function selected() { return { authority: issueDecisionAuthority(), owners: internalTurnOwners, gate: ownToolGate }; }`, select: "selected" });
  const result = await unit.preflight({}, { ports: freshIndexPorts() });
  expect(result.value().authority).toBe(result.value().owners);
  expect(unit.free.get("issueDecisionAuthority")?.step).toBe("declaration");
  expect(unit.free.get("internalTurnOwners")?.step).toBe("state");
  expect(unit.free.get("ownToolGate")?.step).toBe("import");
  expect(result.value().gate).toBe((await import("../outside-own.ts")).ownToolGate);
});
it("H-SCOPE-2 a new import binds to the real module", async () => {
  const unit = extractFunction({ file, text: 'import { redactSecretsInText as zz } from "./redact.ts"; function selected() { return zz; }', select: "selected" });
  const result = await unit.preflight();
  expect(result.value()).toBe(redactSecretsInText);
  expect(unit.free.get("zz")?.step).toBe("import");
});
it("H-SCOPE-3 new module-level state fails before the case body", async () => {
  const body = vi.fn();
  const unit = extractFunction({ file, text: 'const zzState = new Map();\nfunction selected() { body(); return zzState; }', select: "selected" });
  let failure: unknown;
  try { await unit.preflight({ body }); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).toMatch(/FIXTURE_SCOPE_UNRESOLVED zzState:1.*2 state port/);
  expect(body).not.toHaveBeenCalled();
});
it("H-SCOPE-4 an authority override is refused", async () => {
  // MAIN RULING 1114-SC-SAFETY-HSCOPE4: legacy options cannot replace authority.
  const body=vi.fn(),forged=vi.fn(()=>{throw new Error("refused");});
  const unit=extractFunction({file,text:'function issueDecisionAuthority() { return "real"; }\nfunction selected() { return issueDecisionAuthority(); }',select:"selected"});
  const scope={issueDecisionAuthority:forged};
  const run=async(options?:Parameters<typeof unit.preflight>[1])=>{const bound=await unit.preflight(scope,options);body();return bound.value();};
  await expect(run()).rejects.toThrow(/FIXTURE_OVERRIDE_REFUSED.*issueDecisionAuthority.*index\.ts:1.*declaration=issueDecisionAuthority@0/);
  // Unknown runtime input deliberately models an old caller without adding it to BindOptions.
  const legacy=JSON.parse('{"negativeOverrides":{"issueDecisionAuthority":{"reason":"Assert fail-closed refusal","assertsRefusal":true}}}');
  await expect(run(legacy)).rejects.toThrow(/FIXTURE_OVERRIDE_REFUSED.*issueDecisionAuthority.*index\.ts:1.*declaration=issueDecisionAuthority@0/);
  expect(forged).not.toHaveBeenCalled();
  expect(body).not.toHaveBeenCalled();
  const control=await unit.preflight({});
  expect(control.value()).toBe("real");
});

it("H-SCOPE-5 an import with side effects cannot resolve silently", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fixture-extract-")); dirs.push(dir);
  const module = join(dir, "side-effect.mjs");
  writeFileSync(module, 'import net from "node:net"; net.createServer().listen(0,"127.0.0.1"); export const value = 1;');
  const unit = extractFunction({ file, text: `import { value } from ${JSON.stringify(module)}; function selected() { return value; }`, select: "selected" });
  await expect(unit.preflight()).rejects.toThrow("FIXTURE_IMPORT_SIDE_EFFECT");
});
it("H-STORE-1 the execution store fixture is complete", () => {
  expect(Object.keys(executionStoreFixture()).sort()).toEqual([...EXECUTION_STORE_KEYS].sort());
});
it("H-CLAUDE-1 claude mount configuration extracts every declaration it needs", async () => {
  expect(extractor?.extractFunction, "the shared Claude extraction contract must exist").toBeTypeOf("function");
  const { claudeMountConfiguration } = await import("./claude-mount-configuration.ts");
  const result = claudeMountConfiguration({ threadId: "fixture", text: "fixture", cwd: tmpdir(), integrations: { agents: { command: "fixture", args: [], env: {} } } } as never);
  expect(result.argv).toContain("--disallowedTools");
  expect(result.argv.join(" ")).toContain("ListAgents");
});

it("a destructured local never becomes a fixture dependency", async () => {
  const unit = extractFunction({ file, text: `function selected({ botId, files }: { botId: string, files: string[] }) {
    const { id, files: renamedFiles, ...rest } = { id: botId, files, extra: true };
    return files.map((held, depth) => ({ id, held, depth, baseSha256: renamedFiles.length }));
  }`, select: "selected" });
  const result = await unit.preflight();
  expect(result.value({ botId: "fixture", files: ["fixture"] })).toEqual([{ id: "fixture", held: "fixture", depth: 0, baseSha256: 1 }]);
  expect([...unit.free]).toEqual([]);
});

it("cached extraction code retains independent fixture state and captured scopes", async () => {
  const text='const owners = new Map(); function selected(value) { if(value !== undefined) owners.set("row",value); return owners; }';
  const unit=extractFunction({file,text,select:"selected"});
  const ports=[{name:"owners",fresh:()=>new Map(),reason:"Independent test registry; values enter only through the extracted writer."}];
  const first=await unit.preflight({}, {ports});
  const second=await unit.preflight({}, {ports});
  expect(first.value("first").get("row")).toBe("first");
  expect(second.value().size).toBe(0);
  expect(second.value("second").get("row")).toBe("second");
  expect(first.value().get("row")).toBe("first");
});
