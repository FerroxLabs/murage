// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "New Bot" and "New Team": one box each. Say what it should do and the
// best templates come up; or browse one topic at a time; or start blank.
// Clicking a template shows what it comes with before anything is made.
import { ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { track } from "@/lib/analytics";
import { teamImportPreview, type PendingTeamImport } from "@/lib/team-import";
import type { Routine } from "@/lib/routines";
import { api, useStore, type Bot, type Group } from "@/state/store";
import type { TeamImportResult } from "./TeamLibraryPanel";

export type TemplateKind = "bot" | "team";

export interface TemplateEntry {
  slug: string;
  name: string;
  summary: string;
  category: string;
  members: number;
  skills: string[];
  package?: string;
  requires?: { apps: string[] };
}

/** Templates of one kind: a bot template has one member, a team more. */
export function templatesOfKind(entries: TemplateEntry[], kind: TemplateKind): TemplateEntry[] {
  return entries.filter((entry) => (kind === "bot" ? entry.members === 1 : entry.members > 1));
}

/** Topics with how many templates each has, biggest first. */
export function templateTopics(entries: TemplateEntry[]): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const entry of entries) if (entry.category) counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Whether the owner already made something from this template. */
export function alreadyHave(entry: TemplateEntry, bots: Array<Pick<Bot, "name" | "installedPackage" | "hidden">>): boolean {
  return bots.some((bot) => !bot.hidden && ((entry.package && bot.installedPackage?.id === entry.package) || (entry.members === 1 && bot.name.trim().toLowerCase() === entry.name.trim().toLowerCase())));
}

const STOP = new Set("a an and are as at be by can do for from get has have help i in into is it its me my of on or our so that the their them then this to up us use want we what when with you your".split(" "));
/** The words of a request that carry meaning, cut to a stem ("invoices",
 *  "invoicing" -> "invoi"). */
export function contentStems(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2 && !STOP.has(word)).map((word) => word.slice(0, 5)))];
}

/** The ranked templates that really match: with three or more meaningful
 *  words typed, a template has to share at least two of them, one of them in
 *  its own name, summary or topic (the search engine alone counts any one
 *  shared word, so "follow up with clients" brought up templates about
 *  nothing of the kind). */
export function relevantMatches(ranked: TemplateEntry[], query: string): TemplateEntry[] {
  const wanted = contentStems(query);
  const need = wanted.length >= 3 ? 2 : 1;
  return ranked.filter((entry) => {
    // One of the shared words must be in what the template says it is for,
    // not only in the name of a skill it happens to carry.
    const purpose = new Set(contentStems(`${entry.name} ${entry.summary} ${entry.category}`));
    const skills = new Set(contentStems(entry.skills.map((path) => path.split("/").filter(Boolean).at(-2) ?? "").join(" ")));
    const shared = wanted.filter((stem) => purpose.has(stem) || skills.has(stem));
    return shared.length >= need && shared.some((stem) => purpose.has(stem));
  });
}

/** A summary without markdown emphasis. */
export const plainSummary = (text: string) => text.replace(/\*\*|__/g, "").replace(/\s+/g, " ").trim();

type Screen = { kind: "choose" } | { kind: "preview"; entry: TemplateEntry; preview: PendingTeamImport | null; error: string };

