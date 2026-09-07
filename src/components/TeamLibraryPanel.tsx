import { track } from "@/lib/analytics";
import { cn } from "@/lib/cn";
import { plainText } from "@/lib/plain-text";
import { teamImportPreview, type PendingTeamImport } from "@/lib/team-import";
import { assignSkillsToBot } from "@/lib/onboarding-intake";
import { invalidateSkillCount } from "@/lib/bot-skill-count";
import type { Routine } from "@/lib/routines";
import { api, useStore, type Bot, type Group, type TeamLibraryView } from "@/state/store";
import {
  ArrowLeft,
  BookOpen,
  CalendarClock,
  Check,
  Compass,
  Crown,
  ExternalLink,
  FolderOpen,
  Github,
  Loader2,
  MessageSquare,
  Plug,
  Plus,
  Search,
  UploadCloud,
  Users,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BundleImportDialog, type BundleImportResult } from "./BundleImportDialog";

const MAX_TEAM_FILE_BYTES = 1_000_000;

export function matchesLibraryView(members: number, view: TeamLibraryView): boolean {
  return view === "bots" ? members === 1 : view === "teams" && members > 1;
}

interface TeamCatalogEntry {
  slug: string;
  name: string;
  summary: string;
  category: string;
  outcome?: string;
  setupMinutes?: number;
  featured?: boolean;
  package?: string;
  manifest: string;
  readme: string;
  members: number;
  skills: string[];
  requires: { apps: string[] };
}

interface TeamCatalog {
  repositoryUrl: string;
  teams: TeamCatalogEntry[];
}

/** A skill from the shipped library. 2,010 of the 2,237 that ship are named by
 *  no catalog entry, so before this panel could search and browse them they
 *  were reachable from nowhere in the product. */
interface SkillHit {
  id: string;
  name: string;
  description: string;
  terms: string[];
}

/** Topics shown before the list is expanded. 146 facets is a wall on a phone;
 *  18 fills roughly three rows and still shows the shape of the library. */
const FACETS_COLLAPSED = 18;

/** A browse entry point, counted from the skills' own manifests. */
interface Facet {
  term: string;
  count: number;
}

interface LibrarySearchResponse {
  teams: Array<{ slug: string }>;
  skills: SkillHit[];
}

/** Facet terms are lowercase slugs in the data (`software-engineering`).
 *  Nobody wants to read that on a button. */
function facetLabel(term: string): string {
  return term.replace(/-/g, " ").replace(/(^|\s)\p{Ll}/gu, (match) => match.toUpperCase());
}

/** One sentence is enough to decide; the rest is qualifiers. Descriptions
 *  average ~499 characters and are written lead-first.
 *
 *  Flattened first: skill manifests are written by many hands and some open
 *  with Markdown ("**When to use.** …"), which renders as literal asterisks in
 *  a plain one-line blurb. */
function firstSentence(raw: string, max = 150): string {
  const text = plainText(raw);
  const trimmed = text.trim();
  const stop = trimmed.search(/\.\s/);
  const candidate = stop > 40 ? trimmed.slice(0, stop + 1) : trimmed;
  return candidate.length > max ? `${candidate.slice(0, max - 1).trimEnd()}…` : candidate;
}

/** One bot a replace-import put away, and everything the undo needs to put
 *  it back exactly as it was.
 *
 *  `chiefOfStaff` alone was not enough. The org chart is three fields read
 *  together (src/lib/bot-role.ts) — leading something, leading the WHOLE
 *  workspace, leading nothing — so a record that remembers only the first
 *  can only ever restore the first: the workspace Chief of Staff was
 *  archived and came back a section lead, demoted by an Undo button with
 *  nothing said. The harness now sends the tier alongside the role. */
export interface ArchivedTeamBot {
  id: string;
  chiefOfStaff: boolean;
  /** Which chair this bot held. `null` = led nothing. Absent only in a
   *  payload from a harness older than this field. */
  chiefTier?: "workspace" | "section" | null;
}

/** The PATCH body that puts one archived bot back.
 *
 *  `chiefTier` reaches the wire as `chiefScope`, the same rename
 *  `botRolePatch` makes — and the tier is stated explicitly rather than
 *  left out, because an omitted scope means "leave the tier as it is", and
 *  "as it is" is exactly the thing an archive is not trusted to remember.
 *
 *  Restoring a Chief while a DIFFERENT bot now holds the workspace chair is
 *  refused by the harness with 409 and a sentence naming the incumbent.
 *  That refusal is the point: seating two would break the one invariant the
 *  chart has, and silently restoring her as a section lead would repeat the
 *  demotion this type exists to stop. */
export function archivedRestorePatch(bot: ArchivedTeamBot): {
  hidden: false;
  chiefOfStaff?: true;
  chiefScope?: "workspace" | "section";
} {
  if (!bot.chiefOfStaff) return { hidden: false };
  return {
    hidden: false,
    chiefOfStaff: true,
    // A payload with no tier (older harness) keeps the old meaning: a bare
    // election, which the harness reads as a section lead.
    ...(bot.chiefTier ? { chiefScope: bot.chiefTier } : {}),
  };
}

/** One skill the imported profile declared and the import could not
 *  deliver. `install` means the bot never got it; `enable` means it landed
 *  but is switched off — a smaller failure, and worth telling apart. */
export interface TeamImportSkillError {
  botId: string;
  botName: string;
  skillId: string;
  stage: "install" | "enable";
  error: string;
}

export interface TeamImportResult {
  name: string;
  members: number;
  importedBotIds: string[];
  importedGroupIds: string[];
  importedRoutineIds: string[];
  archived: ArchivedTeamBot[];
  /** Empty when everything the profile declared arrived. A short import is
   *  reported rather than logged: the harness used to answer 201 and print
   *  the failure to its own stderr, so a team quietly landed with fewer
   *  skills than it advertised. */
  skillErrors: TeamImportSkillError[];
}

/** The shape of a short import, for a caller that has a sentence to write.
 *  `unavailable` never arrived at all; `disabled` arrived but would not
 *  switch on. Both are unusable, and they are counted apart because they
 *  are not the same thing to say to somebody. */
export function teamImportSkillSummary(result: {
  skillErrors: TeamImportSkillError[];
}): { failed: number; unavailable: number; disabled: number } {
  const unavailable = result.skillErrors.filter((entry) => entry.stage === "install").length;
  return {
    failed: result.skillErrors.length,
    unavailable,
    disabled: result.skillErrors.length - unavailable,
  };
}

type ImportSource = "library" | "file" | "github";
type TeamTab = "explore" | "import" | "scout";

/** the scout endpoint's answer, as far as this panel renders it — the
 * manifest itself stays opaque and goes back to the server verbatim */
interface ScoutResult {
  profile: { name: string; summary: string; stacks: string[] };
  suggestion: {
    roomName: string;
    manifest: {
      team: { members: Array<{ key: string; name: string; title: string; description: string; appearance: { color: string } }> };
    };
    reasons: Record<string, string>;
  };
}

interface DirectoryCandidate {
  slug: string;
  name: string;
  category: string;
  integrations: string[];
  prompt: string;
  detailUrl: string;
  matched: string[];
}

/** appearance colors for community bots folded into a scouted team */
const DIRECTORY_COLORS = ["cyan", "red", "purple", "green", "orange"] as const;

const TEAM_GLYPHS = [
  "bg-purple-500/15 text-purple-300",
  "bg-cyan-500/15 text-cyan-300",
  "bg-orange-500/15 text-orange-300",
  "bg-emerald-500/15 text-emerald-300",
] as const;

