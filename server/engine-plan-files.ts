// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Planners for the three engines whose files Murage maps most closely: Fuigo and Grok (sessions, search index, shared log,
// memory), Claude Code (projects, history, paste cache, per-session side files) and Codex (rollouts, history, snapshots,
// SQLite stores). Each is the engine's removal body with every write replaced by a step; the keys, ownership checks and SQL
// predicates are unchanged. No fs, no sqlite, no try: reads go through `pl.fs` only.
import { claudeProjectKey, fuigoMemoryKey, fuigoSessionKey } from "./engine-keys.ts";
import { ASIDE_SUFFIX, DEFAULT_PRAGMAS, pathApiFor, rolloutEvidence, sameFolder, slugsReferenced, type Planner, type SqlStatement } from "./engine-plan-core.ts";

const ID = /^[\w-]+$/;
const FIRST_LINE_BYTES = 1024 * 1024;
const marks = (values: readonly unknown[]) => values.map(() => "?").join(",");

/** Fuigo and Grok: `<home>/sessions/<key>` for each folder, the lines those sessions wrote to the shared
 * `logs/unified.jsonl` (keyed `sid`), and the folder's memory notes when the folder is outside any repository. */
export function planFuigoSessions(pl: Planner, home: string, folders: string[], memoryFolders: string[]): void {
  const api = pathApiFor(home);
  const sessions = api.join(home, "sessions");
  const sessionIds = pl.facts.get("sessionIds");
  for (const folder of folders) {
    const dir = api.join(sessions, fuigoSessionKey(folder));
    // The folder and its aside (a crash can leave one): every session id in either is an id this removal owes.
    const names = pl.namesWithAside(dir);
    for (const name of names) {
      if (pl.fs.lstat(api.join(dir, name))?.isDirectory() || pl.fs.lstat(api.join(`${dir}${ASIDE_SUFFIX}`, name))?.isDirectory()) sessionIds.add(name);
    }
    // Moved aside and listed again when it runs: a session that appeared since is a change, not a folder to delete unseen.
    pl.removeListed(sessions, dir, names);
  }
  // Fuigo's session search index keeps each session's title and text (0.1.60 Linux D5: the conversation's words were still
  // in it after delete): rows by session id, and by the conversation's own folder in case a session directory was already gone.
  // session_docs holds the text; session_docs_fts is an FTS5 index over it kept by triggers, whose deletes only add markers,
  // so the index is merged to drop the old terms. The log is checkpointed so the text leaves the -wal file too, and the file
  // is vacuumed for the copies Fuigo's own rewrites left in free pages.
  const index = api.join(sessions, "session_search.sqlite");
  const ids = [...sessionIds], cwds = [...new Set(folders)];
  if (ids.length || cwds.length) {
    pl.fs.withDb(index, (db) => {
      const tables = new Set(db.all("SELECT name FROM sqlite_master WHERE type IN ('table','view')").map((row) => String(row.name)));
      if (!tables.has("session_docs")) return;
      const where = [ids.length ? `session_id IN (${marks(ids)})` : "", cwds.length ? `cwd IN (${marks(cwds)})` : ""].filter(Boolean).join(" OR ");
      const params = [...ids, ...cwds];
      const stmts: SqlStatement[] = [{ table: "session_docs", where, params }];
      pl.sqlDelete(index, { stmts, changed: pl.count(db, "session_docs", where, params) });
      // Every scrub merges the index, not only one that deleted rows: a conversation deleted before this fix left its terms in old segments.
      if (tables.has("session_docs_fts")) pl.push({ k: "ftsOptimize", cls: "hygiene", group: index, db: index });
      pl.push({ k: "checkpoint", cls: pl.facts.get("dirtyDbs").has(index) ? "content" : "hygiene", group: index, db: index });
      pl.push({ k: "vacuumIfFree", cls: "hygiene", group: index, db: index });
    });
  }
  if (sessionIds.size) {
    const values = [...sessionIds];
    pl.rewrite(api.join(home, "logs", "unified.jsonl"), { pred: { any: [{ field: "sid", op: "in", values }] }, needles: values, format: "fuigo-unified", how: "lock" });
  }
  const memory = api.join(home, "memory");
  for (const folder of new Set(memoryFolders)) pl.remove(memory, api.join(memory, fuigoMemoryKey(folder)));
}

