#!/usr/bin/env -S node --experimental-strip-types
// B17-AUTH-RECOVERY: after Telegram rejects the saved bot token (401), can the
// owner save a new token for the SAME bot and keep the saved pairing, binding,
// offset and owner link, while a token for a different bot is refused before
// anything is saved?
//
//   node --experimental-strip-types scripts/channel-telegram-auth-recovery.ts baseline EVIDENCE_DIR
//   node --experimental-strip-types scripts/channel-telegram-auth-recovery.ts overlay EVIDENCE_DIR --patch SHARED-PATCHES.md|FILE.diff
//   node --experimental-strip-types scripts/channel-telegram-auth-recovery.ts integrated EVIDENCE_DIR
//
// baseline    this checkout's server as it is. Proves the dead end the root patch
//             (SP-T1, server/index.ts) closes: Retry 409, Pair refused, token save 409.
// overlay     copies this checkout (without .git and node_modules, which is linked)
//             into a private OS-temp directory outside Git, applies the SP-T1 diff
//             there with `git apply` (never to this checkout), drives that copy's
//             server, and removes the copy afterwards. A .md patch source is read
//             from the first ```diff block under its "## SP-T1" heading.
// integrated  this checkout's server with SP-T1 already joined in server/index.ts.
//             Runs the overlay journeys (R0.post-patch to R7) in place, with no copy.
//             Refuses (exit 2, no checks) unless server/index.ts carries the SP-T1
//             branch, and records the sha256 of the server/index.ts it drove.
//
// Offline: the real source server, the scripted Bot API stand-in wrapped per
// token (scripts/channel-telegram-token-fake-api.mjs) and a fake Claude engine.
// Token bytes are never written to evidence; tokens are named by sha256 labels.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Harness } from "./channel-live-harness.ts";
import { Checks, finishCleanup } from "./channel-live-qualify.ts";
import { removeTempDir } from "../server/testing/cleanup.ts";

type HarnessModule = typeof import("./channel-live-harness.ts");
const CHECKOUT = dirname(dirname(fileURLToPath(import.meta.url)));
const BOT = "123", OWNER = 777, OTHER_BOT = 456;
const REPLY = "hello from fake claude";
const TOKENS = {
  A: "123:rehearsal_token_not_real_abcdefghij",
  B: "123:rehearsal_replacement_not_real_klmnop",
  C: "456:rehearsal_other_bot_not_real_qrstuv",
  D: "123:rehearsal_second_replacement_not_real",
  E: "123:rehearsal_third_replacement_not_real_x",
} as const;
type TokenName = keyof typeof TOKENS;
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const LABEL = Object.fromEntries(Object.entries(TOKENS).map(([name, token]) => [name, sha256(token).slice(0, 12)])) as Record<TokenName, string>;

const usage = () => { process.stderr.write("usage: channel-telegram-auth-recovery.ts baseline|overlay|integrated EVIDENCE_DIR [--patch SHARED-PATCHES.md|FILE.diff]\n"); process.exit(2); };
const [mode, evidenceArg, ...rest] = process.argv.slice(2);
if (mode !== "baseline" && mode !== "overlay" && mode !== "integrated") usage();
const patchIndex = rest.indexOf("--patch"), patchSource = patchIndex === -1 ? undefined : rest[patchIndex + 1];
if (mode === "overlay" && !patchSource) usage();
const indexSource = readFileSync(join(CHECKOUT, "server", "index.ts"), "utf8"), indexSha256 = sha256(indexSource);
if (mode === "integrated" && !(/import \{[^}]*\bTelegramTokenRefusal\b[^}]*\} from "\.\/telegram-service\.ts"/.test(indexSource) && indexSource.includes("telegram.replaceToken("))) {
  process.stderr.write("integrated: this checkout's server/index.ts does not carry the SP-T1 branch (TelegramTokenRefusal import and telegram.replaceToken call).\n");
  process.exit(2);
}
const evidence = evidenceArg ? resolve(evidenceArg) : mkdtempSync(join(tmpdir(), `murage-telegram-auth-recovery-${mode}-evidence-`));
const inside = (child: string, parent: string) => { const path = relative(parent, child); return path === "" || (!path.startsWith("..") && !isAbsolute(path)); };
if (inside(evidence, CHECKOUT)) { process.stderr.write("Evidence must stay outside the checkout.\n"); process.exit(2); }
mkdirSync(evidence, { recursive: true, mode: 0o700 });
process.stdout.write(`evidence ${evidence}\n`);

