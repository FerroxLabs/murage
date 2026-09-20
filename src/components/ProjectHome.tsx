// A project's home: what the work is for, and how it is going.
//
// A project is a channel that has been given a purpose, so this is not a
// second kind of thing with a second chat. The Chat tab beside this one is
// the channel's own transcript, with the same bots, the same instructions
// and the same folder it always had. This page only answers the two
// questions a channel could not: what are we doing, and where are we up to.
import { useEffect, useState } from "react";
import { Users } from "lucide-react";

import { useStore, type Bot, type Group } from "@/state/store";
import {
  CHANNEL_PROJECT_GOAL_MAX,
  CHANNEL_PROJECT_STATUSES,
  CHANNEL_PROJECT_STATUS_LABELS,
} from "../../shared/project";
import { PROJECT_STATUS_NOTES, projectTimingLine } from "@/lib/channel-surface";
import { BotAvatar } from "./Avatar";
import { cn } from "@/lib/cn";

export { PROJECT_STATUS_NOTES, projectTimingLine } from "@/lib/channel-surface";

const BUTTON =
  "rounded-lg bg-raised px-3 py-2 text-[13px] text-ink hover:brightness-110 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";
const PRIMARY =
  "rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

export function ProjectHome({
  group,
  members,
  onOpenChat,
  onOpenDetails,
}: {
  group: Group;
  members: Bot[];
  onOpenChat: () => void;
  onOpenDetails: () => void;
}) {
  const { dispatch } = useStore();
  const project = group.channelProject;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(project?.goal ?? "");
  useEffect(() => setDraft(project?.goal ?? ""), [project?.goal]);

  if (!project) return null;

  const saveGoal = () => {
    const goal = draft.trim();
    if (goal && goal !== project.goal) {
      dispatch({ type: "patchGroup", groupId: group.id, patch: { channelProject: { goal } } });
    }
    setEditing(false);
  };

  return (
    <div className="h-full overflow-y-auto px-5 py-6 max-md:px-3">
      <div className="mx-auto flex w-full max-w-[640px] flex-col gap-4">
        <section aria-labelledby="project-goal-heading" className="rounded-2xl border border-hairline/40 bg-panel/60 p-5">
          <h2 id="project-goal-heading" className="text-[13px] font-semibold uppercase tracking-wide text-ink-secondary">
            What this is for
          </h2>
          {editing ? (
            <>
              <label className="sr-only" htmlFor="project-goal-editor">
                What this project is for
              </label>
              <textarea
                id="project-goal-editor"
                autoFocus
                value={draft}
                maxLength={CHANNEL_PROJECT_GOAL_MAX}
                onChange={(event) => setDraft(event.target.value)}
                rows={4}
                className="mt-2 w-full resize-y rounded-xl border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] leading-relaxed text-ink focus:border-accent focus:outline-none"
              />
              <div className="mt-3 flex gap-2">
                <button type="button" onClick={saveGoal} disabled={!draft.trim()} className={PRIMARY}>
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDraft(project.goal);
                    setEditing(false);
                  }}
                  className={BUTTON}
                >
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="mt-2 whitespace-pre-wrap break-words text-[17px] leading-relaxed text-ink">{project.goal}</p>
              <button type="button" onClick={() => setEditing(true)} className={cn(BUTTON, "mt-3")}>
                Change this
              </button>
            </>
          )}
        </section>

        <section aria-labelledby="project-status-heading" className="rounded-2xl border border-hairline/40 bg-panel/60 p-5">
          <h2 id="project-status-heading" className="text-[13px] font-semibold uppercase tracking-wide text-ink-secondary">
            How it is going
          </h2>
          <p className="mt-2 text-[17px] font-medium text-ink">{CHANNEL_PROJECT_STATUS_LABELS[project.status]}</p>
          <p className="mt-0.5 text-[13.5px] text-ink-secondary">{PROJECT_STATUS_NOTES[project.status]}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {CHANNEL_PROJECT_STATUSES.filter((status) => status !== project.status).map((status) => (
              <button
                key={status}
                type="button"
                onClick={() => dispatch({ type: "patchGroup", groupId: group.id, patch: { channelProject: { status } } })}
                className={BUTTON}
              >
                {CHANNEL_PROJECT_STATUS_LABELS[status]}
              </button>
            ))}
          </div>
          <p className="mt-3 text-[12.5px] text-ink-secondary">{projectTimingLine(project)}</p>
        </section>

        <section aria-labelledby="project-team-heading" className="rounded-2xl border border-hairline/40 bg-panel/60 p-5">
          <h2 id="project-team-heading" className="text-[13px] font-semibold uppercase tracking-wide text-ink-secondary">
            Who is on it
          </h2>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {members.map((bot) => (
              <span key={bot.id} className="flex items-center gap-1.5 rounded-full bg-raised/70 py-1 pl-1 pr-3">
                <BotAvatar bot={bot} state="happy" size={24} animated={false} />
                <span className="text-[13px] text-ink">{bot.name}</span>
              </span>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={onOpenChat} className={PRIMARY}>
              Open the chat
            </button>
            <button type="button" onClick={onOpenDetails} className={cn(BUTTON, "flex items-center gap-1.5")}>
              <Users size={14} /> Members, files and instructions
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
