// Paste-a-key rows. Packaged Electron saves secrets in the OS-backed store;
// browser development falls back to PUT /api/config. Secrets are write-only
// either way — GET /api/config returns configured flags, never values.
import { useEffect, useId, useRef, useState } from "react";
import { Check, CircleHelp, ExternalLink, Loader2, TriangleAlert } from "lucide-react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { cn } from "@/lib/cn";
// The label is shared, not copied: the Settings deep-link finds this field by
// it, and a second spelling here would break that link without a word.
import { APPS_KEY_FIELD_LABEL } from "./ConnectedAppsLock";

export type ConfigSection = "composio" | "box" | "opencodeGo";

/**
 * TWO DIFFERENT QUESTIONS, AND THIS ROW USED TO ASK ONLY ONE.
 *
 * "Is this working?" and "is MY key in this box?" are not the same question,
 * and for connected apps they routinely have different answers: a Flux Router
 * key runs the whole app catalogue through Flux's own broker, so the feature
 * works with this field empty.
 *
 * The row asked the first question and rendered the answer in every place
 * that means the second. Green dot, the word Connected, eight dots in the
 * field reading as a stored secret, and a red Clear button offering to remove
 * it. The owner pressed Clear repeatedly, on a key that was never there,
 * because the screen told him one was.
 *
 * So `stored` is the row's OWN secret and decides everything that implies a
 * saved value. `working` is whether the capability is available at all, and
 * only ever adds a sentence saying where it is running from.
 */
const SECTIONS: Record<
  ConfigSection,
  {
    body: (value: string) => unknown;
    /** This row's own secret is saved. Drives the dots, Clear, and Connected. */
    stored: (config: ConfigStatus) => boolean;
    /** The capability works, however it is being paid for. */
    working: (config: ConfigStatus) => boolean;
    /** Said when it works and this box is empty. Never implies a saved key. */
    elsewhere?: string;
  }
> = {
  composio: {
    body: (v) => ({ composio: { apiKey: v } }),
    // "self-hosted" is the server's own word for "running on the key in this
    // box" (server/composio.ts connectionMode). "managed" means a broker is
    // carrying it, which is exactly the case this row was getting wrong.
    stored: (c) => c.composio.mode === "self-hosted",
    working: (c) => c.composio.configured,
    elsewhere: "Already connected via Flux Router",
  },
  box: { body: (v) => ({ box: { token: v } }), stored: (c) => c.box.configured, working: (c) => c.box.configured },
  opencodeGo: {
    body: (v) => ({ opencodeGo: { apiKey: v } }),
    stored: (c) => c.opencodeGo?.configured ?? false,
    working: (c) => c.opencodeGo?.configured ?? false,
  },
};

/** What the row should say, as data, so it can be checked without a browser. */
export interface CredentialRowState {
  stored: boolean;
  working: boolean;
  /** The green "Connected", or the quieter sentence, or nothing at all. */
  status: string;
  /** The line under the field. It changes with the answer, because "add your
   *  own key" and "you do not need one" are different advice and the static
   *  sentence here used to say this key was REQUIRED, which was wrong in both
   *  directions once a broker could carry it. */
  detail: string;
  /** Green only for this row's own key. A borrowed one is not this row's. */
  tone: "own" | "borrowed" | "none";
}

export function credentialRowState(section: ConfigSection, config: ConfigStatus | null | undefined): CredentialRowState {
  const spec = SECTIONS[section];
  const base = CREDENTIALS[section].description;
  if (!config) return { stored: false, working: false, status: "", tone: "none", detail: base };
  const stored = spec.stored(config);
  const working = spec.working(config);
  if (stored) return { stored, working, status: "Connected", tone: "own", detail: `${base} Running on your own key.` };
  if (working && spec.elsewhere) {
    return { stored, working, status: spec.elsewhere, tone: "borrowed", detail: `${base} Nothing to do here. Add your own key only if you would rather run them on that.` };
  }
  return { stored, working, status: "", tone: "none", detail: base };
}

const ELECTRON_CREDENTIAL: Record<ConfigSection, "composioApiKey" | "boxToken" | "opencodeGoApiKey"> = {
  composio: "composioApiKey",
  box: "boxToken",
  opencodeGo: "opencodeGoApiKey",
};