let harness: Harness | undefined;
const checks = new Checks(() => harness);
let api = "", updateId = 0, delivered: TokenName | null = null;
const updates: any[] = [];
const control: Record<string, { state: "revoked" } | { botId: number }> = {};
const lines = (file: string): any[] => existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
const atomic = (file: string, value: unknown) => { writeFileSync(file + ".tmp", JSON.stringify(value)); renameSync(file + ".tmp", file); };
const arrive = (...values: any[]) => { updates.push(...values); atomic(join(api, "updates.json"), updates); };
const setControl = (name: TokenName, value: { state: "revoked" } | { botId: number }) => { control[LABEL[name]] = value; atomic(join(api, "tokens.json"), control); };
const tokenRequests = () => lines(join(api, "token-requests.jsonl"));
const tokenCount = (name: TokenName, method?: string) => tokenRequests().filter(entry => entry.token === LABEL[name] && (method === undefined || entry.method === method)).length;
const pollsSince = (index: number) => tokenRequests().slice(index).filter(entry => entry.method === "getUpdates");
const sent = () => lines(join(api, "sent.jsonl"));
const status = async () => (await harness!.request("GET", "/api/telegram/status")).body;
const runs = async () => ((await harness!.request("GET", "/api/routines")).body?.runs ?? []).filter((run: any) => run.telegramConnectionId === BOT);
const telegramFile = (name: string) => join(harness!.data, "telegram", name);
const connectionBytes = () => existsSync(telegramFile("connection.json")) ? readFileSync(telegramFile("connection.json"), "utf8") : null;
const paused = () => { try { return JSON.parse(connectionBytes() ?? "{}").paused === true; } catch { return false; } };
const channel = () => existsSync(telegramFile(`${BOT}.json`)) ? JSON.parse(readFileSync(telegramFile(`${BOT}.json`), "utf8")) : null;
const bindingBytes = () => JSON.stringify(channel()?.binding ?? null);
const configTokenDigest = () => { const value = JSON.parse(readFileSync(join(harness!.data, "config.json"), "utf8")).telegram?.botToken; return typeof value === "string" ? (value ? sha256(value) : "") : null; };
const humans = async () => JSON.stringify(((await harness!.request("POST", "/api/memory/action", { action: "humans" })).body?.bindings ?? [])
  .filter((item: any) => item.origin?.platform === "telegram" && item.origin?.userId === String(OWNER)).map(({ id, active, personId, revision, state }: any) => ({ id, active, personId, revision, state })));
const patchToken = (name: TokenName, external: boolean) => harness!.request("PATCH", external ? "/api/config?secretStorage=external" : "/api/config", { telegram: { botToken: TOKENS[name] } });
const refusal = (response: { status: number; body: any }) => ({ http: response.status, error: response.body?.error });
const pick = (value: any) => value && { resumeState: value.resumeState, paired: value.paired, enabled: value.enabled, error: value.error, connecting: value.connecting, canResume: value.canResume,
  canReplaceToken: value.canReplaceToken, requiresRevoke: value.requiresRevoke, resumeMessage: value.resumeMessage, humanBindingState: value.humanBindingState };
const message = (from: number, text: string) => ({ update_id: ++updateId, message: { message_id: updateId, date: 1_700_000_000 + updateId, text,
  from: { id: from, is_bot: false }, chat: { id: from, type: "private" } } });
