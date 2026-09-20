// The guided first run, hosted by the bot you first meet.
//
// This file owns three things and deliberately nothing else:
//   1. reading GET /api/setup and re-reading it after every write,
//   2. turning a card's button into the REAL action elsewhere in the app
//      (the one Flux key field, the engines page, the connected-apps panel,
//      the crew library, a message to the Chief),
//   3. opening and closing.
//
// It never decides that a step is finished. Every write answers with the
// server's freshly derived view and that view is what gets rendered, so a
// click that did not actually change the world leaves the card exactly where
// it was — which is the whole point of a checklist that survives a weak
// engine, a capped account and a machine the included brain cannot run on.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { X } from "lucide-react";

import type { SetupStep, SetupView } from "../../shared/setup";
import { SETUP_NOTE_MAX } from "../../shared/setup";
import { api, useStore } from "@/state/store";
import { SetupChecklistBody, type SetupActions } from "./SetupChecklist";
import { COMPOSIO_KEY_FIELD_SELECTOR, FLUX_KEY_FIELD_SELECTOR, focusSettingsField } from "./ConnectedAppsLock";
import { cn } from "@/lib/cn";

void COMPOSIO_KEY_FIELD_SELECTOR; // the apps card points at Flux, not at a second key

// ── opening it from anywhere ───────────────────────────────────────────
// A module-level latch rather than a store action: the composer's "/" menu
// and the Settings row both just want it on screen, and neither should have
// to own a piece of app state to say so.
let open = false;
const listeners = new Set<() => void>();
const publish = () => { for (const listener of [...listeners]) listener(); };

export function openSetup(): void {
  if (open) return;
  open = true;
  publish();
}

