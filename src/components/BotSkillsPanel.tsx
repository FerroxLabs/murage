import { BookOpen, ChevronLeft, Search, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api, useStore, type Bot } from "@/state/store";
import { skillRecorderEnabled } from "@/lib/feature-flags";
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

/** An error the user cannot act on is noise: always name the operation and
 * keep whatever the server said about why it refused. */
export function skillErrorMessage(cause: unknown, headline: string): string {
  const detail = cause instanceof Error ? cause.message.trim() : String(cause ?? "").trim();
  return detail ? `${headline} ${detail}` : headline;
}

/** Where a skill came from, in the words a person used to put it there. */
export function skillSourceLabel(source: string): string {
  if (source.startsWith("library:")) return `Library · ${source.slice("library:".length)}`;
  if (source.startsWith("learn:")) return "Learned in chat";
  return source;
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

export interface SkillsBodyProps {
  botName: string;
  loading: boolean;
  skills: BotSkill[];
  staged: number;
  authoringEnabled: boolean;
  query: string;
  onQuery: (value: string) => void;
  visible: number;
  onShowMore: () => void;
  busy: string;
  error: string;
  viewing: { name: string; text: string | null; error: string } | null;
  onOpen: (skill: BotSkill) => void;
  onBack: () => void;
  onToggle: (skill: BotSkill) => void;
  onRemove: (skill: BotSkill) => void;
}

const ALERT = "mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger";

/** Split from the container so the list, the empty state, the SKILL.md view
 * and the failure copy are all renderable without a live server. */
export function SkillsBody(props: SkillsBodyProps) {
  const { botName, loading, skills, staged, authoringEnabled, viewing } = props;
  const enabledCount = skills.filter((skill) => skill.enabled).length;

  if (loading) {
    return (
      <div className="mt-3 text-[12px] text-ink-secondary">Loading {botName}'s skills…</div>
    );
  }

  if (viewing) {
    const skill = skills.find((entry) => entry.name === viewing.name);
    return (
      <div className="mt-3">
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
              <div className="mt-0.5 text-[11.5px] text-ink-secondary">{skill.description}</div>
              <div className="mt-1 truncate text-[10.5px] text-ink-secondary" title={skill.source}>
                {skillSourceLabel(skill.source)}
              </div>
            </div>
            <Switch
              checked={skill.enabled}
              aria-label={`${skill.enabled ? "Disable" : "Enable"} ${skill.name}`}
              disabled={props.busy === skill.name || viewing.text === null}
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
          <div role="alert" className={ALERT}>{viewing.error}</div>
        ) : viewing.text === null ? (
          <div className="mt-3 text-[12px] text-ink-secondary">Loading SKILL.md…</div>
        ) : (
          <div className="mt-3 max-h-[420px] overflow-y-auto rounded-lg bg-inset p-3 text-[13px] leading-relaxed text-ink">
            <ChatMarkdown text={viewing.text} />
          </div>
        )}
        {props.error && <div role="alert" className={ALERT}>{props.error}</div>}
      </div>
    );
  }

  if (skills.length === 0) {
    return (
      <div className="mt-3">
        <div className="rounded-lg bg-inset px-3 py-2.5 text-[12px] leading-relaxed text-ink-secondary">
          {botName} has no skills yet. Skills arrive with a profile you hire from the team library,
          {authoringEnabled ? " from /learn in chat," : ""} or from a GitHub import — once installed they
          land switched off until you read them here.
        </div>
        {staged > 0 && (
          <div className="mt-2 text-[11.5px] text-warning">
            {staged} proposal{staged === 1 ? " is" : "s are"} waiting for a decision in chat.
          </div>
        )}
        {props.error && <div role="alert" className={ALERT}>{props.error}</div>}
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
                  <div className="mt-0.5 line-clamp-2 text-[11.5px] text-ink-secondary">{skill.description}</div>
                </button>
                <Switch
                  checked={skill.enabled}
                  aria-label={`${skill.enabled ? "Disable" : "Enable"} ${skill.name}`}
                  disabled={props.busy === skill.name}
                  onClick={() => props.onToggle(skill)}
                />
                <button
                  type="button"
                  aria-label={`Remove ${skill.name}`}
                  title="Remove skill"
                  disabled={props.busy === skill.name}
                  onClick={() => props.onRemove(skill)}
                  className="flex size-8 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                >
                  <Trash2 size={15} />
                </button>
              </div>
              {skill.warnings.length > 0 && (
                <div className="mt-1 text-[10.5px] text-warning">{skill.warnings.join(" · ")}</div>
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
      {props.error && <div role="alert" className={ALERT}>{props.error}</div>}
    </div>
  );
}

/** The skills a bot actually has, on the Agent profile panel next to its
 * name, model and folder — the surface a person lands on when they click a
 * bot and ask what it can do. A disabled skill opens its SKILL.md before it
 * can be switched on: an import lands off precisely so the bytes get read
 * once (see the policy note above the routes in server/index.ts). */
export function BotSkillsPanel({ bot }: { bot: Bot }) {
  const { state } = useStore();
  const authoringEnabled = skillRecorderEnabled(state.config);
  const [skills, setSkills] = useState<BotSkill[] | null>(null);
  const [staged, setStaged] = useState<StagedSkillSummary[]>([]);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [visible, setVisible] = useState(SKILL_PAGE_SIZE);
  const [busy, setBusy] = useState("");
  const [viewing, setViewing] = useState<{ name: string; text: string | null; error: string } | null>(null);

  const load = async (cancelled?: () => boolean) => {
    try {
      const result = (await api(`/api/bots/${bot.id}/skills`)) as {
        skills?: BotSkill[];
        staged?: StagedSkillSummary[];
      };
      if (cancelled?.()) return;
      setSkills(result.skills ?? []);
      setStaged(result.staged ?? []);
      setError("");
    } catch (cause) {
      if (cancelled?.()) return;
      setSkills((current) => current ?? []);
      setError(skillErrorMessage(cause, `Could not load ${bot.name}'s skills.`));
    }
  };

  useEffect(() => {
    let cancelled = false;
    setSkills(null);
    setStaged([]);
    setError("");
    setQuery("");
    setVisible(SKILL_PAGE_SIZE);
    setViewing(null);
    void load(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [bot.id]);

  const open = async (skill: BotSkill) => {
    setViewing({ name: skill.name, text: null, error: "" });
    setError("");
    try {
      const result = (await api(`/api/bots/${bot.id}/skills/${encodeURIComponent(skill.name)}`)) as { text?: string };
      if (!result.text) throw new Error("The stored SKILL.md is unavailable; remove and import or learn it again.");
      setViewing((current) => (current?.name === skill.name ? { ...current, text: result.text! } : current));
    } catch (cause) {
      const message = skillErrorMessage(cause, `Could not read “${skill.name}”.`);
      setViewing((current) => (current?.name === skill.name ? { ...current, error: message } : current));
    }
  };

  const toggle = async (skill: BotSkill) => {
    // Switching a skill ON is the moment its instructions reach the engine, so
    // the SKILL.md is put in front of the person first; the switch in that view
    // does the write. Switching OFF needs no reading.
    if (!skill.enabled && viewing?.name !== skill.name) {
      void open(skill);
      return;
    }
    setBusy(skill.name);
    setError("");
    const result = await toggleSkillEnabled({
      botId: bot.id,
      name: skill.name,
      enabled: !skill.enabled,
      apply: (update) => setSkills((current) => update(current ?? [])),
      request: api,
    });
    setBusy("");
    if (!result.ok) setError(result.error);
  };

  const remove = async (skill: BotSkill) => {
    if (!window.confirm(`Remove the skill “${skill.name}” from ${bot.name}?`)) return;
    setBusy(skill.name);
    setError("");
    try {
      await api(`/api/bots/${bot.id}/skills/${encodeURIComponent(skill.name)}`, { method: "DELETE" });
      if (viewing?.name === skill.name) setViewing(null);
      await load();
    } catch (cause) {
      setError(skillErrorMessage(cause, `Could not remove “${skill.name}”.`));
    } finally {
      setBusy("");
    }
  };

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
        loading={skills === null}
        skills={skills ?? []}
        staged={staged.length}
        authoringEnabled={authoringEnabled}
        query={query}
        onQuery={(value) => {
          setQuery(value);
          setVisible(SKILL_PAGE_SIZE);
        }}
        visible={visible}
        onShowMore={() => setVisible((current) => current + SKILL_PAGE_SIZE)}
        busy={busy}
        error={error}
        viewing={viewing}
        onOpen={(skill) => void open(skill)}
        onBack={() => setViewing(null)}
        onToggle={(skill) => void toggle(skill)}
        onRemove={(skill) => void remove(skill)}
      />
    </div>
  );
}