/** Claude Code: the folder's `projects/<key>` (sessions, subagents, tool results), the sessions' lines in `history.jsonl` and
 * the paste cache only they used, and every per-session side file (Claude Code 2.1.282: file history, debug log, tasks,
 * session env, image cache, uploads, plans).
 *
 * Ownership is decided NOW, from what each project folder holds, and a current conflict always wins over anything an earlier
 * run saved: a folder with a session file that names another working folder is kept whole, and only the session files that
 * each independently name this conversation's folder (and nothing else) are removed from it. A clean folder is removed by
 * listing (engine-exec.ts), with each session file's association fingerprint carried so a file that gained a name since is kept. */
export function planClaudeProjects(pl: Planner, home: string, folders: string[], supplied: readonly string[] = []): void {
  const api = pathApiFor(home);
  const projects = api.join(home, "projects");
  const sessionIds = pl.facts.get("sessionIds");
  // the conversation's own Claude session ids, as Murage recorded them: they name its history rows and side files even when its
  // transcripts (and the project folder that held them) are already gone
  for (const id of supplied) if (ID.test(id)) sessionIds.add(id);
  const slugs = pl.facts.get("slugs");
  const projectNames = pl.facts.get("projects");
  const pastes = pl.facts.get("pastes");
  const ours = (cwd: string) => folders.some((folder) => sameFolder(folder, cwd));
  // Every folder that may be this conversation's: by key, plus the names an earlier run saved, each with its aside (a crash can
  // leave one). Value: whether the folder must name one of our folders (a cut, lossy key).
  const candidates = new Map<string, boolean>();
  const exact = new Set<string>();
  for (const folder of folders) {
    const key = claudeProjectKey(folder);
    const names = "exact" in key ? [key.exact, `${key.exact}${ASIDE_SUFFIX}`] : pl.fs.readdir(projects).filter((name) => name.startsWith(key.prefix));
    for (const name of names) {
      candidates.set(name, (candidates.get(name) ?? false) || "prefix" in key);
      if ("exact" in key) exact.add(name);
    }
  }
  for (const base of projectNames) for (const name of [base, `${base}${ASIDE_SUFFIX}`]) if (!candidates.has(name)) candidates.set(name, false);
  interface Found { name: string; dir: string; files: string[]; sessions: Array<{ file: string; id: string; cwds: string[]; slugs: string[]; fp: string }>; conflict: boolean }
  const byBase = new Map<string, Found[]>();
  for (const [name, mustName] of candidates) {
    const dir = api.join(projects, name);
    if (!pl.fs.lstat(dir)) continue;
    const base = name.endsWith(ASIDE_SUFFIX) ? name.slice(0, -ASIDE_SUFFIX.length) : name;
    const files = pl.fs.readdir(dir);
    const sessions: Found["sessions"] = [];
    for (const file of files) {
      // Every physical transcript is read and judged on its own, the original and a copy of it a crash left aside alike: neither
      // stands in for the other, so what one names (a plan slug, another working folder) is never lost behind the other.
      const plain = file.endsWith(ASIDE_SUFFIX) ? file.slice(0, -ASIDE_SUFFIX.length) : file;
      if (!plain.endsWith(".jsonl")) continue;
      const found = pl.associationsOf(api.join(dir, file), folders);
      sessions.push({ file, id: plain.slice(0, -".jsonl".length), ...found });
    }
    // A lossy key: another folder can share it. Keep the folder whole when any session inside names another folder (and, for
    // the cut long form, unless at least one names this conversation's).
    const cwds = sessions.flatMap((session) => session.cwds);
    const conflict = cwds.some((cwd) => !ours(cwd)) || (mustName && !cwds.some(ours));
    const list = byBase.get(base) ?? [];
    list.push({ name, dir, files, sessions, conflict });
    byBase.set(base, list);
  }
  const listed = new Map<string, { names: Set<string>; assoc: Record<string, string> }>();
  // the transcripts this plan removes (physical paths): every other transcript in `projects` may share a plan slug with them
  const removedTranscripts = new Set<string>();
  for (const [base, dirs] of byBase) {
    if (dirs.some((item) => item.conflict)) {
      // The current conflict wins over the saved name. Only a session file that names this conversation's folder and nothing
      // else is ours; its transcript and its folder of subagent files go, and everything else stays.
      projectNames.delete(base);
      for (const item of dirs) {
        if (exact.has(item.name) && !item.name.endsWith(ASIDE_SUFFIX) && item.conflict) pl.leftovers.push({ what: "Claude Code's history of this conversation", where: "Claude Code's project history, filed under a name another folder shares" });
        const idDirs = new Set<string>();
        for (const session of item.sessions) {
          if (!session.cwds.length || !session.cwds.every(ours)) continue;
          if (ID.test(session.id)) sessionIds.add(session.id);
          for (const slug of session.slugs) if (ID.test(slug)) slugs.add(slug);
          pl.removeExact(projects, api.join(item.dir, session.file), session.fp);
          removedTranscripts.add(api.join(item.dir, session.file));
          if ((item.files.includes(session.id) || item.files.includes(`${session.id}${ASIDE_SUFFIX}`)) && !idDirs.has(session.id)) {
            idDirs.add(session.id);
            pl.remove(projects, api.join(item.dir, session.id));
          }
        }
      }
      continue;
    }
    projectNames.add(base);
    const names = new Set<string>(), assoc: Record<string, string> = {};
    for (const item of dirs) {
      for (const file of item.files) names.add(file);
      // keyed by the physical name; those of a folder's aside carry the aside marker (the executor judges that folder first, on its own)
      const prefix = item.name.endsWith(ASIDE_SUFFIX) ? `${ASIDE_SUFFIX}/` : "";
      for (const session of item.sessions) {
        assoc[`${prefix}${session.file}`] = session.fp;
        removedTranscripts.add(api.join(item.dir, session.file));
        if (ID.test(session.id)) sessionIds.add(session.id);
        for (const slug of session.slugs) if (ID.test(slug)) slugs.add(slug);
      }
    }
    listed.set(base, { names, assoc });
  }
  // The history is read even when no project folder and no session id is left: a row names its folder itself (`project`), so a
  // conversation whose transcripts went earlier still has its prompts found and cleared.
  // The history lines and their pasted-content hashes are found before the project goes (a retry may no longer see them).
  const history = api.join(home, "history.jsonl");
  const { remaining } = pl.rewrite(history, {
    pred: { any: [{ field: "sessionId", op: "in", values: [...sessionIds] }, { field: "project", op: "sameFolder", values: folders }] },
    needles: [...folders, ...sessionIds],
    format: "claude-history",
    how: "dirlock",
    collectPastes: true,
  });
  // The history is rewritten FIRST, then the project folders go, then the pasted texts: a Claude started in the middle of the run
  // cannot list a session whose row is still in the history while its folder is being removed.
  for (const name of projectNames) {
    const dir = api.join(projects, name);
    const found = listed.get(name);
    pl.removeListed(projects, dir, [...(found?.names ?? [])], { assoc: found?.assoc });
  }
  // A pasted text stays while any line that remains still uses it.
  for (const hash of pastes) {
    if (remaining.includes(hash)) continue;
    const dir = api.join(home, "paste-cache");
    const file = api.join(dir, `${hash}.txt`);
    if (pl.fs.lstat(file) === null && pl.fs.lstat(`${file}${ASIDE_SUFFIX}`) === null) continue;
    pl.push({ k: "removeUnlessReferenced", cls: "content", group: history, root: dir, target: file, refFile: history, needle: hash });
  }
  for (const id of sessionIds) {
    for (const [dir, name] of [["file-history", id], ["debug", `${id}.txt`], ["tasks", id], ["session-env", id], ["image-cache", id], ["uploads", id]] as const) {
      pl.remove(api.join(home, dir), api.join(home, dir, name));
    }
  }
  const latest = api.join(home, "debug", "latest");
  if (pl.fs.lstat(latest)?.isSymbolicLink()) {
    const target = pl.fs.readlink(latest);
    const suffixes = [...sessionIds].map((id) => `${id}.txt`);
    if (suffixes.some((suffix) => target.endsWith(suffix))) pl.push({ k: "unlinkIfLinkTo", cls: "content", path: latest, suffixes });
  }
  // A plan file belongs to its slug, and a slug can be carried by more than one session (a session forked or resumed from another
  // folder, a collision in Claude Code's own slug names): a plan file goes only when no transcript that stays names one of its slugs,
  // read now from the parsed rows, and read again when the step runs (the step's `slugRefs`). Anything that cannot be told keeps it.
  const plans = api.join(home, "plans");
  const planNames = pl.fs.readdir(plans);
  const plainOf = (name: string) => (name.endsWith(ASIDE_SUFFIX) ? name.slice(0, -ASIDE_SUFFIX.length) : name);
  const slugsOf = (name: string) => [...slugs].filter((slug) => ID.test(slug) && (plainOf(name) === `${slug}.md` || plainOf(name) === `${slug}.workshop.md` || (plainOf(name).startsWith(`${slug}-agent-`) && plainOf(name).endsWith(".md"))));
  const asked = [...new Set(planNames.flatMap(slugsOf))];
  const elsewhere = asked.length ? slugsReferenced(pl.fs, projects, asked, removedTranscripts) : new Set<string>();
  for (const name of planNames) {
    // a plan file a crash left aside is the same plan: removed as a file of its own
    const named = slugsOf(name);
    if (!named.length || named.some((slug) => elsewhere.has(slug))) continue;
    if (pl.fs.lstat(api.join(plans, name)) === null) continue;
    pl.push({ k: "remove", cls: "content", root: plans, target: api.join(plans, name), slugRefs: { projects, slugs: named } });
  }
}

