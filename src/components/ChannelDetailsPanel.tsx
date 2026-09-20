// Everything about one channel, in one place you can get to from its header.
//
// Before this, a channel's instructions were a one-line strip above the
// transcript, its folder was a chip, its lead was a dropdown, its members
// were a row of faces, and what it remembered was nowhere at all. Four
// sections, one panel: About, Members, Files, Memory.
//
// It opens and closes exactly like ManageMembersPanel — a modal over the
// channel, Escape closes it, Tab stays inside it, and focus goes back to the
// control that opened it — because a person should not have to learn two
// different panels in the same header.
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { FolderOpen, X } from "lucide-react";

import { api, useStore, type Bot, type Group, type GroupDefaultResponder } from "@/state/store";
import type { MemoryRecord } from "../../shared/memory";
import { BotAvatar } from "./Avatar";
import { BotPickerList } from "./BotPickerList";
import { nextMemberIds } from "@/lib/room-members";
import { effectiveDefaultResponder } from "@/lib/group-routing";
import { shortPath } from "@/lib/short-path";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { cn } from "@/lib/cn";
import {
  CHANNEL_DETAILS_SECTIONS,
  CHANNEL_DETAILS_SECTION_LABELS,
  channelNoun,
  roomMemorySentence,
  type ChannelDetailsSection,
} from "@/lib/channel-surface";

// Re-exported so a caller that already has this panel does not need to know
// the words live in a lib module of their own.
export {
  CHANNEL_DETAILS_SECTIONS,
  CHANNEL_DETAILS_SECTION_LABELS,
  channelNoun,
  roomMemorySentence,
  type ChannelDetailsSection,
};

type MemoryAudience = { id: string; kind: string; ownerKey: string; label: string };

const FIELD_LABEL = "text-[13px] font-semibold text-ink";
const FIELD_NOTE = "mt-0.5 text-[12.5px] text-ink-secondary";
const CARD = "rounded-xl border border-hairline/40 bg-panel/60 p-3.5";
const BUTTON =
  "rounded-lg bg-raised px-3 py-2 text-[13px] text-ink hover:brightness-110 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";
const PRIMARY =
  "rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

export function ChannelDetailsPanel({
  group,
  onClose,
  triggerRef,
  initialSection = "about",
}: {
  group: Group;
  onClose: () => void;
  triggerRef: RefObject<HTMLElement | null>;
  initialSection?: ChannelDetailsSection;
}) {
  const { state } = useStore();
  const [section, setSection] = useState<ChannelDetailsSection>(initialSection);
  const dialogRef = useRef<HTMLDivElement>(null);

  const members = useMemo(
    () => group.memberIds.map((id) => state.bots.find((b) => b.id === id)).filter((b): b is Bot => Boolean(b)),
    [group.memberIds, state.bots],
  );

  // Same focus contract as ManageMembersPanel: first control focused, Escape
  // closes, Tab cycles inside, and the opener gets focus back on the way out.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = () =>
      [
        ...dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((element) => !element.hasAttribute("hidden"));
    focusable()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = focusable();
      if (!controls.length) return event.preventDefault();
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener("keydown", onKey);
    return () => {
      dialog.removeEventListener("keydown", onKey);
      triggerRef.current?.focus();
    };
  }, [onClose, triggerRef]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-3"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${group.name} details`}
        className="flex max-h-[min(760px,calc(100dvh-1.5rem))] w-[min(620px,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-2xl border border-hairline/50 bg-card shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-hairline/40 px-4 py-3.5">
          <div className="min-w-0">
            <div className="truncate text-[15px] font-semibold text-ink">{group.name}</div>
            <div className="truncate text-[12.5px] text-ink-secondary">
              {members.length} {members.length === 1 ? "bot" : "bots"} in this {channelNoun(group)}
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close details" title="Close" className={BUTTON}>
            <X size={15} />
          </button>
        </div>

        <div role="tablist" aria-label="Channel details sections" className="flex gap-1 border-b border-hairline/40 px-3 py-2">
          {CHANNEL_DETAILS_SECTIONS.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={section === id}
              onClick={() => setSection(id)}
              className={cn(
                "rounded-lg px-3 py-1.5 text-[13px]",
                section === id ? "bg-accent/15 font-medium text-accent" : "text-ink-secondary hover:bg-raised hover:text-ink",
              )}
            >
              {CHANNEL_DETAILS_SECTION_LABELS[id]}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {section === "about" && <AboutSection group={group} members={members} />}
          {section === "members" && <MembersSection group={group} onSaved={onClose} />}
          {section === "files" && <FilesSection group={group} members={members} />}
          {section === "memory" && <MemorySection group={group} />}
        </div>
      </div>
    </div>
  );
}

