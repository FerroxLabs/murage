// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Planners for the ACP engines whose storage was mapped from their own source (Gemini CLI, Qwen Code, OpenCode, Kimi Code,
// Cursor, Droid, Hermes, Antigravity). Each is the engine's removal body with every write replaced by a step: what each
// engine keys on (slugs, hashes, ownership markers, SQL predicates) is unchanged. See engine-history-deletion.ts for the keys
// and the notes on where each engine keeps its history. No fs, no sqlite, no try: reads go through `pl.fs` only.
import { api, cursorChatsKey, cursorProjectSlug, droidCwdKey, geminiNormalizedPath, geminiSlug, kimiWorkDirKey, md5, qwenProjectHash, qwenProjectKey, sha256, SESSION_ID, type AcpEngineHome } from "./engine-history-deletion.ts";
import { ASIDE_SUFFIX, sameFolder, type Planner, type SqlStatement } from "./engine-plan-core.ts";

export function planAcpEngineHistory(pl: Planner, target: AcpEngineHome, folders: string[], sessionIds: string[]): void {
  const ids = sessionIds.filter((id) => SESSION_ID.test(id));
  switch (target.engine) {
    case "gemini": return planGemini(pl, target.home, folders);
    case "qwen": return planQwen(pl, target.home, target.secondary, folders, ids);
    case "opencode": return planOpenCode(pl, target.home, target.db, folders);
    case "kimi": return planKimi(pl, target.home, folders);
    case "cursor": return planCursor(pl, target.home, target.secondary, folders, ids);
    case "droid": return planDroid(pl, target.home, folders, ids);
    case "hermes": return planHermes(pl, target.home, ids);
    case "antigravity": return planAntigravity(pl, target.home, ids);
  }
}

const OPENCODE_PRAGMAS = "PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;";
const marks = (values: readonly unknown[]) => values.map(() => "?").join(",");

function planGemini(pl: Planner, geminiDir: string, folders: string[]): void {
  const p = api(geminiDir);
  const registryPath = p.join(geminiDir, "projects.json");
  const registryText = pl.fs.readText(registryPath);
  const parsed = registryText === null ? undefined : (pl.fs.jsonValue(registryPath, registryText, folders.map(geminiNormalizedPath)) as { projects?: unknown } | null | undefined);
  const registry: Record<string, unknown> = parsed && typeof parsed === "object" && parsed.projects && typeof parsed.projects === "object" ? (parsed.projects as Record<string, unknown>) : {};
  const marker = (name: string, base: string) => {
    const text = pl.fs.readText(p.join(geminiDir, base, name, ".project_root"));
    return text === null ? undefined : geminiNormalizedPath(text.trim());
  };
  for (const folder of folders) {
    const normalized = geminiNormalizedPath(folder);
    // Slugs found by an earlier run stay: the folders that named them may be gone by now.
    const slugs = new Set<string>(pl.facts.get("slugs"));
    const registered = registry[normalized];
    if (typeof registered === "string" && /^[\w.-]+$/.test(registered)) slugs.add(registered);
    // The registry may not have caught up; the marker inside each folder is the engine's own ownership proof.
    for (const name of pl.fs.readdir(p.join(geminiDir, "tmp"))) {
      if (name.startsWith(geminiSlug(folder)) && marker(name, "tmp") === normalized) slugs.add(name);
    }
    pl.facts.add("slugs", ...slugs);
    for (const slug of slugs) {
      for (const base of ["tmp", "history"]) {
        const dir = p.join(geminiDir, base, slug);
        const here = marker(slug, base);
        if (here === undefined && base === "history" && !pl.fs.readdir(dir).length) continue;
        if (here !== undefined && here !== normalized) continue;
        pl.remove(p.join(geminiDir, base), dir);
      }
    }
    for (const base of ["tmp", "history"]) pl.remove(p.join(geminiDir, base), p.join(geminiDir, base, sha256(folder)));
  }
}

/** Qwen Code: `projects/<key>/chats/<session>.jsonl`, the key being a LOSSY form of the folder, so two folders can share one. A chat
 * is the conversation's only when a full read of it names at least one cwd and every cwd it names is this folder. Only such a chat
 * is removed, and only its session ids reach the todos, debug logs and plans: a chat that names another folder, or none, keeps
 * every side file and its place. The chats folder and the project folder are removed only if nothing but those chats was in them
 * (they are removed as empty folders, never recursively, so a chat that arrives meanwhile stops the removal). */
