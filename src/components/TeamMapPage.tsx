import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, BookOpen, Loader2, Network, Radio, RefreshCw, Save, X } from "lucide-react";

import { EmberAvatar } from "./Avatar";
import { api, formatTime, useStore, type Bot } from "@/state/store";
import { normalizeState } from "@/lib/mascot";
import {
  EMPTY_TEAM_MAP_SNAPSHOT,
  buildTeamMapEdges,
  buildTeamMapOrg,
  teamMapStatus,
  type TeamMapEdge,
  type TeamMapSection,
  type TeamMapSnapshot,
} from "@/lib/team-map";
import { botRole } from "@/lib/bot-role";
import { RoleIcon } from "./RoleBadge";
import { cn } from "@/lib/cn";
import { MemorySettings } from "./MemorySettings";

const statusTone = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  idle: "bg-ink-secondary/35",
} as const;

function BotNode({ bot, top = false }: { bot: Bot; top?: boolean }) {
  const { dispatch } = useStore();
  const status = teamMapStatus(bot);
  const role = botRole(bot);
  return (
    <button
      onClick={() => dispatch({ type: "select", id: bot.id })}
      className={cn(
        "group relative flex w-full min-w-0 items-center gap-3 rounded-xl border px-3 py-3 text-left shadow-sm transition",
        top
          ? "border-accent/40 bg-accent/10 hover:bg-accent/15"
          : "border-hairline/50 bg-card hover:border-accent/35 hover:bg-raised/50",
      )}
    >
      <EmberAvatar
        color={bot.color}
        state={normalizeState(bot.mascotExpression) ?? "idle"}
        size={34}
        motion="none"
        motionKey={0}
        animated={false}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[13.5px] font-semibold text-ink">{bot.name}</span>
          <RoleIcon bot={bot} size={12} className={role === "chief" ? "text-accent" : "text-ink-secondary"} />
        </span>
        <span className="block truncate text-[11.5px] text-ink-secondary">{bot.title || bot.modelSelection.model}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5 text-[10.5px] text-ink-secondary">
        <span className={cn("size-1.5 rounded-full", statusTone[status.tone], status.label === "Working" && "animate-pulse")} />
        {status.label}
      </span>
    </button>
  );
}

const RAIL_HEADING = "text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-secondary";

function EdgeRow({ edge, bots }: { edge: TeamMapEdge; bots: Bot[] }) {
  const { dispatch } = useStore();
  const source = bots.find((bot) => bot.id === edge.sourceBotId);
  const target = bots.find((bot) => bot.id === edge.targetBotId);
  if (!source || !target) return null;
  const live = edge.state !== "connected";
  return (
    <button
      onClick={() => dispatch({ type: "select", id: edge.groupId ?? target.id })}
      className="flex w-full items-center gap-3 rounded-xl border border-hairline/40 bg-card px-3 py-2.5 text-left transition hover:bg-raised/50"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate text-[13px] font-medium text-ink">{source.name}</span>
        <ArrowRight size={13} className={cn("shrink-0", live ? "text-accent" : "text-ink-secondary")} />
        <span className="truncate text-[13px] font-medium text-ink">{target.name}</span>
      </div>
      {edge.reason && <span className="max-w-[220px] truncate text-[11.5px] text-ink-secondary">{edge.reason}</span>}
      <span
        className={cn(
          "rounded-full px-2 py-0.5 text-[10.5px] font-medium",
          edge.state === "running"
            ? "bg-success/15 text-success"
            : edge.state === "queued"
              ? "bg-warning/15 text-warning"
              : "bg-control text-ink-secondary",
        )}
      >
        {edge.state === "running" ? "Running" : edge.state === "queued" ? "Queued" : edge.lastAt ? formatTime(edge.lastAt) : "Connected"}
      </span>
    </button>
  );
}

/** One team: its leader on top, its members on the rail beneath. A team with
 * no leader says so — the Chief's prompt says the same sentence, and the two
 * must not disagree. */