/** Instructions, the lead responder and the folder. The three things that
 * decide how this channel behaves, in the order a person asks about them. */
function AboutSection({ group, members }: { group: Group; members: Bot[] }) {
  const { dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const [instructions, setInstructions] = useState(group.bulletin);
  const [saved, setSaved] = useState(false);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [folderSaving, setFolderSaving] = useState(false);
  useEffect(() => setInstructions(group.bulletin), [group.id, group.bulletin]);

  const responder = effectiveDefaultResponder(group, members);
  const responderValue = responder.kind === "member" ? `member:${responder.botId}` : responder.kind;
  const pinned = group.pinnedCwd;
  const locked = pinned !== undefined;
  const folder = locked ? pinned ?? undefined : group.cwd;

  const saveInstructions = () => {
    if (instructions !== group.bulletin) {
      dispatch({ type: "patchGroup", groupId: group.id, patch: { bulletin: instructions } });
    }
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2_000);
  };

  const changeResponder = (value: string) => {
    let next: GroupDefaultResponder;
    if (value === "everyone") next = { kind: "everyone" };
    else if (value === "mentions") next = { kind: "mentions" };
    else next = { kind: "member", botId: value.slice("member:".length) };
    dispatch({ type: "patchGroup", groupId: group.id, patch: { defaultResponder: next } });
  };

  // The folder PATCH is made directly rather than through patchGroup: the
  // server validates the path, and a folder it rejects must not stick.
  const saveFolder = async (cwd: string | null) => {
    setFolderSaving(true);
    setFolderError(null);
    try {
      await api(`/api/groups/${group.id}`, { method: "PATCH", body: JSON.stringify({ cwd }) });
    } catch (cause) {
      setFolderError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setFolderSaving(false);
    }
  };

  return (
    <>
      <div className={CARD}>
        <label htmlFor="channel-details-instructions" className={FIELD_LABEL}>
          Instructions
        </label>
        <p className={FIELD_NOTE}>Every bot in here follows these. Who does what, the tone, what good looks like.</p>
        <textarea
          id="channel-details-instructions"
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          onBlur={saveInstructions}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) saveInstructions();
          }}
          rows={7}
          placeholder="For example: Keep the tone warm and plain. Check with me before anything goes out."
          className="mt-2 w-full resize-y rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] leading-relaxed text-ink placeholder:text-ink-secondary focus:border-accent focus:outline-none"
        />
        <div className="mt-2 flex items-center gap-2">
          <button type="button" onClick={saveInstructions} className={PRIMARY}>
            Save instructions
          </button>
          <span aria-live="polite" className="text-[12.5px] text-ink-secondary">
            {saved ? "Saved." : ""}
          </span>
        </div>
      </div>

      <div className={CARD}>
        <label htmlFor="channel-details-lead" className={FIELD_LABEL}>
          Who answers
        </label>
        <p className={FIELD_NOTE}>A plain message goes here. Naming a bot with @ always beats this.</p>
        <select
          id="channel-details-lead"
          value={responderValue}
          onChange={(event) => changeResponder(event.target.value)}
          className="mt-2 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink focus:border-accent focus:outline-none"
        >
          <optgroup label="One bot leads">
            {members.map((member) => (
              <option key={member.id} value={`member:${member.id}`}>
                Lead: {member.name}
              </option>
            ))}
          </optgroup>
          <optgroup label="Or">
            <option value="everyone">Everyone responds</option>
            <option value="mentions">Only when mentioned</option>
          </optgroup>
        </select>
      </div>

      <div className={CARD}>
        <span className={FIELD_LABEL}>Folder</span>
        <p className={FIELD_NOTE}>Where every bot in here runs its file and shell tools.</p>
        <div
          className="mt-2 truncate rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[12.5px] text-ink"
          title={folder}
        >
          {folder ? shortPath(folder, capabilities.host.homeDir) : <span className="text-ink-secondary">Each bot&apos;s own folder</span>}
        </div>
        {locked ? (
          <p className={FIELD_NOTE}>Fixed for this task after its first turn. Start a new task to work somewhere else.</p>
        ) : (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {window.muragebox?.pickFolder && (
              <button
                type="button"
                disabled={folderSaving}
                onClick={async () => {
                  const chosen = await window.muragebox?.pickFolder?.(group.cwd);
                  if (chosen) await saveFolder(chosen);
                }}
                className={cn(BUTTON, "flex items-center gap-1.5")}
              >
                <FolderOpen size={14} /> Choose a folder
              </button>
            )}
            {group.cwd && (
              <button type="button" disabled={folderSaving} onClick={() => void saveFolder(null)} className={BUTTON}>
                Clear
              </button>
            )}
          </div>
        )}
        {folderError && (
          <p role="alert" className="mt-2 text-[12.5px] text-danger">
            {folderError}
          </p>
        )}
      </div>
    </>
  );
}

