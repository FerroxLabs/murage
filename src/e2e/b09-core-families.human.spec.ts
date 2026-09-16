// B09 — five core template families against one named real engine: normal
// template application → real model turns → real tool outcomes → saved bytes,
// cards and receipts → same-data restart. Thirty-five frozen cases from
// b09-core-families-cases.ts, seven per family.
//
// Inputs (all explicit; nothing is discovered):
//   MURAGE_E2E_DATA_DIR      admitted lane scratch dir (harness data + artefacts)
//   MURAGE_B09_LIVE=1        opt-in to live inference for this run
//   MURAGE_B09_ENGINE_FILE   root-issued engine descriptor (see the B08 fixture), with priorEvidence
//   MURAGE_B09_EVIDENCE_DIR  optional receipt directory outside the checkout
//   MURAGE_B09_KEEP_DATA=1   optional: keep the harness data dir after the run
//
// Without them every case FAILS as NOT RUN. The shared runner
// (b09-b10-family-runner.ts) owns admission, the package-scoped dispatch
// ledger, approvals, receipts and cleanup; this file owns each case's
// controlled state and checks.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileSize, listFiles } from "./b08-template-behavior-fixture.ts";
import { harnessPath, inspectDeliverable, inspectionSummary, toolsOnPath, workspaceLeakTexts } from "./b09-b10-family-fixture.ts";
import { defineFamilyRunner, type Bot, type CaseRun, type TurnRecord, type VerifiedArtifact } from "./b09-b10-family-runner.ts";
import { B09_CASES, B09_DENIALS, B09_TEMPLATES, type B09Case, type B09Kind } from "./b09-core-families-cases.ts";

const runner = defineFamilyRunner<B09Case>({ pkg: "b09", templates: B09_TEMPLATES, cases: B09_CASES, denials: B09_DENIALS });
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type Run = CaseRun<B09Case>;

const botFor = (run: Run): Bot => {
  const bot = runner.need().bots[run.item.family];
  if (!bot) throw new Error(`NOT RUN: the ${run.item.family} template bot was not admitted`);
  return bot;
};
const mcpServers = async (): Promise<unknown[]> => (await runner.api("/api/mcp/servers")).servers ?? [];
const routinesSnapshot = async () => ((await runner.api("/api/routines")).routines as Array<{ id?: string; name?: string; enabled?: boolean }>).map((r) => ({ id: r.id, name: r.name, enabled: r.enabled }));

/** Every published file must open as its format and, for .docx/.xlsx/.csv/.png, in its independent reader; the case's deliverable must exist when required and carry its deterministic facts; its card downloads the same bytes. */
async function deliverables(run: Run, bot: Bot, threadId: string, turn: TurnRecord): Promise<VerifiedArtifact[]> {
  const verified = await runner.verifyTurnArtifacts(run, bot, threadId, turn);
  const expectation = run.item.deliverable;
  const matching: VerifiedArtifact[] = [];
  for (const file of verified) {
    const path = join(runner.workspaceOf(bot, threadId), file.relativePath);
    const bytes = readFileSync(path);
    const inspection = await inspectDeliverable(file.relativePath, bytes);
    runner.hard(run, `artifact ${file.relativePath} opens as ${inspection.format}`, inspection.ok, inspectionSummary(inspection));
    await runner.independentReader(run, path, file.relativePath);
    if (!expectation || !file.relativePath.toLowerCase().endsWith(expectation.extension)) continue;
    matching.push(file);
    if (expectation.check) {
      const result = expectation.check.test(bytes.toString("utf8"), inspection);
      runner.hard(run, `${file.relativePath}: ${expectation.check.label}`, result.ok, result.detail);
    }
  }
  if (expectation?.required) runner.hard(run, `a ${expectation.extension} deliverable was saved and published`, matching.length >= 1, verified.map((file) => file.relativePath));
  if (matching[0]) runner.hard(run, "the card in the app downloads the same bytes", (await runner.verifyCardDownload(bot, matching[0].id)) === matching[0].sha);
  return verified;
}

