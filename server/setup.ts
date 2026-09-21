// The guided first-run state machine.
//
// The server owns the checklist. Every step's `done` is measured against
// live state on every read — a saved key, an engine that answered, a crew
// that exists, an app that is connected, a real reply, lines actually on
// disk — so nothing a model or a request body says can tick a box, and
// re-running `/setup` on a working install shows the finished steps as
// finished without reinstalling anything.
//
// Persistence follows the house pattern for per-install JSON state
// (section-context.ts, coordination-budget.ts): a versioned envelope, zod on
// the way in AND on the way out, `writeFileAtomic` at 0o600, and a file path
// injected by the caller so tests never touch the real data directory.
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  type SetupAgentReading,
  type SetupLiveState,
  type SetupRefusalReading,
  type SetupState,
  type SetupStep,
  type SetupStepState,
  deriveSetupState,
  emptySetupState,
  setupStateSchema,
} from "../shared/setup.ts";
import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { decodeInjectId, localHost } from "./drivers/local-inject.ts";
import { resolveFuigoCli } from "./env-path.ts";

export const SETUP_FILE = join(DATA_DIR, "setup.json");

/** A checklist is a few hundred bytes. Anything larger is not ours. */
const SETUP_FILE_MAX_BYTES = 64 * 1024;

// ── the included brain ─────────────────────────────────────────────────
export type BundledEngineStatus =
  | { ready: true; source: "path" | "bundled" }
  | { ready: false; reason: string };

/**
 * Whether the engine Murage ships can actually be run on this machine.
 *
 * `resolveFuigoCli` is the one resolver, and it fails loudly with a distinct
 * message for each way it can fail: nothing on PATH and no packaged
 * directory declared, a declared directory whose binary is missing, a binary
 * whose executable bit did not survive packaging. The brain step repeats that
 * sentence rather than offering a default that cannot answer — an install
 * where the bundled engine cannot run (an older glibc, a broken package) must
 * be told so and offered the alternatives.
 *
 * It says nothing about whether the engine can BUY anything. A binary that
 * runs and a key that authenticates still leave a third possibility — an
 * account that cannot spend — and only a turn that actually settled can rule
 * that out. That is the brain step's job, not this function's.
 */
