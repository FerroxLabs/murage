// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings → Skills: every skill in one place. Search first; Your skills,
// then the library; click one to read it and choose which bots use it.
import { ChevronRight, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { SkillImportPanel } from "./SkillImportPanel";
import { SkillReader } from "./SkillReader";
import { topicLabel, TopicSelect } from "./TopicSelect";
import { VerdictBadge } from "./VerdictBadge";
import { listSkills, type SkillSummary, type SkillsPage } from "@/lib/skills-api";

type View = { kind: "list" } | { kind: "read"; ref: string } | { kind: "import" };

export function usedByLine(skill: Pick<SkillSummary, "usedBy">): string {
  const on = skill.usedBy.filter((use) => use.enabled).map((use) => use.botName);
  return on.length ? `Used by ${on.join(", ")}` : "Not used yet";
}

function SkillRow({ skill, onOpen }: { skill: SkillSummary; onOpen(ref: string): void }) {
  return (
    <li>
      <button type="button" onClick={() => onOpen(skill.ref)} className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-control">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-ink">{skill.name}</div>
          <div className="truncate text-[11.5px] text-ink-secondary">{skill.description}</div>
        </div>
        <div className="hidden shrink-0 flex-col items-end gap-0.5 sm:flex">
          <VerdictBadge verdict={skill.verdict} />
          <span className="text-[11px] text-ink-secondary">{usedByLine(skill)}</span>
        </div>
        <ChevronRight size={14} className="shrink-0 text-ink-secondary" aria-hidden="true" />
      </button>
    </li>
  );
}

export function SkillsSettings() {
  const [view, setView] = useState<View>({ kind: "list" });
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [page, setPage] = useState<SkillsPage | null>(null);
  const [error, setError] = useState("");
  const generation = useRef(0);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const next = await listSkills({ q: query, category });
      if (mine === generation.current) {
        setPage(next);
        setError("");
      }
    } catch (cause) {
      if (mine === generation.current) setError(cause instanceof Error ? cause.message : "Skills couldn't be loaded.");
    }
  }, [query, category]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), query ? 200 : 0);
    return () => clearTimeout(timer);
  }, [load, query]);

  if (view.kind === "read") {
    return <SkillReader skillRef={view.ref} mode={{ kind: "settings" }} onBack={() => setView({ kind: "list" })} onChanged={() => void load()} />;
  }
  if (view.kind === "import") {
    return <SkillImportPanel onBack={() => { setView({ kind: "list" }); void load(); }} onOpen={(ref) => { void load(); setView({ kind: "read", ref }); }} />;
  }

  const searching = Boolean(query.trim() || category);
  return (
    <section aria-labelledby="skills-settings-title">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 id="skills-settings-title" className="text-[15px] font-medium text-ink">Skills</h2>
          <p className="text-[12.5px] text-ink-secondary">Instructions your bots can follow. Read any skill before you use it.</p>
        </div>
        <button type="button" onClick={() => setView({ kind: "import" })} className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white">Import skill</button>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-hairline/50 bg-inset px-3">
          <Search size={14} className="text-ink-secondary" aria-hidden="true" />
          <input
            autoFocus
            value={query}
            onChange={(event) => { setQuery(event.target.value); setCategory(""); }}
            placeholder="Search skills"
            aria-label="Search skills"
            className="min-h-10 min-w-0 flex-1 bg-transparent text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
          />
        </label>
        {page && page.libraryReady && page.categories.length > 0 && (
          <TopicSelect topics={page.categories} value={category} onChange={(topic) => { setCategory(topic); setQuery(""); }} />
        )}
      </div>

      {error && <div role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}
      {!page && !error && <p className="mt-3 text-[12px] text-ink-secondary">Loading…</p>}

      {page && (
        <>
          <h3 className="mt-4 px-2 text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary">Your skills</h3>
          {page.yours.length ? (
            <ul className="mt-1">{page.yours.map((skill) => <SkillRow key={skill.ref} skill={skill} onOpen={(ref) => setView({ kind: "read", ref })} />)}</ul>
          ) : (
            <p className="mt-1 px-2 text-[12px] text-ink-secondary">{searching ? `None of your skills match “${query.trim() || topicLabel(category)}”.` : "None yet. Import a skill, or switch on one from the library for a bot."}</p>
          )}

          <h3 className="mt-4 px-2 text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary">Library</h3>
          {!page.libraryReady ? (
            <p className="mt-1 px-2 text-[12px] text-ink-secondary">The library is still loading.</p>
          ) : !searching ? (
            <p className="mt-1 px-2 text-[12px] text-ink-secondary">Search, or choose a topic.</p>
          ) : page.library.length ? (
            <ul className="mt-1">{page.library.map((skill) => <SkillRow key={skill.ref} skill={skill} onOpen={(ref) => setView({ kind: "read", ref })} />)}</ul>
          ) : (
            <p className="mt-1 px-2 text-[12px] text-ink-secondary">No skills match “{query.trim() || topicLabel(category)}”.</p>
          )}
        </>
      )}
    </section>
  );
}
