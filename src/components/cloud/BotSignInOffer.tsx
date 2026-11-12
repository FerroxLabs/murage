// F4 C2: the Cloud window's "Sign <bot> in to <engine>" for a bot that is on Fuigo while another bot is signed in to an engine.
// Two faces of one offer: a step right after a bot is made (Skip leaves it on Fuigo), and a banner on the bot's own surface that
// stays until the bot is signed in or the owner says "Not now" (kept on the home). The sign-in itself runs in the local window
// (it holds the pairing), through the same per-bot vendor sign-in the Connect panel uses. No token is ever copied.
import { Suspense, lazy, useCallback, useEffect, useState, type ReactNode } from "react";

import { BROWSER_SIGNIN_ENGINES, CREATE_STEP_SKIP, FUIGO_SLOW_AFTER_MS, fuigoReadyLines, ownSignInNeeded, signInOfferHere, type HomeBot, OFFER_DISMISS, botOfferButton, createStepBody, createStepButton, createStepTitle, type CreateStep } from "@/lib/cloud-signin-status";
import { isCloudHome } from "@/lib/cloud-workspace";
import { onNewBot, type NewBotAnnouncement } from "@/lib/new-bot-step";
import { onCloudHomePage } from "@/lib/owner-code";
import { homeMeta } from "@/lib/cloud-home-meta";
import { releaseSignInTab, reserveSignInTab } from "@/lib/signin-tab";
import type { EngineLoginEngine } from "@/lib/engine-login-terminal";
import { api } from "@/state/store";

/** Whether this page can send the customer anywhere to sign `engine` in: the Cloud window's bridge, or a browser route. */
export function offerShownHere(engine: string, env: { homePage: boolean; bridge: boolean } = { homePage: onCloudHomePage(), bridge: typeof window !== "undefined" && typeof window.muragecloud?.requestSignIn === "function" }): boolean {
  return signInOfferHere(engine, env);
}

const EngineLoginTerminal = lazy(() => import("@/components/EngineLoginTerminal").then((module) => ({ default: module.EngineLoginTerminal })));

/** What a browser sign-in is for: the bot, and the engine the offer named. */
export interface BrowserSignInTarget { bot: { id: string; name: string }; engine: string; label: string }

/** Whether this page signs `engine` in itself: an owner's browser on a home, no Cloud window, and an engine the home's relay can drive from a browser. */
export const browserSignInHere = (engine: string, env: { homePage: boolean; bridge: boolean } = { homePage: onCloudHomePage(), bridge: typeof window !== "undefined" && typeof window.muragecloud?.requestSignIn === "function" }): boolean =>
  env.homePage && !env.bridge && BROWSER_SIGNIN_ENGINES.includes(engine);

/** The browser's sign-in: the vendor's own flow on the home, one tab to the vendor and one paste back. Closing it ends the sign-in. */
export function BrowserSignInDialog({ target, onClose }: { target: BrowserSignInTarget; onClose(): void }) {
  const homeId = typeof document === "undefined" ? "home" : (homeMeta(document).homeId ?? "home");
  return (
    <div role="dialog" aria-modal="true" data-box-exempt="sign-in card whose own body scrolls inside the viewport" aria-label={createStepTitle(target.bot.name, target)} className="overlay-inset fixed inset-x-0 top-0 z-50 flex h-[var(--vvh,100dvh)] items-center justify-center bg-black/50 p-4">
      <div className="max-h-full w-full max-w-lg overflow-y-auto overscroll-contain rounded-xl bg-card p-5 shadow-2xl">
        <Suspense fallback={<p role="status">Opening the sign-in...</p>}>
          <EngineLoginTerminal homeId={homeId} engine={target.engine as EngineLoginEngine} action="login" bot={target.bot} onClose={onClose} />
        </Suspense>
      </div>
    </div>
  );
}

const button = "rounded-md bg-control px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-inset disabled:opacity-50";

