// J0 Changed-recently journal (C12).
// Owner: lane core (Settings v10 BUILD-PLAN §3). One receipt per change, keyed by the caller's changeId and written by the
// process that commits the change. The file lives on this desktop only; the phone is refused. Values are recorded only where
// the writer table says "values"; a key, a token or an operation argument is never written.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { JOURNAL_RETENTION_DAYS, type JournalLookup, type JournalRow, type JournalWrite } from "../../shared/settings-v10/journal.ts";
import { writeFileAtomic } from "../atomic.ts";
import type { SettingsV10Deps, SettingsV10Router } from "./v10-router.ts";

/** What a writer's row may carry: "values" keeps before/after; "changed" says only that it changed; "presence" never carries a value. */
export type JournalValueMode = "values" | "changed" | "presence";
export interface JournalWriter { source: string; value: JournalValueMode }

/** The writer table (TASKS-v7 J0). Memory actions and window-only settings are deliberately absent: a writer missing here is refused. */
export const JOURNAL_WRITERS: Readonly<Record<string, JournalWriter>> = {
  "bot.patch": { source: "SV0, in the bot write", value: "values" },
  "bot.purpose": { source: "SV0, in the bot write", value: "changed" },
  "bot.model": { source: "SV0, in the bot write", value: "values" },
  "murage.repair": { source: "SV0, in the same roster save", value: "values" },
  "level.change": { source: "SV0, in the staged level write", value: "values" },
  "access.commit": { source: "AC1, in the policy commit", value: "values" },
  "tools.toggle": { source: "SV0", value: "values" },
  "provider.key": { source: "SV0", value: "presence" },
  "device.setting": { source: "P1, when the companion commits", value: "values" },
  "host.setting": { source: "HB, when the host call returns committed", value: "values" },
  "host.folder": { source: "HB, when the host call returns committed", value: "changed" },
  "messaging.setting": { source: "G3", value: "values" },
  "owner.setting": { source: "SV0", value: "values" },
  "skills.toggle": { source: "K5's route", value: "values" },
};

const FILE = "settings-journal.json";
export const journalFile = (dataDir: string): string => join(dataDir, FILE);
const DAY_MS = 86_400_000;
const MAX_ROWS = 5_000;
const MAX_REFUSALS = 2_000;

interface Stored { next: number; rows: Array<JournalRow & { seq: number }>; refusals: Array<{ changeId: string; at: number }> }

export interface Journal {
  /** Upsert by changeId (a retry or a replay is one row). Throws for a writer missing from the table. */
  write(input: JournalWrite): JournalRow;
  /** The writer proved it did not commit: the only way a lookup answers notSaved. */
  refused(changeId: string): void;
  /** Rows after a cursor (0 = from the start) and the cursor to pass next time. */
  list(after: number): { rows: JournalRow[]; cursor: number };
  lookup(changeId: string): JournalLookup;
}

