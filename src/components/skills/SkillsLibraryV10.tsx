// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings v10 A9-skills (IA v7 section 12): one scrolling list over the whole library, search first, every row opening
// its own sheet. Advanced adds the filters, a ticked-rows bar and the header box, which selects the 60 rows on the page.
// A bulk result reads Saved, Not saved (only from a refusal the computer recorded, with its reason) or Could not check.
import { ChevronRight, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useStore } from "@/state/store";
import {
  bulkSkills, listSkills, newBulkOpId, pairLine, querySkills, refusalOf, SKILL_QUERY_PAGE, undoBulk,
  type BulkOpResult, type BulkTarget, type SkillQueryParams, type SkillQueryResult, type SkillQueryRow, type SkillSummary,
} from "@/lib/skills-api";
import { SkillImportPanel } from "./SkillImportPanel";
import { SkillReader } from "./SkillReader";
import { VerdictBadge } from "./VerdictBadge";
import { usedByLine } from "./SkillsSettings";

type Show = NonNullable<SkillQueryParams["show"]>;
type View = { kind: "list" } | { kind: "read"; ref: string } | { kind: "import" };

/** What the page says about copying from Claude Code (IA v9 section 9.1): true of the importer, which skips an existing name. */
export const CLAUDE_CODE_COPY_NOTE = "These are copies: changing a skill in Claude Code later does not change it here, and does not turn it off. Copying again adds only skills with new names. A copy you already have stays as it is.";

/** The refs the header box selects: the rows on the page, never more than one page (60). */
export function selectPage(refs: readonly string[]): string[] {
  return refs.slice(0, SKILL_QUERY_PAGE);
}

const tab = (active: boolean) => "min-h-9 rounded-lg px-3 text-[12.5px] " + (active ? "bg-accent text-white" : "bg-control text-ink");