const copyEvidence = (from: string, names: string[], to: string, prefix: string) => { for (const name of names) if (existsSync(join(from, name))) copyFileSync(join(from, name), join(to, prefix + name)); };
const cleanGitEnv = () => { const env: NodeJS.ProcessEnv = {}; for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_")) env[key] = value; return env; };

/** Extract the SP-T1 diff: a .diff file as is, or the first ```diff block under "## SP-T1" in a Markdown patch ledger. */
function readPatch(source: string) {
  const text = readFileSync(source, "utf8");
  if (!source.endsWith(".md")) return text;
  const all = text.split("\n"), heading = all.findIndex(line => line.startsWith("## SP-T1"));
  const start = heading === -1 ? -1 : all.findIndex((line, index) => index > heading && line.trim() === "```diff");
  const end = start === -1 ? -1 : all.findIndex((line, index) => index > start && line.trim() === "```");
  if (end === -1) throw new Error("No ```diff block under ## SP-T1 in the patch source.");
  return all.slice(start + 1, end).join("\n") + "\n";
}

/** The private overlay: a copy of this checkout in the OS temp dir with SP-T1 applied, never inside Git or the checkout. */
function createOverlay(parent: string) {
  const tree = join(parent, "tree");
  if (inside(parent, CHECKOUT)) throw new Error("The overlay must be outside the checkout.");
  const diff = readPatch(resolve(patchSource!)), patchFile = join(parent, "sp-t1.diff");
  writeFileSync(patchFile, diff, { mode: 0o600 });
  const indexBefore = sha256(readFileSync(join(CHECKOUT, "server", "index.ts")));
  cpSync(CHECKOUT, tree, { recursive: true, verbatimSymlinks: true, filter: source => !["node_modules", ".git"].includes(relative(CHECKOUT, source).split(sep)[0]) });
  symlinkSync(realpathSync(join(CHECKOUT, "node_modules")), join(tree, "node_modules"), "dir");
  const env = { ...cleanGitEnv(), GIT_CEILING_DIRECTORIES: parent };
  const outsideGit = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: tree, env, encoding: "utf8" }).status !== 0;
  const check = spawnSync("git", ["apply", "--check", patchFile], { cwd: tree, env, encoding: "utf8" });
  const apply = check.status === 0 ? spawnSync("git", ["apply", patchFile], { cwd: tree, env, encoding: "utf8" }) : check;
  const patched = readFileSync(join(tree, "server", "index.ts"), "utf8");
  return { tree, outsideGit, indexBefore, patchSha256: sha256(diff), applyExit: apply.status, applyError: apply.stderr?.trim().slice(0, 400) || null,
    applied: apply.status === 0 && patched.includes("telegram.replaceToken(") && sha256(patched) !== indexBefore };
}

async function session(lib: HarnessModule, label: string, dir: string, external: boolean) {
  harness = await lib.createHarness({ label: `telegram-auth-${label}`, evidenceDir: dir, preload: join(lib.ROOT, "scripts", "channel-telegram-token-fake-api.mjs"),
    env: () => ({ CHANNEL_LIVE_TELEGRAM_DIR: api }),
    secretEnv: (): Record<string, string> => external && delivered ? { MURAGE_TELEGRAM_BOT_TOKEN: TOKENS[delivered] } : {} });
  api = join(harness.root, "telegram-api");
  mkdirSync(api, { mode: 0o700 });
  updates.length = 0; updateId = 0; delivered = null;
  for (const key of Object.keys(control)) delete control[key];
  await harness.boot();
  const chief = await lib.promoteFixtureChief(harness, "Auth Recovery Chief");
  const saved = await patchToken("A", external);
  if (saved.status !== 200) throw new Error(`${label}: token save refused ${saved.status}`);
  delivered = "A";
  const pairing = await harness.request("POST", "/api/telegram/pair", {});
  if (pairing.status !== 200 || typeof pairing.body?.code !== "string") throw new Error(`${label}: pairing refused ${pairing.status}`);
  arrive(message(OWNER, `/pair ${pairing.body.code}`));
  await lib.waitFor(`${label} paired`, status, value => value.paired === true && value.resumeState === "active", 30_000);
  await lib.waitFor(`${label} pairing acknowledgement`, sent, list => list.length >= 1, 30_000);
  return chief;
}

