import { useEffect, useState, type ReactNode } from "react";
import { Check, AlertTriangle, Loader2, Mic } from "lucide-react";
import { useActiveSkin } from "../lib/use-active-skin";
import { EmberAvatar } from "./Avatar";
import { identifyEmail, setEmailGateDone, track } from "@/lib/analytics";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { EngineSetup } from "./EngineSetup";
import { ProviderMark } from "./ProviderIcons";
import { PhoneSetupFlow } from "./PhoneSetupFlow";
import { useDesktopSurface } from "@/lib/use-surface";
import type { InstanceInfo } from "@/state/store";

// First-run onboarding: who you are (email), what's installed (live engine
// checks from the harness), what the app may use (TCC), then an optional
// phone setup that can always be resumed from Settings → Phone.
// Every check is skippable — onboarding must never brick the app.

type InstanceRow = InstanceInfo;

function StatusRow({
  ok,
  warn,
  title,
  detail,
  mark,
  children,
}: {
  ok: boolean;
  warn?: boolean;
  title: string;
  detail?: string;
  mark?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl bg-card p-3.5">
      <span
        className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full ${
          ok ? "bg-success/15 text-success" : warn ? "bg-warning/15 text-warning" : "bg-raised text-ink-secondary"
        }`}
      >
        {ok ? <Check size={14} /> : <AlertTriangle size={13} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[14px] font-medium text-ink">
          {mark}
          <span className="min-w-0 truncate">{title}</span>
        </div>
        {detail && <div className="mt-0.5 text-[12.5px] leading-relaxed text-ink-secondary">{detail}</div>}
        {children}
      </div>
    </div>
  );
}

/** One engine on the setup screen: what it's called, what the harness
 * found, and the one-liner to show when it's good to go. Ready states get
 * a sentence; anything the user has to act on gets the shared setup UI, so
 * the instructions come from the driver and are correct for this platform. */
interface EngineEntry {
  instance: InstanceRow;
  label: string;
  readyNote: string;
}

function engineReady(instance: InstanceRow): boolean {
  return (
    instance.snapshot.state === "available" &&
    (instance.access === "custom" || instance.snapshot.authenticated !== false)
  );
}

function engineTitle({ instance, label }: EngineEntry): string {
  const version = instance?.snapshot.version ? ` · ${instance.snapshot.version.split(" ")[0]}` : "";
  return `${label}${version}`;
}

/** A ready engine needs no attention: a small tile in the grid, so five
 * engines don't read as one long list where the good news and the setup
 * work look the same. */
function ReadyTile(entry: EngineEntry) {
  return (
    <div className="flex items-start gap-2.5 rounded-xl bg-card p-3">
      <ProviderMark driverKind={entry.instance.driverKind} size={17} />
      <div className="min-w-0">
        <div className="truncate text-[13.5px] font-medium text-ink">{engineTitle(entry)}</div>
        <div className="mt-0.5 text-[12px] leading-snug text-ink-secondary">{entry.readyNote}</div>
      </div>
    </div>
  );
}

/** An engine that still needs installing or signing in keeps the full-width
 * row: the command box and terminal button need the room. */
function SetupRow(entry: EngineEntry) {
  return (
    <StatusRow
      ok={false}
      warn
      title={engineTitle(entry)}
      mark={<ProviderMark driverKind={entry.instance.driverKind} size={16} />}
    >
      <EngineSetup
        instance={entry.instance}
        className="mt-0.5"
        intent={entry.instance.access === "custom" ? "inject" : "cloud"}
      />
    </StatusRow>
  );
}

export function Onboarding({ onDone }: { onDone: () => void }) {
  const desktop = useDesktopSurface();
  const skin = useActiveSkin();
  const { capabilities } = useDesktopCapabilities();
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [instances, setInstances] = useState<InstanceRow[] | null>(null);
  const [perms, setPerms] = useState<{ mic: string } | null>(null);
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());

  const saveProfile = () => {
    identifyEmail(email.trim().toLowerCase());
    // Our own list. Deliberately not awaited: Sendlane being slow or down must
    // never hold someone at the welcome screen.
    void fetch("/api/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: email.trim().toLowerCase(), name: name.trim() }),
    }).catch(() => {});
    // persisted server-side (~/.murage/config.json) — the sidebar
    // footer reads it back through /api/config
    void fetch("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: { name: name.trim(), email: email.trim().toLowerCase() } }),
    }).catch(() => {});
    setStep(1);
  };

  useEffect(() => {
    track("onboarding_step", { step });
  }, [step]);

  useEffect(() => {
    if (step !== 1) return;
    let active = true;
    let latestRequest = 0;
    const refresh = () => {
      const request = ++latestRequest;
      fetch("/api/instances")
        .then((r) => r.json())
        .then((d) => active && request === latestRequest && setInstances(d.instances ?? []))
        .catch(() => active && request === latestRequest && setInstances([]));
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
    };
  }, [step]);

  useEffect(() => {
    if (step === 2 && capabilities.dictation.available) {
      const poll = () => window.muragebox?.permStatus?.().then(setPerms).catch(() => {});
      poll();
      // keep polling — the user may grant in System Settings and come back
      const t = setInterval(poll, 2000);
      return () => clearInterval(t);
    }
  }, [step, capabilities.dictation.available]);

  const finish = () => {
    track("onboarding_completed", {
      engines_available: instances?.filter((i) => i.snapshot.state === "available").length ?? -1,
      mic: perms?.mic ?? "n/a",
    });
    setEmailGateDone("submitted");
    onDone();
  };

  const engines: EngineEntry[] = (instances ?? [])
    .filter((instance) => instance.install)
    .map((instance) => ({
      instance,
      label: instance.displayName,
      readyNote:
        instance.access === "custom"
          ? "Installed — ready for a local model."
          : "Installed — ready to power bots.",
    }));
  const readyEngines = engines.filter((e) => engineReady(e.instance));
  const setupEngines = engines.filter((e) => !engineReady(e.instance));

  // EVERY STEP OF THIS SCREEN IS A DESKTOP STEP.
  //
  // Step 0 asks a returning user who he is because localStorage on a phone is
  // empty. Step 1 lists engines installed ON THIS COMPUTER and offers to
  // install them. Step 2 asks macOS for the microphone. Step 3 explains how to
  // open Murage on a phone — to a phone. None of it is answerable from the
  // other side of the browser door, and all of it was rendered there.
  //
  // App.tsx already refuses to mount this off the desktop. This is the second
  // lock, on the component itself, so a future caller cannot reopen the hole
  // by rendering `<Onboarding>` somewhere new. `undefined` renders nothing:
  // the neutral answer, never the desktop one.
  if (desktop !== true) return null;

  return (
    <div className="fixed inset-x-0 top-0 z-50 flex h-[var(--vvh,100dvh)] items-center justify-center bg-app p-8 max-md:p-4">
      {/* the engines step lays tiles out two across, so it gets more room —
          but never more than the window: the panel caps at the viewport and
          the engine list scrolls inside it, so the header and Continue stay
          put and nothing runs into the edges */}
      <div
        className={`flex max-h-full w-full flex-col rounded-2xl border border-hairline/40 bg-panel p-8 max-md:p-5 ${step === 1 ? "max-w-[680px]" : step === 3 ? "max-w-[620px]" : "max-w-[460px]"}`}
      >
        {step === 0 && (
          // min-h-0 + overflow-y-auto: the card is `max-h-full`, so with the
          // keyboard up (--vvh) this content is taller than the box that holds
          // it. Without a scroller here the children simply render outside the
          // card — measured at 390x508, Continue landed 34px below the fold on
          // the one screen whose first field is autoFocus.
          <div className="flex min-h-0 w-full flex-col items-center overflow-y-auto">
            <img
              // The wordmark is baked ink, not a tintable glyph: the default
              // asset is white and vanished into the light theme's card.
              src={skin === "light" ? "/murage-logo-dark.png" : "/murage-logo.png"}
              alt="Murage"
              className="mb-7 h-14 w-auto max-md:hidden"
              draggable={false}
            />
            <EmberAvatar color="orange" state="happy" size={72} />
            <h1 className="mt-4 text-[20px] font-semibold text-ink">Welcome to Murage</h1>
            <p className="mt-1.5 text-center text-[14px] leading-relaxed text-ink-secondary">
              One desktop, every AI engine doing REAL work on their OWN computer.
              Tell us who you are and we&rsquo;ll let you know when big things ship.
            </p>
            <input
              autoFocus
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              className="mt-5 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
            />
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && valid && saveProfile()}
              placeholder="you@example.com"
              className="mt-3 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
            />
            <button
              onClick={saveProfile}
              disabled={!valid}
              className="mt-3 w-full rounded-lg bg-accent py-2.5 text-[15px] font-medium text-white disabled:opacity-40"
            >
              Continue
            </button>
            <button
              onClick={() => {
                track("email_skipped");
                setStep(1);
              }}
              className="mt-3 text-[12px] text-ink-secondary hover:text-ink"
            >
              Maybe later
            </button>
          </div>
        )}

        {step === 1 && (
          <div className="flex min-h-0 flex-col">
            <h1 className="text-[18px] font-semibold text-ink">Your engines</h1>
            <p className="mt-1 text-[13.5px] text-ink-secondary">
              Bots run on AI tools installed on this computer — here&rsquo;s what we found.
            </p>
            <div className="mt-4 flex min-h-0 flex-col gap-2.5 overflow-y-auto pr-1">
              {!instances ? (
                <div className="flex items-center gap-2 py-6 text-ink-secondary">
                  <Loader2 size={16} className="animate-spin" /> Checking…
                </div>
              ) : (
                <>
                  {readyEngines.length > 0 && (
                    <>
                      <div className="text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary">Ready</div>
                      <div className="grid grid-cols-2 gap-2.5">
                        {readyEngines.map((e) => (
                          <ReadyTile key={e.label} {...e} />
                        ))}
                      </div>
                    </>
                  )}
                  {setupEngines.length > 0 && (
                    <>
                      <div className={`text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary ${readyEngines.length ? "mt-2" : ""}`}>
                        Needs setup
                      </div>
                      {setupEngines.map((e) => (
                        <SetupRow key={e.label} {...e} />
                      ))}
                    </>
                  )}
                </>
              )}
            </div>
            <button
              onClick={() => setStep(capabilities.dictation.available ? 2 : 3)}
              className="mt-5 w-full shrink-0 rounded-lg bg-accent py-2.5 text-[15px] font-medium text-white"
            >
              Continue
            </button>
          </div>
        )}

        {step === 2 && (
          <div className="flex min-h-0 flex-col overflow-y-auto">
            <h1 className="text-[18px] font-semibold text-ink">Permissions</h1>
            <p className="mt-1 text-[13.5px] text-ink-secondary">
              Optional, and only ever used when you ask for the feature.
            </p>
            <div className="mt-4 flex flex-col gap-2.5">
              <div className="flex items-center justify-between gap-3 rounded-xl bg-card p-3.5">
                <div className="flex items-start gap-3">
                  <Mic size={18} className="mt-0.5 shrink-0 text-ink-secondary" />
                  <div>
                    <div className="text-[14px] font-medium text-ink">Microphone & speech</div>
                    <div className="mt-0.5 text-[12.5px] text-ink-secondary">
                      Voice dictation into the composer, transcribed on-device.
                    </div>
                  </div>
                </div>
                {perms?.mic === "granted" ? (
                  <Check size={16} className="shrink-0 text-success" />
                ) : perms?.mic === "denied" || perms?.mic === "restricted" ? (
                  <button
                    onClick={() => window.muragebox?.permOpenSettings?.("mic")}
                    className="shrink-0 rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover"
                  >
                    Open Settings
                  </button>
                ) : (
                  <button
                    onClick={() =>
                      window.muragebox?.permRequestMic?.().then(() => window.muragebox?.permStatus?.().then(setPerms))
                    }
                    className="shrink-0 rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover"
                  >
                    Enable
                  </button>
                )}
              </div>
              {/* Screen Recording deliberately has no row here: macOS 15+
                  makes a pre-grant unreliable (per-process status caching,
                  helper misattribution, periodic re-prompts) — the OS flow
                  triggers on the first real capture in the Computer panel,
                  which is the moment the user has context for the dialog. */}
            </div>
            <button onClick={() => setStep(3)} className="mt-5 w-full rounded-lg bg-accent py-2.5 text-[15px] font-medium text-white">
              Continue
            </button>
            <button onClick={() => setStep(3)} className="mt-3 text-[12px] text-ink-secondary hover:text-ink">
              Skip for now
            </button>
          </div>
        )}

        {step === 3 && (
          <PhoneSetupFlow
            variant="onboarding"
            profileEmail={email}
            onSkip={() => {
              track("phone_setup_skipped");
              finish();
            }}
            onComplete={() => {
              track("phone_setup_completed");
              finish();
            }}
          />
        )}

      </div>
    </div>
  );
}