export function openJournal(dataDir: string, now: () => number = Date.now): Journal {
  const path = journalFile(dataDir);
  const load = (): Stored => {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Stored;
      if (parsed && Array.isArray(parsed.rows) && Array.isArray(parsed.refusals) && Number.isSafeInteger(parsed.next)) return parsed;
    } catch { /* absent or unreadable: start empty, so a lookup says could not check */ }
    return { next: 1, rows: [], refusals: [] };
  };
  const save = (state: Stored): void => {
    const cutoff = now() - JOURNAL_RETENTION_DAYS * DAY_MS;
    state.rows = state.rows.filter((row) => row.at >= cutoff).slice(-MAX_ROWS);
    state.refusals = state.refusals.filter((item) => item.at >= cutoff).slice(-MAX_REFUSALS);
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
    writeFileAtomic(path, JSON.stringify(state));
  };
  const strip = ({ seq: _seq, ...row }: JournalRow & { seq: number }): JournalRow => row;
  const live = (state: Stored): Stored => {
    const cutoff = now() - JOURNAL_RETENTION_DAYS * DAY_MS;
    return { ...state, rows: state.rows.filter((row) => row.at >= cutoff), refusals: state.refusals.filter((item) => item.at >= cutoff) };
  };
  return {
    write(input) {
      const writer = Object.hasOwn(JOURNAL_WRITERS, input.writer) ? JOURNAL_WRITERS[input.writer] : undefined;
      if (!writer) throw new Error(`journal writer not in the table: ${input.writer}`);
      if (!input.changeId) throw new Error("journal write needs a changeId");
      const state = load();
      const keep = writer.value === "values";
      const row: JournalRow = {
        changeId: input.changeId, actor: input.actor, writer: input.writer, settingId: input.settingId,
        ...(input.bot ? { bot: input.bot } : {}),
        ...(keep && input.before !== undefined ? { before: input.before } : {}),
        ...(keep && input.after !== undefined ? { after: input.after } : {}),
        at: now(),
      };
      const at = state.rows.findIndex((existing) => existing.changeId === input.changeId);
      if (at >= 0) state.rows[at] = { ...row, at: state.rows[at].at, seq: state.rows[at].seq };
      else state.rows.push({ ...row, seq: state.next++ });
      state.refusals = state.refusals.filter((item) => item.changeId !== input.changeId);
      save(state);
      return row;
    },
    refused(changeId) {
      const state = load();
      if (state.rows.some((row) => row.changeId === changeId)) return;
      if (!state.refusals.some((item) => item.changeId === changeId)) state.refusals.push({ changeId, at: now() });
      save(state);
    },
    list(after) {
      const rows = live(load()).rows.filter((row) => row.seq > after).sort((a, b) => a.seq - b.seq);
      return { rows: rows.map(strip), cursor: rows.length ? rows[rows.length - 1].seq : after };
    },
    lookup(changeId) {
      const state = live(load());
      const row = state.rows.find((item) => item.changeId === changeId);
      if (row) return { state: "saved", row: strip(row) };
      return state.refusals.some((item) => item.changeId === changeId) ? { state: "notSaved" } : { state: "couldNotCheck" };
    },
  };
}

export function registerJournalRoutes(router: SettingsV10Router, deps: Pick<SettingsV10Deps, "dataDir">): void {
  const journal = openJournal(deps.dataDir);
  router.add("core", async ({ method, path, url, req, res, json, readBody, surface, ownersComputer }) => {
    if (path !== "/api/settings/journal" && path !== "/api/settings/journal/lookup" && path !== "/api/settings/journal/refused") return false;
    if (surface !== "desktop" || ownersComputer === false) { json(res, 403, { error: "The change history is kept on the desktop." }); return true; }
    if (path === "/api/settings/journal" && method === "GET") {
      const after = Number(url.searchParams.get("after") ?? 0);
      json(res, 200, journal.list(Number.isSafeInteger(after) && after > 0 ? after : 0));
      return true;
    }
    if (path === "/api/settings/journal/lookup" && method === "GET") {
      const changeId = url.searchParams.get("changeId") ?? "";
      if (!changeId) { json(res, 400, { error: "changeId is required" }); return true; }
      json(res, 200, journal.lookup(changeId));
      return true;
    }
    if (method !== "POST") { json(res, 405, { error: "method not allowed" }); return true; }
    const body = await readBody(req);
    const text = (value: unknown) => (typeof value === "string" && value.length > 0 && value.length <= 200 ? value : "");
    const changeId = text(body?.changeId);
    if (!changeId) { json(res, 400, { error: "changeId is required" }); return true; }
    if (path === "/api/settings/journal/refused") { journal.refused(changeId); json(res, 200, { ok: true }); return true; }
    const writer = text(body?.writer);
    const settingId = text(body?.settingId);
    if (!settingId || !Object.hasOwn(JOURNAL_WRITERS, writer)) { json(res, 400, { error: "unknown writer or setting" }); return true; }
    // the actor is the authenticated window's owner; whatever the body says is ignored
    const row = journal.write({ changeId, actor: { kind: "owner" }, writer, settingId, ...(text(body?.bot) ? { bot: text(body.bot) } : {}), before: body?.before, after: body?.after });
    json(res, 200, { ok: true, at: row.at });
    return true;
  });
}
