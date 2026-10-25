// F4 C2: the Cloud window's "Sign <bot> in to <engine>" for a bot that is on Fuigo while another bot is signed in to an engine.
// Two faces of one offer: a step right after a bot is made (Skip leaves it on Fuigo), and a banner on the bot's own surface that
// stays until the bot is signed in or the owner says "Not now" (kept on the home). The sign-in itself runs in the local window
// (it holds the pairing), through the same per-bot vendor sign-in the Connect panel uses. No token is ever copied.
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { CREATE_STEP_SKIP, ownSignInNeeded, type HomeBot, OFFER_DISMISS, botOfferButton, createStepBody, createStepButton, createStepTitle, type CreateStep } from "@/lib/cloud-signin-status";
import { isCloudOrigin } from "@/lib/cloud-workspace";
import { onNewBot, type NewBotAnnouncement } from "@/lib/new-bot-step";
import { api } from "@/state/store";

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
}

export function BotSignInOfferView({ bot, step, variant, busy, error, onSignIn, onDismiss }: BotSignInOfferViewProps) {
  const isStep = variant === "step", isGate = variant === "gate";
  return (
    <section aria-label={createStepTitle(bot.name, step)} className="flex flex-col gap-2 text-[13px] text-ink">
      {isStep || isGate ? <h2 className="text-[15px] font-semibold">{createStepTitle(bot.name, step)}</h2> : null}
      <p className="text-ink-secondary">{isGate ? `${bot.name} needs its own ${step.label} sign-in before you can chat.` : isStep ? createStepBody(bot.name, step) : `${step.label} is signed in on another bot. ${bot.name} needs its own ${step.label} sign-in.`}</p>
      {error ? <p role="alert" className="text-danger">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={busy} onClick={onSignIn}>{isStep || isGate ? createStepButton(bot.name, step) : botOfferButton({ id: bot.id, name: bot.name }, step.label)}</button>
        {isGate ? null : <button type="button" className={button} onClick={onDismiss}>{isStep ? CREATE_STEP_SKIP : OFFER_DISMISS}</button>}
      </div>
    </section>
  );
}

/** What the home says this bot should be offered, or null. Only on a Cloud home; anywhere else there is no offer. */
export function useBotSignInStep(botId: string | null, refreshKey: unknown = null): [CreateStep | null, () => void] {
  const [step, setStep] = useState<CreateStep | null>(null);
  useEffect(() => {
    setStep(null);
    if (!botId || !isCloudOrigin()) return;
    let alive = true;
    void api(`/api/cloud/engine-signins?forBot=${encodeURIComponent(botId)}`)
      .then((answer: { createStep?: CreateStep | null }) => { if (alive) setStep(answer.createStep?.engine && answer.createStep.label ? answer.createStep : null); }, () => {});
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
  if (!bridge?.requestSignIn) return "Open Murage on this computer to sign in.";
  try { await bridge.requestSignIn({ bot: botId, engine }); return null; } catch (cause) { return cause instanceof Error && cause.message ? cause.message : "Something went wrong. Try again."; }
}

/** Runs the bot's sign-in in the local window, keeping `busy` and `error` current. true only when it started without a failure. */
export async function runOfferSignIn(botId: string, engine: string, ui: { setBusy(busy: boolean): void; setError(message: string): void }): Promise<boolean> {
  ui.setBusy(true); ui.setError("");
  const failure = await requestSignIn(botId, engine);
  ui.setBusy(false);
  if (failure) { ui.setError(failure); return false; }
  return true;
}

function useOfferActions(bot: { id: string }, step: CreateStep | null, clear: () => void) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return {
    error, busy,
    signIn: async (): Promise<boolean> => (step ? runOfferSignIn(bot.id, step.engine, { setBusy, setError }) : false),
    dismiss: async (keep: boolean) => { if (step && keep) await dismissOffer(bot.id, step.engine).catch(() => {}); clear(); },
  };
}

/** The banner on a bot's own surface: stays until the bot is signed in (the home stops offering it) or the owner dismisses it. */
export function BotSignInOffer({ bot }: { bot: { id: string; name: string; modelSelection?: { instanceId?: string } } }) {
  const [step, clear] = useBotSignInStep(bot.id, bot.modelSelection?.instanceId);
  const actions = useOfferActions(bot, step, clear);
  if (!step) return null;
  return <div className="px-4 py-2"><BotSignInOfferView bot={bot} step={step} variant="banner" busy={actions.busy} error={actions.error} onSignIn={() => void actions.signIn()} onDismiss={() => void actions.dismiss(true)} /></div>;
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
    <div role="dialog" aria-modal="true" aria-label={createStepTitle(made.name, step)} className="overlay-inset fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-sm rounded-xl bg-card p-5 shadow-2xl">
        <BotSignInOfferView bot={made} step={step} variant="step" busy={actions.busy} error={actions.error}
          onSignIn={() => void actions.signIn().then((started) => { if (started) setMade(null); })} onDismiss={() => { clear(); setMade(null); }} />
      </div>
    </div>
  );
}

/** The last answer the home gave, with the (bot, refreshKey) it answered for. */
export type HeldLines = { key: string; lines: readonly HomeBot[] } | undefined;
export const linesKey = (botId: string, refreshKey: unknown): string => `${botId}\u0000${String(refreshKey)}`;
/** The held lines when they answer for `key`; undefined for any other bot or refreshKey. A refetch of the same key never empties them. */
export const readHeld = (held: HeldLines, key: string): readonly HomeBot[] | undefined => (held && held.key === key ? held.lines : undefined);

/** The home's per-bot sign-in lines (the same source as the status line in the Connect panel). undefined off a Cloud home, before the
 * home answers, or when it cannot: then nothing here blocks, and the pre-spawn check stays the backstop. Looks again when the window
 * regains focus and every few seconds while the bot is signed out, so finishing the sign-in opens the chat by itself. */
export function useHomeSignInLines(botId: string | null, refreshKey: unknown = null): readonly HomeBot[] | undefined {
  const [held, setHeld] = useState<HeldLines>(undefined);
  const [tick, setTick] = useState(0);
  const key = botId ? linesKey(botId, refreshKey) : null;
  const lines = key ? readHeld(held, key) : undefined;
  const waiting = lines !== undefined && botId !== null && ownSignInNeeded(lines, botId) !== null;
  useEffect(() => {
    // Nothing is cleared here: a tick or focus refetch keeps the last answer on screen until the new one lands. A different bot
    // (or refreshKey) reads as unanswered through its key, so another bot's lines never gate this one.
    if (!botId || !key || !isCloudOrigin()) return;
    let alive = true;
    void api("/api/cloud/engine-signins")
      .then((answer: { bots?: Array<HomeBot & { engine?: string; label?: string; signedIn?: boolean; uses?: "home" | "own" | null; signedInEngines?: string[] }> }) => {
        if (!alive || !Array.isArray(answer?.bots)) return;
        setHeld({ key, lines: answer.bots.map((line) => ({ id: line.id, name: line.name, signIn: line.engine ? { engine: line.engine, label: line.label ?? line.engine, signedIn: line.signedIn === true, uses: line.uses ?? null, signedInEngines: line.signedInEngines } : undefined })) });
      }, () => {});
    return () => { alive = false; };
  }, [botId, key, tick]);
  useEffect(() => {
    if (!botId || !isCloudOrigin() || typeof window === "undefined") return;
    const again = () => setTick((n) => n + 1);
    window.addEventListener("focus", again);
    const timer = waiting ? window.setInterval(again, 5000) : undefined;
    return () => { window.removeEventListener("focus", again); if (timer !== undefined) window.clearInterval(timer); };
  }, [botId, waiting]);
  return lines;
}

/** Stands in for the composer while the bot's OWN sign-in for its engine is missing: the same sign-in prompt, and nothing to send with.
 * Claude counts as signed in when the home's Claude sign-in is valid (or the bot's own account); every other engine is strictly per bot. */
export function ChatSignInGate({ bot, lines, children, onSignIn, busy, error }: { bot: { id: string; name: string }; lines: readonly HomeBot[] | undefined; children: ReactNode; onSignIn(step: CreateStep): void; busy?: boolean; error?: string }) {
  const step = lines ? ownSignInNeeded(lines, bot.id) : null;
  if (!step) return <>{children}</>;
  return (
    <div className="px-4 py-3" data-testid="chat-signin-gate">
      <BotSignInOfferView bot={bot} step={step} variant="gate" busy={busy} error={error} onSignIn={() => onSignIn(step)} onDismiss={() => {}} />
    </div>
  );
}

/** The live gate for a bot's chat. */
export function BotChatSignInGate({ bot, lines, children }: { bot: { id: string; name: string }; lines: readonly HomeBot[] | undefined; children: ReactNode }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const signIn = async (step: CreateStep) => { await runOfferSignIn(bot.id, step.engine, { setBusy, setError }); };
  return <ChatSignInGate bot={bot} lines={lines} busy={busy} error={error} onSignIn={(step) => void signIn(step)}>{children}</ChatSignInGate>;
}
