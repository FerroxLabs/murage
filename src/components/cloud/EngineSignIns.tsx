// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// B3 WP5: the engine sign-ins of a connected Cloud home, shown under that home's row on the Connect panel. Each opens the
// engine sign-in terminal (xterm relay). A per-bot sign-in (Codex, Grok, Kimi, OpenCode; CLOUD-ENGINES-DESIGN.md r8 R4)
// first asks which bot it is for. Runs in the MAIN (local) window only. No token or key is ever held here.
import { Suspense, lazy, useEffect, useRef, useState } from "react";

import { BOT_REQUIRED_COPY, engineLoginNeedsBot, type EngineLoginAction, type EngineLoginEngine } from "@/lib/engine-login-terminal";
import { HOME_CLAUDE_BUTTON, OWN_CLAUDE_BUTTON, botsToSignIn, canSignInHere, engineName, firstOffer, queueOfferButton, skipKey, queueOfferCopy, signInLine, type HomeBot } from "@/lib/cloud-signin-status";
import type { CloudHomeBridge } from "@/lib/cloud-workspace";

// The terminal brings xterm (about 70 KiB brotli), so it loads the first time a sign-in opens, not with the first paint.
const EngineLoginTerminal = lazy(() => import("@/components/EngineLoginTerminal").then((module) => ({ default: module.EngineLoginTerminal })));

export interface SignInTarget { homeId: string; engine: EngineLoginEngine; action?: EngineLoginAction; bot?: { id: string; name: string } | null }

/** The sign-ins a connected home offers: Claude's is the home's own, the others are per bot; Codex and OpenCode also take a typed API key. */
export const SIGN_INS: { engine: EngineLoginEngine; action: EngineLoginAction; label: string }[] = [
  { engine: "claudeAgent", action: "login", label: "Sign in to Claude" },
  { engine: "codex", action: "login", label: "Sign in to Codex" },
  { engine: "grokAgent", action: "login", label: "Sign in to Grok" },
  { engine: "kimiAgent", action: "login", label: "Sign in to Kimi" },
  { engine: "opencodeGo", action: "login", label: "Sign in to OpenCode" },
  { engine: "codex", action: "enroll-key", label: "Save a Codex API key" },
  { engine: "opencodeGo", action: "enroll-key", label: "Save an OpenCode API key" },
];

const button = "rounded-md bg-control px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-inset disabled:opacity-50";

export interface EngineSignInsViewProps {
  homeId: string;
  busy: boolean;
  signIn: SignInTarget | null;
  /** The bots of the home being signed in (null while they load). */
  botChoices: { id: string; name: string }[] | null;
  onSignIn(homeId: string, engine: EngineLoginEngine, action?: EngineLoginAction): void;
  onChooseBot(bot: { id: string; name: string }): void;
  onCloseSignIn(): void;
  /** F4 C2: the home's bots with their engine's sign-in state (absent while loading or when the home cannot say). */
  bots?: HomeBot[] | null;
  /** The next bot to offer after a sign-in finished, one at a time. */
  offer?: { bot: HomeBot; engine: string; label: string } | null;
  /** Start a bot's own sign-in (or sign-out, `logout`) directly: no bot picker. */
  onSignInBot?(bot: HomeBot, engine: EngineLoginEngine, action?: EngineLoginAction): void;
  onSkipOffer?(): void;
}

/** A sign-in the Cloud window asked for (a new bot's "Sign <bot> in to <engine>"): started once, then cleared. */
export interface SignInRequest { homeId: string; bot: string; engine: string }