/** The same roster picker the header's faces open, inside the panel, so a
 * person looking at a channel's details never has to go back out to change
 * who is in it. */
function MembersSection({ group, onSaved }: { group: Group; onSaved: () => void }) {
  const { state, dispatch } = useStore();
  const [picked, setPicked] = useState<Set<string>>(() => new Set(group.memberIds));

  // An archived bot stays listed while it is still a member, or a channel
  // could keep a member with no way to remove it.
  const bots = useMemo(
    () => state.bots.filter((bot) => !bot.hidden || group.memberIds.includes(bot.id)),
    [state.bots, group.memberIds],
  );

  const toggle = (id: string) =>
    setPicked((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const memberIds = nextMemberIds(
    group.memberIds,
    picked,
    bots.map((bot) => bot.id),
  );
  const changed = memberIds.length !== group.memberIds.length || memberIds.some((id, index) => id !== group.memberIds[index]);

  return (
    <div className={CARD}>
      <span className={FIELD_LABEL}>Members</span>
      <p className={FIELD_NOTE}>Tick a bot to add it, untick to take it out. What it already said stays in the chat.</p>
      <div className="mt-2">
        <BotPickerList bots={bots} picked={picked} onToggle={toggle} emptyHint="Create a bot first. Channels are made of bots." />
      </div>
      {!memberIds.length && <p className="mt-2 text-[12.5px] text-ink-secondary">A channel needs at least one bot.</p>}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={!memberIds.length || !changed}
          onClick={() => {
            dispatch({ type: "patchGroup", groupId: group.id, patch: { memberIds } });
            onSaved();
          }}
          className={PRIMARY}
        >
          Save members
        </button>
      </div>
    </div>
  );
}

/** Two kinds of files belong to a channel: the one folder its own turns run
 * in, and the workspace each member keeps for the task it is on. Both are
 * listed here rather than only the first, because "where did that file go"
 * has both answers. */
function FilesSection({ group, members }: { group: Group; members: Bot[] }) {
  const { capabilities } = useDesktopCapabilities();
  const [error, setError] = useState<string | null>(null);
  const folder = group.pinnedCwd === undefined ? group.cwd : group.pinnedCwd ?? undefined;
  const reveal = window.muragebox?.revealWorkspace;

  const openWorkspace = (bot: Bot) => {
    window.dispatchEvent(new CustomEvent("murage:open-files", { detail: { botId: bot.id, threadId: bot.threadId } }));
  };

  return (
    <>
      <div className={CARD}>
        <span className={FIELD_LABEL}>This {channelNoun(group)}&apos;s folder</span>
        <p className={FIELD_NOTE}>Work the bots do together lands here.</p>
        <div
          className="mt-2 truncate rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[12.5px] text-ink"
          title={folder}
        >
          {folder ? shortPath(folder, capabilities.host.homeDir) : <span className="text-ink-secondary">No shared folder. Each bot uses its own.</span>}
        </div>
      </div>

      <div className={CARD}>
        <span className={FIELD_LABEL}>Each bot&apos;s own files</span>
        <p className={FIELD_NOTE}>What a member made while working on its current task.</p>
        <div className="mt-2 flex flex-col gap-1">
          {members.map((bot) => (
            <div key={bot.id} className="flex items-center gap-2.5 rounded-lg px-1.5 py-1">
              <BotAvatar bot={bot} state="happy" size={26} animated={false} />
              <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">{bot.name}</span>
              <button type="button" onClick={() => openWorkspace(bot)} className={BUTTON}>
                Open files
              </button>
              {reveal && (
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    void reveal(bot.id, bot.threadId).catch(() =>
                      setError(`${bot.name}'s folder could not be opened. It may not exist yet.`),
                    );
                  }}
                  className={BUTTON}
                >
                  Show folder
                </button>
              )}
            </div>
          ))}
        </div>
        {error && (
          <p role="alert" className="mt-2 text-[12.5px] text-danger">
            {error}
          </p>
        )}
      </div>
    </>
  );
}