export interface BotSignInOfferViewProps {
  bot: { id: string; name: string };
  step: CreateStep;
  /** "step": right after the bot was made. "banner": on the bot's own surface. */
  variant: "step" | "banner" | "gate";
  busy?: boolean;
  error?: string;
  onSignIn(): void;
  /** Skip (step) or Not now (banner). */
  onDismiss(): void;
  /** The gate only: the other engines the owner may pick instead, each a button in their words. */
  choices?: readonly CreateStep[];
  onChoose?(step: CreateStep): void;
}

export function BotSignInOfferView({ bot, step, variant, busy, error, onSignIn, onDismiss, choices = [], onChoose }: BotSignInOfferViewProps) {
  const isStep = variant === "step", isGate = variant === "gate";
  return (
    <section aria-label={createStepTitle(bot.name, step)} className="flex flex-col gap-2 text-[13px] text-ink">
      {isStep || isGate ? <h2 className="text-[15px] font-semibold">{createStepTitle(bot.name, step)}</h2> : null}
      <p className="text-ink-secondary">{isGate ? `${bot.name} needs its own ${step.label} sign-in before you can chat.` : isStep ? createStepBody(bot.name, step) : `${step.label} is signed in on another bot. ${bot.name} needs its own ${step.label} sign-in.`}</p>
      {error ? <p role="alert" className="text-danger">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={busy} onClick={onSignIn}>{isStep || isGate ? createStepButton(bot.name, step) : botOfferButton({ id: bot.id, name: bot.name }, step.label)}</button>
        {isGate ? choices.map((choice) => <button key={choice.engine} type="button" className={button} disabled={busy} onClick={() => onChoose?.(choice)}>{createStepButton(bot.name, choice)}</button>) : <button type="button" className={button} onClick={onDismiss}>{isStep ? CREATE_STEP_SKIP : OFFER_DISMISS}</button>}
      </div>
    </section>
  );
}

/** What the home says this bot should be offered, or null. Only on a Cloud home; anywhere else there is no offer. */
export function useBotSignInStep(botId: string | null, refreshKey: unknown = null): [CreateStep | null, () => void] {
  const [step, setStep] = useState<CreateStep | null>(null);
  useEffect(() => {
    setStep(null);
    if (!botId || !isCloudHome()) return;
    let alive = true;
    void api(`/api/cloud/engine-signins?forBot=${encodeURIComponent(botId)}`)
      .then((answer: { createStep?: CreateStep | null }) => { if (alive) setStep(answer.createStep?.engine && answer.createStep.label && offerShownHere(answer.createStep.engine) ? answer.createStep : null); }, () => {});
    return () => { alive = false; };
  }, [botId, refreshKey]);
  return [step, useCallback(() => setStep(null), [])];
}

async function dismissOffer(botId: string, engine: string): Promise<void> {
  await api("/api/cloud/engine-signins/dismiss", { method: "POST", body: JSON.stringify({ bot: botId, engine }) });
}

/** Ask the local window to open the bot's sign-in. Resolves to a plain message when it could not. */
async function requestSignIn(botId: string, engine: string): Promise<string | null> {
  const bridge = typeof window === "undefined" ? undefined : window.muragecloud;
  if (!bridge?.requestSignIn) return "Open Settings, then Connect, to sign in.";
  try { await bridge.requestSignIn({ bot: botId, engine }); return null; } catch (cause) { return cause instanceof Error && cause.message ? cause.message : "Something went wrong. Try again."; }
}

/** Runs the bot's sign-in in the local window, keeping `busy` and `error` current. true only when it started without a failure. */
export async function runOfferSignIn(botId: string, engine: string, ui: { setBusy(busy: boolean): void; setError(message: string): void; openBrowser?(): void }): Promise<boolean> {
  // An owner's browser has no Cloud window to ask: it signs in right here, through the home.
  if (ui.openBrowser && browserSignInHere(engine)) { ui.setError(""); reserveSignInTab(); ui.openBrowser(); return true; }
  ui.setBusy(true); ui.setError("");
  const failure = await requestSignIn(botId, engine);
  ui.setBusy(false);
  if (failure) { ui.setError(failure); return false; }
  return true;
}

function useOfferActions(bot: { id: string; name?: string }, step: CreateStep | null, clear: () => void, afterBrowser: () => void = clear) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [browser, setBrowser] = useState<BrowserSignInTarget | null>(null);
  return {
    error, busy,
    /** The sign-in dialog of an owner's browser, or null. Render it beside the offer. */
    dialog: browser ? <BrowserSignInDialog target={browser} onClose={() => { setBrowser(null); afterBrowser(); }} /> : null,
    signIn: async (): Promise<boolean> => (step ? runOfferSignIn(bot.id, step.engine, { setBusy, setError, openBrowser: () => setBrowser({ bot: { id: bot.id, name: bot.name ?? bot.id }, engine: step.engine, label: step.label }) }) : false),
    dismiss: async (keep: boolean) => { if (step && keep) await dismissOffer(bot.id, step.engine).catch(() => {}); clear(); },
  };
}

