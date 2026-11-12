// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import { Pin } from "lucide-react";
import { t } from "@/lib/i18n";
import { notifySurfacesBridge, type NotifyCapabilities } from "@/lib/notify-surfaces";

const offered = (cap: NotifyCapabilities) => ["darwin", "win32", "linux"].includes(cap.platform) && cap.surfaces.bubble.available === true &&
  (cap.platform !== "linux" || cap.session === "x11");

export function PinToEdgeMenuItem({ botId, onPinned, onError }: { botId: string; onPinned: () => void; onError: (message: string) => void }) {
  const [available, setAvailable] = useState(false), [busy, setBusy] = useState(false);
  const saving = useRef(false);
  useEffect(() => {
    let alive = true;
    const bridge = notifySurfacesBridge();
    void bridge?.capabilities().then(cap => { if (alive) setAvailable(offered(cap)); }).catch(() => {
      // Capability discovery is background work; a failed read must leave pinning unavailable.
      if (alive) setAvailable(false);
    });
    return () => { alive = false; };
  }, []);
  if (!available) return null;
  return <button type="button" role="menuitem" disabled={busy}
    className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
    onClick={async () => {
      const bridge = notifySurfacesBridge();
      if (!bridge || saving.current) return;
      saving.current = true; setBusy(true);
      try {
        if (!offered(await bridge.capabilities())) { setAvailable(false); return; }
        const pinned = await bridge.set("pinnedBotId", botId);
        if (pinned.pinnedBotId !== botId) throw new Error("pin");
        const enabled = await bridge.set("surfaces.bubble", true);
        if (enabled.surfaces.bubble !== true) throw new Error("enable");
        onPinned();
      } catch { onError(t("float.pinError")); }
      finally { saving.current = false; setBusy(false); }
    }}><Pin size={16} aria-hidden="true" />{t("float.pin")}</button>;
}