/** What this channel remembers, in sentences, with the only two answers a
 * person ever wants: change it, or make it stop. */
function MemorySection({ group }: { group: Group }) {
  const [records, setRecords] = useState<MemoryRecord[] | null>(null);
  const [scopeId, setScopeId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => {
    alive.current = false;
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const status = (await api("/api/memory/status")) as { scopes?: MemoryAudience[] };
      const scope = (status.scopes ?? []).find((item) => item.kind === "room" && item.ownerKey === group.id);
      if (!alive.current) return;
      if (!scope) {
        setScopeId(null);
        setRecords([]);
        return;
      }
      setScopeId(scope.id);
      const listed = (await api("/api/memory/action", {
        method: "POST",
        body: JSON.stringify({ action: "list", scopeId: scope.id, state: "active" }),
      })) as { records?: MemoryRecord[] };
      if (!alive.current) return;
      setRecords(listed.records ?? []);
    } catch (cause) {
      if (!alive.current) return;
      setRecords([]);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [group.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (body: Record<string, unknown>, success: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api("/api/memory/action", { method: "POST", body: JSON.stringify(body) });
      if (!alive.current) return;
      setNotice(success);
      setEditing(null);
      await load();
    } catch (cause) {
      if (!alive.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return (
    <div className={CARD}>
      <span className={FIELD_LABEL}>What this {channelNoun(group)} remembers</span>
      <p className={FIELD_NOTE}>
        {records === null ? "Reading…" : roomMemorySentence(group.name, records.length)} Only the bots in here can see it.
      </p>
      {records !== null && records.length === 0 && !scopeId && (
        <p className={FIELD_NOTE}>Nothing has been kept from this chat yet. Anything worth keeping will show up here.</p>
      )}
      <div className="mt-2 flex flex-col gap-2">
        {(records ?? []).map((record) => (
          <div key={`${record.id}:${record.version}`} className="rounded-lg border border-hairline/40 bg-inset p-3">
            {editing === record.id ? (
              <>
                <label className="sr-only" htmlFor={`memory-edit-${record.id}`}>
                  Edit what is remembered
                </label>
                <textarea
                  id={`memory-edit-${record.id}`}
                  autoFocus
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  rows={3}
                  className="w-full resize-y rounded-lg border border-hairline/40 bg-card px-3 py-2 text-[13px] text-ink focus:border-accent focus:outline-none"
                />
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    disabled={busy || !draft.trim() || draft === record.text}
                    onClick={() =>
                      void act(
                        { action: "correct", id: record.id, version: record.version, text: draft.trim() },
                        "Changed. That is what it remembers now.",
                      )
                    }
                    className={PRIMARY}
                  >
                    Save
                  </button>
                  <button type="button" disabled={busy} onClick={() => setEditing(null)} className={BUTTON}>
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="whitespace-pre-wrap break-words text-[13px] text-ink">{record.text}</p>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setDraft(record.text);
                      setEditing(record.id);
                    }}
                    className={BUTTON}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void act(
                        { action: "forget", kind: "record", id: record.id, revision: record.version },
                        "Forgotten. It is gone from here.",
                      )
                    }
                    className={BUTTON}
                  >
                    Forget
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>
      {notice && (
        <p aria-live="polite" className="mt-2 text-[12.5px] text-ink-secondary">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-[12.5px] text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