/** The banner on a bot's own surface: stays until the bot is signed in (the home stops offering it) or the owner dismisses it. */
export function BotSignInOffer({ bot }: { bot: { id: string; name: string; modelSelection?: { instanceId?: string } } }) {
  // After a browser sign-in closes the home is asked again: the banner goes when the bot is signed in, and stays when it is not.
  const [again, setAgain] = useState(0);
  const [step, clear] = useBotSignInStep(bot.id, `${bot.modelSelection?.instanceId ?? ""}:${again}`);
  const actions = useOfferActions(bot, step, clear, () => setAgain((n) => n + 1));
  if (!step) return null;
  return <div className="px-4 py-2"><BotSignInOfferView bot={bot} step={step} variant="banner" busy={actions.busy} error={actions.error} onSignIn={() => void actions.signIn()} onDismiss={() => void actions.dismiss(true)} />{actions.dialog}</div>;
}

/** The step in the create-bot flow: shown for the bot just made when another bot is signed in to an engine. Skipping it leaves the
 * bot on Fuigo (and the banner keeps offering it). Finishing the sign-in moves the bot onto the engine on the home. */
export function NewBotSignInStep() {
  const [made, setMade] = useState<NewBotAnnouncement | null>(null);
  useEffect(() => onNewBot(setMade), []);
  const [step, clear] = useBotSignInStep(made?.id ?? null);
  const actions = useOfferActions(made ?? { id: "" }, step, clear);
  if (!made || !step) return null;
  return (
    <div role="dialog" aria-modal="true" data-box-exempt="sign-in card whose own body scrolls inside the viewport" aria-label={createStepTitle(made.name, step)} className="overlay-inset fixed inset-x-0 top-0 z-50 flex h-[var(--vvh,100dvh)] items-center justify-center bg-black/50 p-4">
      <div className="max-h-full w-full max-w-sm overflow-y-auto overscroll-contain rounded-xl bg-card p-5 shadow-2xl">
        <BotSignInOfferView bot={made} step={step} variant="step" busy={actions.busy} error={actions.error}
          onSignIn={() => void actions.signIn().then((started) => { if (started && !browserSignInHere(step.engine)) setMade(null); })} onDismiss={() => { clear(); setMade(null); }} />
        {actions.dialog}
      </div>
    </div>
  );
}

/** The last answer the home gave, with the (bot, refreshKey) it answered for. */
export type HeldLines = { key: string; lines: readonly HomeBot[] } | undefined;
export const linesKey = (botId: string, refreshKey: unknown): string => `${botId}\u0000${String(refreshKey)}`;
/** The held lines when they answer for `key`; undefined for any other bot or refreshKey. A refetch of the same key never empties them. */
export const readHeld = (held: HeldLines, key: string): readonly HomeBot[] | undefined => (held && held.key === key ? held.lines : undefined);