function TeamCard({
  section,
  onEditContext,
}: {
  section: TeamMapSection<Bot>;
  onEditContext: () => void;
}) {
  const size = section.chiefs.length + section.members.length;
  return (
    <section className="rounded-2xl border border-hairline/50 bg-panel p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className={cn(RAIL_HEADING, "min-w-0 truncate")}>{section.name}</h3>
        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={onEditContext}
            className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[10.5px] font-medium text-ink-secondary hover:bg-raised hover:text-ink"
            aria-label={`Edit ${section.name} shared context`}
            title="Shared context"
          >
            <BookOpen size={11} /> Context
          </button>
          <span className="text-[11px] tabular-nums text-ink-secondary">{size}</span>
        </div>
      </div>
      <div className="space-y-2">
        {section.chiefs.map((bot) => (
          <BotNode key={bot.id} bot={bot} />
        ))}
        {section.chiefs.length === 0 && section.members.length > 0 && (
          <p className="pb-1 text-[11.5px] text-ink-secondary">No team leader yet.</p>
        )}
        {section.chiefs.length > 0 && section.members.length > 0 && (
          <div className="ml-5 h-3 w-px bg-hairline" aria-hidden />
        )}
        {section.members.length > 0 && (
          <div className={cn("space-y-2", section.chiefs.length > 0 && "border-l border-hairline/60 pl-3")}>
            {section.members.map((bot) => (
              <BotNode key={bot.id} bot={bot} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

interface SectionContextResponse {
  section: string;
  label: string;
  text: string;
  updatedAt: number | null;
  maxBytes: number;
}

function SectionContextDialog({ section, label, onClose }: { section: string; label: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const onCloseRef = useRef(onClose);
  const savingRef = useRef(false);
  const dirtyRef = useRef(false);
  const [text, setText] = useState("");
  const [savedText, setSavedText] = useState("");
  const [maxBytes, setMaxBytes] = useState(24_000);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = text !== savedText;
  const bytes = useMemo(() => new TextEncoder().encode(text).byteLength, [text]);
  onCloseRef.current = onClose;
  savingRef.current = saving;
  dirtyRef.current = dirty;

  const requestClose = useCallback(() => {
    if (savingRef.current) return;
    if (dirtyRef.current && !window.confirm("Discard unsaved changes to this shared context?")) return;
    onCloseRef.current();
  }, []);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !savingRef.current) {
        event.preventDefault();
        requestClose();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      )];
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousFocus?.focus();
    };
  }, [requestClose]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void api(`/api/section-context?section=${encodeURIComponent(section)}`)
      .then((result: SectionContextResponse) => {
        if (cancelled) return;
        setText(result.text);
        setSavedText(result.text);
        setUpdatedAt(result.updatedAt);
        setMaxBytes(result.maxBytes);
        window.setTimeout(() => textareaRef.current?.focus(), 0);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [section]);

  const save = async () => {
    if (bytes > maxBytes) return;
    setSaving(true);
    setError(null);
    try {
      const result: SectionContextResponse = await api(
        `/api/section-context?section=${encodeURIComponent(section)}`,
        { method: "PUT", body: JSON.stringify({ text }) },
      );
      setSavedText(result.text);
      setText(result.text);
      setUpdatedAt(result.updatedAt);
      setMaxBytes(result.maxBytes);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-x-0 top-0 z-50 flex h-[var(--vvh,100dvh)] items-center justify-center bg-black/55 p-4 backdrop-blur-[2px] sm:p-6"
      onMouseDown={(event) => event.target === event.currentTarget && requestClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="section-context-title"
        tabIndex={-1}
        className="animate-pop-in flex max-h-[min(680px,calc(var(--vvh,100dvh)-2rem))] w-full max-w-[680px] flex-col overflow-hidden rounded-[24px] border border-hairline/50 bg-panel shadow-2xl shadow-black/50 outline-none"
      >
        <header className="flex items-start justify-between gap-4 border-b border-hairline/40 px-6 pb-4 pt-6 sm:px-8 sm:pt-7">
          <div>
            <div className="flex items-center gap-2">
              <BookOpen size={19} className="text-accent" />
              <h2 id="section-context-title" className="text-[20px] font-semibold tracking-[-0.01em] text-ink">
                {label} shared context
              </h2>
            </div>
            <p className="mt-1.5 max-w-[520px] text-[12.5px] leading-relaxed text-ink-secondary">
              A team brief shown to every bot in this section at the start of each turn. Only you can edit it.
            </p>
          </div>
          <button
            onClick={requestClose}
            disabled={saving}
            aria-label="Close shared context"
            className="flex size-9 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40"
          >
            <X size={19} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 sm:px-8">
          {loading ? (
            <div className="flex min-h-[260px] items-center justify-center text-ink-secondary">
              <Loader2 size={20} className="animate-spin" aria-label="Loading shared context" />
            </div>
          ) : (
            <>
              <textarea
                ref={textareaRef}
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={"Goals\n- Ship the Windows onboarding refresh\n\nDecisions\n- Keep customer data local\n\nPreferences\n- Use concise weekly updates"}
                aria-label={`${label} shared context`}
                className="min-h-[280px] w-full resize-y rounded-xl border border-hairline/60 bg-inset px-4 py-3 font-mono text-[12.5px] leading-relaxed text-ink outline-none placeholder:text-ink-secondary/55 focus:border-accent/50"
              />
              <div className="mt-2 flex items-start justify-between gap-4 text-[11.5px] text-ink-secondary">
                <span>
                  Keep durable team facts here. Private notes stay in each bot's own Memory.
                  {updatedAt ? ` Last saved ${new Date(updatedAt).toLocaleString()}.` : ""}
                </span>
                <span className={cn("shrink-0 tabular-nums", bytes > maxBytes && "text-danger")}>
                  {bytes.toLocaleString()} / {maxBytes.toLocaleString()} bytes
                </span>
              </div>
            </>
          )}
          {error && <div className="mt-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-hairline/40 px-6 py-4 sm:px-8">
          <button onClick={requestClose} disabled={saving} className="rounded-lg px-3.5 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40">
            Cancel
          </button>
          <button
            onClick={() => void save()}
            disabled={loading || saving || !dirty || bytes > maxBytes}
            className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-40"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Save context
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

export function TeamMapPage() {
  const { state } = useStore();
  const [snapshot, setSnapshot] = useState<TeamMapSnapshot>(EMPTY_TEAM_MAP_SNAPSHOT);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contextEditor, setContextEditor] = useState<{ section: string; label: string } | null>(null);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const bots = useMemo(() => state.bots.filter((bot) => !bot.hidden), [state.bots]);
  const org = useMemo(() => buildTeamMapOrg(bots), [bots]);
  const edges = useMemo(() => buildTeamMapEdges(bots, snapshot), [bots, snapshot]);

  const refresh = useCallback(async (showSpinner = false) => {
    if (showSpinner) setRefreshing(true);
    try {
      setSnapshot(await api("/api/team-map"));
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      if (showSpinner) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const working = bots.filter((bot) => bot.busy || bot.activity === "working").length;
  const waiting = bots.filter((bot) => bot.activity === "waiting-on-you").length;

  const branches = [
    ...org.teams.map((section) => (
      <TeamCard
        key={section.key || "__general__"}
        section={section}
        onEditContext={() => setContextEditor({ section: section.key, label: section.name })}
      />
    )),
    ...(org.individuals.length
      ? [
          <section key="__individuals__" className="rounded-2xl border border-hairline/50 bg-panel p-4">
            <div className="mb-1 flex items-center justify-between gap-2">
              <h3 className={RAIL_HEADING}>Individual assistants</h3>
              <span className="text-[11px] tabular-nums text-ink-secondary">{org.individuals.length}</span>
            </div>
            <p className="mb-3 text-[11.5px] leading-relaxed text-ink-secondary">
              No team leader; each one reports to the Chief of Staff directly.
            </p>
            <div className="space-y-2">
              {org.individuals.map((bot) => (
                <BotNode key={bot.id} bot={bot} />
              ))}
            </div>
          </section>,
        ]
      : []),
  ];

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-app text-ink">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-hairline/40 px-4 py-5 sm:px-7 max-md:pl-12">
        <div>
          <div className="flex items-center gap-2.5">
            <Network size={20} className="text-accent" />
            <h1 className="text-[18px] font-semibold">Team map</h1>
            <span className="flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[10.5px] font-medium text-success">
              <Radio size={10} /> Live
            </span>
          </div>
          <p className="mt-1 text-[12.5px] text-ink-secondary">
            The whole org chart: who leads what, who is working, and where tasks are moving.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2"><button type="button" aria-expanded={memoryOpen} onClick={() => setMemoryOpen(open => !open)} className="min-h-10 rounded-lg border border-hairline/50 bg-card px-3 py-2 text-[12px] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">{memoryOpen ? "Close memory" : "Manage memory"}</button><button
          onClick={() => void refresh(true)}
          disabled={refreshing}
          className="rounded-lg border border-hairline/50 bg-card p-2 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
          aria-label="Refresh team map"
          title="Refresh"
        >
          <RefreshCw size={15} className={refreshing ? "animate-spin" : ""} />
        </button></div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-7 sm:py-6">
        {memoryOpen && <div className="mb-5 max-w-3xl"><MemorySettings /></div>}
        <div className="mb-5 grid max-w-[620px] grid-cols-3 gap-2">
          {[
            [bots.length, "Bots"],
            [working, "Working"],
            [waiting, "Waiting on you"],
          ].map(([value, label]) => (
            <div key={label} className="rounded-xl border border-hairline/40 bg-panel px-3.5 py-3">
              <div className="text-[18px] font-semibold tabular-nums text-ink">{value}</div>
              <div className="text-[11.5px] text-ink-secondary">{label}</div>
            </div>
          ))}
        </div>

        {error && <div className="mb-4 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}

        {/* The chart, drawn as one. The Chief sits above everything, and the
            two branches under it — teams with their leaders, and the
            individual assistants who have no leader at all — share one grid
            off one rail, so "reports to the Chief" is a thing you see rather
            than a thing you work out. */}
        <section aria-label="Org chart">
          <h2 className={RAIL_HEADING}>Org chart</h2>
          {org.chief ? (
            <div className="mt-2.5">
              <div className="max-w-[440px]">
                <BotNode bot={org.chief} top />
              </div>
              <div className="ml-5 mt-3 border-l border-hairline/70 pl-5">
                <div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] items-start gap-4">
                  {branches}
                </div>
              </div>
            </div>
          ) : (
            <div className="mt-2.5 space-y-3">
              <div className="rounded-xl border border-dashed border-hairline bg-panel px-4 py-3 text-[12.5px] leading-relaxed text-ink-secondary">
                No Chief of Staff yet. Open an agent's profile, set its Role to Chief of Staff, and it takes the
                top of this chart; team leaders and individual assistants report to it.
              </div>
              <div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] items-start gap-4">{branches}</div>
            </div>
          )}
        </section>

        <section className="mt-7 max-w-[900px]">
          <div className="mb-2.5 flex items-center justify-between">
            <h2 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-secondary">Agent handoffs</h2>
            <span className="text-[11px] text-ink-secondary">Running and queued first</span>
          </div>
          <div className="space-y-2">
            {edges.slice(0, 12).map((edge) => (
              <EdgeRow key={`${edge.sourceBotId}:${edge.targetBotId}`} edge={edge} bots={bots} />
            ))}
            {edges.length === 0 && (
              <div className="rounded-xl border border-dashed border-hairline bg-panel px-4 py-6 text-center text-[12.5px] text-ink-secondary">
                No bot-to-bot handoffs yet. Ask a Chief of Staff to delegate a task and it will appear here live.
              </div>
            )}
          </div>
        </section>
      </div>
      {contextEditor && (
        <SectionContextDialog
          section={contextEditor.section}
          label={contextEditor.label}
          onClose={() => setContextEditor(null)}
        />
      )}
    </main>
  );
}
