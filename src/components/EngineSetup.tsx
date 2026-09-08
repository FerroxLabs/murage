// A focused setup card shared by onboarding, the model picker, and runtime
// errors. The command has one inline copy action and one primary next step;
// unusable model lists stay out of the way until the engine is ready.
import { useEffect, useRef, useState } from "react";
import { Check, Copy, Download, ExternalLink, LogIn, TerminalSquare } from "lucide-react";
import { api, useStore, type EngineInstall, type InstanceInfo } from "@/state/store";
import { cn } from "@/lib/cn";
import { EngineManagement } from "./EngineManagement";
import { FluxKeyCard } from "./FluxKeyCard";

type Platform = "darwin" | "win32" | "linux";

function hostPlatform(): Platform {
  const platform = window.muragebox?.platform;
  if (platform === "darwin" || platform === "win32" || platform === "linux") return platform;
  const userAgent = navigator.userAgent;
  if (userAgent.includes("Mac")) return "darwin";
  if (userAgent.includes("Win")) return "win32";
  return "linux";
}

/** The install command for this machine, or null when the engine has none
 * here (a GUI download, or a POSIX-only installer viewed on Windows). */
export function installCommandFor(install: EngineInstall | undefined): string | null {
  return install?.command?.[hostPlatform()] ?? null;
}

/** Installed but missing the cloud account session. */
export function needsSignIn(instance: InstanceInfo | undefined): boolean {
  return instance?.snapshot.state === "available" && instance.snapshot.authenticated === false;
}

/** The agent CLI itself is absent. Local-model injection needs the CLI but
 * does not need its cloud account to be signed in. */
export function needsCli(instance: InstanceInfo | undefined): boolean {
  return instance?.snapshot.state !== "available";
}

function CommandRow({ command, actionLabel, instanceId, action }: { command: string; actionLabel: string; instanceId: string; action: "install" | "connect" }) {
  const [status, setStatus] = useState<"copied" | "opening" | "opened" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const opening = useRef(false);
  const canOpen = Boolean(window.muragebox?.openEngineSetupTerminal);

  const settle = (next: "copied" | "opened") => {
    setStatus(next);
  };

  const copy = async () => {
    setError(null);
    try {
      await navigator.clipboard.writeText(command);
      settle("copied");
    } catch {
      setError("Could not copy the command. Select it above and copy it manually.");
    }
  };

  const openTerminal = async () => {
    if (opening.current) return;
    opening.current = true;
    setStatus("opening");
    setError(null);
    try {
      const opened = await window.muragebox!.openEngineSetupTerminal!({ instanceId, action });
      if (!opened) throw new Error("Terminal did not open");
      settle("opened");
    } catch {
      setStatus(null);
      setError("Could not open Terminal. Copy the command and run it in your terminal, or try again.");
    } finally {
      opening.current = false;
    }
  };

  return (
    <div className="mt-3">
      <div className="flex min-w-0 items-center gap-2 rounded-lg border border-hairline/50 bg-app px-2.5 py-2">
        <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-secondary" title={command}>
          {command}
        </code>
        {canOpen && (
          <button
            type="button"
            onClick={() => void copy()}
            disabled={status === "opening"}
            aria-label="Copy command"
            title="Copy command"
            className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11.5px] font-medium text-ink-secondary hover:bg-control hover:text-ink"
          >
            {status === "copied" ? <Check size={12} className="text-success" /> : <Copy size={12} />}
            {status === "copied" ? "Copied" : "Copy"}
          </button>
        )}
      </div>

      {canOpen ? (
        <>
          <button
            type="button"
            onClick={() => void openTerminal()}
            disabled={status === "opening"}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-[12.5px] font-semibold text-white hover:brightness-110 disabled:opacity-50"
          >
            {status === "opened" ? <Check size={14} /> : <TerminalSquare size={14} />}
            {status === "opening" ? "Opening Terminal…" : status === "opened" ? "Terminal opened" : actionLabel}
          </button>
          <p aria-live="polite" className="mt-1.5 text-center text-[11px] text-ink-secondary/70">
            {status === "opened" ? "Paste the command and press Enter. Finish or cancel in Terminal, then check again below." : "Opening Terminal does not install or sign in for you."}
          </p>
        </>
      ) : (
        <button
          type="button"
          onClick={() => void copy()}
          className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-control px-3 py-2 text-[12.5px] font-semibold text-ink hover:bg-raised-hover"
        >
          {status === "copied" ? <Check size={14} className="text-success" /> : <Copy size={14} />}
          {status === "copied" ? "Command copied" : "Copy command"}
        </button>
      )}
      {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
    </div>
  );
}