async function openExternal(url: string): Promise<void> {
  if (window.muragebox?.openExternal) {
    await window.muragebox.openExternal(url);
    return;
  }
  const opened = window.open(url, "_blank", "noopener,noreferrer");
  if (opened) opened.opener = null;
}

function TeamGlyph({ index }: { index: number }) {
  return (
    <div className={cn("flex size-11 shrink-0 items-center justify-center rounded-xl", TEAM_GLYPHS[index % TEAM_GLYPHS.length])}>
      <Users size={20} />
    </div>
  );
}

function TeamRow({
  entry,
  index,
  busySlug,
  onLoad,
}: {
  entry: TeamCatalogEntry;
  index: number;
  busySlug: string | null;
  onLoad: (entry: TeamCatalogEntry) => Promise<void>;
}) {
  // 28 of the 58 one-person profiles declare zero skills — they carry a
  // playbook instead, and playbooks have no surface of their own yet. Printing
  // "0 playbooks" under half the catalog reads as broken. Where there is no
  // count to give, the summary is the evidence, and it is already on the line
  // above.
  const facts = [
    `${entry.members} ${entry.members === 1 ? "bot" : "bots"}`,
    entry.skills.length > 0 ? `${entry.skills.length} playbooks` : "",
    entry.requires.apps.length > 0 ? entry.requires.apps.join(", ") : "",
    entry.setupMinutes ? `~${entry.setupMinutes} min` : "",
  ].filter(Boolean);
  return (
    <article className="flex min-h-[104px] items-center gap-3 border-b border-hairline/35 px-1 py-4">
      <TeamGlyph index={index} />
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-[14px] font-medium text-ink">{entry.name}</h3>
        <p className="mt-0.5 line-clamp-3 text-[12.5px] leading-relaxed text-ink-secondary">{plainText(entry.outcome ?? entry.summary)}</p>
        <p className="mt-1 truncate text-[11.5px] text-ink-secondary/80">{facts.join(" · ")}</p>
      </div>
      <button
        onClick={() => void onLoad(entry)}
        disabled={busySlug !== null}
        className="flex min-w-[72px] items-center justify-center gap-1.5 rounded-full bg-raised px-3.5 py-2 text-[12.5px] text-ink hover:bg-raised-hover disabled:opacity-40"
      >
        {busySlug === entry.slug && <Loader2 size={13} className="animate-spin" />}
        {busySlug === entry.slug ? "Loading" : "Preview"}
      </button>
    </article>
  );
}

/** One skill result.
 *
 *  SEAM — skill assignment. This is deliberately a row with a dedicated
 *  right-hand action slot, sized and placed exactly like `TeamRow`'s "Load"
 *  button, rather than a bare paragraph. When `assign(skillId, botId)` exists
 *  it drops into `action` and nothing else here moves.
 *
 *  The slot is a VISIBLE control by construction, not a context menu.
 *  `Sidebar.tsx` exposes its bot row menu only through `onContextMenu`, and iOS
 *  fires no `contextmenu` event at all — that is a live defect in this
 *  codebase, and repeating it here would make assignment unreachable on the
 *  phone this app just became usable on. The slot sits inside the row's flex
 *  line so it stays on screen and finger-sized at 390 px.
 *
 *  `SkillAssignButton` now fills that slot. `POST /api/bots/:id/skills/library`
 *  is the route it needed — desktop-surface-only, bounded, traversal-gated —
 *  so the control is real rather than a "coming soon" affordance that teaches
 *  the button does not work. */
function SkillRow({ hit, action }: { hit: SkillHit; action?: React.ReactNode }) {
  return (
    <article className="flex min-h-[76px] items-center gap-3 border-b border-hairline/35 px-1 py-3">
      <div className="min-w-0 flex-1">
        <h4 className="truncate text-[13.5px] font-medium text-ink">{hit.name}</h4>
        <p className="mt-0.5 line-clamp-2 text-[12.5px] text-ink-secondary">{firstSentence(hit.description)}</p>
      </div>
      {action}
    </article>
  );
}

/** Assign one library skill to one agent — the library end of
 *  `assign(skillId, botId)`.
 *
 *  The label names the OUTCOME, with the agent in it ("Add to Bruce"), never
 *  the category ("Assign"). With exactly one agent in the workspace, or with
 *  the panel opened from an agent's own Skills panel, there is nothing to
 *  choose and the picker is skipped entirely — a chooser with one row is a
 *  question that answers itself. */