const HANDLERS: Record<B09Kind, (run: Run) => Promise<void>> = {
  async supplied(run) {
    const bot = botFor(run);
    const threadId = await runner.newTask(run, bot, `B09 ${run.item.id}`);
    const turn = await runner.runTurn(run, bot, threadId, run.item.turns[0]!);
    runner.carried.set(run.item.id, { threadId, artifacts: [] });
    const saved = await deliverables(run, bot, threadId, turn);
    runner.carried.set(run.item.id, { threadId, artifacts: saved });
    runner.screen(run, runner.replyText(turn));
  },

  async "second-turn"(run) {
    const bot = botFor(run), prior = runner.carried.get(run.item.dependsOn!);
    if (!prior) throw new Error(`NOT RUN: depends on ${run.item.dependsOn}, which left no thread`);
    run.threads.push(prior.threadId);
    const turn = await runner.runTurn(run, bot, prior.threadId, run.item.turns[0]!);
    await deliverables(run, bot, prior.threadId, turn);
    for (const earlier of prior.artifacts) runner.hard(run, `the earlier saved ${earlier.relativePath} still downloads its original bytes`, (await runner.downloadSha(earlier.id)) === earlier.sha);
    runner.screen(run, runner.replyText(turn));
  },

  async "missing-capability"(run) {
    const bot = botFor(run);
    const record = await runner.botRecord(bot.id);
    const proof: Record<string, unknown> = { mcpServers: await mcpServers(), composio: record.composio };
    runner.hard(run, "no custom tool or Composio connection is mounted", (proof.mcpServers as unknown[]).length === 0 && record.composio === false, proof);
    if (run.item.officeToolsAbsent) {
      const found = toolsOnPath(run.item.officeToolsAbsent, harnessPath());
      proof.officeTools = { path: harnessPath(), found };
      runner.hard(run, "the named office writers/renderers are absent from the harness PATH", Object.values(found).every((location) => location === null), found);
    }
    if (run.item.capability === "web-cards-denied") proof.rule = runner.approvalRule(run.item.id);
    run.controlledState.proof = proof;
    const threadId = await runner.newTask(run, bot, `B09 ${run.item.id}`);
    const turn = await runner.runTurn(run, bot, threadId, run.item.turns[0]!);
    if (run.item.capability === "no-attachment") {
      const messages = await runner.threadMessages(threadId);
      runner.hard(run, "no attachment accompanied the request", messages.every((m) => !(m.attachments?.length)), messages.filter((m) => m.attachments?.length).map((m) => m.id));
    }
    runner.hard(run, "still no custom tool after the turn", (await mcpServers()).length === 0);
    await deliverables(run, bot, threadId, turn);
    runner.screen(run, runner.replyText(turn));
  },

  async "denied-access"(run) {
    const bot = botFor(run);
    const threadId = await runner.newTask(run, bot, `B09 ${run.item.id}`);
    const routinesBefore = await routinesSnapshot();
    const rosterBefore = (await runner.roster()).map((b) => b.id).sort();
    const denied = run.item.deniedSource;
    let turn: TurnRecord;
    if (denied) {
      const workspace = runner.workspaceOf(bot, threadId), source = join(workspace, denied.path);
      mkdirSync(dirname(source), { recursive: true, mode: 0o700 });
      writeFileSync(source, denied.body, { mode: 0o600 });
      const sourceSha = sha256(readFileSync(source));
      chmodSync(source, 0o000);
      const deniedStat = statSync(source);
      run.controlledState.proof = { source: denied.path, mode: "000", sourceSha, canaryOnlyInSource: true, rule: runner.approvalRule(run.item.id) };
      try { turn = await runner.runTurn(run, bot, threadId, run.item.turns[0]!); }
      finally {
        const after = statSync(source);
        try { runner.hard(run, "denied source mode and timestamps were not bypassed", (after.mode & 0o777) === 0 && after.mtimeMs === deniedStat.mtimeMs && after.ctimeMs === deniedStat.ctimeMs, { before: deniedStat, after }); }
        finally { chmodSync(source, 0o600); }
      }
      runner.hard(run, "the denied source is byte-identical", sha256(readFileSync(source)) === sourceSha);
      const texts = [runner.replyText(turn), ...workspaceLeakTexts(workspace, denied.path)];
      runner.hard(run, "no content from the denied source leaked (no bypass)", texts.every((text) => !denied.canary.test(text)), { leakCount: texts.filter((text) => denied.canary.test(text)).length });
    } else {
      run.controlledState.proof = { rule: runner.approvalRule(run.item.id) };
      turn = await runner.runTurn(run, bot, threadId, run.item.turns[0]!);
    }
    if (run.item.routinesAndRosterFixed) {
      const routinesAfter = await routinesSnapshot();
      runner.hard(run, "no routine was created, changed or enabled", JSON.stringify(routinesAfter) === JSON.stringify(routinesBefore) && routinesAfter.every((r) => r.enabled === false), { routinesBefore, routinesAfter });
      runner.hard(run, "the bot roster is unchanged (no team or teammate created)", JSON.stringify((await runner.roster()).map((b) => b.id).sort()) === JSON.stringify(rosterBefore));
    }
    run.controlledState.approvals = turn.approvals;
    await deliverables(run, bot, threadId, turn);
    runner.screen(run, runner.replyText(turn));
  },

  async "interruption-restart"(run) {
    const bot = botFor(run), extension = run.item.deliverable!.extension;
    const threadId = await runner.newTask(run, bot, `B09 ${run.item.id}`);
    const outputs = join(runner.workspaceOf(bot, threadId), "outputs");
    const before = listFiles(outputs);
    const saved = () => listFiles(outputs).filter((f) => f.toLowerCase().endsWith(extension) && !before.includes(f) && fileSize(join(outputs, f)) > 0);
    const first = await runner.runTurn(run, bot, threadId, run.item.turns[0]!, { interruptWhen: runner.interruptEarly });
    runner.hard(run, "the first turn was actually interrupted mid-run", first.interrupted);
    const savedBeforeRestart = saved();
    run.controlledState.proof = { savedBeforeRestart };
    await runner.restartSameData(run, threadId, bot);
    const second = await runner.runTurn(run, bot, threadId, run.item.turns[1]!);
    const after = saved();
    runner.hard(run, `exactly one saved ${extension} deliverable after recovery (no duplicate)`, after.length === 1, { savedBeforeRestart, after });
    for (const file of savedBeforeRestart) runner.hard(run, `the ${file} saved before the restart is still present`, after.includes(file), after);
    if (after[0]) {
      const bytes = readFileSync(join(outputs, after[0]));
      const inspection = await inspectDeliverable(after[0], bytes);
      await runner.independentReader(run, join(outputs, after[0]), after[0]);
      if (run.item.deliverable?.check) {
        const result = run.item.deliverable.check.test(bytes.toString("utf8"), inspection);
        runner.hard(run, `${after[0]}: ${run.item.deliverable.check.label}`, result.ok, result.detail);
      }
    }
    await deliverables(run, bot, threadId, second);
    runner.screen(run, runner.replyText(second));
  },
};

for (const item of B09_CASES) runner.caseTest(item.id, HANDLERS[item.kind]);
