// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// B3 WP5: the engine sign-ins of a connected Cloud home, shown under that home's row on the Connect panel. Each opens the
// engine sign-in terminal (xterm relay). A per-bot sign-in (Codex, Grok, Kimi, OpenCode; CLOUD-ENGINES-DESIGN.md r8 R4)
// first asks which bot it is for. Runs in the MAIN (local) window only. No token or key is ever held here.
import { Suspense, lazy, useState } from "react";

import { BOT_REQUIRED_COPY, engineLoginNeedsBot, type EngineLoginAction, type EngineLoginEngine } from "@/lib/engine-login-terminal";
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
}

export function EngineSignInsView(props: EngineSignInsViewProps) {
  const { homeId, busy, signIn } = props;
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {SIGN_INS.map(({ engine, action, label }) => (
          <button key={engine + action} type="button" className={button} disabled={busy} onClick={() => props.onSignIn(homeId, engine, action)}>{label}</button>
        ))}
      </div>
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
export function EngineSignIns({ bridge, homeId, busy, onError }: { bridge: CloudHomeBridge; homeId: string; busy: boolean; onError(message: string): void }) {
  const [signIn, setSignIn] = useState<SignInTarget | null>(null);
  const [botChoices, setBotChoices] = useState<{ id: string; name: string }[] | null>(null);
  return (
    <EngineSignInsView
      homeId={homeId} busy={busy} signIn={signIn} botChoices={botChoices}
      onSignIn={(target, engine, action = "login") => {
        setSignIn({ homeId: target, engine, action, bot: null });
        setBotChoices(null);
        if (!engineLoginNeedsBot(engine, action, null)) return;
        // A per-bot sign-in names its bot: read the home's bots (id and name only) to choose from.
        void (async () => {
          try { setBotChoices(await bridge.listBots(target)); } catch (cause) { setBotChoices([]); onError(messageOf(cause)); }
        })();
      }}
      onChooseBot={(bot) => setSignIn((current) => (current ? { ...current, bot } : current))}
      onCloseSignIn={() => { setSignIn(null); setBotChoices(null); }}
    />
  );
}