const CREDENTIALS: Record<
  ConfigSection,
  {
    label: string;
    placeholder: string;
    description: string;
    href: string;
    linkLabel: string;
    optional: boolean;
    warning?: string;
  }
> = {
  composio: {
    label: APPS_KEY_FIELD_LABEL,
    placeholder: "ak_…",
    description: "Gmail, Slack, Notion, GitHub and 500+ more.",
    href: "https://dashboard.composio.dev",
    linkLabel: "Create or copy your key",
    optional: true,
  },
  box: {
    label: "Box API key",
    placeholder: "Paste your Box API key",
    description: "Give bots an isolated remote Linux computer with a desktop and terminal.",
    href: "https://docs.ascii.dev/box/api-keys",
    linkLabel: "Open Box API key guide",
    optional: true,
    warning: "Box is a separate service with its own account and terms. Check them before you connect it.",
  },
  opencodeGo: {
    label: "OpenCode API key",
    placeholder: "Paste an OpenCode API key",
    description: "Optional. Existing OpenCode Zen, Go, and other provider connections are detected automatically.",
    href: "https://opencode.ai/docs/providers/",
    linkLabel: "Open the OpenCode provider guide",
    optional: true,
  },
};

function CredentialHelp({ section }: { section: ConfigSection }) {
  const credential = CREDENTIALS[section];
  // Read live, because this sentence changes with the answer: "add your own
  // key" and "you do not need one" are different advice, and the static
  // version used to tell everyone this key was required.
  const { state } = useStore();
  const detail = credentialRowState(section, state.config).detail;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();

  useEffect(() => {
    if (!open) return;

    const closeOnOutsideClick = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };

    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative ml-auto">
      <button
        ref={buttonRef}
        type="button"
        aria-label={`About ${credential.label}`}
        aria-expanded={open}
        aria-controls={popoverId}
        onClick={() => setOpen((current) => !current)}
        className="flex size-6 items-center justify-center rounded-md text-ink-secondary outline-none transition-colors hover:bg-control hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/70"
      >
        <CircleHelp size={14} aria-hidden="true" />
      </button>
      {open && (
        <div
          id={popoverId}
          role="group"
          aria-label={`${credential.label} help`}
          className="animate-pop-in absolute right-0 z-30 mt-1.5 w-[270px] rounded-xl border border-hairline bg-panel p-3 text-left shadow-2xl"
        >
          <div className="text-[12px] leading-[1.45] text-ink-secondary">{detail}</div>
          {credential.warning && (
            <div className="mt-2 flex gap-1.5 rounded-lg border border-warning/25 bg-warning/10 px-2 py-1.5 text-[11px] leading-[1.4] text-warning">
              <TriangleAlert size={13} className="mt-px shrink-0" aria-hidden="true" />
              <span>{credential.warning}</span>
            </div>
          )}
          <a
            href={credential.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setOpen(false)}
            className="mt-2.5 flex items-center gap-1.5 text-[12px] font-medium text-accent hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
          >
            {credential.linkLabel}
            <ExternalLink size={12} aria-hidden="true" />
          </a>
        </div>
      )}
    </div>
  );
}

