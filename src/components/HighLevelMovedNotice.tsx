// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Murage's own HighLevel screen is gone (1.0.20): HighLevel now connects through Connected apps or the owner's own MCP
// server. An owner who had set it up sees one quiet, dismissible line about that, once. The server decides "once"
// (GET /api/notices/highlevel-moved answers the line one time per install, then null); the renderer asks once per page
// load on the desktop app, never on a phone or a Cloud surface and never while the first run owns the screen. One call,
// no retries; any failure shows nothing. It waits its turn in the notice corner like the other quiet lines.
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { t } from "@/lib/i18n";
import { useClearOfComposer, useNoticeTurn } from "@/lib/notice-lane";
import { api } from "@/state/store";

type Request = (path: string) => Promise<unknown>;

/** The one line to show, or null. Any failure or odd answer is null: this line is never worth an error. */
export async function fetchHighLevelMovedLine(request: Request): Promise<string | null> {
  try {
    const answer = await request("/api/notices/highlevel-moved");
    const line = answer && typeof answer === "object" ? (answer as { line?: unknown }).line : null;
    return typeof line === "string" && line.trim() ? line.trim() : null;
  } catch {
    return null;
  }
}

/** One GET, no busy or reconnect retries. */
const askOnce: Request = (path) => api(path, undefined, 0, 0);

export function HighLevelMovedNotice({ ready, request = askOnce }: { ready: boolean; request?: Request }) {
  const [line, setLine] = useState<string | null>(null);
  const asked = useRef(false);
  useEffect(() => {
    if (!ready || asked.current) return;
    // Asked once per page load. No cancel on cleanup: the server answers the line only once, so it must not be dropped.
    asked.current = true;
    void fetchHighLevelMovedLine(request).then(setLine);
  }, [ready, request]);
  const wants = line !== null;
  const turn = useNoticeTurn("moved", wants);
  const frame = useRef<HTMLDivElement>(null);
  const clear = useClearOfComposer(frame, wants && turn);
  if (!line || !turn) return null;
  return (
    <div
      ref={frame}
      role="status"
      data-testid="highlevel-moved-notice"
      style={clear}
      className="fixed bottom-4 left-4 z-40 flex max-w-sm items-center gap-3 rounded-lg border border-hairline/40 bg-panel px-3 py-2 text-[12px] text-ink-secondary shadow-lg"
    >
      <span>{line}</span>
      <button aria-label={t("composer.dismissNotice")} onClick={() => setLine(null)} className="rounded p-0.5 text-ink-secondary hover:text-ink">
        <X size={12} />
      </button>
    </div>
  );
}
