import { BookOpen, ChevronLeft, Plus, RotateCw, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api, useStore, type Bot } from "@/state/store";
import { skillRecorderEnabled } from "@/lib/feature-flags";
import { cn } from "@/lib/cn";
import { ChatMarkdown } from "./ChatMarkdown";
import { Switch } from "./SettingsPrimitives";

/** Mirrors SkillListing in server/skills.ts — the exact shape
 * GET /api/bots/:id/skills returns. Field names are not guesses. */
export interface BotSkill {
  name: string;
  description: string;
  enabled: boolean;
  editable: boolean;
  source: string;
  sha256: string;
  importedAt: string;
  license?: string;
  compatibility?: string;
  warnings: string[];
  skippedFiles: string[];
}

/** stagedSkillListing() in server/index.ts strips files and the base hashes;
 * only the lifecycle fields this notice needs are read here. */
export interface StagedSkillSummary {
  id: string;
  name: string;
  gist: string;
}

/** A bot hired from the library can carry hundreds of skills, so the list
 * pages instead of laying out every row on first paint. */
export const SKILL_PAGE_SIZE = 40;

export function filterSkills(skills: readonly BotSkill[], query: string): BotSkill[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [...skills];
  return skills.filter((skill) => {
    const haystack = `${skill.name} ${skill.description}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

export function applySkillEnabled(skills: readonly BotSkill[], name: string, enabled: boolean): BotSkill[] {
  return skills.map((skill) => (skill.name === name ? { ...skill, enabled } : skill));
}

function mergeSkill(skills: readonly BotSkill[], updated: BotSkill): BotSkill[] {
  return skills.map((skill) => (skill.name === updated.name ? updated : skill));
}

/** Whatever the server said about why it refused, with nothing added. */
export function skillErrorDetail(cause: unknown): string {
  return cause instanceof Error ? cause.message.trim() : String(cause ?? "").trim();
}

/** An error the user cannot act on is noise: always name the operation and
 * keep whatever the server said about why it refused. */
export function skillErrorMessage(cause: unknown, headline: string): string {
  const detail = skillErrorDetail(cause);
  return detail ? `${headline} ${detail}` : headline;
}

export function loadFailureMessage(botName: string, detail: string): string {
  const headline = `Could not load ${botName}'s skills.`;
  return detail ? `${headline} ${detail}` : headline;
}

/** Where a skill came from, in the words a person used to put it there. */
export function skillSourceLabel(source: string): string {
  if (source.startsWith("library:")) return `Library · ${source.slice("library:".length)}`;
  if (source.startsWith("learn:")) return "Learned in chat";
  return source;
}

/** A hand-imported SKILL.md can carry no description at all. A blank second
 * line reads as a rendering bug, so fall back to something true about the
 * skill rather than to whitespace. */
export function skillDescriptionLine(skill: BotSkill): string {
  const described = skill.description?.trim();
  if (described) return described;
  const source = skillSourceLabel(skill.source ?? "").trim();
  return source || "No description";
}

export async function toggleSkillEnabled({
  botId,
  name,
  enabled,
  apply,
  request,
}: {
  botId: string;
  name: string;
  enabled: boolean;
  apply: (update: (current: BotSkill[]) => BotSkill[]) => void;
  request: (path: string, init: RequestInit) => Promise<unknown>;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  // Optimistic, and rolled back by the inverse edit rather than by restoring a
  // captured snapshot — a second toggle on another row must survive this one
  // failing.
  apply((current) => applySkillEnabled(current, name, enabled));
  try {
    const result = (await request(`/api/bots/${botId}/skills/${encodeURIComponent(name)}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
    })) as { skill?: BotSkill };
    // The server answers with the authoritative listing. An enable it declined
    // to honour (stored SKILL.md changed after review) comes back disabled with
    // its warning attached, so the row must follow the answer, not the request.
    if (result?.skill) apply((current) => mergeSkill(current, result.skill!));
    return { ok: true };
  } catch (cause) {
    apply((current) => applySkillEnabled(current, name, !enabled));
    return { ok: false, error: skillErrorMessage(cause, `Could not ${enabled ? "enable" : "disable"} “${name}”.`) };
  }
}

export interface SkillView {
  name: string;
  text: string | null;
  error: string;
}

/** "loading" and "failed" are kept apart from "ready" on purpose: an empty
 * list is a statement about the bot, and only a GET that actually answered
 * is entitled to make it. */
export type SkillsPhase = "loading" | "ready" | "failed";

export interface SkillsSnapshot {
  phase: SkillsPhase;
  skills: BotSkill[];
  staged: StagedSkillSummary[];
  /** Server detail for the failed list load; the sentence is built for display. */
  loadFailure: string;
  /** Every row with a request in flight — one name would let a finishing
   * request re-enable a row whose own request is still running. */
  busy: ReadonlySet<string>;
  /** Keyed by skill name so one row's failure never speaks for another's. */
  rowErrors: ReadonlyMap<string, string>;
  viewing: SkillView | null;
}

export const INITIAL_SKILLS_SNAPSHOT: SkillsSnapshot = {
  phase: "loading",
  skills: [],
  staged: [],
  loadFailure: "",
  busy: new Set<string>(),
  rowErrors: new Map<string, string>(),
  viewing: null,
};

export interface SkillsStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => SkillsSnapshot;
  load: (options?: { silent?: boolean }) => Promise<void>;
  open: (skill: BotSkill) => Promise<void>;
  back: () => void;
  toggle: (skill: BotSkill) => Promise<void>;
  remove: (skill: BotSkill) => Promise<void>;
}

/** Every request this panel makes, and every piece of state they land in,
 * outside React so it can be driven and asserted without a DOM. The component
 * below is a subscriber and nothing else. */
export function createSkillsStore({
  botId,
  request,
}: {
  botId: string;
  request: (path: string, init?: RequestInit) => Promise<unknown>;
}): SkillsStore {
  let snapshot: SkillsSnapshot = INITIAL_SKILLS_SNAPSHOT;
  const listeners = new Set<() => void>();
  // A retry fired while an earlier load is still out must win; the loser's
  // answer is thrown away rather than allowed to overwrite it.
  let loadToken = 0;

  const set = (patch: Partial<SkillsSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };

  const setBusy = (name: string, running: boolean) => {
    const busy = new Set(snapshot.busy);
    if (running) busy.add(name);
    else busy.delete(name);
    set({ busy });
  };

  const setRowError = (name: string, message: string) => {
    const rowErrors = new Map(snapshot.rowErrors);
    if (message) rowErrors.set(name, message);
    else rowErrors.delete(name);
    set({ rowErrors });
  };

  const load = async ({ silent = false }: { silent?: boolean } = {}) => {
    const token = ++loadToken;
    if (!silent) set({ phase: "loading", loadFailure: "" });
    try {
      const result = (await request(`/api/bots/${botId}/skills`)) as {
        skills?: BotSkill[];
        staged?: StagedSkillSummary[];
      };
      if (token !== loadToken) return;
      set({ phase: "ready", skills: result?.skills ?? [], staged: result?.staged ?? [], loadFailure: "" });
    } catch (cause) {
      if (token !== loadToken) return;
      // Deliberately does NOT fall back to an empty list: "<bot> has no skills
      // yet" is a claim about the bot, and a GET that failed knows nothing
      // about the bot. Whatever was already listed stays listed.
      set({ phase: "failed", loadFailure: skillErrorDetail(cause) });
    }
  };

  const open = async (skill: BotSkill) => {
    set({ viewing: { name: skill.name, text: null, error: "" } });
    setRowError(skill.name, "");
    try {
      const result = (await request(`/api/bots/${botId}/skills/${encodeURIComponent(skill.name)}`)) as {
        text?: string;
      };
      // An empty SKILL.md is a readable answer, not a broken one — the route
      // returns 404 when the file is genuinely missing, so only a response
      // with no text field at all means the stored file could not be produced.
      if (result?.text === undefined) {
        throw new Error("The stored SKILL.md is unavailable; remove and import or learn it again.");
      }
      if (snapshot.viewing?.name !== skill.name) return;
      set({ viewing: { name: skill.name, text: result.text, error: "" } });
    } catch (cause) {
      if (snapshot.viewing?.name !== skill.name) return;
      set({
        viewing: {
          name: skill.name,
          text: null,
          error: skillErrorMessage(cause, `Could not read “${skill.name}”.`),
        },
      });
    }
  };

  const back = () => set({ viewing: null });

  const toggle = async (skill: BotSkill) => {
    // Switching a skill ON is the moment its instructions reach the engine, so
    // the SKILL.md is put in front of the person first; the switch in that view
    // does the write. Switching OFF needs no reading.
    if (!skill.enabled && snapshot.viewing?.name !== skill.name) {
      await open(skill);
      return;
    }
    if (snapshot.busy.has(skill.name)) return;
    setBusy(skill.name, true);
    setRowError(skill.name, "");
    const result = await toggleSkillEnabled({
      botId,
      name: skill.name,
      enabled: !skill.enabled,
      apply: (update) => set({ skills: update(snapshot.skills) }),
      request,
    });
    setBusy(skill.name, false);
    setRowError(skill.name, result.ok ? "" : result.error);
  };

  const remove = async (skill: BotSkill) => {
    setBusy(skill.name, true);
    setRowError(skill.name, "");
    try {
      await request(`/api/bots/${botId}/skills/${encodeURIComponent(skill.name)}`, { method: "DELETE" });
      if (snapshot.viewing?.name === skill.name) set({ viewing: null });
      // silent: the list is already on screen, and blanking it to "Loading…"
      // for a refresh the user did not ask for reads as a fault.
      await load({ silent: true });
    } catch (cause) {
      setRowError(skill.name, skillErrorMessage(cause, `Could not remove “${skill.name}”.`));
    } finally {
      setBusy(skill.name, false);
    }
  };

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    load,
    open,
    back,
    toggle,
    remove,
  };
}

export interface SkillsBodyProps {
  botName: string;
  phase: SkillsPhase;
  skills: BotSkill[];
  staged: number;
  loadFailure: string;
  authoringEnabled: boolean;
  query: string;
  onQuery: (value: string) => void;
  visible: number;
  onShowMore: () => void;
  busy: ReadonlySet<string>;
  rowErrors: ReadonlyMap<string, string>;
  viewing: SkillView | null;
  onOpen: (skill: BotSkill) => void;
  onBack: () => void;
  onRetry: () => void;
  onToggle: (skill: BotSkill) => void;
  onRemove: (skill: BotSkill) => void;
  /** SEAM — "Add a skill" opens the library browser with THIS agent already
   *  chosen. Assignment is one action, `assign(skillId, botId)`; this end
   *  pre-fills the agent, the library's own row action pre-fills the skill.
   *  Optional so the body still renders in a suite with no store. */
  onBrowse?: () => void;
}

const ALERT = "mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger";
const RETRY =
  "mt-2 inline-flex items-center gap-1.5 rounded-md bg-control px-2.5 py-1.5 text-[12px] text-ink hover:bg-control/70";

/** The way IN to the library, from the agent's own panel.
 *
 *  A VISIBLE control, on purpose. `Sidebar.tsx` exposed its bot menu solely
 *  through `onContextMenu`, and a touch device fires no `contextmenu` event at
 *  all — that was a live defect, not a hypothesis, and repeating it here would
 *  make assignment unreachable on a phone. */
function AddSkillButton({
  botName,
  onBrowse,
  className,
}: {
  botName: string;
  onBrowse: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onBrowse}
      // The outcome, with the agent named — never the category.
      aria-label={`Add a skill to ${botName}`}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg bg-control px-2.5 py-1.5 text-[12px] text-ink hover:bg-control/70",
        className,
      )}
    >
      <Plus size={13} />
      Add a skill
    </button>
  );
}

/** Split from the container so the list, the empty state, the SKILL.md view
 * and the failure copy are all renderable without a live server. */
export function SkillsBody(props: SkillsBodyProps) {
  const { botName, phase, skills, staged, authoringEnabled, viewing } = props;
  const enabledCount = skills.filter((skill) => skill.enabled).length;
  const detail = useRef<HTMLDivElement | null>(null);
  const openedName = viewing?.name ?? "";

  // A disabled row's control swaps this whole panel for the SKILL.md view. A
  // keyboard or screen-reader user has to land in what replaced the control
  // they just pressed, not be left focused on something that vanished.
  useEffect(() => {
    if (openedName) detail.current?.focus();
  }, [openedName]);

  if (phase === "loading") {
    return <div className="mt-3 text-[12px] text-ink-secondary">Loading {botName}'s skills…</div>;
  }

  if (viewing) {
    const skill = skills.find((entry) => entry.name === viewing.name);
    return (
      <div className="mt-3 focus:outline-none" ref={detail} tabIndex={-1}>
        <button
          type="button"
          onClick={props.onBack}
          className="-ml-1.5 flex items-center gap-1 rounded px-1.5 py-1 text-[12px] text-ink-secondary hover:bg-control hover:text-ink"
        >
          <ChevronLeft size={14} />
          All skills
        </button>
        {skill && (
          <div className="mt-2 flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-[13px] text-ink">{skill.name}</div>
              <div className="mt-0.5 text-[11.5px] text-ink-secondary">{skillDescriptionLine(skill)}</div>
              <div className="mt-1 truncate text-[10.5px] text-ink-secondary" title={skill.source}>
                {skillSourceLabel(skill.source)}
              </div>
            </div>
            <Switch
              checked={skill.enabled}
              aria-label={`${skill.enabled ? "Disable" : "Enable"} ${skill.name}`}
              // Only ENABLING waits on the text: an already-on skill must stay
              // switchable off even when its SKILL.md will not load, or a
              // failed read would strand it on.
              disabled={props.busy.has(skill.name) || (!skill.enabled && viewing.text === null)}
              onClick={() => props.onToggle(skill)}
            />
          </div>
        )}
        {skill && skill.warnings.length > 0 && (
          <div className="mt-2 rounded-lg bg-warning/10 px-3 py-2 text-[11.5px] text-warning">
            {skill.warnings.join(" · ")}
          </div>
        )}
        {viewing.error ? (
          <div role="alert" className={ALERT}>
            {viewing.error}
            {skill && (
              <div>
                {/* without this the read is unrepeatable, and a skill whose
                    GET failed once could never be enabled again */}
                <button type="button" onClick={() => props.onOpen(skill)} className={RETRY}>
                  <RotateCw size={13} />
                  Try again
                </button>
              </div>
            )}
          </div>
        ) : viewing.text === null ? (
          <div className="mt-3 text-[12px] text-ink-secondary">Loading SKILL.md…</div>
        ) : viewing.text.trim() === "" ? (
          <div className="mt-3 rounded-lg bg-inset p-3 text-[12px] leading-relaxed text-ink-secondary">
            This skill's SKILL.md is empty. Switching it on adds nothing to what {botName} knows.
          </div>
        ) : (
          <div className="mt-3 max-h-[420px] overflow-y-auto rounded-lg bg-inset p-3 text-[13px] leading-relaxed text-ink">
            <ChatMarkdown text={viewing.text} />
          </div>
        )}
        {skill && props.rowErrors.get(skill.name) && (
          <div role="alert" className={ALERT}>
            {props.rowErrors.get(skill.name)}
          </div>
        )}
      </div>
    );
  }

  const failure = phase === "failed" && (
    <div role="alert" className={ALERT}>
      {loadFailureMessage(botName, props.loadFailure)}
      <div>
        <button type="button" onClick={props.onRetry} className={RETRY}>
          <RotateCw size={13} />
          Try again
        </button>
      </div>
    </div>
  );

  // A failed load says nothing about what the bot has, so it never gets to
  // render the "no skills yet" copy.
  if (phase === "failed" && skills.length === 0) {
    return <div className="mt-3">{failure}</div>;
  }

  if (skills.length === 0) {
    return (
      <div className="mt-3">
        {/* This box said the opposite until 0.1.44 and nothing caught it. The
            import path installs each of a profile's skills and switches it on
            in the same loop (server/index.ts, installSkillFromLibrary then
            setSkillEnabled(…, true)), and a skill learned in chat is enabled
            the moment its proposal is confirmed (applyStagedSkillWrite). There
            is no add control on this panel, so the route has to be named. */}
        <div className="rounded-lg bg-inset px-3 py-2.5 text-[12px] leading-relaxed text-ink-secondary">
          {botName} has no skills yet. Add one from the library and it arrives switched on.
          {authoringEnabled
            ? " A skill you teach with /learn in chat is switched on once you confirm it."
            : ""}{" "}
          Everything that lands here can be read, switched off, or removed.
        </div>
        {props.onBrowse && <AddSkillButton botName={botName} onBrowse={props.onBrowse} className="mt-2.5" />}
        {staged > 0 && (
          <div className="mt-2 text-[11.5px] text-warning">
            {staged} proposal{staged === 1 ? " is" : "s are"} waiting for a decision in chat.
          </div>
        )}
      </div>
    );
  }

  const matches = filterSkills(skills, props.query);
  const shown = matches.slice(0, props.visible);
  return (
    <div className="mt-3">
      <div className="flex items-center justify-between gap-3 text-[11.5px] text-ink-secondary">
        <span>
          {enabledCount} of {skills.length} on
        </span>
        {staged > 0 && (
          <span className="text-warning">
            {staged} proposal{staged === 1 ? " is" : "s are"} waiting in chat
          </span>
        )}
      </div>
      {props.onBrowse && <AddSkillButton botName={botName} onBrowse={props.onBrowse} className="mt-2" />}
      {skills.length > 8 && (
        <div className="mt-2 flex items-center gap-2 rounded-lg bg-inset px-2.5 py-1.5">
          <Search size={13} className="shrink-0 text-ink-secondary" />
          <input
            value={props.query}
            onChange={(event) => props.onQuery(event.target.value)}
            aria-label={`Search ${botName}'s skills`}
            placeholder="Search skills"
            className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink placeholder:text-ink-secondary focus:outline-none"
          />
        </div>
      )}
      {matches.length === 0 ? (
        <div className="mt-2 rounded-lg bg-inset px-3 py-2 text-[12px] text-ink-secondary">
          No skill matches “{props.query}”.
        </div>
      ) : (
        <div className="mt-2 divide-y divide-hairline/40 overflow-hidden rounded-lg border border-hairline/40">
          {shown.map((skill) => (
            <div key={skill.name} className="px-3 py-2.5">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => props.onOpen(skill)}
                  className="min-w-0 flex-1 text-left"
                  aria-label={`Read ${skill.name}`}
                >
                  <div className="truncate font-mono text-[12.5px] text-ink">{skill.name}</div>
                  <div className="mt-0.5 line-clamp-2 text-[11.5px] text-ink-secondary">
                    {skillDescriptionLine(skill)}
                  </div>
                </button>
                {skill.enabled ? (
                  <Switch
                    checked
                    aria-label={`Disable ${skill.name}`}
                    disabled={props.busy.has(skill.name)}
                    onClick={() => props.onToggle(skill)}
                  />
                ) : (
                  // Not a switch. Enabling requires reading the SKILL.md first,
                  // so this control opens that view and flips nothing — a
                  // role="switch" here would announce a state change that never
                  // happens.
                  <button
                    type="button"
                    aria-label={`Review ${skill.name} to enable it`}
                    disabled={props.busy.has(skill.name)}
                    onClick={() => props.onOpen(skill)}
                    className="shrink-0 rounded-md bg-control px-2.5 py-1.5 text-[11.5px] text-ink hover:bg-control/70 disabled:opacity-40"
                  >
                    Review to enable
                  </button>
                )}
                <button
                  type="button"
                  aria-label={`Remove ${skill.name}`}
                  title="Remove skill"
                  disabled={props.busy.has(skill.name)}
                  onClick={() => props.onRemove(skill)}
                  className="flex size-8 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                >
                  <Trash2 size={15} />
                </button>
              </div>
              {skill.warnings.length > 0 && (
                <div className="mt-1 text-[10.5px] text-warning">{skill.warnings.join(" · ")}</div>
              )}
              {props.rowErrors.get(skill.name) && (
                <div role="alert" className="mt-1 text-[10.5px] text-danger">
                  {props.rowErrors.get(skill.name)}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {matches.length > shown.length && (
        <button
          type="button"
          onClick={props.onShowMore}
          className="mt-2 w-full rounded-lg bg-inset px-3 py-2 text-[12px] text-ink-secondary hover:bg-control hover:text-ink"
        >
          Show {Math.min(SKILL_PAGE_SIZE, matches.length - shown.length)} more · {matches.length - shown.length} left
        </button>
      )}
      {failure}
    </div>
  );
}

/** The skills a bot actually has, on the Agent profile panel next to its
 * name, model and folder — the surface a person lands on when they click a
 * bot and ask what it can do. A disabled skill opens its SKILL.md before it
 * can be switched on: an import lands off precisely so the bytes get read
 * once (see the policy note above the routes in server/index.ts). */
export function BotSkillsPanel({ bot, onBrowse }: { bot: Bot; onBrowse?: () => void }) {
  const { state } = useStore();
  const authoringEnabled = skillRecorderEnabled(state.config);
  const [query, setQuery] = useState("");
  const [visible, setVisible] = useState(SKILL_PAGE_SIZE);

  // One store per bot: switching bots builds a new one, so a slow answer for
  // the bot you left can never land in the panel for the bot you are on.
  const store = useMemo(() => createSkillsStore({ botId: bot.id, request: api }), [bot.id]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  useEffect(() => {
    setQuery("");
    setVisible(SKILL_PAGE_SIZE);
    void store.load();
  }, [store]);

  return (
    <div className="rounded-xl bg-card p-4">
      <div className="flex items-center gap-2">
        <BookOpen size={16} className="text-ink-secondary" />
        <div className="text-[15px] font-medium text-ink">Skills</div>
      </div>
      <div className="mt-1 text-[12px] leading-relaxed text-ink-secondary">
        What {bot.name} knows how to do. Open one to read its instructions before you switch it on.
        {authoringEnabled ? " Use /learn in chat to add another." : ""}
      </div>
      <SkillsBody
        botName={bot.name}
        phase={snapshot.phase}
        skills={snapshot.skills}
        staged={snapshot.staged.length}
        loadFailure={snapshot.loadFailure}
        authoringEnabled={authoringEnabled}
        onBrowse={onBrowse}
        query={query}
        onQuery={(value) => {
          setQuery(value);
          setVisible(SKILL_PAGE_SIZE);
        }}
        visible={visible}
        onShowMore={() => setVisible((current) => current + SKILL_PAGE_SIZE)}
        busy={snapshot.busy}
        rowErrors={snapshot.rowErrors}
        viewing={snapshot.viewing}
        onOpen={(skill) => void store.open(skill)}
        onBack={() => store.back()}
        onRetry={() => void store.load()}
        onToggle={(skill) => void store.toggle(skill)}
        onRemove={(skill) => {
          if (!window.confirm(`Remove the skill “${skill.name}” from ${bot.name}?`)) return;
          void store.remove(skill);
        }}
      />
    </div>
  );
}