export function NewFromTemplateDialog({ kind, onClose, onBlank, onOpenFile, onCreated }: {
  kind: TemplateKind;
  onClose(): void;
  onBlank(): void;
  onOpenFile(): void;
  onCreated(result: TeamImportResult): void;
}) {
  const { state, dispatch } = useStore();
  const [catalog, setCatalog] = useState<TemplateEntry[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [topic, setTopic] = useState("");
  const [ranked, setRanked] = useState<string[] | null>(null);
  const [screen, setScreen] = useState<Screen>({ kind: "choose" });
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [showAllTopics, setShowAllTopics] = useState(false);
  const generation = useRef(0);
  const noun = kind === "bot" ? "bot" : "team";

  useEffect(() => {
    void (async () => {
      try {
        const response = (await api("/api/team-library/catalog")) as { teams: TemplateEntry[] };
        setCatalog(templatesOfKind(response.teams ?? [], kind));
      } catch (cause) {
        setLoadError(cause instanceof Error ? cause.message : "Templates couldn't be loaded.");
      }
    })();
  }, [kind]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !creating) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [creating, onClose]);

  // Best matches: the catalogue's own ranking for the sentence typed.
  useEffect(() => {
    const words = query.trim();
    if (!words) {
      setRanked(null);
      return;
    }
    const mine = ++generation.current;
    const timer = setTimeout(() => void (async () => {
      try {
        const response = (await api(`/api/library/search?${new URLSearchParams({ q: words, limit: "40" })}`)) as { teams: Array<{ slug: string }> };
        if (mine === generation.current) setRanked(response.teams.map((team) => team.slug));
      } catch {
        if (mine === generation.current) setRanked([]);
      }
    })(), 200);
    return () => clearTimeout(timer);
  }, [query]);

  const bySlug = useMemo(() => new Map((catalog ?? []).map((entry) => [entry.slug, entry])), [catalog]);
  const topics = useMemo(() => templateTopics(catalog ?? []), [catalog]);
  const matches = relevantMatches(ranked?.flatMap((slug) => bySlug.get(slug) ?? []) ?? [], query);
  const inTopic = topic ? (catalog ?? []).filter((entry) => entry.category === topic).sort((a, b) => a.name.localeCompare(b.name)) : [];

  const open = async (entry: TemplateEntry) => {
    setScreen({ kind: "preview", entry, preview: null, error: "" });
    try {
      const preview = teamImportPreview(await api(`/api/team-library/teams/${encodeURIComponent(entry.slug)}`));
      setScreen({ kind: "preview", entry, preview, error: "" });
    } catch (cause) {
      setScreen({ kind: "preview", entry, preview: null, error: cause instanceof Error ? cause.message : "This template couldn't be read." });
    }
  };

  const create = async (entry: TemplateEntry, preview: PendingTeamImport) => {
    setCreating(true);
    setError("");
    try {
      const response = (await api("/api/teams/import?mode=add", { method: "POST", body: JSON.stringify(preview.manifest) })) as {
        bots: Bot[]; groups?: Group[]; routines?: Routine[]; archivedBots?: Bot[]; archived?: TeamImportResult["archived"]; skillErrors?: TeamImportResult["skillErrors"];
      };
      for (const bot of response.archivedBots ?? []) dispatch({ type: "botPatched", bot });
      for (const bot of response.bots) dispatch({ type: "botAdded", bot });
      for (const group of response.groups ?? []) dispatch({ type: "groupPatched", group });
      for (const routine of response.routines ?? []) dispatch({ type: "routinePatched", routine });
      const first = response.bots[0];
      if (first) dispatch({ type: "select", id: first.id });
      track("team_imported", { members: response.bots.length, source: "library", mode: "add" });
      onCreated({
        name: entry.name,
        members: response.bots.length,
        importedBotIds: response.bots.map((bot) => bot.id),
        importedGroupIds: (response.groups ?? []).map((group) => group.id),
        importedRoutineIds: (response.routines ?? []).map((routine) => routine.id),
        archived: response.archived ?? [],
        skillErrors: response.skillErrors ?? [],
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `This ${noun} couldn't be made.`);
      setCreating(false);
    }
  };

  const Row = ({ entry }: { entry: TemplateEntry }) => (
    <li>
      <button type="button" onClick={() => void open(entry)} className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-control">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-medium text-ink">{entry.name}</div>
          <div className="truncate text-[12px] text-ink-secondary">{plainSummary(entry.summary)}</div>
        </div>
        {alreadyHave(entry, state.bots) && <span className="shrink-0 text-[11.5px] text-ink-secondary">You have this</span>}
        <ChevronRight size={14} className="shrink-0 text-ink-secondary" aria-hidden="true" />
      </button>
    </li>
  );

  const title = kind === "bot" ? "New Bot" : "New Team";
  return (
    <div className="fixed inset-x-0 top-0 z-40 flex h-[var(--vvh,100dvh)] items-center justify-center bg-black/40" onMouseDown={(event) => event.target === event.currentTarget && !creating && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby="new-from-template-title" className="flex max-h-[min(720px,calc(var(--vvh,100dvh)-32px))] w-[min(560px,calc(100vw-32px))] flex-col overflow-hidden rounded-2xl border border-hairline bg-panel shadow-2xl">
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-hairline/40 px-5 py-3">
          <h2 id="new-from-template-title" className="text-[17px] font-semibold text-ink">{title}</h2>
          <button type="button" aria-label="Close" onClick={onClose} disabled={creating} className="flex size-9 items-center justify-center rounded-lg hover:bg-control"><X size={17} /></button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {screen.kind === "preview" ? (
            <div>
              <button type="button" onClick={() => { setScreen({ kind: "choose" }); setError(""); }} disabled={creating} className="-ml-1.5 flex items-center gap-1 rounded px-1.5 py-1 text-[12px] text-ink-secondary hover:bg-control hover:text-ink">
                <ChevronLeft size={14} aria-hidden="true" />
                Back
              </button>
              <h3 className="mt-2 text-[16px] font-medium text-ink">{screen.entry.name}</h3>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">{plainSummary(screen.preview?.description || screen.entry.summary)}</p>
              {screen.error && <div role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{screen.error}</div>}
              {!screen.preview && !screen.error && <p className="mt-3 text-[12px] text-ink-secondary">Loading…</p>}
              {screen.preview && (
                <ul className="mt-3 space-y-1.5 text-[12.5px] text-ink">
                  {kind === "team" && <li><span className="text-ink-secondary">Bots: </span>{screen.preview.members.map((member) => member.name).join(", ")}</li>}
                  {screen.entry.skills.length > 0 && <li><span className="text-ink-secondary">Comes with </span>{screen.entry.skills.length} {screen.entry.skills.length === 1 ? "skill" : "skills"}</li>}
                  {screen.preview.routines > 0 && <li><span className="text-ink-secondary">Routines: </span>{screen.preview.routines}</li>}
                  {screen.preview.apps.length > 0 && <li><span className="text-ink-secondary">Needs </span>{screen.preview.apps.map((app) => app.label + (app.optional ? " (optional)" : "")).join(", ")}</li>}
                </ul>
              )}
              {alreadyHave(screen.entry, state.bots) && <p className="mt-3 text-[12px] text-ink-secondary">You already have this. Creating it again makes a second copy.</p>}
              {error && <div role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}
              <button type="button" disabled={!screen.preview || creating} onClick={() => screen.preview && void create(screen.entry, screen.preview)} className="mt-4 rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white disabled:opacity-50">
                {creating ? "Creating…" : "Create"}
              </button>
            </div>
          ) : (
            <div>
              <label htmlFor="new-from-template-query" className="text-[13px] font-medium text-ink">What should it do?</label>
              <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-hairline/50 bg-inset px-3">
                <Search size={14} className="text-ink-secondary" aria-hidden="true" />
                <input
                  id="new-from-template-query"
                  autoFocus
                  value={query}
                  onChange={(event) => { setQuery(event.target.value); setTopic(""); }}
                  placeholder={kind === "bot" ? "e.g. chase unpaid invoices and follow up with clients" : "e.g. run my sales pipeline"}
                  className="min-h-11 min-w-0 flex-1 bg-transparent text-[13.5px] text-ink placeholder:text-ink-secondary focus:outline-none"
                />
              </div>
              {loadError && <div role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{loadError}</div>}

              {query.trim() ? (
                <>
                  <h3 className="mt-4 px-2 text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary">Best matches</h3>
                  {ranked === null ? (
                    <p className="mt-1 px-2 text-[12px] text-ink-secondary">Looking…</p>
                  ) : matches.length ? (
                    <ul className="mt-1">{matches.slice(0, 5).map((entry) => <Row key={entry.slug} entry={entry} />)}</ul>
                  ) : (
                    <p className="mt-1 px-2 text-[12px] leading-relaxed text-ink-secondary">{kind === "bot" ? "No template fits that yet. Start blank, then add the skills it needs from its Skills page." : "No team template fits that yet. Pick from your bots, or try other words."}</p>
                  )}
                </>
              ) : topic ? (
                <>
                  <button type="button" onClick={() => setTopic("")} className="mt-3 -ml-1.5 flex items-center gap-1 rounded px-1.5 py-1 text-[12px] text-ink-secondary hover:bg-control hover:text-ink">
                    <ChevronLeft size={14} aria-hidden="true" />
                    All topics
                  </button>
                  <h3 className="mt-1 px-2 text-[13px] font-medium text-ink">{topic}</h3>
                  <ul className="mt-1">{inTopic.map((entry) => <Row key={entry.slug} entry={entry} />)}</ul>
                </>
              ) : (
                <div className="mt-4">
                  <div className="px-2 text-[12px] text-ink-secondary">or browse:</div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 px-2">
                    {(showAllTopics ? topics : topics.slice(0, 8)).map((item) => (
                      <button key={item.name} type="button" onClick={() => setTopic(item.name)} className="text-[13px] text-ink hover:text-accent">
                        {item.name} <span className="text-ink-secondary">{item.count}</span>
                      </button>
                    ))}
                    {!showAllTopics && topics.length > 8 && (
                      <button type="button" onClick={() => setShowAllTopics(true)} className="text-[13px] text-ink-secondary hover:text-ink">more…</button>
                    )}
                  </div>
                  {!catalog && !loadError && <p className="mt-2 px-2 text-[12px] text-ink-secondary">Loading templates…</p>}
                </div>
              )}
            </div>
          )}
        </div>
        {screen.kind === "choose" && (
          <footer className="flex shrink-0 items-center justify-end gap-4 border-t border-hairline/40 px-5 py-3 text-[12.5px]">
            <button type="button" onClick={onOpenFile} className="text-ink-secondary hover:text-ink">Open a file…</button>
            <button type="button" onClick={onBlank} className="text-ink-secondary hover:text-ink">{kind === "bot" ? "Start blank" : "Pick from my bots"} →</button>
          </footer>
        )}
      </div>
    </div>
  );
}
