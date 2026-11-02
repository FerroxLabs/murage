import { t } from "@/lib/i18n";
// A focused setup card shared by onboarding, the model picker, and runtime
// errors. The command has one inline copy action and one primary next step;
// unusable model lists stay out of the way until the engine is ready.
import { canOpenSetupTerminal, checkAgainMessage } from "@/lib/engine-setup-check";
import { probeInstances } from "@/lib/instances-probe";
import { useEffect, useRef, useState } from "react";
import { Check, Copy, Download, ExternalLink, LogIn, TerminalSquare } from "lucide-react";
import { api, useStore, type EngineInstall, type InstanceInfo } from "@/state/store";
import { cn } from "@/lib/cn";
import { EngineManagement } from "./EngineManagement";
import { FluxKeyCard } from "./FluxKeyCard";
import { LOCAL_MODELS_TITLE, OPEN_LOCAL_MODELS_EVENT } from "@/lib/local-models-view";
import { localEngineSupport } from "../../shared/local-models";
import { opensPurchasePages } from "@/lib/native-shell";
import { copyTextOrThrow } from "@/lib/copy-text";
import { EngineSignInButton } from "./EngineSignInButton";

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
  return install?.command?.[install.platform ?? hostPlatform()] ?? null;
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

/** Where a set-up press stands: the card shows one step at a time. */
export type SetupStep = "install" | "signin" | "check";
export function setupStep(instance: InstanceInfo, options: { authRequired?: boolean } = {}): SetupStep {
  if (needsCli(instance)) return "install";
  return needsSignIn(instance) || options.authRequired ? "signin" : "check";
}

type ReplyCheck = { result: "ready" | "signin" | "limit" | "refused"; line?: string };

/** Signed in, so one short real reply decides: `authenticated` can be true while a turn fails. Runs on this press alone. */
function SetUpCheck({ instance, className, onReady }: { instance: InstanceInfo; className?: string; onReady?: () => void }) {
  const [phase, setPhase] = useState<"idle" | "checking">("idle");
  const [answer, setAnswer] = useState<ReplyCheck | null>(null);
  const [failed, setFailed] = useState(false);
  const name = instance.displayName;
  const press = async () => {
    if (phase === "checking") return;
    setPhase("checking"); setAnswer(null); setFailed(false);
    try {
      const reply: ReplyCheck = await api("/api/engine-setup-check", { method: "POST", body: JSON.stringify({ instanceId: instance.instanceId }) });
      setAnswer(reply);
      if (reply.result === "ready") onReady?.();
    } catch { setFailed(true); }
    finally { setPhase("idle"); }
  };
  return (
    <div className={cn("rounded-xl border border-hairline/40 bg-control/30 p-3", className)}>
      <div className="text-[13px] font-semibold text-ink">{t("engineCheck.title", { name })}</div>
      {answer?.result === "ready" ? (
        <p role="status" className="mt-1 flex items-center gap-1.5 text-[12.5px] text-ink"><Check size={13} className="text-success" />{t("engineCheck.ready", { name })}</p>
      ) : answer?.result === "signin" ? (
        <EngineSignInButton className="mt-3" instanceId={instance.instanceId} name={name} command={instance.install?.signInCommand} onDone={() => setAnswer(null)} />
      ) : (
        <>
          <p className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{t("engineCheck.line")}</p>
          <button type="button" disabled={phase === "checking"} onClick={() => void press()}
            className="mt-3 w-full rounded-lg bg-accent px-3 py-2 text-[12.5px] font-semibold text-white hover:brightness-110 disabled:opacity-50">
            {phase === "checking" ? t("engineCheck.checking") : t("engineCheck.press")}
          </button>
        </>
      )}
      {answer?.line && <p role="status" className="mt-2 text-[12px] text-ink-secondary">{answer.line}</p>}
      {failed && <p role="alert" className="mt-2 text-[12px] text-danger">{t("engineCheck.failed", { name })}</p>}
    </div>
  );
}

