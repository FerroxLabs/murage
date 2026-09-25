// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings > General > Announcements. On by default. Off hides news and
// important notices; security notices still show, and each can still be
// dismissed. The choice lives in the data dir (server/announcements.ts).
import { useEffect, useState } from "react";
import { api } from "@/state/store";
import { ANNOUNCEMENTS_CHANGED_EVENT } from "@/lib/announcements";
import { Card, Switch } from "./SettingsPrimitives";

export function AnnouncementsSettings() {
  const [show, setShow] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    api("/api/announcements/settings")
      .then((answer: { show?: unknown }) => { if (live) setShow(answer?.show !== false); })
      .catch(() => { if (live) setError("Could not read this setting."); });
    return () => { live = false; };
  }, []);

  const toggle = async () => {
    if (saving || show === null) return;
    setSaving(true);
    setError("");
    try {
      const answer: { show?: unknown } = await api("/api/announcements/settings", { method: "POST", body: JSON.stringify({ show: !show }) });
      setShow(answer?.show !== false);
      window.dispatchEvent(new Event(ANNOUNCEMENTS_CHANGED_EVENT));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save this setting.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title="Announcements" subtitle="Short notes from the Murage team: new features, a service problem, a fix to install.">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-ink">Show announcements</div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
            Security notices always show, even when this is off.
          </div>
        </div>
        <Switch aria-label="Show announcements" checked={show !== false} disabled={show === null || saving} onClick={() => void toggle()} />
      </div>
      {error ? <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p> : null}
    </Card>
  );
}
