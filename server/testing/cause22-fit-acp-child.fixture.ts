// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.21 group B witness child (server/drivers/acp/cause22-fit-acp-1021.test.ts; owner lane cause22-eng). Runs ONE real ACP turn
// through the real driver (core.createAcpDriver, adapter.sendTurn) against the scripted fake engine behind the pad rig, with the
// real outside hooks' mark recorded, and reports the outcome to the test over IPC. A throw in the stdout listener kills this process
// before it reports, which the test reads as "no result" (cause22-eng-design3-fable BASE-RED RULE). It decides nothing itself.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureDirs } from "../config.ts";
import type { ProviderDriver, RuntimeEvent } from "../contracts.ts";
import { recordEvents } from "./events.ts";
import * as core from "../drivers/acp/core.ts";

const report = (value: Record<string, unknown>) => new Promise<void>((done) => { if (process.send) process.send({ type: "fixture-report", ...value }, () => done()); else done(); });
const plan = JSON.parse(process.env.CAUSE22_FIT_PLAN ?? "{}") as { script: unknown[]; second?: boolean };
const rig = fileURLToPath(new URL("./cause22-fit-pad.fixture.mjs", import.meta.url));
const fake = fileURLToPath(new URL("./fake-acp-cli.ts", import.meta.url));

async function main() {
  // the vitest setup's host-power switch for spawned test engines (testing/setup.ts); the environment is inherited from the test
  (globalThis as Record<symbol, unknown>)[Symbol.for("murage.hostPower.testUnwrapped")] = true;
  ensureDirs();
  const home = process.env.CAUSE22_FIT_HOME ?? mkdtempSync(join(tmpdir(), "murage-fit-"));
  const scriptLog = join(home, "script.log");
  writeFileSync(scriptLog, "");
  const marks: string[] = [];
  core.setAcpOutsideHooks({ judge: () => {}, mark: (_threadId: string, source: string, site?: string) => { marks.push(`${source}:${site ?? ""}`); }, marked: () => marks.length > 0 });
  const support: core.AcpSupport = {
    driverKind: "acpFitTest", displayName: "Fit Test", models: { default: "m-one", options: [{ id: "m-one", label: "One" }] },
    defaultCli: "fake-fit", nativeSource: "fit.acp", loginNote: "never reached", spawnArgs: () => [], pickAuthMethod: () => null,
    authFailure: "continue", isAuthenticated: () => true, fluxReach: () => "elsewhere" as const,
  };
  const driver = core.createAcpDriver(support) as unknown as ProviderDriver<core.AcpConfig>;
  const instance = await driver.create({ instanceId: "acp-fit", displayName: "Fit Test", enabled: true,
    config: driver.decodeConfig({ cli: rig, fullAuto: true }),
    environment: { HOME: home, USERPROFILE: home, FAKE_ACP_MODE: "fuigo-script", FAKE_ACP_SCRIPT: JSON.stringify(plan.script),
      FAKE_ACP_SCRIPT_LOG: scriptLog, FAKE_ACP_MCP_READY: "1", CAUSE22_REAL_CLI: fake, CAUSE22_PAD_UNITS: process.env.CAUSE22_PAD_UNITS ?? "0", CAUSE22_PADH_UNITS: process.env.CAUSE22_PADH_UNITS ?? "0" } });
  const recorder = recordEvents(instance.adapter);
  const turns: Array<Record<string, unknown>> = [];
  for (const threadId of plan.second ? ["fit-1", "fit-1"] : ["fit-1"]) {
    const before = recorder.events.length;
    await instance.adapter.sendTurn({ threadId, text: "hello", cwd: home });
    const done = await recorder.until((e) => e.threadId === threadId && e.type === "turn.completed" && recorder!.events.indexOf(e) >= before, 240_000) as RuntimeEvent & { ok: boolean };
    const events = (recorder.events as unknown as Array<Record<string, unknown>>).slice(before);
    const texts = events.filter((e) => e.type === "item.completed" && e.itemType === "assistant_text").map((e) => String(e.text ?? ""));
    const reply = texts.join("");
    turns.push({ ok: done.ok, replyLength: reply.length, replyHead: reply.slice(0, 32), replyHasMarker: / …\[cut \d+ units\]/.test(reply), replyTextCut: reply.endsWith("…[cut: this reply passed the text limit (over 448 MiB)]"),
      replyStartsWithMiB: reply.includes("x".repeat(1024 * 1024)),
      errors: events.filter((e) => e.type === "runtime.error").map((e) => String(e.message).slice(0, 200)),
      notices: events.filter((e) => JSON.stringify(e).length < 4096 && JSON.stringify(e).includes("too large to hold")).length });
  }
  await report({ turns, marks, scriptLog: readFileSync(scriptLog, "utf8").slice(0, 20_000), home });
  recorder.stop();
  await instance.dispose();
  process.exit(0);
}
main().catch(async (error) => { await report({ failed: String(error?.stack ?? error).slice(0, 2000) }); process.exit(1); });