async function journeys(lib: HarnessModule) {
  const { sleep, waitFor } = lib;
  const settle = () => sleep(4_000); // more than two receive cycles at the service's 1.5 s cadence
  const optional = <T>(value: Promise<T>) => value.catch(() => null);

  const chief = await session(lib, mode, evidence, true);
  const link = await lib.linkChannelOwner(harness!, "telegram", String(OWNER));
  arrive(message(OWNER, "First linked request: reply once."));
  await optional(waitFor("first reply", sent, list => list.length >= 2, 45_000));
  await settle();
  checks.expect("R0.setup", "the owner pairs, links the channel account, and one message creates one run and one reply",
    link.stateBefore === "link-required" && (await runs()).length === 1 && sent().length === 2 && sent()[1].text === REPLY && (await status()).humanBindingState === "linked",
    { link, runs: (await runs()).length, sent: sent().length });
  const pinned = { connection: connectionBytes(), binding: bindingBytes(), offset: channel()?.offset as number, humans: await humans() };

  // R0 — Telegram rejects the saved token while polling.
  setControl("A", { state: "revoked" });
  const blocked = await waitFor("401 block", status, value => value.resumeState === "blocked" && value.error === "auth", 30_000);
  const blockIndex = tokenRequests().length;
  await sleep(3_000);
  const retry = await harness!.request("POST", "/api/telegram/resume", {});
  const repair = await harness!.request("POST", "/api/telegram/pair", {});
  const afterRefusals = await status();
  const deadEnd = retry.status === 409 && repair.status !== 200 && afterRefusals.resumeState === "blocked" && afterRefusals.canResume === false
    && pollsSince(blockIndex).length === 0 && connectionBytes() === pinned.connection && bindingBytes() === pinned.binding;
  const r0 = { blocked: pick(blocked), retry: refusal(retry), pair: refusal(repair), afterRefusals: pick(afterRefusals), pollsSinceBlock: pollsSince(blockIndex).length };

  if (mode === "baseline") {
    const replace = await patchToken("B", true);
    if (replace.status === 200) delivered = "B";
    await settle();
    const after = await status();
    checks.expect("R0.dead-end", "without SP-T1 a 401 leaves only revoke + re-pair: Retry 409, Pair refused, a token save 409 before any Telegram call, nothing saved",
      deadEnd && replace.status === 409 && /Revoke Telegram before changing its token/.test(replace.body?.error ?? "") && tokenCount("B") === 0 && configTokenDigest() === ""
        && delivered === "A" && after.resumeState === "blocked" && connectionBytes() === pinned.connection && bindingBytes() === pinned.binding,
      { ...r0, replace: refusal(replace), tokenBRequests: tokenCount("B"), after: pick(after) });
    checks.observe("R0.baseline.replace-offered", "canReplaceToken reported by this checkout's service while its unpatched config route refuses the token (the service change and SP-T1 must land together)",
      { canReplaceToken: after.canReplaceToken ?? null });
    return;
  }

  checks.expect("R0.post-patch", "with SP-T1 a 401 block offers token replacement, not Retry; Retry stays 409 and Pair stays refused",
    deadEnd && blocked.canReplaceToken === true && afterRefusals.canReplaceToken === true && String(afterRefusals.resumeMessage).includes("Paste a new token"), r0);

  // R1 — a token for a different bot is refused before anything is saved.
  setControl("C", { botId: OTHER_BOT });
  const wrong = await patchToken("C", true);
  if (wrong.status === 200) delivered = "C";
  await settle();
  const r1 = await status();
  checks.expect("R1.wrong-bot", "a token for a different bot is refused (409) after one getMe, never polls, saves nothing and keeps the connection replaceable",
    wrong.status === 409 && /different Telegram bot/.test(wrong.body?.error ?? "") && r1.resumeState === "blocked" && r1.canReplaceToken === true && r1.canResume === false
      && tokenCount("C") === 1 && tokenCount("C", "getMe") === 1 && pollsSince(blockIndex).length === 0 && configTokenDigest() === "" && delivered === "A"
      && connectionBytes() === pinned.connection && bindingBytes() === pinned.binding && channel()?.offset === pinned.offset,
    { wrong: refusal(wrong), status: pick(r1), tokenCRequests: tokenRequests().filter(entry => entry.token === LABEL.C).map(entry => entry.method), pollsSinceBlock: pollsSince(blockIndex).length, delivered });

  // R2 — a token for the same bot resumes the saved pairing.
  const r2Index = tokenRequests().length;
  const same = await patchToken("B", true);
  if (same.status === 200) delivered = "B";
  const active = await optional(waitFor("same-bot resume", status, value => value.resumeState === "active" && value.paired === true && value.error === null, 10_000));
  await settle();
  const r2Polls = pollsSince(r2Index);
  checks.expect("R2.same-bot", "a same-bot token is accepted (200) and resumes the saved pairing: same selector bytes and binding, offset kept, getMe twice, polling only with the new token",
    same.status === 200 && Boolean(active) && connectionBytes() === pinned.connection && bindingBytes() === pinned.binding && (channel()?.offset ?? -1) >= pinned.offset
      && tokenCount("B", "getMe") === 2 && r2Polls.length > 0 && r2Polls.every(entry => entry.token === LABEL.B) && configTokenDigest() === "",
    { same: refusal(same), status: pick(active), getMeB: tokenCount("B", "getMe"), polls: r2Polls.length, pollLabels: [...new Set(r2Polls.map(entry => entry.token))] });

  // R3 — no relink: one message, one run, one reply.
  const runsBefore = (await runs()).length, sentBefore = sent().length;
  arrive(message(OWNER, "Request after the token replacement: reply once."));
  await optional(waitFor("reply after replacement", sent, list => list.length >= sentBefore + 1, 45_000));
  await settle();
  const r3 = await status();
  checks.expect("R3.no-relink", "without linking again, one owner message creates exactly one run and one reply, and the channel person binding is unchanged",
    (await runs()).length === runsBefore + 1 && sent().length === sentBefore + 1 && sent().at(-1)?.text === REPLY && (await humans()) === pinned.humans && r3.humanBindingState === "linked",
    { runs: (await runs()).length - runsBefore, replies: sent().length - sentBefore, humansUnchanged: (await humans()) === pinned.humans, status: pick(r3) });

  // R4 — a same-data restart resumes with the replacement token.
  const getMeB = tokenCount("B", "getMe"), r4Index = tokenRequests().length;
  const r4Exit = await harness!.restart();
  const r4 = await optional(waitFor("resume after restart", status, value => value.resumeState === "active" && value.paired === true, 30_000));
  const r4Requests = tokenRequests().slice(r4Index);
  checks.expect("R4.restart", "a same-data restart resumes the pairing with the replacement token only, without a new code",
    r4Exit.exitCode === 0 && Boolean(r4) && tokenCount("B", "getMe") === getMeB + 1 && r4Requests.length > 0 && r4Requests.every(entry => entry.token === LABEL.B)
      && connectionBytes() === pinned.connection && bindingBytes() === pinned.binding,
    { exit: r4Exit, status: pick(r4), labels: [...new Set(r4Requests.map(entry => entry.token))] });

  // R5 — the saved token is rejected at startup.
  await harness!.stop();
  setControl("B", { state: "revoked" });
  const r5Index = tokenRequests().length;
  await harness!.boot();
  const bootBlocked = await optional(waitFor("boot 401 block", status, value => value.resumeState === "blocked" && value.canReplaceToken === true, 30_000));
  await sleep(3_000);
  const bootPolls = pollsSince(r5Index).length;
  const third = await patchToken("E", true);
  if (third.status === 200) delivered = "E";
  const r5 = await optional(waitFor("resume after boot replacement", status, value => value.resumeState === "active" && value.paired === true, 10_000));
  checks.expect("R5.boot-401", "a token rejected at startup is replaceable without polling, and a same-bot token resumes the same pairing",
    Boolean(bootBlocked) && bootBlocked?.canResume === false && bootPolls === 0 && third.status === 200 && Boolean(r5) && tokenCount("E", "getMe") === 2
      && connectionBytes() === pinned.connection && bindingBytes() === pinned.binding,
    { bootBlocked: pick(bootBlocked), bootPolls, third: refusal(third), status: pick(r5) });

  // R6 — after a Chief change the connection is paused and never replaceable.
  setControl("E", { state: "revoked" });
  await optional(waitFor("401 block before Chief change", status, value => value.resumeState === "blocked" && value.error === "auth" && value.canReplaceToken === true, 30_000));
  const demoted = await harness!.request("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: false });
  const fenced = await optional(waitFor("Chief-change pause", status, value => value.canReplaceToken === false && paused(), 20_000));
  const fourth = await patchToken("D", true);
  if (fourth.status === 200) delivered = "D";
  await settle();
  const r6Index = tokenRequests().length;
  const r6Exit = await harness!.restart();
  await sleep(3_000);
  const r6 = await status();
  checks.expect("R6.chief-fence", "after the Chief changes a replacement token is refused without any getMe on it, the pause persists, and a restart contacts no Telegram API",
    demoted.status === 200 && Boolean(fenced) && fourth.status === 409 && /Revoke Telegram before changing its token/.test(fourth.body?.error ?? "") && tokenCount("D") === 0
      && paused() && delivered === "E" && r6Exit.exitCode === 0 && r6.resumeState === "blocked" && r6.canReplaceToken === false && tokenRequests().length === r6Index,
    { demoted: demoted.status, fenced: pick(fenced), fourth: refusal(fourth), tokenDRequests: tokenCount("D"), paused: paused(), afterRestart: pick(r6), callsAfterRestart: tokenRequests().length - r6Index });
  copyEvidence(api, ["requests.jsonl", "token-requests.jsonl", "sent.jsonl", "tokens.json"], evidence, "telegram-desktop-");
  copyEvidence(join(harness!.data, "telegram"), ["connection.json", `${BOT}.json`], evidence, "telegram-desktop-state-");
  await harness!.request("POST", "/api/telegram/revoke", {});
  await harness!.close();
  harness = undefined;

  // R7 — the non-desktop path keeps the token in config.json; compare digests only.
  const plain = join(evidence, "plain-config");
  await session(lib, "plain", plain, false);
  setControl("A", { state: "revoked" });
  await optional(waitFor("plain 401 block", status, value => value.resumeState === "blocked" && value.error === "auth" && value.canReplaceToken === true, 30_000));
  const plainSelector = connectionBytes(), plainBinding = bindingBytes();
  setControl("C", { botId: OTHER_BOT });
  const plainWrong = await patchToken("C", false);
  const digestAfterWrong = configTokenDigest();
  const plainSame = await patchToken("B", false);
  const plainActive = await optional(waitFor("plain resume", status, value => value.resumeState === "active" && value.paired === true, 10_000));
  checks.expect("R7.plain-config", "on the plain config path a wrong-bot token leaves config.json holding the saved token and a same-bot token replaces it (sha256 compared, never printed)",
    plainWrong.status === 409 && digestAfterWrong === sha256(TOKENS.A) && plainSame.status === 200 && configTokenDigest() === sha256(TOKENS.B) && Boolean(plainActive)
      && connectionBytes() === plainSelector && bindingBytes() === plainBinding,
    { wrong: refusal(plainWrong), keptSavedToken: digestAfterWrong === sha256(TOKENS.A), same: refusal(plainSame), holdsReplacement: configTokenDigest() === sha256(TOKENS.B), status: pick(plainActive) });
  copyEvidence(api, ["token-requests.jsonl", "tokens.json"], plain, "telegram-plain-");
  await harness!.request("POST", "/api/telegram/revoke", {});
}

let overlayParent: string | undefined;
let overlay: ReturnType<typeof createOverlay> | undefined;
try {
  let root = CHECKOUT;
  if (mode === "overlay") {
    overlayParent = mkdtempSync(join(tmpdir(), "murage-t1-overlay-"));
    overlay = createOverlay(overlayParent);
    checks.expect("overlay.prepared", "the private overlay is outside Git and the checkout, and SP-T1 applies to its server/index.ts only",
      overlay.outsideGit && overlay.applied && !inside(overlayParent, CHECKOUT), { applyExit: overlay.applyExit, applyError: overlay.applyError, outsideGit: overlay.outsideGit, patchSha256: overlay.patchSha256 });
    if (!overlay.applied || !overlay.outsideGit) throw new Error("overlay not prepared");
    root = overlay.tree;
  }
  const lib: HarnessModule = await import(pathToFileURL(join(root, "scripts", "channel-live-harness.ts")).href);
  if (realpathSync(lib.ROOT) !== realpathSync(root)) throw new Error("harness root does not match the selected server tree");
  await journeys(lib);
} catch (error) {
  checks.expect("fixture.completed", "the journeys reached their final step", false, { error: error instanceof Error ? error.message : String(error) });
} finally {
  await finishCleanup(harness, checks);
  if (overlayParent) {
    await removeTempDir(overlayParent).catch(() => {});
    checks.expect("overlay.removed", "the private overlay directory is removed", !existsSync(overlayParent), { removed: !existsSync(overlayParent) });
  }
}
if (overlay) checks.expect("overlay.checkout-untouched", "the checkout's server/index.ts is byte-identical after the overlay run", sha256(readFileSync(join(CHECKOUT, "server", "index.ts"))) === overlay.indexBefore);
checks.expect("cleanup.absent", "the owned fixture roots are absent", !harness || !existsSync(harness.root));
const leaked: string[] = [];
const scan = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) scan(path);
    else { const bytes = readFileSync(path); for (const [name, token] of Object.entries(TOKENS)) if (bytes.includes(token)) leaked.push(`${name} ${path}`); }
  }
};
scan(evidence);
const labelsOnly = [join(evidence, "telegram-desktop-token-requests.jsonl"), join(evidence, "plain-config", "telegram-plain-token-requests.jsonl")]
  .flatMap(file => lines(file)).every(entry => typeof entry.token === "string" && /^[0-9a-f]{12}$/.test(entry.token));
checks.expect("custody.evidence", "no token bytes (A-E) appear in evidence, server logs or token request logs, which carry sha256 labels only", leaked.length === 0 && labelsOnly, { leaked, labelsOnly });
const result = { mode, server: mode === "overlay" ? "private overlay copy with SP-T1 applied" : mode === "integrated" ? "this checkout with SP-T1 joined (unstaged, root lease)" : "this checkout, unpatched",
  provider: "scripted Telegram Bot API stand-in, per-token wrapper", engine: "fake Claude CLI", node: process.version, tokenLabels: LABEL, patchSha256: overlay?.patchSha256 ?? null,
  serverIndexSha256: mode === "integrated" ? indexSha256 : null, checks: checks.list,
  failed: checks.list.filter(check => check.outcome === "fail").map(check => check.id), observed: checks.list.filter(check => check.outcome === "observed").map(check => check.id) };
writeFileSync(join(evidence, "result.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
process.stdout.write(`result ${JSON.stringify({ mode, passed: checks.list.filter(check => check.outcome === "pass").length, failed: result.failed, observed: result.observed })}\n`);
process.exitCode = result.failed.length ? 1 : 0;