function planQwen(pl: Planner, runtime: string, global: string | undefined, folders: string[], ids: string[]): void {
  const p = api(runtime);
  const sessions = new Set([...ids, ...pl.facts.get("sessions")]);
  for (const folder of folders) {
    const key = qwenProjectKey(folder);
    for (const root of new Set([runtime, global].filter((dir): dir is string => Boolean(dir)))) {
      const project = p.join(root, "projects", key);
      const chatsDir = p.join(project, "chats");
      // Every physical chat file, each read and judged on its own: the folder and its aside (a crash can leave one), and a chat
      // renamed to its aside name. A chat and the copy of it a crash left are two files; neither stands in for the other.
      const chats: string[] = [];
      for (const dir of [`${chatsDir}${ASIDE_SUFFIX}`, chatsDir]) for (const name of pl.fs.readdir(dir)) chats.push(p.join(dir, name));
      let others = false;
      let allOurs = true;
      for (const file of chats) {
        const name = p.basename(file);
        const plain = name.endsWith(ASIDE_SUFFIX) ? name.slice(0, -ASIDE_SUFFIX.length) : name;
        if (!plain.endsWith(".jsonl")) { allOurs = false; continue; }
        const found = pl.associationsOf(file, [folder]);
        if (found.cwds.length && found.cwds.every((cwd) => sameFolder(cwd, folder))) {
          sessions.add(plain.slice(0, -".jsonl".length));
          pl.removeExact(project, file, found.fp);
        } else { others = true; allOurs = false; }
      }
      if (others) pl.leftovers.push({ what: "Qwen Code's history of this conversation", where: "Qwen Code's project history, filed under a name another folder shares" });
      if (allOurs && pl.fs.lstat(chatsDir)) {
        pl.push({ k: "rmdirIfEmpty", cls: "content", root: project, target: chatsDir });
        if (pl.fs.readdir(project).every((name) => name === "chats")) pl.push({ k: "rmdirIfEmpty", cls: "content", root: p.join(root, "projects"), target: project });
      }
    }
    for (const base of ["tmp", "history"]) pl.remove(p.join(runtime, base), p.join(runtime, base, qwenProjectHash(folder)));
  }
  pl.facts.add("sessions", ...sessions);
  for (const id of sessions) {
    if (!SESSION_ID.test(id)) continue;
    pl.remove(p.join(runtime, "todos"), p.join(runtime, "todos", `${id}.json`));
    pl.remove(p.join(runtime, "debug"), p.join(runtime, "debug", `${id}.txt`));
    if (global) pl.remove(p.join(global, "plans"), p.join(global, "plans", `${id}.md`));
  }
}

function planOpenCode(pl: Planner, dataDir: string, dbOverride: string | undefined, folders: string[]): void {
  const p = api(dataDir);
  const databases = dbOverride ? [dbOverride] : pl.fs.readdir(dataDir).filter((name) => /^opencode(-[\w.-]+)?\.db$/.test(name)).map((name) => p.join(dataDir, name));
  const known = pl.facts.get("ids");
  for (const path of databases) {
    pl.fs.withDb(path, (db) => {
      const tables = db.all("SELECT name FROM sqlite_master WHERE type='table'").map((row) => String(row.name)).filter((name) => /^\w+$/.test(name));
      const columns = (table: string) => new Set(db.all(`PRAGMA table_info("${table}")`).map((row) => String(row.name)));
      if (!tables.includes("session") || !columns("session").has("directory")) return;
      const here = new Set(db.all(`SELECT id FROM session WHERE directory IN (${marks(folders)})`, folders).map((row) => String(row.id)));
      // Ids an earlier run saved count too: the rows that named them may already be gone.
      const found = new Set([...here, ...known]);
      if (columns("session").has("parent_id")) {
        for (let grew = true; grew;) {
          grew = false;
          const current = [...found];
          if (!current.length) break;
          for (const row of db.all(`SELECT id FROM session WHERE parent_id IN (${marks(current)})`, current)) {
            if (!found.has(String(row.id))) { found.add(String(row.id)); grew = true; }
          }
        }
      }
      for (const id of found) known.add(id);
      if (!found.size) return;
      const list = [...found];
      const stmts: SqlStatement[] = [];
      let changed = 0;
      for (const table of tables) {
        const has = columns(table);
        for (const column of ["session_id", "aggregate_id"]) {
          if (!has.has(column)) continue;
          const where = `"${column}" IN ({ids})`;
          changed += pl.count(db, table, where.replace("{ids}", marks(list)), list);
          stmts.push({ table, where, params: [], useIds: true });
        }
      }
      changed += pl.count(db, "session", `id IN (${marks(list)})`, list);
      stmts.push({ table: "session", where: "id IN ({ids})", params: [], useIds: true });
      pl.sqlDelete(path, { pragmas: OPENCODE_PRAGMAS, ids: list, closure: columns("session").has("parent_id") ? { table: "session", idCol: "id", parentCol: "parent_id", fact: "ids" } : undefined, stmts, changed });
      pl.checkpointIfDirty(path);
    });
  }
  for (const id of known) {
    if (!SESSION_ID.test(id)) continue;
    const dir = p.join(dataDir, "storage", "session_diff");
    pl.remove(dir, p.join(dir, `${id}.json`));
  }
}

