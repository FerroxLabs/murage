// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { useState } from "react";
import type { Bot, Group, Message } from "@/state/store";
import { projectClient, refreshProject } from "@/lib/use-project";
import { projectEvents } from "@/lib/project-events";
const BUTTON = "min-h-11 rounded-lg px-3 text-[13px] hover:bg-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50";
export function MurageMessageRow({ message, group, members, disabledReason }: { message: Message; group: Group; members: Bot[]; disabledReason?: string | null }) {
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [reassign, setReassign] = useState(false);
  const [assignee, setAssignee] = useState("");
  const requestId = message.murage?.retry?.requestId ?? message.requestId;
  const actions = !!message.murage?.retry || !!message.murage?.reassign;
  async function retry() {
    if (!requestId || busy || disabledReason) return;
    setBusy(true); setReason(null);
    const result = await projectClient.retry(group.id, requestId, reassign ? assignee : undefined);
    if (!result.ok) setReason(result.reason);
    else { setReassign(false); setReason("New attempt queued"); }
    setBusy(false);
    if (group.channelProject) void refreshProject(group.id);
    projectEvents.frame({ kind: "room.requests", groupId: group.id, threadId: group.threadId });
  }
  return <div data-testid="murage-row" className="min-w-0 rounded-lg border border-hairline/40 px-3 py-2 text-[13px] text-ink-secondary">
    <span className="font-medium text-ink">Murage</span>
    <p className="whitespace-pre-wrap break-words">{message.text || message.tool?.name.replace(/^error:\s*/, "")}</p>
    {actions && <div className="flex flex-wrap items-center gap-1">
      {message.murage?.retry && <button type="button" className={BUTTON} disabled={busy || !!disabledReason || !requestId} onClick={() => void retry()}>Retry</button>}
      {message.murage?.reassign && <button type="button" className={BUTTON} disabled={busy || !!disabledReason || !requestId} onClick={() => setReassign(!reassign)}>Reassign</button>}
      {reassign && <form className="flex flex-wrap gap-1" onSubmit={(event) => { event.preventDefault(); void retry(); }}>
        <label>Assign to <select autoFocus value={assignee} onChange={(event) => setAssignee(event.target.value)} className="min-h-11 rounded-lg border border-hairline bg-app px-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"><option value="">Choose a member</option>{members.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select></label>
        <button type="submit" className={BUTTON} disabled={!assignee || busy}>Reassign request</button>
      </form>}
    </div>}
    {actions && disabledReason && <p>{disabledReason}</p>}
    {reason && <p role="status">{reason}</p>}
  </div>;
}