/** One request lifecycle: a newer request makes every older answer stale, and an answer whose rid is not the latest is dropped. */
function useSkillQuery(params: SkillQueryParams) {
  const [result, setResult] = useState<SkillQueryResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const latest = useRef(0);
  const key = JSON.stringify(params);
  const run = useCallback(async (append?: SkillQueryResult) => {
    const rid = String(++latest.current);
    setBusy(true);
    try {
      const next = await querySkills({ ...params, rid, ...(append?.next ? { cursor: append.next } : {}) });
      if (next.rid !== String(latest.current)) return;
      setResult(append ? { ...next, rows: [...append.rows, ...next.rows], yours: append.yours } : next);
      setError("");
    } catch (cause) {
      if (rid === String(latest.current)) setError(cause instanceof Error ? cause.message : "Skills couldn't be loaded.");
    } finally {
      if (rid === String(latest.current)) setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the serialised params
  }, [key]);
  useEffect(() => {
    const timer = setTimeout(() => void run(), params.q ? 200 : 0);
    return () => { clearTimeout(timer); ++latest.current; };
  }, [run, params.q]);
  return { result, error, busy, reload: () => void run(), more: () => result && void run(result) };
}

function Row({ skill, advanced, checked, onCheck, onOpen }: { skill: SkillSummary & Partial<SkillQueryRow>; advanced: boolean; checked: boolean; onCheck(ref: string, on: boolean): void; onOpen(ref: string): void }) {
  const flagged = skill.verdict === "review" || skill.verdict === "blocked";
  return (
    <li className="flex items-center gap-2">
      {advanced && <input type="checkbox" checked={checked} onChange={(event) => onCheck(skill.ref, event.target.checked)} aria-label={`Select ${skill.name}`} className="ml-2 size-4 shrink-0" />}
      <button type="button" onClick={() => onOpen(skill.ref)} className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-control">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-ink">{skill.name}{skill.isNew && <span className="ml-2 rounded bg-accent/15 px-1.5 text-[10.5px] text-accent">New</span>}</div>
          <div className="truncate text-[11.5px] text-ink-secondary">{skill.description}</div>
          {skill.updateReady?.length ? <div className="text-[11.5px] text-warning">Update ready for {skill.updateReady.map((bot) => bot.botName).join(", ")}</div> : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-0.5">
          <span className={flagged ? "block" : "hidden sm:block"}><VerdictBadge verdict={skill.verdict} builtIn={skill.kind !== "collection"} /></span>
          {advanced && skill.category && <span className="text-[11px] text-ink-secondary">{skill.category}</span>}
          <span className="text-[11px] text-ink-secondary">{usedByLine(skill)}</span>
        </div>
        <ChevronRight size={14} className="shrink-0 text-ink-secondary" aria-hidden="true" />
      </button>
    </li>
  );
}

/** The answer to one bulk act, pair by pair, with the way back. */
export function BulkResult({ op, busy, onRetry, onUndo, onClose }: { op: BulkOpResult; busy: boolean; onRetry(): void; onUndo(): void; onClose(): void }) {
  const unknown = op.pairs.filter((pair) => pair.state === "unknown").length;
  const changed = op.pairs.filter((pair) => pair.state === (op.on ? "on" : "off")).length;
  return (
    <div role="dialog" aria-label="Bulk result" className="mt-3 rounded-xl bg-card p-4">
      <h3 className="text-[14px] font-medium text-ink">{op.undoOf ? "Undone" : op.on ? "Turned on" : "Turned off"}: {op.pairs.length} {op.pairs.length === 1 ? "choice" : "choices"}</h3>
      <ul className="mt-2 space-y-1 text-[12.5px]">
        {op.pairs.map((pair) => {
          const line = pairLine(pair, op.on);
          return <li key={`${pair.skill}|${pair.botId}`} data-pair-state={line.label}><span className="font-medium text-ink">{pair.skill.slice(pair.skill.indexOf(":") + 1)} · {pair.botName}</span>: <span className={line.label === "Saved" ? "text-ink" : "text-warning"}>{line.label}</span> <span className="text-ink-secondary">{line.detail}</span></li>;
        })}
      </ul>
      <div className="mt-3 flex gap-2">
        {unknown > 0 && <button type="button" disabled={busy} onClick={onRetry} className="min-h-9 rounded-lg bg-accent px-3 text-[12.5px] text-white">Try again</button>}
        {changed > 0 && !op.undoOf && <button type="button" disabled={busy} onClick={onUndo} className="min-h-9 rounded-lg bg-control px-3 text-[12.5px] text-ink">Undo</button>}
        <button type="button" onClick={onClose} className="min-h-9 rounded-lg bg-control px-3 text-[12.5px] text-ink">Done</button>
      </div>
    </div>
  );
}

export function SkillsLibraryV10({ advanced }: { advanced: boolean }) {
  const { state } = useStore();
  const [view, setView] = useState<View>({ kind: "list" });
  const [q, setQ] = useState("");
  const [show, setShow] = useState<Show>("all");
  const [category, setCategory] = useState("");
  const [source, setSource] = useState<NonNullable<SkillQueryParams["source"]>>("");
  const [status, setStatus] = useState<NonNullable<SkillQueryParams["status"]>>("");
  const [sort, setSort] = useState<NonNullable<SkillQueryParams["sort"]>>("name");
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [botIds, setBotIds] = useState<ReadonlySet<string>>(new Set());
  const [bulk, setBulk] = useState<{ op: BulkOpResult | null; busy: boolean; error: string; final?: boolean }>({ op: null, busy: false, error: "" });
  const [bulkOn, setBulkOn] = useState(true);
  /** The act as first sent, kept so a lost reply is retried with the same id and the same choices, never as a second act. */
  const draft = useRef<{ opId: string; on: boolean; skills: string[]; target: BulkTarget; undoOf?: string } | null>(null);
  /** One undo id per operation, so asking Undo again after a lost reply reads the same undo back. */
  const undoIds = useRef(new Map<string, string>());
  const [builtIn, setBuiltIn] = useState<number | null>(null);
  useEffect(() => { void listSkills({ limit: 1 }).then((page) => setBuiltIn(page.builtins?.length ?? 0), () => setBuiltIn(null)); }, []);

  const params = useMemo<SkillQueryParams>(() => ({ q, show, category, ...(advanced ? { source, status, sort } : {}) }), [q, show, category, source, status, sort, advanced]);
  const { result, error, busy, reload, more } = useSkillQuery(params);
  const counts = useSkillQuery(useMemo<SkillQueryParams>(() => ({ show: "onBots" }), []));
  const everything = useSkillQuery(useMemo<SkillQueryParams>(() => ({}), []));
  const bots = state.bots.filter((bot) => !bot.hidden);

  useEffect(() => { setPicked(new Set()); }, [params]);

  if (view.kind === "read") return <SkillReader skillRef={view.ref} mode={{ kind: "settings" }} onBack={() => setView({ kind: "list" })} onChanged={reload} />;
  if (view.kind === "import") return <SkillImportPanel onBack={() => { setView({ kind: "list" }); reload(); }} onOpen={(ref) => { reload(); setView({ kind: "read", ref }); }} />;

  const open = (ref: string) => setView({ kind: "read", ref });
  const rows: Array<SkillSummary & Partial<SkillQueryRow>> = result ? [...result.yours, ...result.rows] : [];
  const pageRefs = selectPage(rows.map((row) => row.ref));
  const headerLabel = rows.length > pageRefs.length ? `Select the first ${pageRefs.length} shown` : `Select all ${pageRefs.length} shown`;
  const allPicked = pageRefs.length > 0 && pageRefs.every((ref) => picked.has(ref));
  const check = (ref: string, on: boolean) => setPicked((current) => { const next = new Set(current); if (on) next.add(ref); else next.delete(ref); return next; });
  const yoursCount = (everything.result?.yours.length ?? 0);
  const allCount = everything.result && builtIn !== null ? everything.result.total + yoursCount + builtIn : null;
  const onBotCount = counts.result ? counts.result.total + counts.result.yours.length : null;

  const apply = async (input: { opId: string; on: boolean; skills: string[]; target: BulkTarget }, undoOf?: string) => {
    setBulk((current) => ({ ...current, busy: true, error: "" }));
    try {
      const { op } = undoOf ? await undoBulk(undoOf, input.opId) : await bulkSkills(input);
      setBulk({ op, busy: false, error: "" });
      reload();
    } catch (cause) {
      // A lost reply is not a refusal: the same act is sent again by its id, so nothing is marked Not saved here. An owner's
      // browser is refused whole, and asking again cannot change that.
      const code = refusalOf(cause).code;
      setBulk((current) => ({ ...current, busy: false, error: cause instanceof Error ? cause.message : "Murage could not check this. Try again.", final: code === "bulk-needs-desktop" }));
    }
  };
  const start = () => {
    draft.current = { opId: newBulkOpId(), on: bulkOn, skills: [...picked].filter((ref) => !ref.startsWith("builtin:")), target: { botIds: [...botIds] } };
    void apply(draft.current);
  };

  return (
    <section aria-labelledby="skills-library-title">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 id="skills-library-title" className="text-[15px] font-medium text-ink">Skills</h2>
          <p className="text-[12.5px] text-ink-secondary">Instructions your bots can follow. Read any skill before you use it.</p>
        </div>
        <button type="button" data-setting-control="skills-settings-title" onClick={() => setView({ kind: "import" })} className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white">Import skill</button>
      </div>
      <p className="mt-2 text-[12px] text-ink-secondary">{CLAUDE_CODE_COPY_NOTE}</p>

      <div className="mt-3 flex items-center gap-2">
        <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-hairline/50 bg-inset px-3">
          <Search size={14} className="text-ink-secondary" aria-hidden="true" />
          <input value={q} onChange={(event) => setQ(event.target.value)} placeholder="Search skills" aria-label="Search skills" className="min-h-10 min-w-0 flex-1 bg-transparent text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none" />
        </label>
        {result && result.facets.length > 0 && (
          <select aria-label="Category" value={category} onChange={(event) => setCategory(event.target.value)} className="min-h-10 rounded-lg bg-control px-2 text-[12.5px] text-ink">
            <option value="">Any category</option>
            {result.facets.map((facet) => <option key={facet.category} value={facet.category}>{facet.category} ({facet.count})</option>)}
          </select>
        )}
      </div>

      <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Show">
        <button type="button" aria-pressed={show === "onBots"} onClick={() => setShow("onBots")} className={tab(show === "onBots")}>On a bot{onBotCount === null ? "" : ` ${onBotCount.toLocaleString("en-US")}`}</button>
        <button type="button" aria-pressed={show === "all"} onClick={() => setShow("all")} className={tab(show === "all")}>All{allCount === null ? "" : ` ${allCount.toLocaleString("en-US")}`}</button>
        <button type="button" aria-pressed={show === "mine"} onClick={() => setShow("mine")} className={tab(show === "mine")}>Yours{everything.result ? ` ${yoursCount}` : ""}</button>
      </div>

      {advanced && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[12.5px]">
          <select aria-label="Source" value={source} onChange={(event) => setSource(event.target.value as typeof source)} className="min-h-9 rounded-lg bg-control px-2 text-ink"><option value="">Any source</option><option value="library">Library</option><option value="yours">Yours</option></select>
          <select aria-label="Status" value={status} onChange={(event) => setStatus(event.target.value as typeof status)} className="min-h-9 rounded-lg bg-control px-2 text-ink"><option value="">Any status</option><option value="clean">Checked, nothing risky found</option><option value="flagged">Needs a look</option><option value="update">Update ready</option></select>
          <select aria-label="Sort" value={sort} onChange={(event) => setSort(event.target.value as typeof sort)} className="min-h-9 rounded-lg bg-control px-2 text-ink"><option value="name">Name</option><option value="newest">Newest</option></select>
          <label className="ml-auto flex items-center gap-2 text-ink-secondary">
            <input type="checkbox" checked={allPicked} disabled={!pageRefs.length} onChange={(event) => setPicked(event.target.checked ? new Set(pageRefs) : new Set())} aria-label={headerLabel} className="size-4" />
            {headerLabel}
          </label>
        </div>
      )}

      {advanced && picked.size > 0 && (
        <div role="region" aria-label="Selected skills" className="mt-2 rounded-xl bg-card p-3 text-[12.5px]">
          <div className="font-medium text-ink">{picked.size} selected</div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
            {bots.map((bot) => (
              <label key={bot.id} className="flex items-center gap-1.5 text-ink">
                <input type="checkbox" aria-label={bot.name} checked={botIds.has(bot.id)} onChange={(event) => setBotIds((current) => { const next = new Set(current); if (event.target.checked) next.add(bot.id); else next.delete(bot.id); return next; })} className="size-4" />
                {bot.name}
              </label>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <button type="button" aria-pressed={bulkOn} onClick={() => setBulkOn(true)} className={tab(bulkOn)}>Turn on</button>
            <button type="button" aria-pressed={!bulkOn} onClick={() => setBulkOn(false)} className={tab(!bulkOn)}>Turn off</button>
            <button type="button" disabled={!botIds.size || bulk.busy} onClick={start} className="min-h-9 rounded-lg bg-accent px-3 text-white disabled:opacity-40">Apply to {botIds.size} {botIds.size === 1 ? "bot" : "bots"}</button>
          </div>
        </div>
      )}
      {bulk.error && <div role="alert" className="mt-2 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger"><p>{bulk.error}</p>{!bulk.final && draft.current && <button type="button" onClick={() => void apply(draft.current!, draft.current!.undoOf)} className="mt-2 min-h-9 rounded-lg bg-control px-3 text-ink">Try again</button>}</div>}
      {bulk.op && (
        <BulkResult op={bulk.op} busy={bulk.busy}
          onRetry={() => void apply({ opId: bulk.op!.opId, on: bulk.op!.on, skills: bulk.op!.skills, target: bulk.op!.target ?? { botIds: [...new Set(bulk.op!.pairs.map((pair) => pair.botId))] } }, bulk.op!.undoOf)}
          onUndo={() => {
            const opId = bulk.op!.opId;
            if (!undoIds.current.has(opId)) undoIds.current.set(opId, newBulkOpId());
            draft.current = { opId: undoIds.current.get(opId)!, on: !bulk.op!.on, skills: bulk.op!.skills, target: {}, undoOf: opId };
            void apply(draft.current, opId);
          }}
          onClose={() => setBulk({ op: null, busy: false, error: "" })} />
      )}

      {error && <div role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger"><p>{error}</p><button type="button" onClick={reload} className="mt-2 min-h-11 rounded-lg bg-control px-3 text-ink">Try again</button></div>}
      {!result && !error && <p className="mt-3 text-[12px] text-ink-secondary">Loading…</p>}
      {result && !error && (
        <>
          <p role="status" className="mt-3 px-2 text-[11.5px] text-ink-secondary">{(result.total + result.yours.length).toLocaleString("en-US")} {result.total + result.yours.length === 1 ? "skill" : "skills"}{show === "all" && !q.trim() && !category && !status && !source && builtIn ? ` · ${builtIn} built in, with no switch` : ""}{busy ? " · loading…" : ""}</p>
          {rows.length ? (
            <ul className="mt-1">{rows.map((row) => <Row key={row.ref} skill={row} advanced={advanced} checked={picked.has(row.ref)} onCheck={check} onOpen={open} />)}</ul>
          ) : (
            <p className="mt-1 px-2 text-[12px] text-ink-secondary">
              {result.widen ? <>Nothing here for “{q.trim()}”. {result.widen.all.toLocaleString("en-US")} in the whole library. <button type="button" className="underline" onClick={() => { setShow("all"); setCategory(""); setSource(""); setStatus(""); }}>Search all</button></> : q.trim() ? `No skills match “${q.trim()}”.` : "No skills here yet."}
            </p>
          )}
          {result.next && <button type="button" disabled={busy} onClick={more} className="mt-2 w-full rounded-lg bg-inset px-3 py-2 text-[12px] text-ink-secondary hover:bg-control hover:text-ink">Show the next {SKILL_QUERY_PAGE}</button>}
        </>
      )}
    </section>
  );
}