/** The engine a shown chat runs on: its own instance (the chat's picker, or the bot's setting) and that instance's driver kind. */
export interface InUseEngine { instanceId?: string; engine?: string }

/** The home's per-bot sign-in lines (the same source as the status line in the Connect panel). undefined off a Cloud home, before the
 * home answers, or when it cannot: then nothing here blocks, and the pre-spawn check stays the backstop. Looks again when the window
 * regains focus, on `refetch()`, and every few seconds while the chat is gated, so finishing the sign-in opens the chat by itself.
 * "Gated" is judged on `inUse`, the same engine the gate judges, so a chat on another engine than the bot's own keeps polling. */
export function useHomeSignInLines(botId: string | null, refreshKey: unknown = null, inUse: InUseEngine = {}): { lines: readonly HomeBot[] | undefined; refetch(): void } {
  const [held, setHeld] = useState<HeldLines>(undefined);
  const [tick, setTick] = useState(0);
  const key = botId ? linesKey(botId, refreshKey) : null;
  const lines = key ? readHeld(held, key) : undefined;
  const waiting = lines !== undefined && botId !== null && ownSignInNeeded(lines, botId, inUse.instanceId, inUse.engine) !== null;
  useEffect(() => {
    // Nothing is cleared here: a tick or focus refetch keeps the last answer on screen until the new one lands. A different bot
    // (or refreshKey) reads as unanswered through its key, so another bot's lines never gate this one.
    if (!botId || !key || !isCloudHome()) return;
    let alive = true;
    void api("/api/cloud/engine-signins")
      .then((answer: { bots?: Array<HomeBot & { engine?: string; label?: string; signedIn?: boolean; uses?: "home" | "own" | null; signedInEngines?: string[] }> }) => {
        if (!alive || !Array.isArray(answer?.bots)) return;
        setHeld({ key, lines: answer.bots.map((line) => ({ id: line.id, name: line.name, instanceId: line.instanceId, signIn: line.engine ? { engine: line.engine, label: line.label ?? line.engine, signedIn: line.signedIn === true, uses: line.uses ?? null, signedInEngines: line.signedInEngines } : undefined })) });
      }, () => {});
    return () => { alive = false; };
  }, [botId, key, tick]);
  useEffect(() => {
    if (!botId || !isCloudHome() || typeof window === "undefined") return;
    const again = () => setTick((n) => n + 1);
    window.addEventListener("focus", again);
    const timer = waiting ? window.setInterval(again, 5000) : undefined;
    return () => { window.removeEventListener("focus", again); if (timer !== undefined) window.clearInterval(timer); };
  }, [botId, waiting]);
  const refetch = useCallback(() => setTick((n) => n + 1), []);
  return { lines, refetch };
}

/** A chat's sign-in lines and the engine it runs on, computed once: the poll and the gate judge the same engine. */
export interface ChatSignIn { lines: readonly HomeBot[] | undefined; inUseEngine?: string; refetch(): void }
export function useChatSignIn(bot: { id: string; modelSelection?: { instanceId?: string } }, instances: readonly { instanceId: string; driverKind?: string }[]): ChatSignIn {
  const instanceId = bot.modelSelection?.instanceId;
  const inUseEngine = instances.find((instance) => instance.instanceId === instanceId)?.driverKind;
  const { lines, refetch } = useHomeSignInLines(bot.id, instanceId, { instanceId, engine: inUseEngine });
  return { lines, inUseEngine, refetch };
}