export function bundledEngineStatus(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): BundledEngineStatus {
  try {
    return { ready: true, source: resolveFuigoCli(env, platform).source };
  } catch (error) {
    return { ready: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

// ── what this machine can already run ──────────────────────────────────
/** An engine as `registry.describe()` reports it. Structural, like
 *  `ReachableBot`, so this module never pulls the registry's own types into
 *  the contract. */
export interface SetupInstanceReading {
  instanceId: string;
  displayName?: string;
  driverKind?: string;
  enabled?: boolean;
  /** `authenticated` is TRI-STATE and every reader here treats it as one.
   *  See `signedOut` below for why that matters more than it looks. */
  snapshot: { state: string; authenticated?: boolean };
  /** What it can actually be asked to think with. Empty is the whole point:
   *  see `setupAgentsReading`. */
  models?: { default?: string };
  /** The driver's own install descriptor. Only `signInCommand` is read, and
   *  only to tell the person which command signs them in. */
  install?: { signInCommand?: string };
}

/**
 * This engine's driver ASKED whether anyone is signed in and was told no.
 *
 * `=== false`, never `!== true`, and the difference is the whole function.
 * `authenticated` is undefined on every driver that does not probe, which is
 * most of them, so `!== true` would call a working engine signed out. That
 * mistake has already been made once in this codebase and it is recorded in
 * `server/default-engine.ts`: filtering on it emptied the list on installs
 * where engines work perfectly well, and a delegated teammate ended up with
 * no engine at all (`server/unattended.test.ts` caught it).
 *
 * So this is deliberately narrow. It catches the drivers that genuinely went
 * and looked — Claude Code and Codex both run a real sign-in probe — and
 * nothing else. An engine that does not answer the question keeps the benefit
 * of the doubt and stays in `setupAgentsReading`, exactly as it does today.
 */
function signedOut(instance: SetupInstanceReading): boolean {
  return instance.snapshot.authenticated === false;
}

/** Everything the agents step asks of an engine EXCEPT whether anyone is
 *  signed into it. Shared so the two readings below cannot drift apart and
 *  start disagreeing about which engines they are even talking about. */
function runnable(instance: SetupInstanceReading): boolean {
  return instance.enabled !== false
    && instance.snapshot.state === "available"
    && (instance.models?.default ?? "").trim().length > 0;
}

/**
 * The model on this person's own hard disk, named the way they name it.
 *
 * WHAT THIS REPLACES. A person running llama.cpp or Ollama was told "you
 * already had OpenAI-compatible (OpenRouter / Groq) on this computer". That
 * is the generic connection's `displayName` (drivers/openai-compat.ts) put
 * into the Chief's mouth: an engine id, and two cloud vendors named at
 * somebody whose model is three feet away. It was the opening line.
 *
 * Nothing new had to be detected to fix it. A local pick is already encoded
 * as `host::model` and `decodeInjectId` already validates that the host is a
 * real one, so an engine whose default model decodes IS pointed at a local
 * server, and the decode hands over the model's name at the same time.
 * `localHost().label` then names the server the way its own UI does, which
 * is "Ollama" or "LM Studio" rather than a port number.
 *
 * Anyone who installed a local model will recognise it instantly, which is
 * the whole reason to say the model rather than the engine.
 */
function localModelOf(instance: SetupInstanceReading): { model: string; host: string } | undefined {
  const decoded = decodeInjectId((instance.models?.default ?? "").trim());
  if (!decoded) return undefined;
  const host = localHost(decoded.host);
  return host ? { model: decoded.model, host: host.label } : undefined;
}

/** One engine, as a card may describe it. */
function reading(instance: SetupInstanceReading): SetupAgentReading {
  const local = localModelOf(instance);
  return {
    id: instance.instanceId,
    name: instance.displayName?.trim() || instance.instanceId,
    installed: instance.driverKind !== "fuigoAgent",
    ...(local ? { localModel: local } : {}),
  };
}

/**
 * The engines the agents card may honestly claim.
 *
 * Available AND enabled AND able to think, because a card that says "I
 * connected Claude Code" about an engine that cannot answer is worse than
 * saying nothing.
 *
 * THE CATALOGUE IS THE PART THAT MATTERS, and it is the part this used to
 * miss. Murage SHIPS Fuigo's binary, so on a machine with nothing else on it
 * the CLI answers and reports itself available. That is not the same as being
 * able to think: Fuigo is a client, and with no key, no login and no local
 * runtime within reach its catalogue merges down to nothing. Availability
 * alone therefore told somebody with no brain at all that they had an engine,
 * ticked their agents step, and let the card say the one in the box was
 * already running and talking to them. It was not.
 *
 * `pickDefaultEngine` has always required a non-empty catalogue for exactly
 * this reason, and would have handed that same person no engine. The two
 * readings must agree, or the checklist says yes about the thing the selector
 * says no about.
 *
 * The bundled engine is `fuigoAgent` and is the one thing on the list the
 * person did not put there, so it is reported with `installed: false`: the
 * Chief says "one came in the box" about that and "you already had these"
 * about the rest, and never confuses the two.
 */
export function setupAgentsReading(instances: readonly SetupInstanceReading[]): SetupAgentReading[] {
  return instances
    .filter((instance) => runnable(instance) && !signedOut(instance))
    .map(reading);
}

/**
 * Here, and ready, and nobody is signed in.
 *
 * THE DEFECT THIS EXISTS TO END. Every driver carries a STATIC model list that
 * does not depend on auth, so a Claude Code that is installed and signed out
 * answers `--version`, reports itself available, and hands over a full
 * catalogue. It therefore satisfied every condition `setupAgentsReading` used
 * to have. Three things followed, in order: the Chief said in writing "you
 * already had Claude Code on this computer, so I have connected them", which
 * was false; the agents step ticked, because `setupStepDone` counts this list;
 * and on a machine with no Flux key it was the ONLY candidate `pickDefaultEngine`
 * had, so the Chief was pointed at it. The first thing that person ever asked
 * their assistant to do failed, after being told it was ready.
 *
 * The answer is not to hide these engines. Somebody who installed Codex knows
 * what it is, and the gap between them and a working subscription is one
 * command. So they are reported separately and OFFERED, which is also the
 * honest economics: signing them back into something they already pay for is
 * better for them than putting them on a metered router.
 *
 * `signInCommand` rides along because the driver is the only thing that knows
 * it, and the card would otherwise have to hardcode per-engine copy — the
 * exact thing `EngineInstall` exists to prevent.
 */
export function setupSignedOutReading(instances: readonly SetupInstanceReading[]): SetupAgentReading[] {
  return instances
    .filter((instance) => runnable(instance) && signedOut(instance))
    .map((instance) => ({
      ...reading(instance),
      ...(instance.install?.signInCommand ? { signInCommand: instance.install.signInCommand } : {}),
    }));
}

// ── reading the workspace ──────────────────────────────────────────────
/** A message as the checklist reads it. Structural, like `ReachableBot`, so
 *  this module never pulls the store's own types into the contract. */
export interface SetupMessageReading {
  role: string;
  kind: string;
  text?: string;
  turnTerminal?: boolean;
  at?: number;
  /** A failed turn's activity chip. Only the structured provider facts are
   *  read; the error text belongs to the card that already shows it. */
  tool?: { providerError?: { httpStatus: number; provider?: string } };
}

export interface SetupTaskReading {
  threadId: string;
  /** The engine that last dispatched this task. */
  lastInstanceId?: string;
}

export interface SetupBotReading {
  id: string;
  hidden?: boolean;
  threadId: string;
  /** The bot's OWN engine selection, not a task's. */
  modelSelection: { instanceId: string; model: string };
  tasks?: readonly SetupTaskReading[];
}

export interface SetupWorkspaceReading {
  bots: readonly SetupBotReading[];
  messagesFor(threadId: string): readonly SetupMessageReading[];
  /** Whether a picked model routes through Flux Router — the app's own
   *  `isFluxModel`, injected so this module stays free of the engine tables. */
  routesThroughFlux(model: string): boolean;
}

/**
 * A settled engine reply sits in this thread.
 *
 * `turnTerminal` is set only by the store when a provider turn settles, so a
 * freshly created bot — which is seeded with a greeting and an intake card,
 * both bot-authored — never reads as having answered. That distinction is the
 * whole point: "the engine said something" has to mean an engine ran.
 */
export function threadAnswered(messages: readonly SetupMessageReading[]): boolean {
  return messages.some(
    (message) =>
      message.role === "bot" &&
      message.kind === "text" &&
      message.turnTerminal === true &&
      (message.text ?? "").trim().length > 0,
  );
}

/** The newest provider rejection in a thread, or null when a settled reply
 *  is newer. A refusal the engine has since recovered from is history:
 *  leaving it standing would keep a step blocked for good, long after a
 *  spend ceiling reset or a different engine was chosen. */
function latestRefusal(messages: readonly SetupMessageReading[]): { at: number; refusal: SetupRefusalReading } | null {
  let answeredAt = -1;
  let newest: { at: number; refusal: SetupRefusalReading } | null = null;
  for (const message of messages) {
    const at = message.at ?? 0;
    if (message.role === "bot" && message.kind === "text" && message.turnTerminal === true) {
      answeredAt = Math.max(answeredAt, at);
    }
    const providerError = message.tool?.providerError;
    if (providerError && (newest === null || at >= newest.at)) {
      newest = {
        at,
        refusal: {
          httpStatus: providerError.httpStatus,
          ...(providerError.provider ? { provider: providerError.provider } : {}),
        },
      };
    }
  }
  return newest && newest.at > answeredAt ? newest : null;
}

/** The workspace facts the checklist measures. Threads other than the
 *  Chief's stop being scanned once one reply has been found: a mature
 *  workspace has thousands, and one is all that step asks for. */
export function readWorkspace(
  workspace: SetupWorkspaceReading,
  chiefBotId?: string,
): Pick<SetupLiveState, "chiefInstanceId" | "chiefAnsweredBy" | "chiefRefusal" | "chiefUsesFlux" | "crewSize" | "botReplyExists"> {
  const chief = chiefBotId ? workspace.bots.find((bot) => bot.id === chiefBotId) : undefined;
  const chiefAnsweredBy = new Set<string>();
  let botReplyExists = false;
  let chiefRefusal: { at: number; refusal: SetupRefusalReading } | null = null;
  for (const bot of workspace.bots) {
    const isChief = bot.id === chief?.id;
    if (botReplyExists && !isChief) continue;
    const tasks: readonly SetupTaskReading[] = bot.tasks?.length ? bot.tasks : [{ threadId: bot.threadId }];
    for (const task of tasks) {
      const messages = workspace.messagesFor(task.threadId);
      if (isChief) {
        const refusal = latestRefusal(messages);
        if (refusal && (chiefRefusal === null || refusal.at >= chiefRefusal.at)) chiefRefusal = refusal;
      }
      if (!threadAnswered(messages)) continue;
      botReplyExists = true;
      // A task with no recorded dispatch predates the field; it cannot prove
      // WHICH engine answered, so it counts for "a reply exists" and not for
      // the Chief's own brain.
      if (isChief && task.lastInstanceId) chiefAnsweredBy.add(task.lastInstanceId);
    }
  }
  return {
    chiefInstanceId: chief?.modelSelection.instanceId ?? "",
    chiefAnsweredBy: [...chiefAnsweredBy],
    chiefRefusal: chiefRefusal?.refusal ?? null,
    chiefUsesFlux: chief ? workspace.routesThroughFlux(chief.modelSelection.model) : false,
    crewSize: workspace.bots.filter((bot) => !bot.hidden && bot.id !== chief?.id).length,
    botReplyExists,
  };
}

// ── who the Chief is ───────────────────────────────────────────────────
export interface ChiefCandidate {
  id: string;
  hidden?: boolean;
  chiefOfStaff?: boolean;
  chiefScope?: "workspace";
  section?: string | null;
  createdAt: number;
}

export type ChiefDecision =
  /** Already recorded and still here. */
  | { kind: "keep"; botId: string }
  /** Record this bot; its role is already right, or not ours to change. */
  | { kind: "adopt"; botId: string }
  /** Record this bot AND make it the workspace Chief. */
  | { kind: "elect"; botId: string; section: string | null }
  | { kind: "none" };

/**
 * Which bot hosts setup.
 *
 * The bot a fresh install creates first IS the Chief of Staff, so on an empty
 * workspace this elects it. It elects ONLY when no bot carries a leadership
 * flag at all: an upgraded workspace that already has team leaders gets its
 * oldest visible bot recorded as the Chief without any role being rewritten,
 * because electing there would demote leaders the person chose, silently.
 * Once recorded, the choice stands — a crew installed later reports to the
 * Chief already met and never takes the role.
 */
export function chiefDecision(recorded: string | undefined, bots: readonly ChiefCandidate[]): ChiefDecision {
  if (recorded && bots.some((bot) => bot.id === recorded)) return { kind: "keep", botId: recorded };
  const workspaceChief = bots.find((bot) => !bot.hidden && bot.chiefOfStaff === true && bot.chiefScope === "workspace");
  if (workspaceChief) return { kind: "adopt", botId: workspaceChief.id };
  const visible = bots.filter((bot) => !bot.hidden);
  const oldest = visible.reduce<ChiefCandidate | null>(
    (best, bot) => (best === null || bot.createdAt < best.createdAt ? bot : best),
    null,
  );
  if (!oldest) return { kind: "none" };
  if (bots.some((bot) => bot.chiefOfStaff === true)) return { kind: "adopt", botId: oldest.id };
  return { kind: "elect", botId: oldest.id, section: oldest.section ?? null };
}

// ── the checklist ──────────────────────────────────────────────────────
function loadState(file: string, now: number): SetupState {
  if (!existsSync(file)) return emptySetupState(now);
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > SETUP_FILE_MAX_BYTES) return emptySetupState(now);
    const parsed = setupStateSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    // A damaged checklist is not worth a recovery screen: every step is
    // re-derived from live state anyway, so a fresh one re-ticks whatever is
    // genuinely finished. Only the recorded answers are lost.
    return parsed.success ? parsed.data : emptySetupState(now);
  } catch {
    return emptySetupState(now);
  }
}

/** Server-owned first-run checklist. The caller supplies live state on every
 *  call; this class never measures anything itself. */
export class SetupChecklist {
  private state: SetupState;
  private readonly file: string;
  private readonly now: () => number;

  constructor(file: string = SETUP_FILE, now: () => number = Date.now) {
    this.file = file;
    this.now = now;
    this.state = loadState(file, now());
  }

  private persist(next: SetupState): SetupState {
    const validated = setupStateSchema.parse(next);
    if (JSON.stringify(validated) !== JSON.stringify(this.state)) {
      writeFileAtomic(this.file, JSON.stringify(validated, null, 2), { mode: 0o600 });
      this.state = validated;
    }
    return this.state;
  }

  /** Re-derive every step from live state. Persisted when something moved,
   *  so a step that became true while the app was closed is durable. */
  read(live: SetupLiveState): SetupState {
    return this.persist(deriveSetupState(this.state, live, this.now()));
  }

  chiefBotId(): string | undefined {
    return this.state.chiefBotId;
  }

  /** Record the bot that hosts setup. Idempotent, and it never moves once
   *  set while that bot exists — `chiefDecision` owns that rule. */
  recordChief(botId: string): SetupState {
    if (this.state.chiefBotId === botId) return this.state;
    return this.persist({ ...this.state, chiefBotId: botId });
  }

  briefRoutineId(): string | undefined {
    return this.state.briefRoutineId;
  }

  /**
   * Remember which routine is the morning brief.
   *
   * A pointer rather than a flag on the routine itself, and rather than a
   * name match. The person is free to rename their brief, to have three
   * routines with "brief" in the name, or to have imported one from a
   * package; none of that should change which routine this step is about.
   * The pointer is checked against the live routine list on every read, so a
   * deleted brief puts the step back rather than leaving it done forever.
   */
  recordBriefRoutine(routineId: string): SetupState {
    if (this.state.briefRoutineId === routineId) return this.state;
    return this.persist({ ...this.state, briefRoutineId: routineId });
  }

  /** Record an answer. It clears a previous skip and is stored, never
   *  trusted: the re-derivation immediately after decides `done`. */
  answer(step: SetupStep, note: string, live: SetupLiveState): SetupState {
    const recorded = this.state.steps[step];
    const next: SetupStepState = { ...recorded, note: note.trim(), at: this.now() };
    delete next.skipped;
    return this.persist(
      deriveSetupState({ ...this.state, steps: { ...this.state.steps, [step]: next } }, live, this.now()),
    );
  }

  /** Pass a step over. Skipped is not done: the step stays outstanding and
   *  the checklist simply moves past it. */
  skip(step: SetupStep, live: SetupLiveState): SetupState {
    const recorded = this.state.steps[step];
    const next: SetupStepState = { ...recorded, skipped: true, at: this.now() };
    return this.persist(
      deriveSetupState({ ...this.state, steps: { ...this.state.steps, [step]: next } }, live, this.now()),
    );
  }

  /** Put a step back on the list. The answer is dropped and the step is
   *  re-derived, so one still backed by live state comes straight back as
   *  done — reopening asks again, it does not undo the install. */
  reopen(step: SetupStep, live: SetupLiveState): SetupState {
    const next: SetupStepState = { done: false };
    return this.persist(
      deriveSetupState({ ...this.state, steps: { ...this.state.steps, [step]: next } }, live, this.now()),
    );
  }
}
