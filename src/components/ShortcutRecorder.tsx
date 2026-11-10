// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useId, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import { validAccelerator } from "../../shared/notify-surfaces.mjs";

export type ShortcutRecordResult = { ok: boolean; reason?: "taken" | "invalid" | "unsupported" };
export interface ShortcutRecorderProps {
  value: string | null;
  platform: string;
  onRecord: (accelerator: string | null) => Promise<ShortcutRecordResult>;
  /** Optional clear adapter; otherwise Clear calls onRecord(null). */
  onClear?: () => Promise<ShortcutRecordResult>;
  disabled?: boolean;
  unsupported?: boolean;
}

type ShortcutKeyEvent = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">;
const namedKeys: Record<string, string> = {
  " ": "Space", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  Enter: "Return", "+": "Plus", "-": "Minus",
};
const modifiers = new Set(["Control", "Alt", "AltGraph", "Shift", "Meta", "OS"]);

/** Layout letters first, physical codes for shifted digits and non-Latin letter layouts. */
export function shortcutAccelerator(event: ShortcutKeyEvent, platform: string): string | null {
  if (modifiers.has(event.key) || ["Escape", "Dead", "Process", "Unidentified"].includes(event.key)) return null;
  const parts = [];
  if (event.ctrlKey) parts.push("Control");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push(platform === "darwin" ? "Command" : "Super");
  let key = namedKeys[event.key] ?? event.key;
  if (/^[a-z]$/i.test(key)) key = key.toUpperCase();
  else if (!validAccelerator(`Control+${key}`)) {
    const code = /^(?:Key([A-Z])|Digit([0-9])|Numpad([0-9]))$/.exec(event.code);
    if (code) key = code[1] ?? code[2] ?? code[3];
  }
  const accelerator = [...parts, key].join("+");
  return validAccelerator(accelerator) ? accelerator : null;
}

const errorKeys = {
  taken: "notifyMe.shortcut.taken", invalid: "notifyMe.shortcut.invalid", unsupported: "notifyMe.shortcut.unsupported",
} as const;
const buttonClass = "min-h-11 rounded-lg border border-hairline/50 bg-control px-3 text-[13px] text-ink disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

export function ShortcutRecorder({ value, platform, onRecord, onClear, disabled = false, unsupported = false }: ShortcutRecorderProps) {
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const button = useRef<HTMLButtonElement>(null);
  const pending = useRef(false);
  const focusAfter = useRef(false);
  const mounted = useRef(false);
  const descriptionId = useId();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!busy && focusAfter.current) { focusAfter.current = false; button.current?.focus(); }
  }, [busy, recording]);

  const cancel = () => { focusAfter.current = true; setRecording(false); };
  const save = async (accelerator: string | null) => {
    if (pending.current) return;
    pending.current = true; setRecording(false); setBusy(true); setError("");
    try {
      const result = await (accelerator === null && onClear ? onClear() : onRecord(accelerator));
      if (mounted.current && !result.ok) setError(t(result.reason ? errorKeys[result.reason] : "notifyMe.shortcut.errorSave"));
    } catch { if (mounted.current) setError(t("notifyMe.shortcut.errorSave")); }
    finally {
      pending.current = false;
      if (mounted.current) { focusAfter.current = true; setBusy(false); }
    }
  };

  useEffect(() => {
    if (!recording || disabled || unsupported) return;
    // Capture before application keyboard handlers while the recorder owns focus.
    let captured = false;
    const keydown = (event: KeyboardEvent) => {
      event.preventDefault(); event.stopPropagation();
      if (captured || event.repeat || event.isComposing) return;
      if (event.key === "Escape") { captured = true; cancel(); return; }
      if (modifiers.has(event.key)) return;
      captured = true;
      const accelerator = shortcutAccelerator(event, platform);
      if (!accelerator) { setError(t("notifyMe.shortcut.invalid")); cancel(); return; }
      void save(accelerator);
    };
    const doc = button.current?.ownerDocument;
    doc?.addEventListener("keydown", keydown, true);
    return () => { doc?.removeEventListener("keydown", keydown, true); };
    // The callback props are captured for one recording session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, disabled, unsupported, platform]);
  useEffect(() => { if (disabled || unsupported) setRecording(false); }, [disabled, unsupported]);

  return <div className="mt-2 text-[12px] text-ink">
    <div className="flex flex-wrap items-center gap-2">
      {value && <kbd aria-label={t("notifyMe.shortcut.current", { key: value })} className="rounded-md border border-hairline/50 bg-inset px-2 py-1 font-mono text-[12px]">{value}</kbd>}
      <button ref={button} type="button" disabled={disabled || busy || unsupported} aria-pressed={recording}
        aria-label={t(recording ? "notifyMe.shortcut.cancel" : "notifyMe.shortcut.record")} aria-describedby={descriptionId}
        onClick={() => { if (recording) cancel(); else { setError(""); setRecording(true); } }} className={buttonClass}>
        {t(recording ? "notifyMe.shortcut.cancel" : "notifyMe.shortcut.record")}
      </button>
      <button type="button" disabled={disabled || busy || recording || value === null} aria-label={t("notifyMe.shortcut.clear")}
        onClick={() => void save(null)} className={buttonClass}>{t("notifyMe.shortcut.clear")}</button>
    </div>
    <p id={descriptionId} role="status" className="mt-1 text-ink-secondary">
      {unsupported ? t("notifyMe.shortcut.unsupported") : recording ? t("notifyMe.shortcut.recording") : ""}
    </p>
    {error && <p role="alert" className="mt-1 text-danger">{error}</p>}
  </div>;
}