function CommandRow({ command, actionLabel, instanceId, action, onTerminalOpened }: { command: string; actionLabel: string; instanceId: string; action: "install" | "connect"; onTerminalOpened?: () => void }) {
  const [status, setStatus] = useState<"copied" | "opening" | "opened" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const opening = useRef(false);
  const canOpen = canOpenSetupTerminal(window.muragebox, typeof document === "undefined" ? undefined : document);

  const settle = (next: "copied" | "opened") => {
    setStatus(next);
  };

  const copy = async () => {
    setError(null);
    try {
      await copyTextOrThrow(command);
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
      onTerminalOpened?.();
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
            aria-label={t("setup.copyCommand")}
            title={t("setup.copyCommand")}
            className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11.5px] font-medium text-ink-secondary hover:bg-control hover:text-ink"
          >
            {status === "copied" ? <Check size={12} className="text-success" /> : <Copy size={12} />}
            {status === "copied" ? t("common.copied") : t("common.copy")}
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
            {status === "opening" ? t("setup.openingTerminal") : status === "opened" ? t("setup.terminalOpened") : actionLabel}
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
          {status === "copied" ? t("setup.commandCopied") : t("setup.copyCommand")}
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
  authRequired = false,
  setUp = false,
  onReady,
}: {
  instance: InstanceInfo;
  className?: string;
  /** `inject` installs the CLI but deliberately skips cloud sign-in. */
  intent?: "cloud" | "inject";
  /** A flagged native auth failure overrides an older ready snapshot until rechecked. */
  authRequired?: boolean;
  /** A set-up link opened this card: it picks install, sign-in or the one real reply by state. */
  setUp?: boolean;
  onReady?: () => void;
}) {
  const { dispatch } = useStore();
  const openLocalModels = () => {
    dispatch({ type: "toggleAppSettings", open: true, section: "models" });
    setTimeout(() => window.dispatchEvent(new Event(OPEN_LOCAL_MODELS_EVENT)), 0);
  };
  const [checking, setChecking] = useState(false);
  const [checkMessage, setCheckMessage] = useState<string | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const checkGate = useRef(false);
  /** An install command was started from this card (its Terminal opened), so the next check confirms it. */
  const installStarted = useRef(false);
  const checkAgain = async () => {
    if (checkGate.current) return;
    checkGate.current = true;
    setChecking(true); setCheckError(null); setCheckMessage(null);
    try {
      const { instances }: { instances: InstanceInfo[] } = await probeInstances("/api/instances", api);
      const current = instances.find((item) => item.instanceId === instance.instanceId);
      if (!current) throw new Error("This engine was not returned. Refresh Settings and try again.");
      dispatch({ type: "instances", instances });
      if (current.snapshot.state === "available" && (!authRequired || current.snapshot.authenticated === true)) onReady?.();
      setCheckMessage(checkAgainMessage(current, { signInOnly: current.snapshot.state === "available" && needsSignIn(current), installStarted: installStarted.current, cloudIntent: intent === "cloud" }));
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
  const signInOnly = intent === "cloud" && (needsSignIn(instance) || (authRequired && instance.snapshot.state === "available"));
  // Pi below the version Murage can run: it is installed, and the install command updates it.
  const outdated = instance.driverKind === "piAgent" && !signInOnly && Boolean(instance.snapshot.version) && instance.snapshot.state === "unavailable";
  const title = signInOnly ? `Sign in to ${instance.displayName}` : outdated ? `Update ${instance.displayName}` : `Install ${instance.displayName}`;
  const description = outdated
    ? `${instance.snapshot.reason} Run this once, then check again.`
    : signInOnly
    ? t("engineSignIn.setupLine")
    : intent === "inject"
      ? "Install the engine once, then you can run it with local models; no cloud sign-in required."
      : `Install the command-line app once. Models will appear here as soon as it’s ready${signInCommand ? "; sign-in may follow" : ""}.`;

  if (instance.driverKind === "fuigoAgent" && signInOnly) {
    return <div className={cn("rounded-xl border border-hairline/40 bg-control/30 p-3", className)}>
      <div className="text-[13px] font-semibold text-ink">{t("setup.fuigoIncluded")}</div>
      <p className="mt-1 mb-3 text-[12px] text-ink-secondary">Manage your Flux Router connection in Models, then check this engine again.</p>
      <FluxKeyCard />
      {checking && <p role="status" className="mt-2 text-[12px] text-ink-secondary">Checking connection…</p>}
      {checkMessage && <p role="status" className="mt-2 text-[12px] text-ink-secondary">{checkMessage}</p>}
      {checkError && <p role="alert" className="mt-2 text-[12px] text-danger">{checkError}</p>}
      <button type="button" disabled={checking} onClick={() => void checkAgain()} className="mt-2 rounded-lg border border-hairline/40 px-3 py-2 text-[12px] text-ink">{t("setup.checkConnection")}</button>
    </div>;
  }

  if (instance.snapshot.state === "unavailable" && instance.snapshot.setupAction === "repair") {
    return <div className={cn("rounded-xl border border-hairline/40 bg-control/30 p-3", className)}>
      <div className="text-[13px] font-semibold text-ink">Repair bundled {instance.displayName}</div>
      <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">This engine is included with Murage but could not start. You do not need Node.js, npm or a separate engine installation.</p>
      <p className="mt-2 text-[12px] leading-relaxed text-ink-secondary">{instance.snapshot.reason}</p>
      <p className="mt-2 text-[12px] leading-relaxed text-ink-secondary">Reinstall the official Murage package without deleting your workspace. If the problem continues, report your Murage version, operating system and installer type.</p>
      <button type="button" disabled={checking} onClick={() => void checkAgain()}
        className="mt-3 rounded-lg border border-hairline/40 px-3 py-2 text-[12px] font-medium text-ink hover:bg-raised-hover disabled:opacity-50">
        {checking ? t("setup.checkingEngine") : t("common.checkAgain")}
      </button>
      {checkMessage && <p role="status" className="mt-2 text-[12px] text-ink-secondary">{checkMessage}</p>}
      {checkError && <p role="alert" className="mt-2 text-[12px] text-danger">{checkError}</p>}
    </div>;
  }

  const desktop = canOpenSetupTerminal(window.muragebox, typeof document === "undefined" ? undefined : document);
  if (setUp && desktop && intent === "cloud" && setupStep(instance, { authRequired }) === "check") return <SetUpCheck instance={instance} className={className} onReady={onReady} />;

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
          {/* Spec V5: the one first-run line that mentions local models now
              reaches the section that manages them, instead of leaving the
              reader to find where "local models" live. */}
          {intent === "inject" && localEngineSupport(instance.driverKind) === "tools" && (
            <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">
              <button type="button" onClick={openLocalModels} className="text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                Set up {LOCAL_MODELS_TITLE.toLowerCase()} under Models → {LOCAL_MODELS_TITLE}
              </button>
            </p>
          )}
        </div>
      </div>

      {signInOnly ? (
        <EngineSignInButton className="mt-3" instanceId={instance.instanceId} name={instance.displayName} command={signInCommand} onDone={() => void checkAgain()} />
      ) : install.native ? (
        desktop ? <EngineManagement instance={instance} /> : <p className="mt-3 rounded-lg bg-inset px-2.5 py-2 text-[12px] leading-relaxed text-ink-secondary">{t("projects.work.needsApp")}</p>
      ) : installCommand ? (
        <CommandRow key={installCommand} command={installCommand} instanceId={instance.instanceId} action="install" onTerminalOpened={() => { installStarted.current = true; }} actionLabel={t("setup.openInstall")} />
      ) : (
        <p className="mt-3 rounded-lg bg-inset px-2.5 py-2 text-[12px] leading-relaxed text-ink-secondary">
          There isn’t a one-line installer for this platform. Use the setup guide below.
        </p>
      )}

      <button type="button" disabled={checking} onClick={() => void checkAgain()}
        className="mt-3 rounded-lg border border-hairline/40 px-3 py-2 text-[12px] font-medium text-ink hover:bg-raised-hover disabled:opacity-50">
        {checking ? t("setup.checkingEngine") : t("common.checkAgain")}
      </button>
      {checkMessage && <p role="status" className="mt-2 text-[12px] text-ink-secondary">{checkMessage}</p>}
      {checkError && <p role="alert" className="mt-2 text-[12px] text-danger">{checkError}</p>}

      {!signInOnly && install.needsNode && (
        <p className="mt-2 text-[11px] leading-relaxed text-ink-secondary/70">
          Requires Node.js and <code className="font-mono">npm</code>.
        </p>
      )}

      {install.docsUrl && opensPurchasePages() && (
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