/** Codex: rollout files (sessions/YYYY/MM/DD and archived_sessions) whose first line (`session_meta`) names the folder; then,
 * by those thread ids, the lines in history.jsonl and session_index.jsonl, shell snapshots, and the rows in its SQLite stores
 * (state, logs, memories, goals, history). */
export function planCodexRollouts(pl: Planner, home: string, folders: string[], sqliteHome?: string): void {
  const api = pathApiFor(home);
  const candidates: string[] = [];
  const sessions = api.join(home, "sessions");
  for (const year of pl.fs.readdir(sessions).filter((name) => /^\d{4}$/.test(name)))
    for (const month of pl.fs.readdir(api.join(sessions, year)).filter((name) => /^\d{2}$/.test(name)))
      for (const day of pl.fs.readdir(api.join(sessions, year, month)).filter((name) => /^\d{2}$/.test(name)))
        for (const file of pl.fs.readdir(api.join(sessions, year, month, day))) candidates.push(api.join(sessions, year, month, day, file));
  const archived = api.join(home, "archived_sessions");
  for (const file of pl.fs.readdir(archived)) candidates.push(api.join(archived, file));
  // A rollout a crash left aside (its recovery name) is a file of its own: found, read and judged on its own first line, before
  // any filter on the name, and removed as itself; the original of the same name is another file with its own step.
  candidates.sort((x, y) => Number(!x.endsWith(ASIDE_SUFFIX)) - Number(!y.endsWith(ASIDE_SUFFIX)));
  // The thread ids are what the rest of the cleanup is keyed by; they are saved with the plan so a retry still has them.
  const threadIds = pl.facts.get("threadIds");
  const fromRollouts = new Set<string>();
  for (const file of candidates) {
    const name = api.basename(file);
    const plain = name.endsWith(ASIDE_SUFFIX) ? name.slice(0, -ASIDE_SUFFIX.length) : name;
    if (!/^rollout-.+\.jsonl(\.zst)?$/.test(plain)) continue;
    // The first line of a rollout, plain or zstd-compressed. A compressed file that cannot be decoded is a failed read.
    const first = !plain.endsWith(".zst") ? pl.fs.readHead(file, FIRST_LINE_BYTES)?.text.split("\n", 1)[0] : pl.fs.zstdFirstLine(file);
    if (!first) continue;
    const row = pl.fs.jsonValue(file, first, folders) as { type?: unknown; payload?: { cwd?: unknown; id?: unknown } } | null | undefined;
    const cwd = row?.payload?.cwd;
    if (!row || row.type !== "session_meta" || typeof cwd !== "string" || !folders.some((folder) => sameFolder(folder, cwd))) continue;
    if (typeof row.payload?.id === "string" && ID.test(row.payload.id)) { threadIds.add(row.payload.id); fromRollouts.add(row.payload.id); }
    // the rollout is removed only while its first line still says what this plan read (type, folder, thread id)
    pl.removeExact(home, file, undefined, rolloutEvidence(row));
  }
  // A thread whose rollout is already gone still has its prompt text in the state database (real-engine qualification of Codex):
  // its ids come from there too, by the working folder the thread was started in.
  const stateDir = sqliteHome || home;
  const threadDbs: string[] = [];
  for (const name of pl.fs.readdir(stateDir).filter((item) => /^state_\d+\.sqlite$/.test(item))) {
    pl.fs.withDb(pathApiFor(stateDir).join(stateDir, name), (db) => {
      const tables = new Set(db.all("SELECT name FROM sqlite_master WHERE type='table'").map((row) => String(row.name)));
      if (!tables.has("threads")) return;
      if (!db.all('PRAGMA table_info("threads")').some((column) => column.name === "cwd")) return;
      const asked = [...new Set(folders)];
      if (!asked.length) return;
      threadDbs.push(pathApiFor(stateDir).join(stateDir, name));
      for (const row of db.all(`SELECT id FROM threads WHERE cwd IN (${marks(asked)})`, asked)) if (typeof row.id === "string" && ID.test(row.id)) threadIds.add(row.id);
      // An id learned earlier (a saved plan) whose row now names another folder is someone else's thread: it is dropped.
      const unproven = [...threadIds].filter((id) => !fromRollouts.has(id));
      if (unproven.length) {
        for (const row of db.all(`SELECT id, cwd FROM threads WHERE id IN (${marks(unproven)})`, unproven)) {
          if (typeof row.id === "string" && !(typeof row.cwd === "string" && folders.some((folder) => sameFolder(folder, row.cwd as string)))) threadIds.delete(row.id);
        }
      }
    });
  }
  if (!threadIds.size) return;
  const values = [...threadIds];
  // Threads that no rollout of this plan vouches for (found by the state store, or learned earlier) are checked against the store
  // itself before anything else of theirs is touched, and again inside the delete.
  const guard = { ids: values.filter((id) => !fromRollouts.has(id)), folders: [...new Set(folders)] };
  // Every step keyed by these ids waits for the checks that vouch for them (a check that threw stops them, whatever it threw).
  const owners = guard.ids.length ? threadDbs.map((path) => `owner:${path}`) : [];
  if (guard.ids.length) for (const path of threadDbs) pl.push({ k: "ownerCheck", cls: "content", id: `owner:${path}`, db: path, pragmas: DEFAULT_PRAGMAS, ids: guard.ids, folders: guard.folders });
  pl.needing = owners;
  // history.jsonl is written under the engine's own lock (codex-rs message-history try_lock on append and trim). session_index.jsonl
  // has no lock; Codex appends to it (write and close) and replaces it by rename, so it is cleared in place, row by row, and found
  // again by name afterwards (engine-exec.ts clearInPlace).
  pl.rewrite(api.join(home, "history.jsonl"), { pred: { any: [{ field: "session_id", op: "in", values }] }, needles: values, format: "codex-history", how: "lock" });
  pl.rewrite(api.join(home, "session_index.jsonl"), { pred: { any: [{ field: "id", op: "in", values }] }, needles: values, format: "codex-session-index", how: "inplace" });
  const snapshots = api.join(home, "shell_snapshots");
  for (const name of pl.fs.readdir(snapshots)) {
    if (values.some((id) => name.startsWith(`${id}.`))) pl.remove(snapshots, api.join(snapshots, name));
  }
  const dbDir = sqliteHome || home;
  for (const name of pl.fs.readdir(dbDir).filter((item) => /^(state|logs|memories|goals|thread_history)_\d+\.sqlite$/.test(item))) {
    const path = pathApiFor(dbDir).join(dbDir, name);
    pl.fs.withDb(path, (db) => {
      const stmts: SqlStatement[] = [];
      let changed = 0;
      for (const { name: table } of db.all("SELECT name FROM sqlite_master WHERE type='table'") as Array<{ name: string }>) {
        if (!/^\w+$/.test(table)) continue;
        const columns = new Set((db.all(`PRAGMA table_info("${table}")`) as Array<{ name: string }>).map((column) => column.name));
        for (const column of ["thread_id", "parent_thread_id", "child_thread_id", ...(table === "threads" ? ["id"] : [])]) {
          if (!columns.has(column)) continue;
          const where = `"${column}" IN (${marks(values)})`;
          changed += pl.count(db, table, where, values);
          stmts.push({ table, where, params: values });
        }
      }
      pl.sqlDelete(path, { stmts, changed, guard });
      pl.checkpointIfDirty(path);
    });
  }
}