export function EngineSignInsView(props: EngineSignInsViewProps) {
  const { homeId, busy, signIn } = props;
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {SIGN_INS.map(({ engine, action, label }) => (
          <button key={engine + action} type="button" className={button} disabled={busy} onClick={() => props.onSignIn(homeId, engine, action)}>{label}</button>
        ))}
      </div>
      {props.bots && props.bots.some((bot) => bot.signIn) ? <BotLines bots={props.bots} busy={busy} onSignInBot={props.onSignInBot} /> : null}
      {props.offer && !signIn ? (
        <section aria-label="Sign the other bots in" className="flex flex-col gap-2">
          <p>{queueOfferCopy(props.offer.bot, props.offer.label)}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={button} disabled={busy} onClick={() => props.onSignInBot?.(props.offer!.bot, props.offer!.engine as EngineLoginEngine)}>{queueOfferButton(props.offer.bot, props.offer.label)}</button>
            <button type="button" className={button} onClick={() => props.onSkipOffer?.()}>Not now</button>
          </div>
        </section>
      ) : null}
      {signIn?.homeId === homeId ? (
        engineLoginNeedsBot(signIn.engine, signIn.action ?? "login", signIn.bot)
          ? <BotChoice bots={props.botChoices} onChoose={props.onChooseBot} onCancel={props.onCloseSignIn} />
          : <Suspense fallback={<p role="status">Opening the sign-in...</p>}>
              <EngineLoginTerminal key={`${signIn.engine}:${signIn.action ?? "login"}:${signIn.bot?.id ?? ""}`} homeId={homeId} engine={signIn.engine}
                action={signIn.action ?? "login"} bot={signIn.bot ?? null} onClose={props.onCloseSignIn} />
            </Suspense>
      ) : null}
    </>
  );
}