export function EngineSetup({
  instance,
  className,
  intent = "cloud",
}: {
  instance: InstanceInfo;
  className?: string;
  /** `inject` installs the CLI but deliberately skips cloud sign-in. */
  intent?: "cloud" | "inject";
}) {
  const { dispatch } = useStore();
  const [checking, setChecking] = useState(false);
  const [checkMessage, setCheckMessage] = useState<string | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const checkGate = useRef(false);
  const checkAgain = async () => {
    if (checkGate.current) return;
    checkGate.current = true;
    setChecking(true); setCheckError(null); setCheckMessage(null);
    try {
      const { instances }: { instances: InstanceInfo[] } = await api("/api/instances");
      const current = instances.find((item) => item.instanceId === instance.instanceId);
      if (!current) throw new Error("This engine was not returned. Refresh Settings and try again.");
      dispatch({ type: "instances", instances });
      setCheckMessage(current.snapshot.state !== "available"
        ? current.snapshot.reason ?? "The engine is not detected yet. Finish setup and check again."
        : needsSignIn(current) && intent === "cloud"
          ? "Engine detected. Finish sign-in, then check again."
          : "Engine detected. Select a model to test it with a task.");
    } catch (error) {
      setCheckError(error instanceof Error ? error.message : "Could not check this engine. Try again.");
    } finally { checkGate.current = false; setChecking(false); }
  };
  // Recheck after a browser/terminal account flow returns to Murage.
  const refreshRef = useRef(checkAgain);
  refreshRef.current = checkAgain;
  useEffect(() => {
    const refresh = () => { void refreshRef.current(); };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  const install = instance.install;
  const installCommand = installCommandFor(install);
  const signInCommand = install?.signInCommand;
  const signInOnly = intent === "cloud" && needsSignIn(instance);
  const command = signInOnly ? signInCommand : installCommand;
  const title = signInOnly ? `Sign in to ${instance.displayName}` : `Install ${instance.displayName}`;
  const description = signInOnly
    ? "Finish the account sign-in in Terminal, then check again below."
    : intent === "inject"
      ? "Install the agent once, then you can run it with local models; no cloud sign-in required."
      : `Install the command-line app once. Models will appear here as soon as it’s ready${signInCommand ? "; sign-in may follow" : ""}.`;

  if (instance.driverKind === "fuigo" && signInOnly) {
    return <div className={cn("rounded-xl border border-hairline/40 bg-control/30 p-3", className)}>
      <div className="text-[13px] font-semibold text-ink">Fuigo is included</div>
      <p className="mt-1 mb-3 text-[12px] text-ink-secondary">Got a Flux Router key? Connect it here to get started.</p>
      <FluxKeyCard onSaved={checkAgain} />
      {checking && <p role="status" className="mt-2 text-[12px] text-ink-secondary">Checking connection…</p>}
      {checkMessage && <p role="status" className="mt-2 text-[12px] text-ink-secondary">{checkMessage}</p>}
      {checkError && <p role="alert" className="mt-2 text-[12px] text-danger">{checkError}</p>}
      <button type="button" disabled={checking} onClick={() => void checkAgain()} className="mt-2 rounded-lg border border-hairline/40 px-3 py-2 text-[12px] text-ink">Check connection</button>
    </div>;
  }

  // Some engines are configured elsewhere (for example, a cloud computer
  // token) and intentionally have no install descriptor.
  if (!install) {
    return (
      <div className={cn("rounded-xl border border-hairline/40 bg-control/30 p-3", className)}>
        <div className="text-[13px] font-semibold text-ink">{instance.displayName} isn’t ready</div>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">
          {instance.snapshot.reason ?? "This engine is not available on this machine."}
        </p>
      </div>
    );
  }

  return (
    <div className={cn("rounded-xl border border-hairline/40 bg-control/30 p-3", className)}>
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-inset text-ink-secondary">
          {signInOnly ? <LogIn size={14} /> : <Download size={14} />}
        </span>
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-ink">{title}</div>
          <p className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{description}</p>
        </div>
      </div>

      {instance.driverKind === "codex" && !signInOnly && <EngineManagement instance={instance} />}
      {command ? (
        <CommandRow key={command} command={command} instanceId={instance.instanceId} action={signInOnly ? "connect" : "install"} actionLabel={signInOnly ? "Open sign-in in Terminal" : "Open install in Terminal"} />
      ) : (
        <p className="mt-3 rounded-lg bg-inset px-2.5 py-2 text-[12px] leading-relaxed text-ink-secondary">
          There isn’t a one-line installer for this platform. Use the setup guide below.
        </p>
      )}

      <button type="button" disabled={checking} onClick={() => void checkAgain()}
        className="mt-3 rounded-lg border border-hairline/40 px-3 py-2 text-[12px] font-medium text-ink hover:bg-raised-hover disabled:opacity-50">
        {checking ? "Checking engine…" : "Check again"}
      </button>
      {checkMessage && <p role="status" className="mt-2 text-[12px] text-ink-secondary">{checkMessage}</p>}
      {checkError && <p role="alert" className="mt-2 text-[12px] text-danger">{checkError}</p>}

      {!signInOnly && install.needsNode && (
        <p className="mt-2 text-[11px] leading-relaxed text-ink-secondary/70">
          Requires Node.js and <code className="font-mono">npm</code>.
        </p>
      )}

      {install.docsUrl && (
        <a
          href={install.docsUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-2.5 inline-flex items-center gap-1.5 text-[12px] font-medium text-accent hover:underline"
        >
          <ExternalLink size={12} /> View setup guide
        </a>
      )}
    </div>
  );
}
