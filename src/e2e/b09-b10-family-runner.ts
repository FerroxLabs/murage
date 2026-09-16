// Live runner for B09 (five core template families) and B10 (specialist
// anchors): the B08 runner's mechanics, parameterised by package so both reuse
// one set of admission, isolation and evidence primitives.
//
// One named real engine is admitted from a root-owned descriptor; its dispatch
// ledger is package-scoped and lives beside that descriptor. One owned isolated
// harness runs the product. A solo template is applied through the normal
// reviewed assistant-profile route to its own bot; a room package is imported
// through the normal team import route as a real room of members, each pinned
// to the admitted engine. Turns are real model turns (a room turn dispatches
// once per @mentioned member). The runner denies only the cards a case's
// controlled state names and otherwise waits for the owner's one-time decision;
// it never grants. Artifacts are checked as saved bytes, registrations, card
// downloads and restarts. Without live inputs every case fails as NOT RUN.
// Nothing is scripted.
import { chromium, test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { openSidebar } from "./fixtures.ts";
import { laneDataDir } from "./lane-data-dir";
import {
  admitEngineDescriptor, assertRealEngineIdentity, boundedClose, caseFileName, caseStatus, claimEngineDispatch, denialVerdictHint, dispatchHeadroom,
  dispatchLedgerPath, endedByEngineAfterDenial, evaluateRubric, exportNativeLogs, inside, nativeStops, publicDescriptor, readCredential, retainArtifact,
  runEvidenceDir, startIsolatedHarness, taskIdentityProblems, unexecutedStatus, writeReceipt,
  type B08EngineDescriptor, type B08Harness, type B08Rubric, type DescribedInstance, type EngineStop,
} from "./b08-template-behavior-fixture.ts";
import {
  familyApprovalPolicy, familyApprovalRule, familyCaseDispatches, familyEnv, familyInputGaps,
  type ControlledDenial, type FamilyCase, type FamilyPackage, type FamilyRoom, type FamilyTemplate,
} from "./b09-b10-family-fixture.ts";
import {
  READER_GATES_NOT_ESTABLISHED, csvReaderAgreement, docxReaderAgreement, pngReaderAgreement, xlsxReaderAgreement,
  type CsvReaderAgreement, type DocxReaderAgreement, type PngReaderAgreement, type XlsxReaderAgreement,
} from "./b09-b10-deliverable-readers.ts";

export interface Bot { id: string; name: string; threadId: string }
export interface LiveRoom { key: string; id: string; name: string; members: Record<string, Bot>; bulletin: string; defaultResponderKind: string }
export interface Msg { id: string; role?: string; kind?: string; text?: string; turnId?: string; artifactIds?: string[]; attachments?: unknown[]; from?: { botId?: string; name?: string }; tool?: { name?: string; ok?: boolean }; card?: { requestId?: string; tool?: string; title?: string; subtitle?: string; answered?: string; expired?: boolean; dismissed?: boolean; intake?: unknown; questions?: unknown[] } }
interface Ask { requestId: string; tool?: string; title?: string; subtitle?: string; behavior: "allow" | "deny" | "skip"; status?: number; outcome?: string; by?: string }
export interface TurnRecord {
  text: string; threadId: string; surface: "desktop" | "companion"; target: "bot" | "room"; responders: string[]; sendStatus: number; startedAt: number; endedAt: number; interrupted: boolean;
  replies: Array<{ id: string; turnId?: string; from?: string; text: string }>; activity: Array<{ name?: string; ok?: boolean; from?: string }>;
  approvals: Ask[]; questions: Ask[]; artifactMessages: Array<{ id: string; text?: string; artifactIds: string[] }>; newMessageIds: string[];
  endedAfterDenial: boolean; engineStops: EngineStop[]; awaitingOwner: string[]; ownerCardsExpired: string[];
}
export interface CaseRun<C extends FamilyCase = FamilyCase> {
  item: C; threads: string[]; turns: TurnRecord[]; dispatches: number; controlledState: Record<string, unknown>;
  hard: Array<{ check: string; ok: boolean; detail?: unknown }>; rubric?: ReturnType<typeof evaluateRubric>; fileRubric?: ReturnType<typeof evaluateRubric>; status: string; startedAt: number;
}
export interface VerifiedArtifact { id: string; relativePath: string; sha: string; botId: string }
interface Live { harness: B08Harness; descriptor: B08EngineDescriptor; ledger: string; bots: Record<string, Bot>; rooms: Record<string, LiveRoom>; chief: Bot; vite: ViteDevServer; origin: string; dispatches: number; restarts: number; usedThreads: Set<string> }
export interface TurnOptions { interruptWhen?: (state: { fresh: Msg[]; elapsed: number }) => boolean | Promise<boolean>; timeoutMs?: number }
type TurnTarget = { kind: "bot"; bot: Bot } | { kind: "room"; room: LiveRoom; responders: Bot[] };

export interface FamilyRunnerOptions<C extends FamilyCase> {
  pkg: FamilyPackage;
  templates: Record<string, FamilyTemplate>;
  /** Room packages imported through the team import route (B10 Back-Office Crew). */
  rooms?: Record<string, FamilyRoom>;
  cases: readonly C[];
  denials: Partial<Record<string, ControlledDenial>>;
  /** Package admission, once per admitted worker in live mode: after the live inputs, descriptor and dispatch ledger are admitted and before any
   * credential is read or the harness starts (B10: qualifyGeneratedCodeSandbox). A throw refuses the whole run as NOT RUN, with no harness and no
   * dispatch. Its result is recorded in the admission receipt. */
  admit?: () => Promise<Record<string, unknown>>;
}

const MEMORY_REVOKED = "error: MEMORY_CONTEXT_REVOKED";
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Mirrors the room router: `@` starts a word, the full name matches case-insensitively and does not run into a longer word. */
export const mentions = (text: string, name: string) => new RegExp(`(^|\\s)@${escapeRegExp(name)}(?![a-z0-9])`, "i").test(text);
const isRoom = (target: Bot | LiveRoom): target is LiveRoom => "members" in target;

type ReaderAgreement = DocxReaderAgreement | XlsxReaderAgreement | CsvReaderAgreement | PngReaderAgreement;
/** The independent reader for a saved file's extension (b09-b10-deliverable-readers.ts); other extensions have none. */
const READERS: Record<string, { reader: ReaderAgreement["reader"]; read: (file: string, workDir: string) => Promise<ReaderAgreement> }> = {
  ".docx": { reader: "textutil", read: docxReaderAgreement },
  ".xlsx": { reader: "qlmanage+sips", read: xlsxReaderAgreement },
  ".csv": { reader: "qlmanage", read: csvReaderAgreement },
  ".png": { reader: "sips", read: pngReaderAgreement },
};
/** A receipt view of a reader agreement: its problems and run receipts plus what qualifies the reading (unrendered booleans, uncached formulas, the formula-calculation gate, bounded rows and text), then every reader gate that stays NOT ESTABLISHED (number formats, boolean rendering, layout, multi-sheet, PPTX and the rest), so a case receipt shows what this check does not prove. */
function readerDetail(agreement: ReaderAgreement): Record<string, unknown> {
  const base = { reader: agreement.reader, problems: agreement.problems };
  const gates = { notEstablished: READER_GATES_NOT_ESTABLISHED };
  if (agreement.format === "xlsx") return { ...base, unrenderedBooleans: agreement.unrenderedBooleans, uncachedFormulas: agreement.uncachedFormulas, formulaCalculation: agreement.formulaCalculation, thumbnail: agreement.thumbnail, renderedRows: agreement.renderedRows.slice(0, 40), runs: agreement.runs, ...gates };
  if (agreement.format === "csv") return { ...base, parsedRows: agreement.parsedRows.slice(0, 40), renderedRows: agreement.renderedRows.slice(0, 40), runs: agreement.runs, ...gates };
  if (agreement.format === "docx") return { ...base, readerText: agreement.readerText.slice(0, 2_000), packageText: agreement.packageText.slice(0, 2_000), runs: agreement.runs, ...gates };
  return { ...base, header: agreement.header, image: agreement.image, runs: agreement.runs, ...gates };
}

export function defineFamilyRunner<C extends FamilyCase>(options: FamilyRunnerOptions<C>) {
  const ENV = familyEnv(options.pkg);
  const LABEL = options.pkg.toUpperCase();
  const ROOT = fileURLToPath(new URL("../../", import.meta.url));
  /** Engine dispatches the whole suite needs; the ledger's per-allocation headroom unit. */
  const suiteTurns = options.cases.reduce((total, item) => total + familyCaseDispatches(item), 0);
  let evidence = "";
  let notRun: string[] = [`${LABEL} admission has not run`];
  let live: Live | undefined;
  const outcomes = new Map<string, string>();
  /** Thread and saved artifacts a later case continues. */
  const carried = new Map<string, { threadId: string; artifacts: VerifiedArtifact[] }>();
  // One original never-dispatched second turn; no resume of a consumed turn.
  const carryFile = process.env.MURAGE_B09_CARRY_FILE;
  let carry: any;
  function admitCarry(descriptor: B08EngineDescriptor, ledger: string) {
    if (!carryFile) return;
    const base = dirname(realpathSync(process.env[ENV.engineFile]!));
    if (options.pkg !== "b09" || !inside(realpathSync(carryFile), base)) throw new Error("unadmitted B09 carry file");
    const c = JSON.parse(readFileSync(carryFile, "utf8"));
    const row = options.cases.find(item => item.id === c.caseId);
    const start = Date.parse(c.approvedAt), end = Date.parse(c.deadline);
    if (c.version !== 1 || c.rootApproved !== true || !(start <= Date.now() && Date.now() < end && end - start <= 30 * 60_000)) throw new Error("B09 carry not admitted in bounded window");
    if (!row || !["explainer/second-turn", "excel-creator/second-turn"].includes(row.id) || row.dependsOn !== c.priorCaseId || row.turns.length !== 1) throw new Error("not original second turn");
    if (!inside(realpathSync(c.retainedRoot), base) || dirname(realpathSync(c.dataDir)) !== realpathSync(c.retainedRoot) || !inside(realpathSync(c.rootMarker), c.retainedRoot)) throw new Error("carry root mismatch");
    if (ledger !== c.ledger || c.maximumClaims !== descriptor.maxDispatches) throw new Error("carry ledger mismatch");
    for (const [path, digest] of [[c.rootMarker, c.rootMarkerSha256], [c.rootRecord, c.rootRecordSha256], [c.priorReceipt, c.priorReceiptSha256], [c.unstartedReceipt, c.unstartedReceiptSha256], [c.priorAdmission, c.priorAdmissionSha256], [c.ledgerSnapshot, c.ledgerSnapshotSha256]]) {
      if (!inside(realpathSync(path), base) || sha256(readFileSync(path)) !== digest) throw new Error("carry evidence changed");
    }
    const budget = JSON.parse(readFileSync(ledger, "utf8")), before = JSON.parse(readFileSync(c.ledgerSnapshot, "utf8"));
    if (budget.used < before.used || budget.used >= budget.max || budget.max !== descriptor.maxDispatches || JSON.stringify({ ...budget, used: before.used }) !== JSON.stringify(before)) throw new Error("carry allocation changed");
    const previous = JSON.parse(readFileSync(c.priorAdmission, "utf8"));
    if (previous.harness.dataDir !== c.dataDir || previous.engine.instanceId !== descriptor.instanceId || previous.engine.model !== descriptor.model || previous.engine.account !== descriptor.account || previous.engine.config.cli !== descriptor.config.cli) throw new Error("carry prior engine binding changed");
    if (sha256(readFileSync(String(descriptor.config.cli))) !== c.binarySha256) throw new Error("carry native binary changed");
    if (sha256(readFileSync(join(ROOT, "src/e2e/b09-core-families-cases.ts"))) !== c.caseSourceSha256) throw new Error("original carry prompts changed");
    const original = JSON.parse(readFileSync(c.priorReceipt, "utf8")), unstarted = JSON.parse(readFileSync(c.unstartedReceipt, "utf8"));
    if (original.case.id !== c.priorCaseId || original.dispatches !== 1 || !original.threads.includes(c.threadId)) throw new Error("prior case not established");
    if (unstarted.case.id !== c.caseId || unstarted.dispatches !== 0 || unstarted.turns.length !== 0 || !unstarted.status.startsWith("NOT RUN:")) throw new Error("carry turn was already attempted");
    if (!inside(resolve(c.claimMarker), dirname(realpathSync(carryFile))) || existsSync(c.claimMarker)) throw new Error("carry already attempted");
    const records = JSON.parse(readFileSync(join(c.dataDir, "bots.json"), "utf8"));
    const bot = records.find((b: any) => b.id === c.botId), task = bot?.tasks?.find((t: any) => t.threadId === c.threadId);
    if (previous.bots[row.family]?.id !== c.botId || taskIdentityProblems(task, descriptor, false).length) throw new Error("saved carry task pin changed");
    const priorArtifacts = original.hardChecks.filter((h: any) => h.check.endsWith("retained for assessment")).map((h: any) => h.detail);
    const ids = [...new Set(original.turns.flatMap((t: any) => t.artifactMessages.flatMap((m: any) => m.artifactIds)))].sort();
    if (JSON.stringify(priorArtifacts.map((a: any) => a.id).sort()) !== JSON.stringify(ids) || JSON.stringify(c.artifacts) !== JSON.stringify(priorArtifacts.map((a: any) => ({ id: a.id, relativePath: a.relativePath, sha: a.sha, botId: a.botId, evidencePath: a.evidencePath })))) throw new Error("carry artifacts missing or changed");
    for (const a of c.artifacts) {
      const path = realpathSync(join(c.dataDir, "workspaces", c.botId, "threads", c.threadId, a.relativePath));
      if (a.botId !== c.botId || !inside(path, join(c.dataDir, "workspaces", c.botId, "threads", c.threadId, "outputs")) || sha256(readFileSync(path)) !== a.sha || !inside(realpathSync(a.evidencePath), base) || sha256(readFileSync(a.evidencePath)) !== a.sha) throw new Error("carry artifact bytes changed");
    }
    const db = new DatabaseSync(join(c.dataDir, "messages.db"), { readOnly: true });
    try {
      const ids = db.prepare("SELECT id FROM messages WHERE thread_id=? ORDER BY at,id").all(c.threadId).map(row => row.id);
      if (JSON.stringify(ids) !== JSON.stringify(c.messageIds)) throw new Error("saved carry transcript changed");
    } finally { db.close(); }
    carry = c;
  }
  async function restoreCarryArtifacts() {
    const restored: VerifiedArtifact[] = [];
    for (const prior of carry.artifacts) {
      const served = await artifact(prior.id);
      if (served.id !== prior.id || served.botId !== carry.botId || served.threadId !== carry.threadId || served.relativePath !== prior.relativePath || served.sha256 !== prior.sha || await downloadSha(prior.id) !== prior.sha) throw new Error("served carry artifact differs");
      restored.push({ id: prior.id, relativePath: prior.relativePath, sha: prior.sha, botId: prior.botId });
    }
    carried.set(carry.priorCaseId, { threadId: carry.threadId, artifacts: restored });
  }


  // ── Harness access ──────────────────────────────────────────────────────

  function need(): Live { if (!live) throw new Error(`NOT RUN: ${notRun.join("; ")}`); return live; }
  async function call(path: string, method = "GET", body?: unknown) {
    const h = need().harness;
    return fetch(h.url + path, { method, headers: { ...h.headers(), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000) });
  }
  async function api(path: string, method = "GET", body?: unknown): Promise<any> {
    const response = await call(path, method, body);
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${text.slice(0, 400)}`);
    return text ? JSON.parse(text) : {};
  }
  const workspace = async (): Promise<{ bots: any[]; groups: any[] }> => { const data = await api("/api/bots?messages=0"); return { bots: data.bots ?? [], groups: data.groups ?? [] }; };
  const roster = async (): Promise<any[]> => (await workspace()).bots;
  const botRecord = async (id: string) => (await roster()).find((bot) => bot.id === id);
  const groupRecord = async (id: string) => (await workspace()).groups.find((group) => group.id === id);
  const threadMessages = async (threadId: string): Promise<Msg[]> => (await api(`/api/threads/${threadId}/messages?limit=500`)).messages;
  const diskBots = (): any[] => JSON.parse(readFileSync(join(need().harness.dataDir, "bots.json"), "utf8"));
  /** A bot's managed task workspace; room member turns run in the member's own one for the room thread. */
  const workspaceOf = (bot: Bot, threadId: string) => join(need().harness.dataDir, "workspaces", bot.id, "threads", threadId);
  const openIntake = (messages: Msg[]) => [...messages].reverse().find((m) => m.kind === "options" && !m.card?.answered && m.card?.intake);
  function taskBusy(record: any, threadId: string): boolean {
    const task = (record?.tasks ?? []).find((item: any) => item.threadId === threadId);
    return Boolean(task ? task.busy : record?.threadId === threadId && record?.busy);
  }
  function outputReceipts(threadId: string) {
    const db = new DatabaseSync(join(need().harness.dataDir, "messages.db"), { readOnly: true });
    try { return db.prepare("SELECT id, producer, run_id, path_token, sha256, stage, artifact_id, message_id, error_category FROM output_publications WHERE thread_id=? ORDER BY created_at, id").all(threadId) as Array<Record<string, string | null>>; }
    finally { db.close(); }
  }
  function claimDispatch(): number {
    const state = need();
    return claimEngineDispatch(state.ledger, state.descriptor, suiteTurns);
  }
  function recordOwnerOutcome(requestId: string, observed: Record<string, unknown>) {
    const path = join(evidence, "pending-approvals", `${encodeURIComponent(requestId)}.json`);
    const prior = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    writeReceipt(path, { ...prior, observed: { ...observed, at: new Date().toISOString() } });
  }
  async function memberProblems(bots: readonly Bot[]): Promise<Array<{ bot: string; problem: string }>> {
    const state = need(), records = await roster();
    return bots.flatMap((bot) => {
      const record = records.find((item) => item.id === bot.id);
      const problems: string[] = [];
      if (record?.modelSelection?.instanceId !== state.descriptor.instanceId || record?.modelSelection?.model !== state.descriptor.model) problems.push("model selection differs from the admitted engine/model");
      if (record?.autoApprove === true || (record?.alwaysAllow ?? []).length > 0) problems.push("Auto or remembered grants");
      return problems.map((problem) => ({ bot: bot.name, problem }));
    });
  }

  // ── Turns ───────────────────────────────────────────────────────────────

  async function newTask(run: CaseRun<C>, bot: Bot, title: string): Promise<string> {
    const created = await api(`/api/bots/${bot.id}/tasks`, "POST", { title });
    const threadId = created.task.threadId as string;
    run.threads.push(threadId);
    need().usedThreads.add(threadId);
    return threadId;
  }
  async function newRoomTask(run: CaseRun<C>, room: LiveRoom, title: string): Promise<string> {
    const created = await api(`/api/groups/${room.id}/tasks`, "POST", { title });
    const threadId = created.task.threadId as string;
    run.threads.push(threadId);
    need().usedThreads.add(threadId);
    return threadId;
  }
  async function ensureActive(bot: Bot, threadId: string) {
    const record = await botRecord(bot.id);
    if (record.threadId !== threadId) await api(`/api/bots/${bot.id}/tasks/${threadId}?messages=0`, "POST");
    expect((await botRecord(bot.id)).threadId, "case thread is the bot's active thread").toBe(threadId);
  }
  async function ensureRoomActive(room: LiveRoom, threadId: string) {
    const record = await groupRecord(room.id);
    if (record?.threadId !== threadId) await api(`/api/groups/${room.id}/tasks/${threadId}?messages=0`, "POST");
    expect((await groupRecord(room.id))?.threadId, "case task is the room's active task").toBe(threadId);
  }

  async function runTargetTurn(run: CaseRun<C>, target: TurnTarget, threadId: string, text: string, turnOptions: TurnOptions = {}): Promise<TurnRecord> {
    const state = need();
    const speakers = target.kind === "bot" ? [target.bot] : target.responders;
    if (target.kind === "bot") await ensureActive(target.bot, threadId);
    else await ensureRoomActive(target.room, threadId);
    const existing = await threadMessages(threadId);
    if (openIntake(existing)) throw new Error(`thread ${threadId} has an open intake card; the runner never answers onboarding on the person's behalf`);
    const before = new Set(existing.map((m) => m.id));
    const timeoutMs = turnOptions.timeoutMs ?? (Number(process.env[ENV.turnTimeout]) || 600_000);
    if (target.kind === "bot") {
      const beforeTask = diskBots().find((b) => b.id === target.bot.id)?.tasks?.find((t: any) => t.threadId === threadId);
      hard(run, "task pins admitted model and Ask permissions before dispatch", taskIdentityProblems(beforeTask, state.descriptor, false).length === 0, taskIdentityProblems(beforeTask, state.descriptor, false));
    } else {
      if (!speakers.length) throw new Error(`the case names no room responder for this turn`);
      for (const responder of speakers) hard(run, `the message @mentions room member ${responder.name}`, mentions(text, responder.name));
      const others = Object.values(target.room.members).filter((member) => !speakers.some((speaker) => speaker.id === member.id));
      hard(run, "the message @mentions no other room member", others.every((member) => !mentions(text, member.name)) && !/(^|\s)@everyone\b/i.test(text), others.filter((member) => mentions(text, member.name)).map((member) => member.name));
      const problems = await memberProblems(speakers);
      hard(run, "room responders pin the admitted model and Ask permissions before dispatch", problems.length === 0, problems);
    }
    const headroom = dispatchHeadroom(state.ledger, state.descriptor, suiteTurns);
    if (headroom.remaining < speakers.length) throw new Error(`NOT RUN: this turn needs ${speakers.length} dispatch(es) and the engine ledger has ${headroom.remaining} left`);
    if (carry) {
      if (run.item.id !== carry.caseId || threadId !== carry.threadId || target.kind !== "bot" || target.bot.id !== carry.botId || text !== run.item.turns[0] || speakers.length !== 1 || Date.now() >= Date.parse(carry.deadline)) throw new Error("carry dispatch differs");
      writeFileSync(carry.claimMarker, JSON.stringify({ caseId: carry.caseId, threadId, at: new Date().toISOString(), ledgerUsedBefore: headroom.used }) + "\n", { flag: "wx", mode: 0o600 });
    }
    for (const _speaker of speakers) { claimDispatch(); state.dispatches += 1; run.dispatches += 1; }
    const startedAt = Date.now();
    const sendId = randomUUID();
    const sent = target.kind === "bot"
      ? await call(`/api/bots/${target.bot.id}/messages`, "POST", { text, threadId, sendId })
      : await call(`/api/groups/${target.room.id}/messages`, "POST", { text, threadId, sendId });
    const record: TurnRecord = { text, threadId, surface: "desktop", target: target.kind, responders: speakers.map((speaker) => speaker.id), sendStatus: sent.status, startedAt, endedAt: 0, interrupted: false, replies: [], activity: [], approvals: [], questions: [], artifactMessages: [], newMessageIds: [], endedAfterDenial: false, engineStops: [], awaitingOwner: [], ownerCardsExpired: [] };
    run.turns.push(record);
    if (sent.status !== 200 && sent.status !== 202) throw new Error(`send refused: ${sent.status} ${(await sent.text()).slice(0, 300)}`);
    const respond = (requestId: string, behavior: "deny" | "skip") => target.kind === "bot"
      ? call(`/api/bots/${target.bot.id}/respond`, "POST", { requestId, behavior, threadId })
      : call(`/api/threads/${threadId}/respond`, "POST", { requestId, behavior });
    const interrupt = () => target.kind === "bot"
      ? call(`/api/bots/${target.bot.id}/interrupt`, "POST", { threadId })
      : call(`/api/groups/${target.room.id}/interrupt`, "POST", { threadId });
    const handled = new Set<string>();
    const pendingOwner = new Set<string>();
    run.controlledState.permissionPolicy = familyApprovalRule(options.denials, run.item.id);
    let started = false, idle = 0;
    for (;;) {
      const [current, messages] = await Promise.all([target.kind === "bot" ? botRecord(target.bot.id) : groupRecord(target.room.id), threadMessages(threadId)]);
      const fresh = messages.filter((m) => !before.has(m.id));
      for (const m of fresh) {
        const card = m.card;
        if (card?.requestId && pendingOwner.has(card.requestId) && card.answered) {
          hard(run, "owner chose a one-time decision, not a persistent grant", card.answered === "allow" || card.answered === "deny", card.answered);
          record.approvals.push({ requestId: card.requestId, tool: card.tool, title: card.title, subtitle: card.subtitle, behavior: card.answered as "allow" | "deny", outcome: "observed persisted owner decision; HTTP response not observed", by: "owner in isolated app" });
          pendingOwner.delete(card.requestId);
          handled.add(card.requestId);
          recordOwnerOutcome(card.requestId, { decision: card.answered });
        } else if (card?.requestId && pendingOwner.has(card.requestId) && (card.expired || card.dismissed)) {
          record.ownerCardsExpired.push(card.requestId);
          pendingOwner.delete(card.requestId);
          handled.add(card.requestId);
          recordOwnerOutcome(card.requestId, { decision: "none", expired: Boolean(card.expired), dismissed: Boolean(card.dismissed) });
        }
        if (card?.requestId && !card.answered && !card.expired && !card.dismissed && !handled.has(card.requestId)) {
          const question = Array.isArray(card.questions) && card.questions.length > 0;
          if (!question && familyApprovalPolicy(options.denials, run.item.id, card) === "owner-once") {
            if (!pendingOwner.has(card.requestId)) {
              pendingOwner.add(card.requestId);
              writeReceipt(join(evidence, "pending-approvals", `${encodeURIComponent(card.requestId)}.json`), { case: run.item.id, threadId, target: target.kind === "bot" ? { bot: target.bot.id } : { room: target.room.id, from: m.from }, card, origin: state.origin, instruction: "Owner: inspect this action in the isolated app and choose Allow once or Deny. Do not use Auto or Always allow. Runner does not infer authorization from tool names or summaries." });
              console.log(`[${options.pkg}] owner permission needed in ${state.origin} for ${run.item.id}; request ${card.requestId}`);
            }
            continue;
          }
          handled.add(card.requestId);
          const behavior = question ? "skip" : "deny";
          const answered = await respond(card.requestId, behavior);
          const result = await answered.json() as { outcome?: string };
          (question ? record.questions : record.approvals).push({ requestId: card.requestId, tool: card.tool, title: card.title, subtitle: card.subtitle, behavior, status: answered.status, outcome: result.outcome, by: "runner" });
          hard(run, "approval response was accepted", answered.status === 200 && (question || result.outcome === "rejected"), result);
        }
      }
      const busy = target.kind === "bot" ? taskBusy(current, threadId) : Boolean(current?.working);
      if (busy || fresh.some((m) => m.role === "bot")) started = true;
      if (fresh.some((m) => m.kind === "activity" && m.tool?.name === MEMORY_REVOKED)) throw new Error(`${MEMORY_REVOKED}: turn ended before the engine started; recorded as an incident and NOT resent`);
      if (busy && turnOptions.interruptWhen && !record.interrupted && await turnOptions.interruptWhen({ fresh, elapsed: Date.now() - startedAt })) {
        const stopped = await interrupt();
        if (stopped.status !== 200) throw new Error(`interrupt refused: ${stopped.status} ${(await stopped.text()).slice(0, 300)}`);
        record.interrupted = true;
      }
      if (started && !busy) { if (++idle >= 3) break; } else idle = 0;
      if (!started && Date.now() - startedAt > 120_000) throw new Error("the turn never started");
      if (Date.now() - startedAt > timeoutMs) {
        await interrupt().catch(() => undefined);
        record.awaitingOwner = [...pendingOwner];
        for (const requestId of pendingOwner) recordOwnerOutcome(requestId, { decision: "none", turnInterruptedAfterMs: timeoutMs });
        if (pendingOwner.size) throw new Error(`NOT ESTABLISHED: no owner decision arrived for ${pendingOwner.size} approval card(s) (${[...pendingOwner].join(", ")}) within ${timeoutMs} ms; turn interrupted, not resent`);
        throw new Error(`turn exceeded ${timeoutMs} ms; interrupted and failed, not resent`);
      }
      await sleep(1_000);
    }
    const fresh = (await threadMessages(threadId)).filter((m) => !before.has(m.id));
    record.endedAt = Date.now();
    record.newMessageIds = fresh.map((m) => m.id);
    record.replies = fresh.filter((m) => m.role === "bot" && m.kind === "text" && !m.artifactIds?.length).map((m) => ({ id: m.id, turnId: m.turnId, from: m.from?.botId, text: String(m.text ?? "") }));
    record.activity = fresh.filter((m) => m.kind === "activity").map((m) => ({ name: m.tool?.name, ok: m.tool?.ok, from: m.from?.botId }));
    record.artifactMessages = fresh.filter((m) => m.artifactIds?.length).map((m) => ({ id: m.id, text: m.text, artifactIds: m.artifactIds! }));
    if (target.kind === "bot") {
      const task = diskBots().find((b) => b.id === target.bot.id)?.tasks?.find((t: any) => t.threadId === threadId);
      hard(run, "turn retains admitted task identity and Ask permissions", taskIdentityProblems(task, state.descriptor).length === 0, taskIdentityProblems(task, state.descriptor));
    } else {
      const problems = await memberProblems(speakers);
      hard(run, "room responders still pin the admitted model and Ask permissions", problems.length === 0, problems);
      const allowed = new Set(speakers.map((speaker) => speaker.id));
      const strangers = fresh.filter((m) => m.role === "bot" && m.from?.botId && !allowed.has(m.from.botId)).map((m) => ({ id: m.id, from: m.from }));
      hard(run, "only the mentioned room members spoke", strangers.length === 0, strangers);
      const silent = speakers.filter((speaker) => !fresh.some((m) => m.from?.botId === speaker.id));
      hard(run, "every mentioned room member took its turn", record.interrupted || silent.length === 0, silent.map((speaker) => speaker.name));
    }
    hard(run, "runner never grants; the owner decides every card the scenario does not itself deny", record.approvals.every((a) => a.by === "runner" ? a.behavior === "deny" && familyApprovalPolicy(options.denials, run.item.id, a) === "deny" : a.by === "owner in isolated app" && familyApprovalPolicy(options.denials, run.item.id, a) === "owner-once"), record.approvals);
    record.engineStops = nativeStops(state.harness.dataDir, startedAt - 1_000, Date.now() + 1_000);
    const denied = new Set(record.approvals.filter((a) => a.behavior === "deny").map((a) => a.requestId));
    const lastDenial = fresh.reduce((last, m, index) => (m.card?.requestId && denied.has(m.card.requestId) ? index : last), -1);
    record.endedAfterDenial = !record.interrupted && lastDenial >= 0
      && !fresh.slice(lastDenial + 1).some((m) => m.role === "bot" && m.kind === "text" && !m.artifactIds?.length && String(m.text ?? "").trim());
    return record;
  }
  const runTurn = (run: CaseRun<C>, bot: Bot, threadId: string, text: string, turnOptions: TurnOptions = {}) => runTargetTurn(run, { kind: "bot", bot }, threadId, text, turnOptions);
  const runRoomTurn = (run: CaseRun<C>, room: LiveRoom, responders: readonly Bot[], threadId: string, text: string, turnOptions: TurnOptions = {}) => runTargetTurn(run, { kind: "room", room, responders: [...responders] }, threadId, text, turnOptions);
  const replyText = (turn: TurnRecord) => turn.replies.map((r) => r.text).join("\n\n");
  const interruptEarly = ({ fresh, elapsed }: { fresh: Msg[]; elapsed: number }) => fresh.some((m) => m.role === "bot" && m.kind === "text") || elapsed > 4_000;

  // ── Checks and evidence ─────────────────────────────────────────────────

  function hard(run: CaseRun<C>, check: string, ok: boolean, detail?: unknown) {
    run.hard.push({ check, ok, ...(detail === undefined ? {} : { detail }) });
    expect(ok, `${run.item.id}: ${check}${detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 600)}`}`).toBe(true);
  }
  function screen(run: CaseRun<C>, text: string) { run.rubric = evaluateRubric(text, run.item.rubric); }
  function fileScreen(run: CaseRun<C>, text: string, rubric: B08Rubric) { run.fileRubric = evaluateRubric(text, rubric); }
  async function artifact(id: string) { return (await api(`/api/artifacts/${id}`)).artifact as { id: string; sha256: string; relativePath?: string; producer?: string; threadId?: string; botId?: string; runId?: string; name?: string }; }
  async function downloadSha(id: string) {
    const response = await call(`/api/artifacts/${id}/download`);
    if (response.status !== 200) throw new Error(`download ${id} → ${response.status}`);
    return sha256(Buffer.from(await response.arrayBuffer()));
  }
  /** Hands a saved file to its independent reader (b09-b10-deliverable-readers.ts) and records exactly one hard check; call it after
   * inspectDeliverable. DELIVERABLE_READER_UNAVAILABLE or any other thrown error is a failed check, never a skip. The reader's outputs
   * (thumbnail, preview, decoded image) stay under this run's evidence for assessment. Extensions without a reader record nothing. */
  async function independentReader(run: CaseRun<C>, file: string, label: string): Promise<void> {
    const entry = READERS[extname(file).toLowerCase()];
    if (!entry) return;
    const read = async () => {
      const parent = join(resolve(evidence), "readers", caseFileName(run.item.id).replace(/\.json$/, ""));
      mkdirSync(parent, { recursive: true });
      const agreement = await entry.read(resolve(file), mkdtempSync(join(parent, `${entry.reader.replace(/\W+/g, "-")}-`)));
      return { ok: agreement.ok, detail: readerDetail(agreement) };
    };
    const verdict = await read().catch((error: unknown) => ({ ok: false, detail: { reader: entry.reader, error: message(error) } }));
    hard(run, `artifact ${label} opens in an independent reader (${entry.reader})`, verdict.ok, verdict.detail);
  }
  async function workspaceInvariants(run: CaseRun<C>) {
    const state = need();
    const pinned = { instanceId: state.descriptor.instanceId, model: state.descriptor.model };
    const { bots, groups } = await workspace();
    const admitted: Array<[string, Bot]> = [["chief", state.chief], ...Object.entries(state.bots), ...Object.values(state.rooms).flatMap((room) => Object.entries(room.members).map(([key, member]) => [`${room.key}/${key}`, member] as [string, Bot]))];
    for (const [label, bot] of admitted) {
      const record = bots.find((item) => item.id === bot.id);
      hard(run, `${label} keeps the pinned model`, record?.modelSelection?.instanceId === pinned.instanceId && record?.modelSelection?.model === pinned.model, record?.modelSelection);
      hard(run, `${label} has no auto-approval or remembered grants`, record?.autoApprove !== true && (record?.alwaysAllow ?? []).length === 0);
    }
    const chief = bots.find((item) => item.id === state.chief.id);
    hard(run, "fixture Chief unchanged", chief?.chiefOfStaff === true && chief?.chiefScope === "workspace");
    hard(run, "no template bot became workspace Chief", bots.filter((b) => b.chiefScope === "workspace").map((b) => b.id).join() === state.chief.id);
    for (const room of Object.values(state.rooms)) {
      const record = groups.find((group) => group.id === room.id);
      hard(run, `room ${room.name} keeps its members, bulletin and routing`, JSON.stringify([...(record?.memberIds ?? [])].sort()) === JSON.stringify(Object.values(room.members).map((member) => member.id).sort()) && (record?.bulletin ?? "") === room.bulletin && record?.defaultResponder?.kind === room.defaultResponderKind, { memberIds: record?.memberIds, defaultResponder: record?.defaultResponder });
    }
    const routines = (await api("/api/routines")).routines as Array<{ name?: string; enabled?: boolean }>;
    hard(run, "every routine remains paused", routines.every((r) => r.enabled === false), routines.map((r) => ({ name: r.name, enabled: r.enabled })));
    const problems = assertRealEngineIdentity((await api("/api/instances")).instances as DescribedInstance[], state.descriptor, ROOT);
    hard(run, "harness still runs exactly the admitted real engine", problems.length === 0, problems);
    const disk = diskBots();
    const wrong = [...state.usedThreads].flatMap((threadId) => disk.flatMap((b) => (b.tasks ?? []).filter((t: any) => t.threadId === threadId && t.lastInstanceId && t.lastInstanceId !== pinned.instanceId).map((t: any) => ({ threadId, lastInstanceId: t.lastInstanceId }))));
    hard(run, "no used thread was dispatched on another instance", wrong.length === 0, wrong);
  }
  async function identitySnapshot() {
    return ((await api("/api/instances")).instances as DescribedInstance[]).map((i) => ({ instanceId: i.instanceId, driverKind: i.driverKind, state: i.snapshot?.state, enabled: i.enabled, cli: i.cli, models: (i.models?.options ?? []).map((o) => o.id) }));
  }
  function beginCase(item: C): CaseRun<C> {
    if (!live) { outcomes.set(item.id, `NOT RUN: ${notRun.join("; ")}`); throw new Error(`NOT RUN — ${item.id}: ${notRun.join("; ")}`); }
    return { item, threads: [], turns: [], dispatches: 0, controlledState: { description: item.controlledState }, hard: [], status: "running", startedAt: Date.now() };
  }
  async function finishCase(run: CaseRun<C>, error?: unknown) {
    const flagged = [run.rubric, run.fileRubric].filter((rubric) => rubric && !rubric.screened).length;
    const afterDenial = run.turns.filter(endedByEngineAfterDenial).length;
    run.status = caseStatus({ dispatches: run.dispatches, error: error === undefined ? undefined : message(error), flagged, endedAfterDenial: afterDenial });
    outcomes.set(run.item.id, run.status);
    let identity: unknown;
    try { identity = await identitySnapshot(); } catch (snapshotError) { identity = `unavailable: ${message(snapshotError)}`; }
    let nativeLogs: unknown = "no dispatch in this case";
    if (run.dispatches) { try { nativeLogs = exportNativeLogs(need().harness.dataDir, evidence, run.item.id, run.startedAt); } catch (exportError) { nativeLogs = `export failed: ${message(exportError)}`; } }
    writeReceipt(join(evidence, "cases", caseFileName(run.item.id)), {
      case: { id: run.item.id, template: options.templates[run.item.family]?.name ?? options.rooms?.[run.item.family]?.name, kind: run.item.kind, fictionalInput: run.item.fictionalInput, authoredExpectation: run.item.expected, responders: run.item.responders },
      status: run.status, engine: publicDescriptor(need().descriptor), identity, threads: run.threads, dispatches: run.dispatches, controlledState: run.controlledState,
      turns: run.turns, hardChecks: run.hard, rubric: run.rubric, fileRubric: run.fileRubric, verdictHint: denialVerdictHint(afterDenial), nativeLogs, durationMs: Date.now() - run.startedAt,
      note: "Hard checks are product state and saved-file facts. Rubric results are automated heuristics over text; behavioural acceptance needs human assessment.",
    });
  }
  function caseTest(id: string, body: (run: CaseRun<C>) => Promise<void>) {
    const item = options.cases.find((candidate) => candidate.id === id);
    if (!item) throw new Error(`unknown ${LABEL} case ${id}`);
    if (carryFile && !["explainer/second-turn", "excel-creator/second-turn"].includes(id)) return;
    test(id, async () => {
      if (carryFile && (!carry || id !== carry.caseId)) throw new Error("only admitted original carry may run");
      const run = beginCase(item);
      try {
        const needed = familyCaseDispatches(item);
        const headroom = dispatchHeadroom(need().ledger, need().descriptor, suiteTurns);
        run.controlledState.dispatchLedger = headroom;
        if (headroom.remaining < needed) throw new Error(`NOT RUN: this case needs ${needed} dispatch(es) and the engine ledger has ${headroom.remaining} left (${headroom.used}/${headroom.max} used across runs); no partial case is started`);
        await body(run); await workspaceInvariants(run); await finishCase(run);
      } catch (error) { await finishCase(run, error); throw error; }
    });
  }
  function refuse(reasons: string[]) {
    notRun = reasons;
    writeReceipt(join(evidence, "NOT-RUN.json"), {
      status: "NOT RUN", realModelExecution: "not run", reasons, cases: options.cases.map((c) => c.id), at: new Date().toISOString(),
      note: "No harness, engine or credential was used for this result. Each case fails with this reason; none is skipped or passed.",
    });
    console.warn(`[${options.pkg}] NOT RUN: ${reasons.join("; ")}`);
  }

  async function restartSameData(run: CaseRun<C>, threadId: string, owner: Bot | LiveRoom) {
    const state = need();
    const snapshot = async () => { const { bots, groups } = await workspace(); return { bots: bots.map((b) => ({ id: b.id, threadId: b.threadId })), groups: groups.map((g) => ({ id: g.id, threadId: g.threadId, memberIds: g.memberIds })) }; };
    const idsBefore = (await threadMessages(threadId)).map((m) => m.id);
    const before = await snapshot();
    const pidBefore = state.harness.pids.at(-1);
    await state.harness.restart();
    state.restarts += 1;
    const idsAfter = (await threadMessages(threadId)).map((m) => m.id);
    const after = await snapshot();
    run.controlledState.restart = { pidBefore, pidAfter: state.harness.pids.at(-1), dataDir: state.harness.dataDir, logs: state.harness.logPaths.slice(-2) };
    hard(run, "restart replaced the server process", pidBefore !== state.harness.pids.at(-1));
    hard(run, "same-data restart kept every bot, room and thread", JSON.stringify(after) === JSON.stringify(before), { before, after });
    hard(run, "same-data restart kept the transcript", idsBefore.every((id) => idsAfter.includes(id)), { missing: idsBefore.filter((id) => !idsAfter.includes(id)) });
    if (isRoom(owner)) expect((await groupRecord(owner.id))?.id).toBe(owner.id);
    else expect((await botRecord(owner.id))?.id).toBe(owner.id);
  }
  /** Opens the app, selects the bot or room in the sidebar and downloads the card's bytes. */
  async function verifyCardDownload(owner: Bot | LiveRoom, artifactId: string): Promise<string> {
    const state = need();
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
      const page = await context.newPage();
      page.setDefaultTimeout(60_000);
      await page.addInitScript(() => { localStorage.setItem("murage-email-gate", "skipped"); localStorage.setItem("murage-flux-invite-dismissed", "1"); localStorage.setItem("murage-skin", "light"); });
      await page.goto(state.origin, { waitUntil: "domcontentloaded" });
      const row = (await openSidebar(page)).getByRole("button", { name: new RegExp(`^${escapeRegExp(owner.name)}`) }).first();
      // A bot row's select button is an overlay whose centre sits under the sibling Rename button (see the B08 runner); a room row is a plain button.
      if (isRoom(owner)) await row.click(); else await row.dispatchEvent("click");
      const card = page.locator(`[data-artifact-id="${artifactId}"]`).first();
      await expect(card).toBeVisible({ timeout: 30_000 });
      const download = page.waitForEvent("download");
      await card.getByRole("button", { name: "Download", exact: true }).click();
      const bytes = readFileSync((await (await download).path())!);
      await page.screenshot({ path: join(evidence, "screens", `card-${artifactId}.png`), fullPage: true });
      return sha256(bytes);
    } finally { await browser.close(); }
  }
  /** Every new artifact from a turn must be a file saved under outputs/ of a bot that spoke in this turn, byte-identical on disk, in its receipt and on download. */
  async function verifyTurnArtifacts(run: CaseRun<C>, owners: Bot | readonly Bot[], threadId: string, turn: TurnRecord): Promise<VerifiedArtifact[]> {
    const candidates: readonly Bot[] = Array.isArray(owners) ? owners : [owners as Bot];
    const ids = [...new Set(turn.artifactMessages.flatMap((m) => m.artifactIds))];
    const rows = outputReceipts(threadId);
    const verified: VerifiedArtifact[] = [];
    for (const id of ids) {
      const saved = await artifact(id);
      const owner = candidates.find((bot) => bot.id === saved.botId);
      hard(run, `artifact ${id} belongs to a bot that spoke in this turn`, Boolean(owner), { botId: saved.botId, speakers: candidates.map((bot) => bot.id) });
      const root = workspaceOf(owner!, threadId);
      const path = join(root, saved.relativePath ?? "");
      hard(run, `artifact ${id} path is contained in task outputs`, Boolean(saved.relativePath?.startsWith("outputs/")) && inside(path, join(root, "outputs")), saved.relativePath);
      const disk = existsSync(path) ? sha256(readFileSync(path)) : "absent";
      const row = rows.find((r) => r.artifact_id === id);
      const directRegistration = saved.producer === undefined && Boolean(saved.runId) && turn.artifactMessages.some((m) => m.artifactIds.includes(id) && m.text === `Saved file: ${saved.name}`);
      hard(run, `artifact ${id} is a model file under outputs/ in this thread`, (saved.producer === "shell-output" || directRegistration) && saved.threadId === threadId, saved);
      hard(run, `artifact ${id} bytes on disk equal the registered sha256`, disk === saved.sha256, { disk, registered: saved.sha256 });
      hard(run, `artifact ${id} download equals the registered sha256`, (await downloadSha(id)) === saved.sha256);
      hard(run, `artifact ${id} has registration evidence joined to its card`, directRegistration || (row?.stage === "registered" && Boolean(row?.message_id) && turn.artifactMessages.some((m) => m.id === row?.message_id)), directRegistration ? { route: "internal/register-artifact", runId: saved.runId, artifact: saved } : row);
      const retained = retainArtifact(evidence, run.item.id, id, readFileSync(path));
      run.hard.push({ check: `artifact ${id} retained for assessment`, ok: true, detail: { id, relativePath: saved.relativePath, sha: saved.sha256, botId: saved.botId, evidencePath: retained } });
      verified.push({ id, relativePath: saved.relativePath!, sha: saved.sha256, botId: owner!.id });
    }
    return verified;
  }

  // ── Admission ───────────────────────────────────────────────────────────

  test.beforeAll(async ({}, testInfo) => {
    test.setTimeout(900_000);
    if (testInfo.config.workers !== 1 || testInfo.config.shard) throw new Error(`${LABEL} requires exactly one worker and no sharding: shared state/budget must remain serial`);
    const lane = laneDataDir(`${LABEL} behaviour data and evidence never use ~/.murage`);
    const stamp = process.env[ENV.runStamp];
    if (!stamp) throw new Error(`${ENV.runStamp} is set by the ${LABEL} Playwright config; run through that config`);
    const override = process.env[ENV.evidence];
    evidence = runEvidenceDir(lane, override, stamp);
    if (inside(evidence, ROOT)) { evidence = runEvidenceDir(lane, undefined, stamp); mkdirSync(evidence, { recursive: true }); return refuse([`${ENV.evidence} points inside the checkout; evidence stays outside Git`]); }
    mkdirSync(evidence, { recursive: true });

    const gaps = familyInputGaps(options.pkg, process.env);
    if (gaps.length) return refuse(gaps);
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(process.env[ENV.engineFile]!, "utf8")); }
    catch (error) { return refuse([`engine descriptor could not be read as JSON: ${message(error)}`]); }
    const admitted = admitEngineDescriptor(raw, { repoRoot: ROOT, home: homedir() }, suiteTurns);
    if (!admitted.ok) return refuse(admitted.refusals.map((r) => `descriptor refused: ${r}`));
    const descriptor = admitted.descriptor;
    const engineFile = resolve(process.env[ENV.engineFile]!);
    if (inside(engineFile, ROOT)) return refuse([`${ENV.engineFile} lives inside the checkout; the descriptor and its dispatch ledger stay outside Git`]);
    const ledger = dispatchLedgerPath(engineFile, descriptor, options.pkg);
    try {
      const headroom = dispatchHeadroom(ledger, descriptor, suiteTurns);
      if (headroom.remaining < 1) return refuse([`engine dispatch ledger ${ledger} has no remaining allocation (${headroom.used}/${headroom.max} used across runs); a new allocation must be issued in the engine descriptor`]);
    } catch (error) { return refuse([`dispatch ledger refused: ${message(error).replace(/^NOT RUN:\s*/, "")}`]); }
    try { admitCarry(descriptor, ledger); } catch (error) { return refuse([message(error)]); }
    let packageAdmission: Record<string, unknown> | undefined;
    if (options.admit) {
      try { packageAdmission = await options.admit(); }
      catch (error) { return refuse([`package admission refused: ${message(error)}`]); }
    }
    const credential = readCredential(descriptor, { repoRoot: ROOT, home: homedir() });
    if (!credential.ok) return refuse([`credential refused: ${credential.refusal}`]);

    let harness: B08Harness;
    try {
      harness = await startIsolatedHarness({
        repoRoot: ROOT, parent: lane, evidenceDir: join(evidence, "logs"), keepData: Boolean(carry) || process.env[ENV.keepData] === "1",
        ...(carry ? { retainedData: { dataDir: carry.dataDir, configSha256: carry.configSha256, botsSha256: carry.botsSha256 } } : {}),
        instances: { [descriptor.instanceId]: { driver: descriptor.driver, displayName: descriptor.displayName, config: descriptor.config } },
        extraEnv: credential.env ? { [credential.env]: credential.value } : {},
      });
    } catch (error) { return refuse([`isolated harness did not start: ${message(error)}`]); }

    let vite: ViteDevServer | undefined;
    try {
      const get = async (path: string) => { const r = await fetch(harness.url + path, { headers: harness.headers(), signal: AbortSignal.timeout(60_000) }); if (!r.ok) throw new Error(`GET ${path} → ${r.status}`); return r.json() as Promise<any>; };
      let problems: string[] = ["identity not checked"];
      for (const deadline = Date.now() + 180_000; Date.now() < deadline; await sleep(2_000)) {
        problems = assertRealEngineIdentity((await get("/api/instances")).instances, descriptor, ROOT);
        if (!problems.length) break;
      }
      if (problems.length) throw new Error(`real-engine identity refused: ${problems.join("; ")}`);
      live = { harness, descriptor, ledger, bots: {}, rooms: {}, chief: undefined as unknown as Bot, vite: undefined as unknown as ViteDevServer, origin: "", dispatches: 0, restarts: 0, usedThreads: new Set() };
      const state = live;
      const pinned = { instanceId: descriptor.instanceId, model: descriptor.model };
      const safety = { computer: "off", browser: false, composio: false };

      const imports: Record<string, unknown> = {};
      if (carry) {
        const previous = JSON.parse(readFileSync(carry.priorAdmission, "utf8"));
        state.chief = previous.chief; state.bots = previous.bots; state.rooms = previous.rooms;
        const records = await roster();
        if (JSON.stringify(records.map(b => b.id).sort()) !== JSON.stringify([...carry.rosterIds].sort())) throw new Error("retained roster binding changed");
        const messages = await threadMessages(carry.threadId);
        if (JSON.stringify(messages.map(m => m.id).sort()) !== JSON.stringify([...carry.messageIds].sort())) throw new Error("served carry transcript differs");
        const bot = state.bots[carry.caseId.split("/")[0]];
        if (!bot || bot.id !== carry.botId) throw new Error("served carry bot differs");
        await restoreCarryArtifacts();
      } else {
      const chief = (await api("/api/bots", "POST", { name: `${LABEL} Fixture Chief`, title: `Workspace chief (${LABEL} fixture)`, modelSelection: pinned, requireAvailableModel: true })).bot;
      await api(`/api/bots/${chief.id}`, "PATCH", { chiefOfStaff: true, chiefScope: "workspace", ...safety });
      state.chief = { id: chief.id, name: chief.name, threadId: chief.threadId };

      const catalog = (await api("/api/team-library/catalog")).teams as Array<{ slug: string; adaptable?: boolean; profileReviewHash?: string }>;
      for (const [family, template] of Object.entries(options.templates)) {
        const entry = catalog.find((team) => team.slug === template.slug);
        if (!entry?.adaptable || !entry.profileReviewHash) throw new Error(`catalog entry ${template.slug} is not an adaptable reviewed profile`);
        const bot = (await api("/api/bots", "POST", { name: `${LABEL} ${template.name}`, title: `${template.name} (${LABEL} fixture)`, modelSelection: pinned, requireAvailableModel: true })).bot;
        await api(`/api/bots/${bot.id}`, "PATCH", safety);
        await api(`/api/bots/${bot.id}/assistant-profile`, "POST", { slug: template.slug, rename: false, profileReviewHash: entry.profileReviewHash });
        state.bots[family] = { id: bot.id, name: bot.name, threadId: bot.threadId };
      }

      for (const [key, room] of Object.entries(options.rooms ?? {})) {
        const document = JSON.parse(readFileSync(join(ROOT, room.source), "utf8"));
        const packageRoom = (document.package?.rooms ?? []).find((candidate: { key?: string }) => candidate.key === room.roomKey);
        if (!packageRoom) throw new Error(`${room.source} declares no room ${room.roomKey}`);
        const before = new Set((await roster()).map((bot) => bot.id));
        const imported = await api("/api/teams/import?mode=add", "POST", document);
        imports[key] = { name: imported.name, bots: (imported.bots ?? []).map((bot: Bot) => ({ id: bot.id, name: bot.name })), groups: (imported.groups ?? []).map((group: { id: string; name: string }) => ({ id: group.id, name: group.name })), routines: imported.routines, skillErrors: imported.skillErrors };
        if ((imported.skillErrors ?? []).length) throw new Error(`team import of ${room.source} reported skill errors: ${JSON.stringify(imported.skillErrors).slice(0, 400)}`);
        const groups = imported.groups ?? [];
        const group = groups.find((candidate: { name: string }) => candidate.name === room.name);
        if (!group || groups.length !== 1) throw new Error(`team import of ${room.source} should create exactly the room ${room.name}, created ${groups.map((candidate: { name: string }) => candidate.name).join(", ")}`);
        if ((imported.bots ?? []).length !== Object.keys(room.members).length) throw new Error(`team import of ${room.source} should add exactly ${Object.keys(room.members).length} members`);
        const members: Record<string, Bot> = {};
        for (const [memberKey, member] of Object.entries(room.members)) {
          const bot = (imported.bots ?? []).find((candidate: Bot) => candidate.name === member.name);
          if (!bot || before.has(bot.id)) throw new Error(`team import of ${room.source} did not add member ${member.name}`);
          await api(`/api/bots/${bot.id}`, "PATCH", { modelSelection: pinned, ...safety });
          members[memberKey] = { id: bot.id, name: bot.name, threadId: bot.threadId };
        }
        if (JSON.stringify([...group.memberIds].sort()) !== JSON.stringify(Object.values(members).map((member) => member.id).sort())) throw new Error(`room ${room.name} members differ from the imported bots`);
        if (group.defaultResponder?.kind !== packageRoom.defaultResponder?.kind) throw new Error(`room ${room.name} routing ${JSON.stringify(group.defaultResponder)} differs from the package's ${JSON.stringify(packageRoom.defaultResponder)}`);
        if ((group.bulletin ?? "") !== (packageRoom.bulletin ?? "")) throw new Error(`room ${room.name} bulletin differs from the package`);
        if ((imported.routines ?? []).some((routine: { enabled?: boolean }) => routine.enabled !== false)) throw new Error(`team import of ${room.source} enabled a routine`);
        state.rooms[key] = { key, id: group.id, name: group.name, members, bulletin: group.bulletin ?? "", defaultResponderKind: String(group.defaultResponder?.kind) };
      }

      }

      const records = await roster();
      const playbookKeys = (bot: Bot) => (records.find((record) => record.id === bot.id)?.playbooks ?? []).map((p: { key: string }) => p.key);
      const playbooks: Record<string, string[]> = {};
      for (const [family, template] of Object.entries(options.templates)) {
        playbooks[family] = playbookKeys(state.bots[family]!);
        if (!playbooks[family]!.includes(template.playbook)) throw new Error(`${family} is missing its ${template.playbook} playbook after applying ${template.slug}`);
      }
      for (const [key, room] of Object.entries(options.rooms ?? {})) {
        for (const [memberKey, member] of Object.entries(room.members)) {
          playbooks[`${key}/${memberKey}`] = playbookKeys(state.rooms[key]!.members[memberKey]!);
          if (!playbooks[`${key}/${memberKey}`]!.includes(member.playbook)) throw new Error(`${member.name} is missing its ${member.playbook} playbook after importing ${room.source}`);
        }
        const problems = await memberProblems(Object.values(state.rooms[key]!.members));
        if (problems.length) throw new Error(`room members are not pinned to the admitted engine: ${JSON.stringify(problems)}`);
      }

      vite = await createServer({ configFile: false, root: ROOT, envFile: false, cacheDir: join(evidence, "vite-cache"), resolve: { alias: { "@": join(ROOT, "src") } }, plugins: [react(), tailwindcss()], server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, proxy: { "/api": { target: harness.url } } } });
      await vite.listen(0);
      const address = vite.httpServer!.address();
      if (!address || typeof address === "string") throw new Error(`the ${LABEL} app did not bind`);
      state.vite = vite;
      state.origin = `http://127.0.0.1:${address.port}`;

      writeReceipt(join(evidence, `ADMISSION-worker-${process.pid}.json`), {
        status: "admitted", engine: publicDescriptor(descriptor), ledger, identity: await identitySnapshot(), harness: { url: harness.url, dataDir: harness.dataDir, pids: harness.pids, logs: harness.logPaths },
        chief: state.chief, bots: state.bots, rooms: state.rooms, imports, playbooks, templates: options.templates, roomPackages: options.rooms, packageAdmission, routines: (await api("/api/routines")).routines, at: new Date().toISOString(),
      });
    } catch (error) {
      live = undefined;
      let viteError: string | undefined;
      if (vite) await boundedClose(() => vite!.close()).catch((closeError) => { viteError = message(closeError); });
      const cleanup = await harness.close(Boolean(viteError)).catch((closeError) => ({ error: message(closeError) }));
      refuse([`admission failed after harness start: ${message(error)}`, `cleanup: ${JSON.stringify({ harness: cleanup, viteError })}`]);
    }
  });

  test.afterAll(async () => {
    let cleanup: unknown = "no harness was started";
    let cleanupFailure: string | undefined;
    if (live) {
      const state = live;
      try { await boundedClose(() => state.vite.close()); }
      catch (error) { cleanupFailure = message(error); }
      const harnessCleanup = await state.harness.close(Boolean(cleanupFailure)).catch((error) => ({ error: message(error) }));
      cleanup = { viteError: cleanupFailure, harness: harnessCleanup };
      if (!("pidsGone" in harnessCleanup) || !harnessCleanup.pidsGone) cleanupFailure ??= "owned harness/child exit was not confirmed; data retained";
    }
    if (!evidence) return;
    const path = join(evidence, "SUMMARY.json");
    const previous = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { workers: [], cases: [] };
    const prior = new Map<string, string>((previous.cases ?? []).map((c: { id: string; status: string }) => [c.id, c.status]));
    writeReceipt(path, {
      package: LABEL,
      realModelExecution: live || previous.realModelExecution === "attempted with the admitted engine" ? "attempted with the admitted engine" : "NOT RUN",
      workers: [...(previous.workers ?? []), { pid: process.pid, admitted: Boolean(live), notRunReasons: live ? undefined : notRun, dispatches: live?.dispatches ?? 0, restarts: live?.restarts ?? 0, cleanup }],
      dispatchLedger: live && existsSync(live.ledger) ? { path: live.ledger, ...JSON.parse(readFileSync(live.ledger, "utf8")) } : previous.dispatchLedger ?? "no dispatch claimed by an admitted worker",
      cases: options.cases.map((c) => ({ id: c.id, status: outcomes.get(c.id) ?? prior.get(c.id) ?? unexecutedStatus() })),
      at: new Date().toISOString(),
      note: "No case is a behavioural pass until its outputs are human-assessed.",
    });
    if (cleanupFailure) throw new Error(cleanupFailure);
  });

  return {
    need, api, roster, botRecord, groupRecord, threadMessages, workspaceOf, newTask, newRoomTask, runTurn, runRoomTurn, replyText, interruptEarly, hard, screen, fileScreen,
    downloadSha, restartSameData, verifyCardDownload, verifyTurnArtifacts, independentReader, caseTest, carried, suiteTurns,
    approvalRule: (id: string) => familyApprovalRule(options.denials, id),
  };
}