/** One line per bot: its engine's state in plain words, and the one button that changes it. */
function BotLines({ bots, busy, onSignInBot }: { bots: HomeBot[]; busy: boolean; onSignInBot?: EngineSignInsViewProps["onSignInBot"] }) {
  return (
    <ul aria-label="Bot sign-ins" className="flex flex-col gap-1">
      {bots.filter((bot) => bot.signIn).map((bot) => {
        const state = bot.signIn!, engine = state.engine;
        return (
          <li key={bot.id} className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{bot.name}</span>
            <span className={state.signedIn ? "text-ink-secondary" : "text-ink"}>{signInLine(bot)}</span>
            {onSignInBot && canSignInHere(engine) ? (
              engine !== "claudeAgent"
                ? (!state.signedIn ? <button type="button" className={button} disabled={busy} onClick={() => onSignInBot(bot, engine)}>Sign in</button> : null)
                : (state.signedIn ? <button type="button" className={button} disabled={busy} onClick={() => onSignInBot(bot, engine, state.uses === "own" ? "logout" : "login")}>{state.uses === "own" ? HOME_CLAUDE_BUTTON : OWN_CLAUDE_BUTTON}</button> : null)
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Which bot a per-bot sign-in is for: the home's bots by name. */
function BotChoice({ bots, onChoose, onCancel }: { bots: { id: string; name: string }[] | null; onChoose: (bot: { id: string; name: string }) => void; onCancel: () => void }) {
  return (
    <section aria-label={BOT_REQUIRED_COPY} className="flex flex-col gap-2">
      <p>{BOT_REQUIRED_COPY}</p>
      {bots === null ? <p className="text-ink-secondary">Loading the bots on this home...</p>
        : bots.length === 0 ? <p className="text-ink-secondary">This home has no bots yet. Open it and add one, then sign the engine in for it.</p>
        : (
          <div className="flex flex-wrap gap-2">
            {bots.map((bot) => <button key={bot.id} type="button" className={button} onClick={() => onChoose(bot)}>{bot.name}</button>)}
          </div>
        )}
      <div><button type="button" className={button} onClick={() => onCancel()}>Cancel</button></div>
    </section>
  );
}

const messageOf = (cause: unknown) => (cause instanceof Error && cause.message ? cause.message : "Something went wrong. Try again.");

/** The stateful sign-ins for one connected home. `onError` shows a failure to read the home's bots. */
export function EngineSignIns({ bridge, homeId, busy, onError, request, onRequestHandled }: { bridge: CloudHomeBridge; homeId: string; busy: boolean; onError(message: string): void; request?: SignInRequest | null; onRequestHandled?(): void }) {
  const [signIn, setSignIn] = useState<SignInTarget | null>(null);
  const [botChoices, setBotChoices] = useState<{ id: string; name: string }[] | null>(null);
  const [bots, setBots] = useState<HomeBot[] | null>(null);
  const [offer, setOffer] = useState<{ bot: HomeBot; engine: string; label: string } | null>(null);
  // Bots the owner said "Not now" to for this visit; they are not offered again until the panel is reopened.
  const skipped = useRef<Set<string>>(new Set());
  const refresh = async (): Promise<HomeBot[] | null> => {
    try { const next = await bridge.listBots(homeId); setBots(next); return next; } catch { return null; }
  };
  useEffect(() => { void refresh().then((next) => { if (next) setOffer(firstOffer(next, skipped.current)); }); }, [homeId]);
  // The Cloud window asked for this bot's sign-in: open the same per-bot sign-in the offer opens, once.
  useEffect(() => {
    if (!request || request.homeId !== homeId || !canSignInHere(request.engine)) return;
    void refresh().then((next) => {
      const bot = next?.find((candidate) => candidate.id === request.bot);
      onRequestHandled?.();
      if (!bot) return;
      setOffer(null);
      setSignIn({ homeId, engine: request.engine as EngineLoginEngine, action: "login", bot: { id: bot.id, name: bot.name } });
    });
  }, [request, homeId]);
  /** After a sign-in window closed: re-read the home, and when that bot is now signed in on a per-bot engine, offer the next bot that needs it. */
  const afterClose = async (closed: SignInTarget | null) => {
    const next = await refresh();
    if (!closed?.bot || (closed.action ?? "login") !== "login" || !next) return;
    const done = next.find((bot) => bot.id === closed.bot!.id);
    const signedInNow = done?.signIn && ((done.signIn.engine === closed.engine && done.signIn.signedIn) || (done.signIn.signedInEngines ?? []).includes(closed.engine));
    if (!signedInNow) return;
    const waiting = botsToSignIn(next, closed.engine, closed.bot.id, skipped.current)[0];
    setOffer(waiting ? { bot: waiting, engine: closed.engine, label: engineName(closed.engine) } : null);
  };
  return (
    <EngineSignInsView
      homeId={homeId} busy={busy} signIn={signIn} botChoices={botChoices} bots={bots} offer={offer}
      onSignIn={(target, engine, action = "login") => {
        setSignIn({ homeId: target, engine, action, bot: null });
        setBotChoices(null);
        setOffer(null);
        if (!engineLoginNeedsBot(engine, action, null)) return;
        // A per-bot sign-in names its bot: read the home's bots (id and name only) to choose from.
        void (async () => {
          try { setBotChoices(await bridge.listBots(target)); } catch (cause) { setBotChoices([]); onError(messageOf(cause)); }
        })();
      }}
      onSignInBot={(bot, engine, action = "login") => { setOffer(null); setSignIn({ homeId, engine, action, bot: { id: bot.id, name: bot.name } }); }}
      onSkipOffer={() => {
        if (!offer) return;
        skipped.current.add(skipKey(offer.bot.id, offer.engine));
        // "Not now" is kept on the home, so the offer stays gone after the panel is reopened or the home restarts.
        void Promise.resolve(bridge.dismissOffer?.(homeId, offer.bot.id, offer.engine)).catch(() => {});
        const waiting = bots ? botsToSignIn(bots, offer.engine, "", skipped.current)[0] : undefined;
        setOffer(waiting ? { bot: waiting, engine: offer.engine, label: offer.label } : null);
      }}
      onChooseBot={(bot) => setSignIn((current) => (current ? { ...current, bot } : current))}
      onCloseSignIn={() => { const closed = signIn; setSignIn(null); setBotChoices(null); void afterClose(closed); }}
    />
  );
}