/** What ChatView puts in the composer slot: the gate for the engine the chat runs on, fed by `useChatSignIn`. */
export function ChatComposerGate({ bot, signIn, children, fuigoPending }: { bot: { id: string; name: string; modelSelection?: { instanceId?: string } }; signIn: ChatSignIn; children: ReactNode; /** CLOUD-NOKEY-FALLBACK (fuigoPendingHere). */ fuigoPending?: boolean }) {
  return <BotChatSignInGate bot={bot} lines={signIn.lines} inUseEngine={signIn.inUseEngine} onSignInEnd={signIn.refetch} fuigoPending={fuigoPending}>{children}</BotChatSignInGate>;
}

/** When each bot's "Getting Fuigo ready" card first showed this session, so a re-mount does not restart the 10 minute clock. */
const fuigoCardSince = new Map<string, number>();

/** CLOUD-NOKEY-FALLBACK: stands in for another engine's sign-in while the home's Flux credit is on its way. The text box stays, so the
 * owner can keep looking around; after 10 minutes the line says Fuigo is slow and where to get help. No sign-in button, no engine list. */
export function FuigoReadyCard({ botId, now = Date.now }: { botId: string; now?: () => number }) {
  const since = fuigoCardSince.get(botId) ?? now();
  if (!fuigoCardSince.has(botId)) fuigoCardSince.set(botId, since);
  const [elapsed, setElapsed] = useState(() => now() - since);
  useEffect(() => {
    if (elapsed >= FUIGO_SLOW_AFTER_MS) return;
    const timer = setTimeout(() => setElapsed(now() - since), Math.max(0, FUIGO_SLOW_AFTER_MS - elapsed));
    return () => clearTimeout(timer);
  }, [elapsed, since, now]);
  return <FuigoReadyView lines={fuigoReadyLines(elapsed)} />;
}

export function FuigoReadyView({ lines }: { lines: { title: string; line: string; others: string } }) {
  return (
    <div className="rounded-xl border border-hairline bg-raised p-4 text-[13px]" data-testid="fuigo-ready" role="status" aria-live="polite">
      <p className="font-medium text-ink">{lines.title}</p>
      <p className="mt-1 text-ink-secondary">{lines.line}</p>
      <p className="mt-2 text-[12px] text-ink-secondary">{lines.others}</p>
    </div>
  );
}

/** The engines a chat's gate offers, in the owner's order. Kimi and OpenCode are left to the Connect panel and Settings. */
export const GATE_ENGINES: readonly CreateStep[] = [{ engine: "claudeAgent", label: "Claude" }, { engine: "codex", label: "Codex" }, { engine: "grokAgent", label: "Grok" }];
export const gateChoices = (current: string): CreateStep[] => GATE_ENGINES.filter((choice) => choice.engine !== current && offerShownHere(choice.engine));

