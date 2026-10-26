// The sign-in terminal for an engine on a Cloud home (B3 WP5).
//
// Shows the vendor CLI's own sign-in screen, relayed by the desktop's main process (electron/
// cloud-home-engine-login.mjs). Read-only: the terminal takes no keystrokes. For Claude, the page the vendor opens
// shows a code that is pasted into the masked box below within 2 minutes. Everything that decides what is trusted
// lives in src/lib/engine-login-terminal.ts: OSC 52 and OSC 8 are swallowed, links open only on vendor auth hosts.
//
// Per-bot sign-ins (Codex, Grok, Kimi, OpenCode) name their bot and are refused without one. Codex and OpenCode can
// also save a typed API key ("enroll-key"): the key is typed here first, and the session opens only to carry it as
// its first and only message.
import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  BOT_LOGIN_ENGINES, BOT_REQUIRED_COPY, ENGINE_KEY_PROVIDER_SHAPE, ENGINE_KEY_SHAPE, KEY_ENGINES, authLinkProvider, engineLoginNeedsBot, installTerminalGuards, startEngineLoginSession,
  type EngineLoginAction, type EngineLoginBridge, type EngineLoginEngine, type EngineLoginStart, type SessionState,
} from "@/lib/engine-login-terminal";

// Kept here too for the callers that read them with the component; they live in the lib so the Connect panel can ask
// them without loading xterm (the terminal itself is loaded on first use, see EngineSignIns.tsx).
export { BOT_REQUIRED_COPY, engineLoginNeedsBot } from "@/lib/engine-login-terminal";

export interface EngineLoginTerminalProps {
  homeId: string;
  engine: EngineLoginEngine;
  /** "login" opens the vendor sign-in; "logout" signs the engine (or that bot) out; "enroll-key" saves a typed API key. */
  action?: EngineLoginAction;
  /** The bot a per-bot engine (Codex, Grok, Kimi, OpenCode) signs in for. Claude's sign-in is for the whole home. */
  bot?: { id: string; name: string } | null;
  onClose?: () => void;
  /** Test seam; defaults to the desktop bridge. */
  bridge?: EngineLoginBridge | null;
}

const ENGINE_LABEL: Record<EngineLoginEngine, string> = { codex: "Codex", claudeAgent: "Claude", grokAgent: "Grok", kimiAgent: "Kimi", opencodeGo: "OpenCode" };

/** Same words as server/cloud-home/copy.ts (cloudClaudeSigninScreen, cloudClaudeSigninRenew, engineLoginBotRequired). */
export const CLAUDE_CLOUD_SIGNIN_COPY = "Cloud turns run on a long-lived Claude subscription token. Your local MCP servers work as before; claude.ai connectors and Remote Control are desktop features and are not part of Cloud turns.";
export const CLAUDE_CLOUD_RENEW_COPY = "Renew your Claude sign-in";

/** "Sign Codex in for Atlas" for a per-bot sign-in, "Sign Claude in" for the home's own. */
export function engineLoginTitle(engine: EngineLoginEngine, action: EngineLoginAction, bot?: { name: string } | null): string {
  const label = ENGINE_LABEL[engine];
  if (action === "enroll-key") return `Save an API key for ${label}`;
  if (action === "logout") return bot ? `Sign ${label} out for ${bot.name}` : `Sign ${label} out`;
  return bot ? `Sign ${label} in for ${bot.name}` : `Sign ${label} in`;
}

/** Whether this engine's sign-in asks for a pasted code (Claude does; Codex shows a code on its own page). */
export const engineNeedsCode = (engine: EngineLoginEngine, action: EngineLoginAction) => engine === "claudeAgent" && action === "login";

/** The start request: the bot rides every per-bot action except a key enrollment; the provider only an OpenCode key. */
export function engineLoginRequest(homeId: string, engine: EngineLoginEngine, action: EngineLoginAction, bot?: { id: string } | null, enrollment?: { key: string; provider?: string } | null): EngineLoginStart {
  return {
    homeId, engine, action,
    ...(bot && action !== "enroll-key" && (BOT_LOGIN_ENGINES.includes(engine) || engine === "claudeAgent") ? { bot: bot.id } : {}),
    ...(action === "enroll-key" && enrollment ? { secret: enrollment.key } : {}),
    ...(action === "enroll-key" && engine === "opencodeGo" && enrollment?.provider ? { provider: enrollment.provider } : {}),
  };
}

