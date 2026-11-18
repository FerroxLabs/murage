// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "Add a skill", inside the bot's own window: search Your skills and the
// library, read one, and Add it. Rendered in place (never a separate layer,
// which is what hid the old library behind the bot window).
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { useState } from "react";

import { SkillReader } from "./SkillReader";
import { SkillPageControls } from "./SkillPageControls";
import { useSkillsBrowser } from "./useSkillsBrowser";
import { topicLabel, TopicSelect } from "./TopicSelect";
import { VerdictBadge } from "./VerdictBadge";
import type { SkillSummary } from "@/lib/skills-api";

function Row({ skill, botId, onOpen }: { skill: SkillSummary; botId: string; onOpen(ref: string): void }) {
  const added = skill.usedBy.some((use) => use.botId === botId && use.enabled);
  return (
    <li>
      <button type="button" onClick={() => onOpen(skill.ref)} className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-control">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-ink">{skill.name}</div>
          <div className="truncate text-[11.5px] text-ink-secondary">{skill.description}</div>
        </div>
        {added ? <span className="shrink-0 text-[11.5px] text-success">Added</span> : <VerdictBadge verdict={skill.verdict} builtIn={skill.kind !== "collection"} className="shrink-0" />}
        <ChevronRight size={14} className="shrink-0 text-ink-secondary" aria-hidden="true" />
      </button>
    </li>
  );
}

export function SkillPicker({ botId, botName, onDone }: { botId: string; botName: string; onDone(): void }) {
  const { query, category, page, error, busy, setQuery, setCategory, goToPage, load } = useSkillsBrowser();
  const [reading, setReading] = useState<string | null>(null);

  if (reading) return <SkillReader skillRef={reading} mode={{ kind: "bot", botId }} onBack={() => setReading(null)} onChanged={() => void load()} />;

  const searching = Boolean(query.trim() || category);
  const open = (ref: string) => setReading(ref);
  return (
    <div className="mt-1">
      <button type="button" onClick={onDone} className="-ml-1.5 flex items-center gap-1 rounded px-1.5 py-1 text-[12px] text-ink-secondary hover:bg-control hover:text-ink">
        <ChevronLeft size={14} aria-hidden="true" />
        {botName}'s skills
      </button>
      <h3 className="mt-2 text-[14px] font-medium text-ink">Add a skill to {botName}</h3>
      <div className="mt-2 flex items-center gap-2">
        <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-hairline/50 bg-inset px-3">
          <Search size={14} className="text-ink-secondary" aria-hidden="true" />
          <input
            autoFocus
            value={query}
            onChange={(event) => { setQuery(event.target.value); }}
            placeholder={category ? "Search in " + topicLabel(category) : "What should it know how to do?"}
            aria-label="Search skills to add"
            className="min-h-10 min-w-0 flex-1 bg-transparent text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
          />
        </label>
        {page && page.libraryReady && page.categories.length > 0 && (
          <TopicSelect topics={page.categories} value={category} onChange={setCategory} />
        )}
      </div>
      {error && <div role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger"><p>{error}</p><button type="button" onClick={() => void load()} className="mt-2 min-h-11 rounded-lg bg-control px-3 text-ink">Try again</button></div>}
      {!page && !error && <p className="mt-3 text-[12px] text-ink-secondary">Loading…</p>}
      {busy && page && <p role="status" className="mt-3 text-[12px] text-ink-secondary">Loading skills…</p>}
      {page && !error && (
        <>
          {!busy && <>
            {page.yours.length > 0 && (
              <>
                <h4 className="mt-3 px-2 text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary">Your skills</h4>
                <ul className="mt-1">{page.yours.map((skill) => <Row key={skill.ref} skill={skill} botId={botId} onOpen={open} />)}</ul>
              </>
            )}
            <h4 className="mt-3 px-2 text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary">Library</h4>
            {!page.libraryReady ? (
              <p className="mt-1 px-2 text-[12px] text-ink-secondary">The library is still loading.</p>
            ) : !searching ? (
              <p className="mt-1 px-2 text-[12px] text-ink-secondary">Search, or choose a topic.</p>
            ) : page.library.length ? (
              <ul className="mt-1">{page.library.map((skill) => <Row key={skill.ref} skill={skill} botId={botId} onOpen={open} />)}</ul>
            ) : (
              <p className="mt-1 px-2 text-[12px] text-ink-secondary">No skills match “{query.trim() || topicLabel(category)}”.</p>
            )}
          </>}
          {searching && page.libraryReady && <SkillPageControls page={page.pagination} busy={busy} onPage={goToPage} />}
        </>
      )}
    </div>
  );
}