function SkillAssignButton({
  skillId,
  bots,
  preselected,
  installed,
}: {
  skillId: string;
  bots: Bot[];
  preselected?: Bot;
  /** Library ids the assign TARGET already has. Empty when there is no single
   *  target to read, which is the honest state — see `alreadyAdded`. */
  installed?: ReadonlySet<string>;
}) {
  const [phase, setPhase] = useState<"idle" | "picking" | "busy" | "done">("idle");
  const [addedTo, setAddedTo] = useState("");
  const [error, setError] = useState("");
  const target = preselected ?? (bots.length === 1 ? bots[0] : undefined);
  /** An installed skill's stored name IS its library id — `installSkillFromLibrary`
   *  refuses any manifest whose frontmatter name differs from the directory —
   *  so this comparison is exact, not a guess. */
  const alreadyAdded = Boolean(target && installed?.has(skillId));

  const assign = async (bot: Bot) => {
    setPhase("busy");
    setError("");
    try {
      const result = await assignSkillsToBot(bot.id, [skillId], api);
      // A 201 with nothing installed is a failure wearing a success code.
      if (result.installed.length === 0) {
        throw new Error(result.errors.join("; ") || "That skill could not be added");
      }
      // The agent just gained a skill, so anything keyed on "this agent is
      // unconfigured" — the chat intake card, the seeded setup quiz — has to
      // stop saying so.
      invalidateSkillCount(bot.id);
      setAddedTo(bot.name);
      setPhase("done");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPhase("idle");
    }
  };

  if (phase === "done") {
    return (
      <span className="flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] text-ink-secondary">
        <Check size={13} />
        Added to {addedTo}
      </span>
    );
  }

  if (bots.length === 0) return null;

  /* ALREADY THERE. Adding it again reaches `server/skills.ts`, which refuses a
     duplicate with an error no person was ever shown — the button simply did
     nothing. Saying so before the press is the whole fix. */
  if (alreadyAdded) {
    return (
      <span
        className="flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] text-ink-secondary"
        title={`${target!.name} already has this skill`}
      >
        <Check size={13} />
        Added
      </span>
    );
  }

  return (
    <span className="relative flex shrink-0 flex-col items-end">
      <button
        type="button"
        disabled={phase === "busy"}
        onClick={() => {
          if (target) void assign(target);
          else setPhase((current) => (current === "picking" ? "idle" : "picking"));
        }}
        className="flex items-center gap-1.5 rounded-lg bg-control px-2.5 py-1.5 text-[12px] text-ink hover:bg-control/70 disabled:opacity-60"
      >
        {phase === "busy" ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
        {target ? `Add to ${target.name}` : "Add to…"}
      </button>
      {phase === "picking" && (
        <div className="absolute right-0 top-full z-10 mt-1 max-h-56 w-48 overflow-y-auto rounded-lg border border-hairline/50 bg-card py-1 shadow-lg">
          {/* A SECOND LINE, because names are not unique. The live workspace
              has "Bruce" and "Bruce (Smart Trader)" and two agents both called
              "Seam Audit Probe"; a list of bare names asks a question the
              person cannot answer. The title is what they wrote themselves, so
              it comes first. */}
          {bots.map((bot) => {
            const detail = bot.title?.trim() || bot.description?.trim() || "";
            return (
              <button
                key={bot.id}
                type="button"
                onClick={() => void assign(bot)}
                className="block w-full px-3 py-2 text-left hover:bg-raised-hover"
              >
                <span className="block truncate text-[12.5px] text-ink">Add to {bot.name}</span>
                {detail && <span className="mt-0.5 block truncate text-[11px] text-ink-secondary">{detail}</span>}
              </button>
            );
          })}
        </div>
      )}
      {error && (
        <span role="alert" className="mt-1 max-w-[180px] text-right text-[11px] text-danger">
          {error}
        </span>
      )}
    </span>
  );
}

export function TeamLibraryPanel({
  onClose,
  onImported,
  returnFocusRef,
  initialUrl,
  initialView,
  preselectedBotId,
}: {
  onClose: () => void;
  onImported: (result: TeamImportResult) => void;
  returnFocusRef: React.RefObject<HTMLButtonElement | null>;
  initialUrl?: string;
  /** Which half of the library to open on.
   *
   *  "Add a skill to Bruce" and "browse teams" are different questions, and
   *  before this they landed on the same screen — the team grid, with a row of
   *  Load buttons that import a whole crew. A person who asked for a skill and
   *  was handed a team importer either imports the wrong thing or gives up.
   *  Absent = teams, the panel's own default. */
  initialView?: TeamLibraryView;
  /** SEAM — the agent this panel was opened "for", when the user arrived from
   *  an agent's Skills panel rather than from the sidebar. Assignment is one
   *  action, `assign(skillId, botId)`, with one end pre-filled by where the
   *  user entered; this is that end. Naming the agent on screen is what stops
   *  the pre-fill being invisible state the user cannot see or undo.
   *
   *  Nothing passes it yet — see the report note on lifting `teamLibraryOpen`
   *  out of `Sidebar.tsx` into `AppState`, which this direction needs. */
  preselectedBotId?: string;
}) {
  const { state, dispatch } = useStore();
  const dialogRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<TeamTab>("explore");
  /** Teams or skills. A real switch, not a derived one: the person who arrived
   *  here for a skill must be able to walk over to the teams and back without
   *  the panel deciding for them. */
  const [view, setView] = useState<TeamLibraryView>(initialView ?? "teams");
  const [catalog, setCatalog] = useState<TeamCatalog | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState("");
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingTeamImport | null>(null);
  const [bundleFile, setBundleFile] = useState<{ path: string; name: string } | null>(null);
  const [source, setSource] = useState<ImportSource>("file");
  const [githubUrl, setGithubUrl] = useState("");
  const [githubLoading, setGithubLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [search, setSearch] = useState("");
  // Ranked retrieval, served by the local FTS5 index (server/skill-search.ts).
  // `teamOrder` is a list of slugs, not entries: the catalog is already loaded
  // here, so shipping the entries back per keystroke would re-send 68 KB to
  // say something this component can look up for free.
  const [teamOrder, setTeamOrder] = useState<string[] | null>(null);
  const [skillHits, setSkillHits] = useState<SkillHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [facets, setFacets] = useState<Facet[]>([]);
  const [totalSkills, setTotalSkills] = useState(0);
  const [activeFacet, setActiveFacet] = useState<string | null>(null);
  const [showAllFacets, setShowAllFacets] = useState(false);
  const [error, setError] = useState("");
  const [scoutFolder, setScoutFolder] = useState("");
  const [scouting, setScouting] = useState(false);
  const [scouted, setScouted] = useState<ScoutResult | null>(null);
  // the folder the current `scouted` result was actually read from — the
  // import must pin the room to THIS, not to whatever the input says now
  const [scoutedFolder, setScoutedFolder] = useState("");
  // null = not asked yet or still loading; [] = asked, nothing (or offline)
  const [directory, setDirectory] = useState<DirectoryCandidate[] | null>(null);
  const [pickedDirectory, setPickedDirectory] = useState<Set<string>>(new Set());
  const [roomName, setRoomName] = useState("");
  const [creating, setCreating] = useState(false);
  // monotonically increasing scout token: a late response from an older
  // scout (including its lazy directory call) must never overwrite state
  // that belongs to a newer one
  const scoutRequest = useRef(0);

  const currentBotCount = state.bots.filter((bot) => !bot.hidden).length;
  /** SEAM: resolved here rather than passed as a name, so the panel always
   *  shows the agent's CURRENT name and degrades to no label if that agent was
   *  deleted while the panel was open. */
  const preselectedBot = preselectedBotId ? state.bots.find((bot) => bot.id === preselectedBotId) : undefined;
  /** Who a skill can be assigned to. Archived bots are not on screen anywhere
   *  else, so offering them here would name agents the person cannot see. */
  const assignableBots = state.bots.filter((bot) => !bot.hidden);
  /** The agent every "Add to…" on this screen would land on, when there is
   *  exactly one. Only then is there a set worth reading — with a picker open
   *  the answer differs per row, and a wrong "Added ✓" is worse than none. */
  const assignTarget = preselectedBot ?? (assignableBots.length === 1 ? assignableBots[0] : undefined);
  const [installedSkills, setInstalledSkills] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const botId = assignTarget?.id;
    if (!botId) {
      setInstalledSkills(new Set());
      return;
    }
    let live = true;
    void api(`/api/bots/${botId}/skills`)
      .then((response: { skills?: Array<{ name?: unknown }> }) => {
        if (!live) return;
        const names = Array.isArray(response?.skills) ? response.skills : [];
        setInstalledSkills(new Set(names.map((skill) => String(skill?.name ?? "")).filter(Boolean)));
      })
      // An unreadable list means "unknown", and unknown renders the ordinary
      // Add button — never a false "Added".
      .catch(() => live && setInstalledSkills(new Set()));
    return () => {
      live = false;
    };
  }, [assignTarget?.id]);

  const loadCatalog = useCallback(async () => {
    setCatalogLoading(true);
    setCatalogError("");
    try {
      // SAFETY: this endpoint is owned by the app and returns TeamCatalog.
      setCatalog((await api("/api/team-library/catalog")) as TeamCatalog);
    } catch (cause) {
      setCatalogError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  // Browse entry points. Loaded once, with nothing typed — a new user does not
  // know what is in here and cannot query for it, so the categories have to be
  // on screen before the first keystroke.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // SAFETY: this endpoint is owned by the app and returns facet counts.
        const response = (await api("/api/library/browse")) as { facets: Facet[]; totalSkills: number };
        if (cancelled) return;
        setFacets(response.facets ?? []);
        setTotalSkills(response.totalSkills ?? 0);
      } catch {
        // Browse is an enhancement over the team list, never a blocker: if the
        // index is unavailable the panel still lists every team as before.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Ranked search across both corpora. Debounced because it fires per
  // keystroke; sequenced because responses can land out of order and a stale
  // one must never overwrite a newer one.
  const searchRequest = useRef(0);
  useEffect(() => {
    const query = search.trim();
    if (!query && !activeFacet) {
      setTeamOrder(null);
      setSkillHits([]);
      setSearching(false);
      return;
    }
    const token = ++searchRequest.current;
    setSearching(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const params = new URLSearchParams(activeFacet ? { term: activeFacet, limit: "60" } : { q: query, limit: "40" });
          // SAFETY: this endpoint is owned by the app and returns ranked hits.
          const response = (await api(`/api/library/search?${params}`)) as LibrarySearchResponse;
          if (token !== searchRequest.current) return;
          setTeamOrder((response.teams ?? []).map((hit) => hit.slug));
          setSkillHits(response.skills ?? []);
        } catch {
          if (token !== searchRequest.current) return;
          // An unreachable index must not blank the team list.
          setTeamOrder(null);
          setSkillHits([]);
        } finally {
          if (token === searchRequest.current) setSearching(false);
        }
      })();
    }, 120);
    return () => clearTimeout(timer);
  }, [search, activeFacet]);

  useEffect(() => {
    dialogRef.current?.focus();
    return () => returnFocusRef.current?.focus();
  }, [returnFocusRef]);

  useEffect(() => {
    if (bundleFile) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !importing) {
        event.preventDefault();
        event.stopPropagation();
        if (pending) setPending(null);
        else onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      const items = Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
      if (!dialog || items.length === 0) return;
      const first = items[0]!;
      const last = items.at(-1)!;
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [importing, onClose, pending, bundleFile]);

  const previewManifest = (preview: PendingTeamImport, nextSource: ImportSource) => {
    setPending(preview);
    setSource(nextSource);
    setError("");
  };

  const readFile = async (file: File) => {
    if (file.name.toLowerCase().endsWith(".zip")) {
      if (file.size > 52 * 1024 * 1024) throw new Error("That package archive is too large.");
      const path = window.muragebox?.getPathForFile?.(file) ?? "";
      if (!path) throw new Error("ZIP package import needs a local file in the Murage desktop app. Open this package there.");
      setError(""); setBundleFile({ path, name: file.name }); return;
    }
    if (file.size > MAX_TEAM_FILE_BYTES) throw new Error("That team file is too large.");
    const raw = await file.text();
    let manifest: unknown = raw;
    if (!file.name.toLowerCase().endsWith(".md")) {
      try {
        manifest = JSON.parse(raw);
      } catch (cause) {
        if (cause instanceof SyntaxError) throw new Error("That legacy team file is not valid JSON.");
        throw cause;
      }
    }
    previewManifest(teamImportPreview(manifest), "file");
  };

  const finishBundleImport = (result: BundleImportResult) => {
    for (const bot of result.bots) dispatch({ type: "botAdded", bot });
    for (const group of result.groups) dispatch({ type: "groupPatched", group });
    for (const routine of result.routines) dispatch({ type: "routinePatched", routine });
    if (result.bots[0]) dispatch({ type: "select", id: result.bots[0].id });
    setBundleFile(null);
    onImported({ name: result.name, members: result.bots.length,
      importedBotIds: result.bots.map(bot => bot.id), importedGroupIds: result.groups.map(group => group.id),
      importedRoutineIds: result.routines.map(routine => routine.id), archived: [], skillErrors: [] });
  };

  const loadLibraryTeam = async (entry: TeamCatalogEntry) => {
    setBusySlug(entry.slug);
    setError("");
    try {
      previewManifest(teamImportPreview(await api(`/api/team-library/teams/${entry.slug}`)), "library");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusySlug(null);
    }
  };

  const loadGithubTeam = async () => {
    await loadGithubUrl(githubUrl);
  };

  const loadGithubUrl = async (requestedUrl: string) => {
    if (!requestedUrl.trim()) return;
    setGithubLoading(true);
    setError("");
    try {
      const manifest = await api("/api/team-library/github", {
        method: "POST",
        body: JSON.stringify({ url: requestedUrl.trim() }),
      });
      previewManifest(teamImportPreview(manifest), "github");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setGithubLoading(false);
    }
  };

  useEffect(() => {
    if (!initialUrl) return;
    setTab("import");
    setGithubUrl(initialUrl);
    void loadGithubUrl(initialUrl);
    // A deep link is immutable for this panel instance; reloading it on
    // every callback identity change would duplicate the preview request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialUrl]);

  const importTeam = async () => {
    if (!pending) return;
    setImporting(true);
    setError("");
    try {
      // SAFETY: this endpoint is owned by the app and returns imported bots.
      const response = (await api("/api/teams/import?mode=add", {
        method: "POST",
        body: JSON.stringify(pending.manifest),
      })) as {
        bots: Bot[];
        groups?: Group[];
        routines?: Routine[];
        archivedBots?: Bot[];
        archived?: ArchivedTeamBot[];
        skillErrors?: TeamImportSkillError[];
      };
      for (const bot of response.archivedBots ?? []) dispatch({ type: "botPatched", bot });
      for (const bot of response.bots) dispatch({ type: "botAdded", bot });
      for (const group of response.groups ?? []) dispatch({ type: "groupPatched", group });
      for (const routine of response.routines ?? []) dispatch({ type: "routinePatched", routine });
      const first = response.bots[0];
      if (first) dispatch({ type: "select", id: first.id });
      track("team_imported", { members: response.bots.length, source, mode: "add" });
      onImported({
        name: pending.name,
        members: response.bots.length,
        importedBotIds: response.bots.map((bot) => bot.id),
        importedGroupIds: (response.groups ?? []).map((group) => group.id),
        importedRoutineIds: (response.routines ?? []).map((routine) => routine.id),
        archived: response.archived ?? [],
        skillErrors: response.skillErrors ?? [],
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setImporting(false);
    }
  };

  const scoutTarget = scoutFolder.trim();

  const runScout = async (folder: string) => {
    const request = ++scoutRequest.current;
    setScouting(true);
    setError("");
    setScouted(null);
    setDirectory(null);
    setPickedDirectory(new Set());
    try {
      // SAFETY: this endpoint is owned by the app and returns ScoutResult.
      const result = (await api(`/api/teams/scout?cwd=${encodeURIComponent(folder)}`)) as ScoutResult;
      if (request !== scoutRequest.current) return;
      setScouted(result);
      setScoutedFolder(folder);
      setRoomName(result.suggestion.roomName);
      track("team_scouted", { signals: result.suggestion.manifest.team.members.length - 1 });
      // community candidates arrive lazily; an unreachable directory just
      // leaves this section empty
      void api(`/api/teams/scout/directory?cwd=${encodeURIComponent(folder)}`)
        // SAFETY: this endpoint is owned by the app and returns candidates.
        .then((extra) => {
          if (request === scoutRequest.current) setDirectory((extra as { directory: DirectoryCandidate[] }).directory);
        })
        .catch(() => {
          if (request === scoutRequest.current) setDirectory([]);
        });
    } catch (cause) {
      if (request !== scoutRequest.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request === scoutRequest.current) setScouting(false);
    }
  };

  const pickScoutFolder = async () => {
    const chosen = await window.muragebox?.pickFolder?.(scoutTarget || undefined);
    if (!chosen) return;
    setScoutFolder(chosen);
    await runScout(chosen);
  };

  const createProject = async () => {
    if (!scouted || creating) return;
    setCreating(true);
    setError("");
    try {
      // the confirmed suggestion, plus any community bots the user ticked —
      // folded in as ordinary manifest members so the import boundary
      // (persona only, no grants) applies to them like to everything else
      const extras = (directory ?? [])
        .filter((candidate) => pickedDirectory.has(candidate.slug))
        .map((candidate, index) => ({
          key: `dir-${candidate.slug}`,
          name: candidate.name,
          title: candidate.category || "Ember",
          description: candidate.prompt,
          appearance: { color: DIRECTORY_COLORS[index % DIRECTORY_COLORS.length] },
        }));
      const manifest = {
        ...scouted.suggestion.manifest,
        team: {
          ...scouted.suggestion.manifest.team,
          members: [...scouted.suggestion.manifest.team.members, ...extras],
        },
      };
      const room = roomName.trim() || scouted.suggestion.roomName;
      // SAFETY: this endpoint is owned by the app and returns imported bots.
      const response = (await api(
        `/api/teams/import?mode=project&cwd=${encodeURIComponent(scoutedFolder)}&room=${encodeURIComponent(room)}`,
        { method: "POST", body: JSON.stringify(manifest) },
      )) as { bots: Bot[]; group?: Group };
      for (const bot of response.bots) dispatch({ type: "botAdded", bot });
      if (response.group) {
        // upsert now instead of waiting for the SSE frame, then land in the room
        dispatch({ type: "groupPatched", group: { ...response.group, messages: [] } });
        dispatch({ type: "select", id: response.group.id });
      }
      track("team_imported", { members: response.bots.length, source: "scout", mode: "project" });
      onImported({
        name: room,
        members: response.bots.length,
        importedBotIds: response.bots.map((bot) => bot.id),
        importedGroupIds: response.group ? [response.group.id] : [],
        importedRoutineIds: [],
        archived: [],
        // a scouted team is people only; it declares no skills to miss
        skillErrors: [],
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(false);
    }
  };

  const normalizedSearch = search.trim();
  const browsing = !normalizedSearch && !activeFacet;

  // Ranked order comes from the server's BM25 index. Until the first response
  // lands, `teamOrder` is null and the full catalog shows — a search box that
  // empties the list while it thinks reads as "no results", which is the bug
  // this panel is being fixed for.
  const catalogTeams = (catalog?.teams ?? []).filter((entry) => matchesLibraryView(entry.members, view));
  const visibleTeams = (() => {
    if (browsing) return catalogTeams;
    if (activeFacet) return [];
    if (!teamOrder) return catalogTeams;
    const bySlug = new Map(catalogTeams.map((entry) => [entry.slug, entry] as const));
    return teamOrder.map((slug) => bySlug.get(slug)).filter((entry): entry is TeamCatalogEntry => Boolean(entry));
  })();

  /** The chips actually rendered. The selected topic is always among them,
   *  even when it ranks below the fold — a filter you cannot see is a filter
   *  you cannot turn off. */
  const visibleFacets = (() => {
    if (showAllFacets) return facets;
    const head = facets.slice(0, FACETS_COLLAPSED);
    if (!activeFacet || head.some((facet) => facet.term === activeFacet)) return head;
    const selected = facets.find((facet) => facet.term === activeFacet);
    return selected ? [selected, ...head.slice(0, FACETS_COLLAPSED - 1)] : head;
  })();

  /** Teams grouped by their own category, for browsing with nothing typed.
   *  25 categories already exist in the data; a flat list of 122 hides them. */
  const teamsByCategory = (() => {
    const groups = new Map<string, TeamCatalogEntry[]>();
    for (const entry of catalogTeams) {
      const list = groups.get(entry.category);
      if (list) list.push(entry);
      else groups.set(entry.category, [entry]);
    }
    return [...groups].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  })();

  return createPortal(
    <div
      className="fixed inset-x-0 top-0 z-50 flex h-[var(--vvh,100dvh)] items-center justify-center bg-black/55 p-4 backdrop-blur-[2px] sm:p-6"
      onMouseDown={(event) => event.target === event.currentTarget && !importing && !bundleFile && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="team-library-title"
        tabIndex={-1}
        className="animate-pop-in flex h-[min(780px,calc(var(--vvh,100dvh)-2rem))] w-full max-w-[1040px] flex-col overflow-hidden rounded-[24px] border border-hairline/50 bg-panel shadow-2xl shadow-black/50 outline-none"
      >
        <header className="flex items-start justify-between gap-4 px-6 pb-3 pt-6 sm:px-8 sm:pt-7">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {pending && (
                <button
                  onClick={() => {
                    setPending(null);
                    setError("");
                  }}
                  disabled={importing}
                  className="rounded-lg p-1.5 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
                  aria-label="Back to teams"
                >
                  <ArrowLeft size={18} />
                </button>
              )}
              <h2 id="team-library-title" className="truncate text-[22px] font-semibold tracking-[-0.01em] text-ink">
                {pending ? pending.name : "Library"}
              </h2>
            </div>
            <p className={cn("mt-1 text-[13px] text-ink-secondary", pending && "ml-9")}>
                {pending
                  ? pending.kind === "package"
                    ? `${pending.members.length} bots · portable Markdown playbook`
                    : `${pending.members.length} ready-to-load bots`
                  : "Find an individual bot, a team, or a skill for your work."}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              onClick={onClose}
              disabled={importing}
              className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
              aria-label="Close teams"
            >
              <X size={21} />
            </button>
          </div>
        </header>

        {pending ? (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-6 sm:px-8">
              {pending.description && (
                <section>
                  <h3 className="mb-2 text-[14px] font-semibold text-ink">Purpose</h3>
                  <p className="max-w-2xl text-[13.5px] leading-relaxed text-ink-secondary">{plainText(pending.description)}</p>
                </section>
              )}
              {!!pending.outcomes?.length && (
                <section className="mt-5">
                  <h3 className="mb-2 text-[14px] font-semibold text-ink">Expected outcomes</h3>
                  <ul className="list-disc space-y-2 pl-5 text-[13.5px] leading-relaxed text-ink-secondary">
                    {pending.outcomes.map((outcome, index) => <li key={index}>{plainText(outcome)}</li>)}
                  </ul>
                </section>
              )}
              {!!pending.examples?.length && (
                <section className="mt-5">
                  <h3 className="mb-2 text-[14px] font-semibold text-ink">Example requests</h3>
                  <div className="space-y-3 text-[13.5px] leading-relaxed text-ink-secondary">
                    {pending.examples.map((example, index) => (
                      <div key={index} className="rounded-xl bg-raised/45 p-3">
                        <h4 className="font-medium text-ink">{plainText(example.title)}</h4>
                        <p className="mt-1"><span className="font-medium">Request: </span>{plainText(example.input)}</p>
                        <p className="mt-1"><span className="font-medium">Expected result: </span>{plainText(example.output)}</p>
                      </div>
                    ))}
                  </div>
                </section>
              )}
              {pending.kind === "package" && (
                <div className="mt-5 flex flex-wrap gap-2 text-[11.5px] text-ink-secondary">
                  {pending.chiefOfStaff && <span className="flex items-center gap-1.5 rounded-full bg-raised px-3 py-1.5"><Crown size={13} />{pending.chiefOfStaff} leads</span>}
                  <span className="flex items-center gap-1.5 rounded-full bg-raised px-3 py-1.5"><MessageSquare size={13} />{pending.rooms} {pending.rooms === 1 ? "room" : "rooms"}</span>
                  <span className="flex items-center gap-1.5 rounded-full bg-raised px-3 py-1.5"><BookOpen size={13} />{pending.playbooks} playbooks</span>
                  <span className="flex items-center gap-1.5 rounded-full bg-raised px-3 py-1.5"><CalendarClock size={13} />{pending.routines} paused routines</span>
                  <span className="flex items-center gap-1.5 rounded-full bg-raised px-3 py-1.5"><Plug size={13} />{pending.apps.length} connections</span>
                </div>
              )}
              <div className="mt-6 text-[12px] font-medium text-ink-secondary">{pending.members.length === 1 ? "Your bot" : "Team members and roles"}</div>
              <div className="mt-2 grid grid-cols-1 gap-x-10 md:grid-cols-2">
                {pending.members.map((member, index) => (
                  <div key={`${member.name}-${index}`} className="flex min-h-[72px] items-center gap-3 border-b border-hairline/35 px-1 py-3">
                    <div className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg text-[13px] font-semibold", TEAM_GLYPHS[index % TEAM_GLYPHS.length])}>
                      {member.name.slice(0, 1).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-[14px] font-medium text-ink">{member.name}</div>
                      <div className="mt-0.5 truncate text-[12.5px] text-ink-secondary">{member.title || "General assistant"}</div>
                      {member.description && <p className="mt-1 text-[12.5px] leading-relaxed text-ink-secondary">{plainText(member.description)}</p>}
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-6 flex items-start gap-2.5 rounded-xl bg-raised/45 px-4 py-3 text-[12.5px] leading-relaxed text-ink-secondary">
                <Check size={15} className="mt-0.5 shrink-0 text-success" />
                <p>
                  {pending.kind === "package"
                    ? "Bots, Chief of Staff, rooms, and reviewed playbooks are loaded. Suggested routines arrive paused, and connected apps stay off until you approve them. Conversations, credentials, permissions, and computer access stay private."
                    : "Only roles and appearance are loaded. Your conversations, account connections, permissions, and computer access stay private."}
                </p>
              </div>
              {error && <div role="alert" className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</div>}
            </div>

            <footer className="flex flex-col gap-3 border-t border-hairline/35 px-6 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-8">
              <div className="text-[12.5px] text-ink-secondary">
                {currentBotCount > 0 ? (
                  <>
                    Joins your {currentBotCount} current {currentBotCount === 1 ? "bot" : "bots"}. Nothing is removed or replaced.
                  </>
                ) : (
                  pending.kind === "package" ? "Review the complete setup, then activate the playbook." : "No channel is created; you can make one later if you want."
                )}
              </div>
              <button
                onClick={() => void importTeam()}
                disabled={importing}
                className="flex shrink-0 items-center justify-center gap-2 rounded-full bg-accent px-5 py-2.5 text-[13.5px] font-medium text-white hover:bg-accent/90 disabled:opacity-60"
              >
                {importing && <Loader2 size={15} className="animate-spin" />}
                {importing
                  ? "Loading…"
                  : pending.kind === "package" && currentBotCount === 0
                    ? "Activate playbook"
                    : currentBotCount === 0
                      ? pending.members.length === 1 ? "Load bot" : "Load team"
                      : pending.members.length === 1 ? "Add bot" : "Add team"}
              </button>
            </footer>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-3 px-6 pb-4 pt-5 sm:flex-row sm:items-center sm:justify-between sm:px-8">
              <div className="flex w-fit rounded-xl bg-raised/70 p-1" role="tablist" aria-label="Team source">
                <button
                  role="tab"
                  aria-selected={tab === "explore"}
                  onClick={() => {
                    setTab("explore");
                    setError("");
                  }}
                  className={cn(
                    "rounded-lg px-4 py-2 text-[13.5px] transition-colors",
                    tab === "explore" ? "bg-card text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
                  )}
                >
                  Explore
                </button>
                <button
                  role="tab"
                  aria-selected={tab === "import"}
                  onClick={() => {
                    setTab("import");
                    setError("");
                  }}
                  className={cn(
                    "rounded-lg px-4 py-2 text-[13.5px] transition-colors",
                    tab === "import" ? "bg-card text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
                  )}
                >
                  Import
                </button>
                <button
                  role="tab"
                  aria-selected={tab === "scout"}
                  onClick={() => {
                    setTab("scout");
                    setError("");
                  }}
                  className={cn(
                    "rounded-lg px-4 py-2 text-[13.5px] transition-colors",
                    tab === "scout" ? "bg-card text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
                  )}
                >
                  From a folder
                </button>
              </div>
              {tab === "explore" && (
                <label className="flex h-11 w-full items-center gap-2.5 rounded-xl bg-raised/70 px-3.5 sm:w-[320px]">
                  <Search size={17} className="shrink-0 text-ink-secondary" />
                  <input
                    value={search}
                    onChange={(event) => {
                      setSearch(event.target.value);
                      // Typing is a new intent; a facet left active would
                      // silently filter the results being typed for.
                      if (event.target.value.trim()) setActiveFacet(null);
                    }}
                    placeholder={`Search ${view}`}
                    aria-label={`Search ${view}`}
                    className="min-w-0 flex-1 bg-transparent text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
                  />
                  {(search || activeFacet) && (
                    <button
                      onClick={() => {
                        setSearch("");
                        setActiveFacet(null);
                      }}
                      aria-label="Clear search"
                      className="shrink-0 rounded-full p-1 text-ink-secondary hover:bg-raised-hover hover:text-ink"
                    >
                      <X size={14} />
                    </button>
                  )}
                </label>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-7 pt-5 sm:px-8">
              {tab === "explore" && (
                <div>
                  {/* THE PANEL'S MISSING TABS. It had `activeFacet` and a
                      search box and nothing else, so "Add a skill to Bruce"
                      and "browse teams" arrived at the same screen. */}
                  <div role="tablist" aria-label="Library view" className="mb-4 inline-flex rounded-xl bg-raised/60 p-1">
                    {(["bots", "teams", "skills"] as const).map((candidate) => (
                      <button
                        key={candidate}
                        role="tab"
                        aria-selected={view === candidate}
                        onClick={() => { setView(candidate); setActiveFacet(null); }}
                        className={cn(
                          "rounded-lg px-4 py-1.5 text-[13px] transition-colors",
                          view === candidate ? "bg-card text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
                        )}
                      >
                        {candidate === "bots" ? "Bots" : candidate === "teams" ? "Teams" : "Skills"}
                      </button>
                    ))}
                  </div>
                  {/* Say whose skill this is about BEFORE any search — a
                      pre-filled target the person cannot see is exactly the
                      invisible state that makes an "Add a skill" flow feel
                      like it did nothing. */}
                  {view === "skills" && (
                    <h2 className="mb-3 text-[15px] font-semibold text-ink">
                      Skills{preselectedBot && <span className="text-ink-secondary"> · for {preselectedBot.name}</span>}
                    </h2>
                  )}
                  {/* Browse, with nothing typed. Krug: search only helps
                      someone who already knows what to ask for. */}
                  {view === "skills" && facets.length > 0 && (
                    <div className="mb-5">
                      <div className="mb-2 flex items-baseline justify-between gap-3">
                        <div className="text-[12px] font-medium text-ink-secondary">
                          {activeFacet ? "Browsing" : "Browse skills by topic"}
                        </div>
                        {totalSkills > 0 && (
                          <div className="text-[11.5px] text-ink-secondary/80">
                            {totalSkills.toLocaleString()} skills included
                          </div>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {visibleFacets.map((facet) => (
                          <button
                            key={facet.term}
                            aria-pressed={activeFacet === facet.term}
                            onClick={() => {
                              setActiveFacet(activeFacet === facet.term ? null : facet.term);
                              setSearch("");
                            }}
                            className={cn(
                              "rounded-full px-3 py-1.5 text-[12.5px] transition-colors",
                              activeFacet === facet.term
                                ? "bg-ink text-card"
                                : "bg-raised/70 text-ink-secondary hover:bg-raised-hover hover:text-ink",
                            )}
                          >
                            {facetLabel(facet.term)}
                            <span className="ml-1.5 text-[11px] opacity-60">{facet.count}</span>
                          </button>
                        ))}
                        {facets.length > FACETS_COLLAPSED && (
                          <button
                            onClick={() => setShowAllFacets((open) => !open)}
                            className="rounded-full px-3 py-1.5 text-[12.5px] text-ink-secondary underline underline-offset-2 hover:text-ink"
                          >
                            {showAllFacets ? "Show fewer" : `Show all ${facets.length} topics`}
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                  <div className="mb-3 flex items-center gap-2 text-[12px] font-medium text-ink-secondary">
                    {activeFacet ? `Skills in ${facetLabel(activeFacet)}` : view === "skills" ? "Skills" : `${visibleTeams.length} ${view}`}
                    {searching && <Loader2 size={12} className="animate-spin" />}
                  </div>
                  {catalogLoading && (
                    <div className="flex items-center justify-center gap-2 py-24 text-[13px] text-ink-secondary">
                      <Loader2 size={16} className="animate-spin" /> Loading library…
                    </div>
                  )}
                  {!catalogLoading && catalogError && (
                    <div className="rounded-xl bg-danger/10 p-4 text-[13px] text-danger">
                      <p>{catalogError}</p>
                      <button onClick={() => void loadCatalog()} className="mt-3 rounded-full bg-raised px-3.5 py-2 text-ink hover:bg-raised-hover">Try again</button>
                    </div>
                  )}
                  {/* NO LOAD BUTTONS ON THE SKILLS VIEW. `TeamRow`'s action
                      imports an entire crew of bots; offering it to someone who
                      asked for one skill is how this flow produced workspaces
                      full of agents nobody wanted. */}
                  {!catalogLoading && catalog && !activeFacet && view !== "skills" && (
                    <>
                      {/* Browsing: grouped by the catalog's own categories, so
                          the shape of the library is visible at a glance.
                          Searching: one ranked list, best first — grouping
                          ranked results by category would hide the ranking. */}
                      {browsing
                        ? teamsByCategory.map(([category, entries]) => (
                            <section key={category} className="mb-6">
                              <h3 className="mb-1 text-[12px] font-medium text-ink-secondary">
                                {category} <span className="opacity-60">{entries.length}</span>
                              </h3>
                              <div className="grid grid-cols-1 gap-x-10 md:grid-cols-2">
                                {entries.map((entry, index) => (
                                  <TeamRow
                                    key={entry.slug}
                                    entry={entry}
                                    index={index}
                                    busySlug={busySlug}
                                    onLoad={loadLibraryTeam}
                                  />
                                ))}
                              </div>
                            </section>
                          ))
                        : (
                          <div className="grid grid-cols-1 gap-x-10 md:grid-cols-2">
                            {visibleTeams.map((entry, index) => (
                              <TeamRow
                                key={entry.slug}
                                entry={entry}
                                index={index}
                                busySlug={busySlug}
                                onLoad={loadLibraryTeam}
                              />
                            ))}
                          </div>
                        )}
                      {/* Only worth saying when there IS something below it to
                          point at; otherwise the full empty state says it once,
                          properly, with somewhere to go. */}
                      {!browsing && visibleTeams.length === 0 && (
                        <p className="px-1 pb-2 text-[12.5px] text-ink-secondary">
                          No {view} match “{normalizedSearch}”. Try another search or library tab.
                        </p>
                      )}
                    </>
                  )}

                  {/* Skills. 2,010 of the 2,237 that ship are named by no team,
                      so without this section they are reachable from nowhere. */}
                  {view === "skills" && (activeFacet || (!browsing && skillHits.length > 0)) && (
                    <section className={cn(activeFacet ? "" : "mt-7 border-t border-hairline/35 pt-6")}>
                      {!activeFacet && (
                        <h3 className="mb-3 text-[12px] font-medium text-ink-secondary">
                          Skills <span className="opacity-60">{skillHits.length}</span>
                          {/* SEAM: when the panel is opened for a specific
                              agent, say so. A pre-filled target the user cannot
                              see is exactly the invisible state Krug warns
                              about. */}
                          {/* The skills view already names the agent in its
                              own heading; saying it twice is noise. */}
                        </h3>
                      )}
                      <div className="grid grid-cols-1 gap-x-10 md:grid-cols-2">
                        {skillHits.map((hit) => (
                          <SkillRow
                            key={hit.id}
                            hit={hit}
                            action={
                              <SkillAssignButton
                                skillId={hit.id}
                                bots={assignableBots}
                                preselected={preselectedBot}
                                installed={installedSkills}
                              />
                            }
                          />
                        ))}
                      </div>
                      {activeFacet && skillHits.length === 0 && !searching && (
                        <p className="px-1 py-6 text-[12.5px] text-ink-secondary">Nothing in this topic yet.</p>
                      )}
                    </section>
                  )}

                  {/* The honest empty state. Where the words a person typed are
                      simply not in either corpus, say so and offer the browse
                      that does not require knowing what to ask for — never a
                      confidently irrelevant top hit. */}
                  {view === "skills" && !catalogLoading && catalog && !browsing && !activeFacet && !searching
                    && visibleTeams.length === 0 && skillHits.length === 0 && (
                    <div className="flex min-h-56 flex-col items-center justify-center px-6 text-center">
                      <div className="text-[14px] font-medium text-ink">Nothing matches “{normalizedSearch}”</div>
                      <div className="mt-1 max-w-sm text-[12.5px] text-ink-secondary">
                        No skills match these words. Try a different word, or browse by topic.
                      </div>
                      {facets.length > 0 && (
                        <div className="mt-4 flex flex-wrap justify-center gap-1.5">
                          {facets.slice(0, 6).map((facet) => (
                            <button
                              key={facet.term}
                              onClick={() => {
                                setSearch("");
                                setActiveFacet(facet.term);
                              }}
                              className="rounded-full bg-raised/70 px-3 py-1.5 text-[12.5px] text-ink-secondary hover:bg-raised-hover hover:text-ink"
                            >
                              {facetLabel(facet.term)}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {tab === "import" && (
                <div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".zip,.md,.json,.emberteam.json,application/zip,text/markdown,application/json"
                    className="hidden"
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = "";
                      if (!file) return;
                      void readFile(file).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
                    }}
                  />
                  <div className="mb-3 text-[12px] font-medium text-ink-secondary">Bring your own team</div>
                  <div className="grid gap-5 md:grid-cols-2">
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      onDragEnter={(event) => {
                        event.preventDefault();
                        setDragging(true);
                      }}
                      onDragOver={(event) => event.preventDefault()}
                      onDragLeave={() => setDragging(false)}
                      onDrop={(event) => {
                        event.preventDefault();
                        setDragging(false);
                        const file = event.dataTransfer.files[0];
                        if (file) void readFile(file).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
                      }}
                      className={cn(
                        "flex min-h-56 flex-col items-center justify-center rounded-2xl border border-dashed px-6 text-center transition-colors",
                        dragging ? "border-accent bg-accent/5" : "border-hairline/60 bg-raised/20 hover:bg-raised/35",
                      )}
                    >
                      <UploadCloud size={27} className="text-accent" />
                      <span className="mt-3 text-[14px] font-medium text-ink">Choose a team file</span>
                      <span className="mt-1 text-[12.5px] text-ink-secondary">or drop a package .zip, BotMRR .md or legacy .emberteam.json here</span>
                    </button>

                    <div className="flex min-h-56 flex-col justify-center rounded-2xl bg-raised/25 px-6">
                      <Github size={25} className="text-ink-secondary" />
                      <h3 className="mt-3 text-[14px] font-medium text-ink">Load from GitHub</h3>
                      <p className="mt-1 text-[12.5px] leading-relaxed text-ink-secondary">Paste a public repo or a direct team JSON link.</p>
                      <div className="mt-4 flex gap-2">
                        <input
                          value={githubUrl}
                          onChange={(event) => setGithubUrl(event.target.value)}
                          onKeyDown={(event) => event.key === "Enter" && void loadGithubTeam()}
                          placeholder="github.com/owner/repo"
                          aria-label="GitHub team URL"
                          className="min-w-0 flex-1 rounded-xl bg-raised/80 px-3 py-2.5 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
                        />
                        <button
                          onClick={() => void loadGithubTeam()}
                          disabled={!githubUrl.trim() || githubLoading}
                          className="flex items-center gap-1.5 rounded-full bg-accent px-4 py-2.5 text-[13px] font-medium text-white hover:bg-accent/90 disabled:opacity-40"
                        >
                          {githubLoading && <Loader2 size={13} className="animate-spin" />}
                          Load
                        </button>
                      </div>
                    </div>
                  </div>
                  {error && <div role="alert" className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</div>}
                </div>
              )}

              {tab === "scout" && (
                <div>
                  <div className="mb-3 text-[12px] font-medium text-ink-secondary">Start from a project folder</div>
                  <p className="max-w-2xl text-[12.5px] leading-relaxed text-ink-secondary">
                    Point the scout at a folder. It reads what&apos;s in there (README, dependencies, layout) and
                    suggests a team for it. Nothing is created until you say so.
                  </p>
                  <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                    <input
                      value={scoutFolder}
                      onChange={(event) => setScoutFolder(event.target.value)}
                      onKeyDown={(event) => event.key === "Enter" && scoutTarget && void runScout(scoutTarget)}
                      placeholder="/path/to/your/project"
                      aria-label="Project folder to scout"
                      className="min-w-0 flex-1 rounded-xl bg-raised/80 px-3 py-2.5 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
                    />
                    {Boolean(window.muragebox?.pickFolder) && (
                      <button
                        onClick={() => void pickScoutFolder()}
                        disabled={scouting}
                        className="flex items-center justify-center gap-1.5 rounded-full bg-raised px-4 py-2.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-40"
                      >
                        <FolderOpen size={14} />
                        Browse
                      </button>
                    )}
                    <button
                      onClick={() => void runScout(scoutTarget)}
                      disabled={!scoutTarget || scouting}
                      className="flex items-center justify-center gap-1.5 rounded-full bg-accent px-4 py-2.5 text-[13px] font-medium text-white hover:bg-accent/90 disabled:opacity-40"
                    >
                      {scouting ? <Loader2 size={14} className="animate-spin" /> : <Compass size={14} />}
                      {scouting ? "Scouting…" : "Scout"}
                    </button>
                  </div>

                  {scouted && (
                    <div className="mt-6">
                      <div className="rounded-2xl bg-raised/25 px-5 py-4">
                        <div className="text-[15px] font-semibold text-ink">{scouted.profile.name}</div>
                        {scouted.profile.summary && (
                          <p className="mt-1 text-[12.5px] leading-relaxed text-ink-secondary">{plainText(scouted.profile.summary)}</p>
                        )}
                        {scouted.profile.stacks.length > 0 && (
                          <div className="mt-2.5 flex flex-wrap gap-1.5">
                            {scouted.profile.stacks.map((stack) => (
                              <span key={stack} className="rounded-full bg-raised px-2.5 py-1 text-[11.5px] text-ink-secondary">
                                {stack}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>

                      <div className="mt-5 text-[12px] font-medium text-ink-secondary">Suggested team</div>
                      <div className="mt-1 grid grid-cols-1 gap-x-10 md:grid-cols-2">
                        {scouted.suggestion.manifest.team.members.map((member, index) => (
                          <div key={member.key} className="flex min-h-[64px] items-center gap-3 border-b border-hairline/35 px-1 py-3">
                            <div className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg text-[13px] font-semibold", TEAM_GLYPHS[index % TEAM_GLYPHS.length])}>
                              {member.name.slice(0, 1).toUpperCase()}
                            </div>
                            <div className="min-w-0">
                              <div className="truncate text-[14px] font-medium text-ink">
                                {member.name} <span className="font-normal text-ink-secondary">· {member.title}</span>
                              </div>
                              <div className="mt-0.5 truncate text-[12px] text-ink-secondary">
                                {scouted.suggestion.reasons[member.key] ?? ""}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>

                      {directory && directory.length > 0 && (
                        <>
                    <div className="mt-5 text-[12px] font-medium text-ink-secondary">From the community directory: tick to add</div>
                          <div className="mt-1 flex flex-col">
                            {directory.map((candidate) => (
                              <div key={candidate.slug} className="flex items-center gap-3 border-b border-hairline/35 px-1 py-3">
                                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                                  <input
                                    type="checkbox"
                                    checked={pickedDirectory.has(candidate.slug)}
                                    onChange={() =>
                                      setPickedDirectory((prev) => {
                                        const next = new Set(prev);
                                        if (next.has(candidate.slug)) next.delete(candidate.slug);
                                        else next.add(candidate.slug);
                                        return next;
                                      })
                                    }
                                    className="size-4 accent-accent"
                                  />
                                  <div className="min-w-0 flex-1">
                                    <div className="truncate text-[13.5px] font-medium text-ink">
                                      {candidate.name}
                                      {candidate.category && <span className="font-normal text-ink-secondary"> · {candidate.category}</span>}
                                    </div>
                                    <div className="mt-0.5 truncate text-[12px] text-ink-secondary">
                                      Matches {candidate.matched.join(", ")}
                                    </div>
                                  </div>
                                </label>
                                <button
                                  onClick={() => void openExternal(candidate.detailUrl)}
                                  aria-label={`Open ${candidate.name} on botdirectory.ai`}
                                  title="Read this bot's page before adding it"
                                  className="rounded-lg p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
                                >
                                  <ExternalLink size={14} />
                                </button>
                              </div>
                            ))}
                          </div>
                        </>
                      )}

                      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
                        <input
                          value={roomName}
                          onChange={(event) => setRoomName(event.target.value)}
                          aria-label="Project channel name"
                          className="min-w-0 flex-1 rounded-xl bg-raised/80 px-3 py-2.5 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
                        />
                        <button
                          onClick={() => void createProject()}
                          disabled={creating}
                          className="flex shrink-0 items-center justify-center gap-2 rounded-full bg-accent px-5 py-2.5 text-[13.5px] font-medium text-white hover:bg-accent/90 disabled:opacity-60"
                        >
                          {creating && <Loader2 size={15} className="animate-spin" />}
                          {creating ? "Creating…" : "Create project channel"}
                        </button>
                      </div>
                      <p className="mt-2 text-[12px] text-ink-secondary">
                        Creates the team as new bots, opens a channel for them, and points the channel at this folder.
                      </p>
                    </div>
                  )}
                  {error && <div role="alert" className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</div>}
                </div>
              )}
            </div>
          </>
        )}
      </div>
      {bundleFile && <BundleImportDialog archivePath={bundleFile.path} fileName={bundleFile.name}
        onClose={() => { setBundleFile(null); dialogRef.current?.focus(); }} onImported={finishBundleImport} />}
    </div>,
    document.body,
  );
}