export function EngineLoginTerminal({ homeId, engine, action = "login", bot = null, onClose, bridge = typeof window === "undefined" ? null : (window.muragebox?.cloudEngineLogin ?? null) }: EngineLoginTerminalProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const session = useRef<ReturnType<typeof startEngineLoginSession> | null>(null);
  const [state, setState] = useState<SessionState>({ phase: "connecting" });
  const [code, setCode] = useState("");
  const [keyText, setKeyText] = useState("");
  const [providerText, setProviderText] = useState("");
  // A typed key waits here until its session starts; main sends it as the first message and keeps nothing.
  const [enrollment, setEnrollment] = useState<{ key: string; provider?: string } | null>(null);
  const live = state.phase === "connecting" || state.phase === "open";
  const missingBot = engineLoginNeedsBot(engine, action, bot);
  const enrolling = action === "enroll-key";
  const botId = bot?.id ?? null;

  useEffect(() => {
    if (!bridge || !host.current || missingBot || (enrolling && !enrollment)) return;
    const terminal = new Terminal({ disableStdin: true, cursorBlink: false, cursorStyle: "bar", cursorInactiveStyle: "none", convertEol: true, scrollback: 2000, rows: 18, cols: 80, fontSize: 12, allowProposedApi: false });
    const guards = installTerminalGuards(terminal);
    const link = terminal.registerLinkProvider(authLinkProvider(terminal, (url) => { void session.current?.openLink(url); }));
    terminal.open(host.current);
    const request = engineLoginRequest(homeId, engine, action, botId ? { id: botId } : null, enrollment);
    // StrictMode mounts, unmounts and mounts again: start once the dust settles so the person is asked to confirm once.
    const timer = setTimeout(() => {
      session.current = startEngineLoginSession({ bridge, request, write: (data) => terminal.write(data), onState: setState });
    }, 0);
    return () => {
      clearTimeout(timer);
      session.current?.stop();
      session.current = null;
      link.dispose();
      guards.dispose();
      terminal.dispose();
    };
  }, [bridge, homeId, engine, action, botId, missingBot, enrolling, enrollment]);

  const send = useCallback(async () => {
    const value = code;
    setCode("");
    if (value.trim()) await session.current?.sendCode(value);
  }, [code]);

  if (!bridge) return <p role="status">Signing in from this window isn't available on this device.</p>;
  const title = engineLoginTitle(engine, action, bot);
  if (missingBot) return <p role="status">{BOT_REQUIRED_COPY}</p>;
  if (enrolling && KEY_ENGINES.includes(engine) && !enrollment) {
    const needsProvider = engine === "opencodeGo";
    const ready = ENGINE_KEY_SHAPE.test(keyText.trim()) && (!needsProvider || ENGINE_KEY_PROVIDER_SHAPE.test(providerText.trim()));
    return (
      <section aria-label={title} className="flex flex-col gap-3">
        <h3 className="text-sm font-medium">{title}</h3>
        <form className="flex flex-col gap-2" onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          setEnrollment({ key: keyText.trim(), ...(needsProvider ? { provider: providerText.trim() } : {}) });
          setKeyText("");
        }}>
          {needsProvider ? (
            <label className="flex flex-col gap-1 text-sm">
              <span>Provider</span>
              <input value={providerText} onChange={(event) => setProviderText(event.target.value)} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
                className="rounded-md border border-hairline bg-transparent px-2 py-1 text-sm" />
            </label>
          ) : null}
          <label className="flex flex-col gap-1 text-sm">
            <span>API key</span>
            <input type="password" value={keyText} onChange={(event) => setKeyText(event.target.value)} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
              className="rounded-md border border-hairline bg-transparent px-2 py-1 text-sm" />
          </label>
          <div className="flex gap-2">
            <button type="submit" disabled={!ready} className="rounded-md px-3 py-1 text-sm">Save key</button>
            <button type="button" className="rounded-md px-3 py-1 text-sm" onClick={() => onClose?.()}>Cancel</button>
          </div>
        </form>
      </section>
    );
  }
  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <h3 className="text-sm font-medium">{title}</h3>
      {engine === "claudeAgent" && action === "login" ? <p className="text-sm text-ink-secondary">{CLAUDE_CLOUD_SIGNIN_COPY}</p> : null}
      <div ref={host} className="rounded-md border border-hairline bg-black p-2" style={{ minHeight: 280 }} />
      <p role="status" aria-live="polite" className="text-sm text-ink-secondary">
        {state.phase === "connecting" ? "Connecting to your Cloud home..." : null}
        {state.phase === "open" ? (engineNeedsCode(engine, action) ? "Open the link, approve, then paste the code below within 2 minutes." : enrolling ? "Saving the key..." : action === "login" ? "Open the link, approve, and enter the code the page shows. This closes by itself when you are done." : "Signing out...") : null}
        {state.phase === "closed" || state.phase === "error" ? state.message : null}
        {state.notice ? ` ${state.notice}` : null}
      </p>
      {engineNeedsCode(engine, action) && live ? (
        <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void send(); }}>
          <label className="sr-only" htmlFor="engine-login-code">Sign-in code</label>
          <input id="engine-login-code" type="password" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} value={code}
            onChange={(event) => setCode(event.target.value)} disabled={state.phase !== "open"} placeholder="Paste the code"
            className="min-w-0 flex-1 rounded-md border border-hairline bg-transparent px-2 py-1 text-sm" />
          <button type="submit" disabled={state.phase !== "open" || code.trim() === ""} className="rounded-md px-3 py-1 text-sm">Send code</button>
        </form>
      ) : null}
      <div>
        <button type="button" className="rounded-md px-3 py-1 text-sm" onClick={() => { session.current?.stop(); onClose?.(); }}>{live ? "Cancel" : "Close"}</button>
      </div>
    </section>
  );
}