function planKimi(pl: Planner, root: string, folders: string[]): void {
  const p = api(root);
  const workDirs = [...new Set(folders.map((folder) => folder.replace(/\\/g, "/").replace(/\/+$/, "")))];
  const removedSessions = pl.facts.get("sessions");
  for (const folder of folders) {
    const bucket = p.join(root, "sessions", kimiWorkDirKey(folder));
    const names = pl.namesWithAside(bucket);
    for (const name of names) removedSessions.add(name);
    pl.removeListed(p.join(root, "sessions"), bucket, names);
    pl.remove(p.join(root, "user-history"), p.join(root, "user-history", `${md5(folder)}.jsonl`));
  }
  const sessions = [...removedSessions];
  pl.rewrite(p.join(root, "session_index.jsonl"), {
    pred: { any: [{ field: "workDir", op: "slashNormIn", values: workDirs }, { field: "sessionId", op: "in", values: sessions }] },
    needles: [...workDirs, ...folders, ...sessions],
    format: "kimi-session-index",
    how: "exclusive",
  });
}

function planCursor(pl: Planner, dataDir: string, configDir: string | undefined, folders: string[], ids: string[]): void {
  const p = api(dataDir);
  // The ids are saved like every other engine's, so a retry still has them.
  const sessions = new Set([...ids, ...pl.facts.get("sessions")]);
  pl.facts.add("sessions", ...sessions);
  for (const folder of folders) {
    pl.remove(p.join(dataDir, "projects"), p.join(dataDir, "projects", cursorProjectSlug(folder)));
    if (configDir) pl.remove(p.join(configDir, "chats"), p.join(configDir, "chats", cursorChatsKey(folder)));
  }
  if (configDir) for (const id of sessions) if (SESSION_ID.test(id)) pl.remove(p.join(configDir, "acp-sessions"), p.join(configDir, "acp-sessions", id));
}

function planDroid(pl: Planner, root: string, folders: string[], ids: string[]): void {
  const p = api(root);
  const sessions = p.join(root, "sessions");
  const found = new Set([...ids, ...pl.facts.get("sessions")]);
  for (const folder of folders) {
    const bucket = p.join(sessions, droidCwdKey(folder));
    const names = pl.namesWithAside(bucket);
    for (const name of names) if (name.endsWith(".jsonl")) found.add(name.slice(0, -".jsonl".length));
    pl.removeListed(sessions, bucket, names);
  }
  pl.facts.add("sessions", ...found);
  for (const id of found) {
    if (!/^[\w-]{1,200}$/.test(id)) continue;
    for (const name of [`${id}.jsonl`, `${id}.settings.json`]) pl.remove(sessions, p.join(sessions, name));
    pl.remove(p.join(sessions, "btw"), p.join(sessions, "btw", `${id}.jsonl`));
  }
  // Droid's derived session index (cache/session-index/index.db) holds summaries. Its schema is not published: drop rows
  // whose session-id column names one of these sessions, or whose path column names one.
  const index = p.join(root, "cache", "session-index", "index.db");
  const known = [...found].filter((id) => /^[\w-]{8,200}$/.test(id));
  if (!known.length) return;
  pl.fs.withDb(index, (db) => {
    const stmts: SqlStatement[] = [];
    let changed = 0;
    for (const { name: table } of db.all("SELECT name FROM sqlite_master WHERE type='table'") as Array<{ name: string }>) {
      if (!/^\w+$/.test(table)) continue;
      for (const { name: column } of db.all(`PRAGMA table_info("${table}")`) as Array<{ name: string }>) {
        if (!/^\w+$/.test(column)) continue;
        if (/^session_?id$/i.test(column)) {
          const where = `"${column}" IN (${marks(known)})`;
          changed += pl.count(db, table, where, known);
          stmts.push({ table, where, params: known });
        } else if (/path|file/i.test(column)) {
          for (const id of known) {
            const where = `instr("${column}", ?) > 0`;
            changed += pl.count(db, table, where, [`${id}.jsonl`]);
            stmts.push({ table, where, params: [`${id}.jsonl`] });
          }
        }
      }
    }
    pl.sqlDelete(index, { stmts, changed });
    pl.checkpointIfDirty(index);
  });
}