export function closeSetup(): void {
  if (!open) return;
  open = false;
  publish();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useSetupOpen(): boolean {
  return useSyncExternalStore(subscribe, () => open, () => false);
}

/** Remembered per machine, so closing the first run does not make it come
 *  back at the next launch. `/setup` and Settings reopen it regardless. */
const SEEN_KEY = "murage-setup-seen";

function markSeen(): void {
  try { window.localStorage.setItem(SEEN_KEY, "1"); } catch { /* storage blocked */ }
}

function alreadySeen(): boolean {
  try { return window.localStorage.getItem(SEEN_KEY) === "1"; } catch { return false; }
}

/**
 * Whether this is the first run the checklist is FOR.
 *
 * Nothing recorded and nothing done: an install that has never been through
 * setup. An existing workspace — which has answered a bot, connected an app
 * or saved a key long ago — is never interrupted by this, it reaches the same
 * list through `/setup` or Settings.
 */
export function setupIsFirstRun(view: SetupView): boolean {
  return view.progress.done === 0 && view.steps.every((step) => !step.skipped && !(step.note ?? "").trim());
}

// ── the panel ──────────────────────────────────────────────────────────
export function SetupPanel() {
  const { state, dispatch } = useStore();
  const visible = useSetupOpen();
  const [view, setView] = useState<SetupView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyStep, setBusyStep] = useState<SetupStep | null>(null);
  const [openStep, setOpenStep] = useState<SetupStep | null>(null);
  const autoOffered = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  const read = useCallback(async () => {
    try {
      setView((await api("/api/setup")) as SetupView);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Setup could not be read.");
    }
  }, []);

  // One read as soon as the harness is there, whether or not the panel is
  // up: it is also what decides whether a fresh install is offered the list.
  useEffect(() => {
    if (!state.connected) return;
    void read();
  }, [state.connected, read]);

  useEffect(() => {
    if (!view || autoOffered.current) return;
    autoOffered.current = true;
    if (setupIsFirstRun(view) && !alreadySeen()) openSetup();
  }, [view]);

  useEffect(() => {
    if (!visible) return;
    markSeen();
    void read();
    setOpenStep(null);
  }, [visible, read]);

  useEffect(() => {
    if (!visible) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); closeSetup(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible]);

  useEffect(() => {
    if (visible && view) dialogRef.current?.focus();
  }, [visible, view]);

  const chief = view?.chiefBotId ? state.bots.find((bot) => bot.id === view.chiefBotId) : undefined;
  const brainName = chief
    ? (state.instances.find((instance) => instance.instanceId === chief.modelSelection.instanceId)?.displayName
      ?? chief.modelSelection.instanceId)
    : undefined;

  /** Every write answers with the server's own re-derived view; that answer
   *  is what is rendered. Nothing is assumed from the click. */
  const write = useCallback(async (step: SetupStep, path: string, body: Record<string, unknown>) => {
    setBusyStep(step);
    try {
      await api(path, { method: "POST", body: JSON.stringify(body) });
      setError(null);
      setOpenStep(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That could not be saved.");
      await read();
    } finally {
      setBusyStep(null);
    }
  }, [read]);

  const openSettings = useCallback((section: "connections" | "engines") => {
    closeSetup();
    dispatch({ type: "toggleAppSettings", open: true, section });
  }, [dispatch]);

  const sendToChief = useCallback((text: string) => {
    if (!chief) return;
    closeSetup();
    dispatch({ type: "select", id: chief.id });
    dispatch({ type: "send", botId: chief.id, text });
  }, [chief, dispatch]);

  const actions: SetupActions = {
    answer: (step, answer) => void write(step, "/api/setup/answer", { step, answer: answer.slice(0, SETUP_NOTE_MAX) }),
    skip: (step) => void write(step, "/api/setup/skip", { step }),
    reopen: (step) => void write(step, "/api/setup/reopen", { step }),
    letMeIn: () => {
      void (async () => {
        if (!view) return;
        setBusyStep("purpose");
        try {
          let latest = view;
          for (const step of view.steps) {
            if (step.status === "done" || step.skipped) continue;
            latest = (await api("/api/setup/skip", {
              method: "POST",
              body: JSON.stringify({ step: step.id }),
            })) as SetupView;
          }
          setView(latest);
          closeSetup();
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "That could not be saved.");
          await read();
        } finally {
          setBusyStep(null);
        }
      })();
    },
    addFluxKey: () => {
      openSettings("connections");
      focusSettingsField(FLUX_KEY_FIELD_SELECTOR);
    },
    chooseBrain: () => openSettings("engines"),
    sayHello: () => sendToChief("Hello — can you hear me?"),
    browseCrews: () => {
      closeSetup();
      dispatch({ type: "showTeamLibrary" });
    },
    connectApps: () => {
      closeSetup();
      dispatch({ type: "togglePlugins", open: true });
    },
    startFirstTask: (task) => sendToChief(task),
    saveMemory: (text) => {
      void (async () => {
        if (!chief) return;
        setBusyStep("wrap");
        try {
          await api(`/api/bots/${chief.id}/memory`, { method: "PUT", body: JSON.stringify({ text }) });
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Your Chief's notebook could not be written.");
          setBusyStep(null);
          await read();
          return;
        }
        setBusyStep(null);
        await write("wrap", "/api/setup/answer", { step: "wrap", answer: "confirmed" });
      })();
    },
  };

  if (!visible) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-0 sm:p-6">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="setup-panel-title"
        tabIndex={-1}
        data-setup-panel=""
        className={cn(
          "flex max-h-full w-full flex-col overflow-hidden bg-panel shadow-2xl shadow-black/50",
          "sm:max-h-[90vh] sm:max-w-[640px] sm:rounded-2xl sm:border sm:border-hairline/50",
          "h-full sm:h-auto focus-visible:outline-none",
        )}
      >
        <div className="flex items-center justify-between gap-3 border-b border-hairline/40 px-4 py-3">
          <h2 id="setup-panel-title" className="text-[15px] font-semibold text-ink">
            Get set up
          </h2>
          <button
            type="button"
            onClick={closeSetup}
            aria-label="Close setup"
            className="rounded-md p-1.5 text-ink-secondary hover:bg-control hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {error && (
          <p role="alert" className="border-b border-danger/30 bg-danger/10 px-4 py-2.5 text-[13px] text-ink">
            {error}
          </p>
        )}

        {view ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <SetupChecklistBody
              view={view}
              actions={actions}
              chiefName={chief?.name}
              brainName={brainName}
              openStep={openStep}
              onOpenStep={setOpenStep}
              busyStep={busyStep}
            />
          </div>
        ) : (
          <p className="px-4 py-6 text-[13px] text-ink-secondary">Reading where you got to…</p>
        )}
      </div>
    </div>
  );
}