export function ApiKeyRow({
  section,
  onSaved,
}: {
  section: ConfigSection;
  /** Called after a successful save with the section's new configured flag. */
  onSaved?: (configured: boolean) => void;
}) {
  const { state, dispatch } = useStore();
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const row = credentialRowState(section, state.config);
  // Everything that implies a saved value keys off the row's OWN key.
  const configured = row.stored;
  const clearing = !value.trim() && configured;
  const credential = CREDENTIALS[section];

  const save = () => {
    if (saving || (!value.trim() && !configured)) return;
    setSaving(true);
    setError(null);
    const request = window.muragebox?.setCredential
      ? window.muragebox.setCredential(ELECTRON_CREDENTIAL[section], value.trim())
      : api("/api/config", {
          method: "PUT",
          body: JSON.stringify(SECTIONS[section].body(value.trim())),
        });
    request
      .then((status: ConfigStatus) => {
        dispatch({ type: "configStatus", config: status });
        setValue("");
        onSaved?.(SECTIONS[section].working(status));
      })
      .catch((e) => setError(e.message))
      .finally(() => setSaving(false));
  };

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2 text-[13px] text-ink-secondary">
        <span className={cn("size-1.5 rounded-full", row.tone === "own" ? "bg-success" : "bg-raised-hover")} />
        <span>{credential.label}</span>
        {credential.optional && (
          <span className="rounded bg-control px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-secondary">
            Optional
          </span>
        )}
        {row.status && (
          <span className={cn("text-[11px]", row.tone === "own" ? "text-success" : "text-ink-secondary")}>
            {row.status}
          </span>
        )}
        <CredentialHelp section={section} />
      </div>
      <div className="flex gap-2">
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          placeholder={configured ? "••••••••  (paste to replace)" : credential.placeholder}
          aria-label={credential.label}
          autoComplete="off"
          className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
        />
        <button
          onClick={save}
          disabled={saving || (!value.trim() && !configured)}
          className={cn(
            "flex w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-lg py-2 text-[13px]",
            clearing
              ? "bg-control text-danger hover:bg-raised-hover"
              : "bg-control text-ink hover:bg-raised-hover",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
          title={clearing ? "Remove the saved key" : "Save"}
        >
          {saving ? <Loader2 size={13} className="animate-spin" /> : clearing ? "Clear" : <><Check size={13} />Save</>}
        </button>
      </div>
      {error && <div className="mt-1 text-[12px] text-danger">{error}</div>}
    </div>
  );
}

/** Non-secret Docker-over-SSH target. Keys and passwords stay with SSH. */
export function VpsConnection() {
  const { state, dispatch } = useStore();
  const [alias, setAlias] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const configured = Boolean(state.config?.vps?.configured);

  useEffect(() => {
    setAlias(state.config?.vps?.sshAlias ?? "");
  }, [state.config?.vps?.sshAlias]);

  const save = () => {
    if (saving || (!alias.trim() && !configured)) return;
    setSaving(true);
    setError(null);
    api("/api/config", {
      method: "PUT",
      body: JSON.stringify({ vps: { sshAlias: alias.trim() } }),
    })
      .then((status: ConfigStatus) => {
        dispatch({ type: "configStatus", config: status });
        setAlias(status.vps?.sshAlias ?? "");
      })
      .catch((e) => setError(e.message))
      .finally(() => setSaving(false));
  };

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2 text-[13px] text-ink-secondary">
        <span className={cn("size-1.5 rounded-full", configured ? "bg-success" : "bg-raised-hover")} />
        <span>Self-hosted VPS</span>
        <span className="rounded bg-control px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-secondary">
          Optional
        </span>
        {configured && <span className="text-[11px] text-success">Connected</span>}
      </div>
      <div className="mb-1.5 text-[12px] leading-relaxed text-ink-secondary">
        SSH config alias for the Linux VPS. Murage uses your normal SSH config and agent; it does not store keys or passwords.{" "}
        See the{" "}
        <a
          href="https://github.com/FerroxLabs/murage/blob/main/docs/byo-vps.md"
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent hover:underline"
        >
          setup guide
        </a>{" "}
        for the required SSH alias shape.
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={alias}
          onChange={(e) => setAlias(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          placeholder="my-vps"
          aria-label="Self-hosted VPS SSH config alias"
          autoComplete="off"
          className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
        />
        <button
          onClick={save}
          disabled={saving || (!alias.trim() && !configured)}
          className={cn(
            "flex w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-lg py-2 text-[13px]",
            !alias.trim() && configured ? "bg-control text-danger hover:bg-raised-hover" : "bg-control text-ink hover:bg-raised-hover",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
          title={!alias.trim() && configured ? "Remove the saved alias" : "Save"}
        >
          {saving ? <Loader2 size={13} className="animate-spin" /> : !alias.trim() && configured ? "Clear" : <><Check size={13} />Save</>}
        </button>
      </div>
      {error && <div className="mt-1 text-[12px] text-danger">{error}</div>}
    </div>
  );
}