/** Move a bot onto `engine`: the same PATCH the model picker sends (setModel in the store), to the engine's default model. false when the home has no such engine ready. */
export async function switchBotEngine(botId: string, engine: string, call: (path: string, init?: RequestInit) => Promise<any> = api): Promise<boolean> {
  const answer = await call("/api/instances");
  const target = (answer?.instances ?? []).find((item: { driverKind?: string; enabled?: boolean; snapshot?: { state?: string }; models?: { default?: string } }) => item.driverKind === engine && item.enabled !== false && item.snapshot?.state === "available" && item.models?.default);
  if (!target) return false;
  await call(`/api/bots/${encodeURIComponent(botId)}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: target.instanceId, model: target.models.default }, settingsScope: "defaults" }) });
  return true;
}

/** Stands in for the composer while the bot's OWN sign-in for its engine is missing: the same sign-in prompt, and nothing to send with.
 * Claude counts as signed in when the home's Claude sign-in is valid (or the bot's own account); every other engine is strictly per bot. */
export function ChatSignInGate({ bot, lines, children, onSignIn, busy, error, inUseEngine, fuigoPending = false }: { bot: { id: string; name: string; modelSelection?: { instanceId?: string } }; lines: readonly HomeBot[] | undefined; /** The driver kind of the engine the shown chat runs on. */ inUseEngine?: string; children: ReactNode; onSignIn(step: CreateStep): void; busy?: boolean; error?: string; /** CLOUD-NOKEY-FALLBACK: a Cloud home whose Flux credit is not ready, on a chat not on Fuigo (fuigoPendingHere). */ fuigoPending?: boolean }) {
  // Every engine the owner can sign in to from here is a button, so they choose; the bot's own engine is the first.
  const needed = lines ? ownSignInNeeded(lines, bot.id, bot.modelSelection?.instanceId, inUseEngine) : null;
  // CLOUD-NOKEY-FALLBACK: while Flux is on its way a bot not yet on Fuigo (a sign-in it lacks, or no engine yet) waits for Fuigo; no
  // other engine's sign-in is offered here. The text box stays.
  if (fuigoPending && (needed || !bot.modelSelection?.instanceId)) {
    return <><div className="px-4 py-3" data-testid="chat-fuigo-pending"><FuigoReadyCard botId={bot.id} /></div>{children}</>;
  }
  // A browser on a home has no route for this engine: nothing blocks the chat, and the turn check says where to sign in.
  const step = needed && offerShownHere(needed.engine) ? needed : null;
  if (!step) return <>{children}</>;
  return (
    <div className="px-4 py-3" data-testid="chat-signin-gate">
      <BotSignInOfferView bot={bot} step={step} variant="gate" busy={busy} error={error} onSignIn={() => onSignIn(step)} onDismiss={() => {}} choices={gateChoices(step.engine)} onChoose={onSignIn} />
    </div>
  );
}

/** The live gate for a bot's chat. `onSignInEnd` asks the home again when the sign-in dialog closes or a sign-in request returns. */
export function BotChatSignInGate({ bot, lines, children, inUseEngine, onSignInEnd, fuigoPending }: { bot: { id: string; name: string; modelSelection?: { instanceId?: string } }; lines: readonly HomeBot[] | undefined; inUseEngine?: string; children: ReactNode; onSignInEnd?(): void; fuigoPending?: boolean }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [browser, setBrowser] = useState<BrowserSignInTarget | null>(null);
  const signIn = async (step: CreateStep) => {
    const needed = lines ? ownSignInNeeded(lines, bot.id, bot.modelSelection?.instanceId, inUseEngine) : null;
    // The click opens the empty tab now; the awaits below would otherwise cost the browser's permission for it.
    if (browserSignInHere(step.engine)) reserveSignInTab();
    if (needed && needed.engine !== step.engine) {
      // Another engine than the bot's own: move the bot onto it first. The home folds its own Claude sign-in into the bot's line, so a signed in Claude needs nothing more.
      setBusy(true); setError("");
      try {
        if (!(await switchBotEngine(bot.id, step.engine))) { setBusy(false); releaseSignInTab(); setError(`${step.label} is not ready on this home yet.`); return; }
        const answer = await api("/api/cloud/engine-signins") as { bots?: Array<{ id: string; engine?: string; signedIn?: boolean }> };
        if (answer.bots?.some((line) => line.id === bot.id && line.engine === step.engine && line.signedIn === true)) { setBusy(false); releaseSignInTab(); return; }
      } catch { setBusy(false); releaseSignInTab(); setError("Something went wrong. Try again."); return; }
      setBusy(false);
    }
    await runOfferSignIn(bot.id, step.engine, { setBusy, setError, openBrowser: () => setBrowser({ bot, engine: step.engine, label: step.label }) });
    onSignInEnd?.();
  };
  return <><ChatSignInGate bot={bot} lines={lines} inUseEngine={inUseEngine} busy={busy} error={error} fuigoPending={fuigoPending} onSignIn={(step) => void signIn(step)}>{children}</ChatSignInGate>{browser ? <BrowserSignInDialog target={browser} onClose={() => { setBrowser(null); onSignInEnd?.(); }} /> : null}</>;
}
