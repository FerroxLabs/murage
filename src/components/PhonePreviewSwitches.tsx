// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.12: Settings > Phone and other devices > Preview. Two independent switches for the two phone previews. Each writes its own
// flag through PATCH /api/config ({features:{phoneTools}} or {features:{phoneShareAsk}}) and reads back GET /api/phones/offered.
// A switch that is on but not offered on this host (a Cloud home, a shared workspace, no desktop launch proof) stays on and shows
// one plain line saying why. Desktop app only: CompanionSection renders it on its desktop path, and it renders nothing elsewhere.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/state/store";
import { useDesktopSurface } from "../lib/use-surface";
import { Card, Switch } from "./SettingsPrimitives";

export type PhoneOfferBlock = "cloud-home" | "shared-workspace" | "launch-proof";
/** GET /api/phones/offered. `shareAskFlag` and `blocked` are 1.0.12 additions; an older harness leaves them out. */
export interface PhoneOfferAnswer {
  offered: boolean;
  flag: boolean;
  shareAsk: boolean;
  shareAskFlag?: boolean;
  blocked?: PhoneOfferBlock | null;
}
export type PhonePreview = "phoneTools" | "phoneShareAsk";

export const PREVIEW_CARD_TITLE = "Preview";
export const PREVIEW_CARD_SUBTITLE = "Early versions of new phone features. Each one is off until you turn it on.";
export const PREVIEW_COPY: Record<PhonePreview, { label: string; body: string }> = {
  phoneTools: {
    label: "Phone tools (preview)",
    body: "Let your bots check and add to this phone's calendar, reminders, contacts, alarms and rough location. You approve each request on the phone.",
  },
  phoneShareAsk: {
    label: "Share and ask (preview)",
    body: "Send things to your bots from any app on the phone, and ask them from anywhere.",
  },
};
/** The one line under a switch that is on but does nothing on this host. */
export const PREVIEW_BLOCKED_LINE: Record<PhoneOfferBlock | "unknown", string> = {
  "cloud-home": "On, but not used here: this Murage runs in the Cloud, and the preview works only on your own computer.",
  "shared-workspace": "On, but not used here: this workspace is shared with other people.",
  "launch-proof": "On, but not used here: open Murage from the desktop app to use it.",
  unknown: "On, but not used on this computer yet.",
};
export const PREVIEW_SAVE_FAILED = "That did not save. Try again.";
export const PREVIEW_READ_FAILED = "Could not check these settings.";
export const PREVIEW_RETRY = "Try again";

/** The exact PATCH /api/config body for one switch. */
export function previewPatchBody(which: PhonePreview, on: boolean): { features: Partial<Record<PhonePreview, boolean>> } {
  return { features: { [which]: on } };
}

/** Whether the switch shows on: the saved flag, never whether the host offers it. */
export function previewFlagOn(which: PhonePreview, answer: PhoneOfferAnswer | null): boolean {
  if (!answer) return false;
  return which === "phoneTools" ? answer.flag === true : answer.shareAskFlag === true;
}

/** The plain reason line, or null: shown only while the flag is on and this host does not offer the feature. */
export function previewReason(which: PhonePreview, answer: PhoneOfferAnswer | null): string | null {
  if (!answer || !previewFlagOn(which, answer)) return null;
  const offered = which === "phoneTools" ? answer.offered === true : answer.shareAsk === true;
  if (offered) return null;
  return PREVIEW_BLOCKED_LINE[answer.blocked ?? "unknown"];
}

export function PreviewSwitchRow({
  which,
  answer,
  busy,
  error,
  onChange,
}: {
  which: PhonePreview;
  answer: PhoneOfferAnswer | null;
  busy: boolean;
  error: boolean;
  onChange: (on: boolean) => void;
}) {
  const copy = PREVIEW_COPY[which];
  const on = previewFlagOn(which, answer);
  const reason = previewReason(which, answer);
  return (
    <div className="flex items-start justify-between gap-4 border-t border-hairline/30 pt-3 first:border-t-0 first:pt-0" data-preview={which}>
      <div className="min-w-0">
        <div className="text-[13px] text-ink">{copy.label}</div>
        <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-secondary">{copy.body}</div>
        {reason && <div className="mt-1 text-[11.5px] leading-relaxed text-ink-secondary" data-preview-reason={which}>{reason}</div>}
        {error && <div className="mt-1 text-[11.5px] text-danger" role="alert">{PREVIEW_SAVE_FAILED}</div>}
      </div>
      <Switch
        checked={on}
        aria-label={copy.label}
        disabled={busy || answer === null}
        onClick={() => onChange(!on)}
      />
    </div>
  );
}

/** Shown when the current settings could not be read: the switches are held, because a click would act on a state nobody knows. */
export function PreviewReadFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 text-[11.5px] text-ink-secondary" role="alert">
      <span>{PREVIEW_READ_FAILED}</span>
      <button type="button" onClick={onRetry} className="shrink-0 text-[12px] text-accent hover:opacity-80">{PREVIEW_RETRY}</button>
    </div>
  );
}

/**
 * The Preview card. `onAnswer` hands every fresh answer to the parent (CompanionSection reads `shareAsk` from it for the
 * per-device share and ask row), so the page asks the harness once per change, not twice.
 */
export function PhonePreviewSwitches({ onAnswer }: { onAnswer?: (answer: PhoneOfferAnswer | null) => void }) {
  const desktop = useDesktopSurface();
  const [answer, setAnswer] = useState<PhoneOfferAnswer | null>(null);
  const [busy, setBusy] = useState<PhonePreview | null>(null);
  const [failed, setFailed] = useState<PhonePreview | null>(null);
  const [unread, setUnread] = useState(false);
  // A ref, so a parent passing a fresh function each render never makes this ask again.
  const report = useRef(onAnswer);
  report.current = onAnswer;

  const load = useCallback(async (): Promise<void> => {
    try {
      const next = (await api("/api/phones/offered")) as PhoneOfferAnswer;
      setAnswer(next);
      setUnread(false);
      report.current?.(next);
    } catch {
      // Never keep the last answer: after a save that worked, it would show the old state and the next click would send the same write.
      setAnswer(null);
      setUnread(true);
      report.current?.(null);
    }
  }, []);

  useEffect(() => {
    if (desktop !== true) return;
    void load();
  }, [desktop, load]);

  if (desktop !== true) return null;

  const change = async (which: PhonePreview, on: boolean) => {
    setBusy(which);
    setFailed(null);
    try {
      await api("/api/config", { method: "PATCH", body: JSON.stringify(previewPatchBody(which, on)) });
    } catch {
      setFailed(which);
    } finally {
      await load();
      setBusy(null);
    }
  };

  return (
    <Card title={PREVIEW_CARD_TITLE} subtitle={PREVIEW_CARD_SUBTITLE}>
      <div className="flex flex-col gap-3" data-testid="phone-preview-switches">
        {unread && <PreviewReadFailed onRetry={() => void load()} />}
        {(["phoneTools", "phoneShareAsk"] as const).map((which) => (
          <PreviewSwitchRow
            key={which}
            which={which}
            answer={answer}
            busy={busy !== null}
            error={failed === which}
            onChange={(on) => void change(which, on)}
          />
        ))}
      </div>
    </Card>
  );
}