/** Hermes 0.14 (hermes_state.py, acp_adapter/session.py): one state.db per home (sessions, messages; the full-text index
 * follows by trigger) and sessions/<id>.json|.jsonl plus request dumps. Child sessions of a deleted one go too: Hermes's own
 * delete only orphans them. */
function planHermes(pl: Planner, home: string, ids: string[]): void {
  const p = api(home);
  // Descendants an earlier run found stay in the set: their rows may be gone, their transcripts are not.
  const all = new Set([...ids, ...pl.facts.get("ids")]);
  if (!all.size) return;
  const path = p.join(home, "state.db");
  pl.fs.withDb(path, (db) => {
    const tables = db.all("SELECT name FROM sqlite_master WHERE type='table'").map((row) => String(row.name)).filter((name) => /^\w+$/.test(name));
    const cols = (table: string) => new Set(db.all(`PRAGMA table_info("${table}")`).map((row) => String(row.name)));
    const closure = tables.includes("sessions") && cols("sessions").has("parent_session_id");
    if (closure) {
      for (let grew = true; grew;) {
        grew = false;
        const current = [...all];
        for (const row of db.all(`SELECT id FROM sessions WHERE parent_session_id IN (${marks(current)})`, current)) {
          if (!all.has(String(row.id))) { all.add(String(row.id)); grew = true; }
        }
      }
    }
    const list = [...all];
    const stmts: SqlStatement[] = [];
    let changed = 0;
    for (const table of tables) {
      if (table.endsWith("_fts") || table.includes("_fts_")) continue;
      if (table !== "sessions" && cols(table).has("session_id")) {
        changed += pl.count(db, table, `session_id IN (${marks(list)})`, list);
        stmts.push({ table, where: "session_id IN ({ids})", params: [], useIds: true });
      }
    }
    if (tables.includes("sessions")) {
      changed += pl.count(db, "sessions", `id IN (${marks(list)})`, list);
      stmts.push({ table: "sessions", where: "id IN ({ids})", params: [], useIds: true });
    }
    pl.sqlDelete(path, { ids: list, ...(closure ? { closure: { table: "sessions", idCol: "id", parentCol: "parent_session_id", fact: "ids" } } : {}), stmts, changed });
    pl.checkpointIfDirty(path);
  });
  pl.facts.add("ids", ...all);
  const sessions = p.join(home, "sessions");
  const names = pl.fs.readdir(sessions);
  for (const id of all) {
    if (!/^[\w-]{8,200}$/.test(id)) continue;
    for (const name of names) {
      if (name === `${id}.json` || name === `${id}.jsonl` || (name.startsWith(`request_dump_${id}_`) && name.endsWith(".json"))) pl.remove(sessions, p.join(sessions, name));
    }
  }
}

/** Antigravity (agy, shipped binary): brain/<conversation id>/ holds the full transcript; conversation_summaries.db keeps a
 * summary row per conversation. Conversation and annotation files named by the id go too. */
function planAntigravity(pl: Planner, appData: string, ids: string[]): void {
  const p = api(appData);
  const known = [...new Set([...ids, ...pl.facts.get("sessions")])].filter((id) => /^[\w-]{8,200}$/.test(id));
  pl.facts.add("sessions", ...known);
  if (!known.length) return;
  for (const id of known) {
    pl.remove(p.join(appData, "brain"), p.join(appData, "brain", id));
    for (const dir of ["conversations", "annotations"]) {
      for (const name of pl.fs.readdir(p.join(appData, dir))) if (name === id || name.startsWith(`${id}.`)) pl.remove(p.join(appData, dir), p.join(appData, dir, name));
    }
  }
  const path = p.join(appData, "conversation_summaries.db");
  pl.fs.withDb(path, (db) => {
    const stmts: SqlStatement[] = [];
    let changed = 0;
    for (const { name: table } of db.all("SELECT name FROM sqlite_master WHERE type='table'") as Array<{ name: string }>) {
      if (!/^\w+$/.test(table)) continue;
      const columns = (db.all(`PRAGMA table_info("${table}")`) as Array<{ name: string }>).map((row) => row.name);
      if (!columns.includes("conversation_id")) continue;
      const where = `conversation_id IN (${marks(known)})`;
      changed += pl.count(db, table, where, known);
      stmts.push({ table, where, params: known });
    }
    pl.sqlDelete(path, { stmts, changed });
    pl.checkpointIfDirty(path);
  });
}
