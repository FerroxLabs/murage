import { createHash } from "node:crypto";
import { accessSync, constants, lstatSync, readFileSync, readlinkSync, realpathSync, statSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { userInfo } from "node:os";
import { DatabaseSync, type StatementSync } from "node:sqlite";

export type DestinationEnv = Record<string, string | undefined>;
// All values come from the hand. Credentials in AUTH_CONTENT never enter the key.
export const DESTINATION_CONFIG_ENV = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", "OPENCODE_DISABLE_PROJECT_CONFIG", "ProgramData", "OPENCODE_TEST_HOME", "OPENCODE_TEST_MANAGED_CONFIG_DIR", "OPENCODE_DB", "OPENCODE_DISABLE_CHANNEL_DB", "OPENCODE_PERMISSION", "OPENCODE_PURE", "OPENCODE_DISABLE_AUTOCOMPACT", "OPENCODE_DISABLE_PRUNE"] as const;
const missing = (error: unknown) => ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
const names = ["config.json", "opencode.json", "opencode.jsonc"];
export function destinationRoots(env: DestinationEnv) {
  const home = (process.platform === "win32" ? env.USERPROFILE : env.HOME) ?? env.HOME;
  if (!home) throw new Error("missing handed home");
  return { home, config: join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode"), data: join(env.XDG_DATA_HOME || join(home, ".local/share"), "opencode") };
}
export function destinationCandidates(env: DestinationEnv, cwd: string): string[] {
  const { home, config, data } = destinationRoots(env);
  const files = new Set<string>();
  const add = (dir: string) => names.forEach(name => files.add(resolve(cwd, dir, name)));
  for (let dir = resolve(cwd);; dir = dirname(dir)) {
    for (const name of ["opencode.json", "opencode.jsonc"]) { files.add(join(dir, name)); files.add(join(dir, ".opencode", name)); }
    if (dirname(dir) === dir) break;
  }
  add(config); files.add(join(config, "config"));
  add(join(env.OPENCODE_TEST_HOME ?? home, ".opencode"));
  if (env.OPENCODE_CONFIG_DIR) add(env.OPENCODE_CONFIG_DIR);
  if (env.OPENCODE_CONFIG) files.add(resolve(cwd, env.OPENCODE_CONFIG));
  add(env.OPENCODE_TEST_MANAGED_CONFIG_DIR || (process.platform === "darwin" ? "/Library/Application Support/opencode" : process.platform === "win32" ? join(env.ProgramData || "C:\\ProgramData", "opencode") : "/etc/opencode"));
  if (process.platform === "darwin") {
    files.add("/Library/Managed Preferences/ai.opencode.managed.plist");
    files.add(join("/Library/Managed Preferences", userInfo().username, "ai.opencode.managed.plist"));
  }
  files.add(join(data, "auth.json"));
  return [...files];
}
export function inlineAuthRemote(text: string | undefined): boolean {
  if (text === undefined) return false;
  try { const auth = JSON.parse(text); return !auth || typeof auth !== "object" || Object.values(auth).some(v => v && typeof v === "object" && (v as { type?: unknown }).type === "wellknown"); }
  catch { return true; }
}
/** One read-only account query per turn. No database or tables are created. */
export function destinationAccountRemote(env: DestinationEnv): boolean {
  const { data } = destinationRoots(env);
  if (env.OPENCODE_DB === ":memory:") return false;
  const path = env.OPENCODE_DB ? (isAbsolute(env.OPENCODE_DB) ? env.OPENCODE_DB : join(data, env.OPENCODE_DB)) : join(data, "opencode.db");
  try { statSync(path); } catch (error) { return !missing(error); }
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='account_state'").get();
    if (!table) {
      const legacy = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='control_account'").get();
      return Boolean(legacy && db.prepare("SELECT 1 FROM control_account WHERE active=1 LIMIT 1").get());
    }
    return Boolean(db.prepare("SELECT active_org_id FROM account_state WHERE id=1 AND active_account_id IS NOT NULL").get()?.active_org_id);
  } catch { return true; } finally { db?.close(); }
}

export class OpenCodeDestinationKey {
  private texts = new Map<string, { tuple: string; text: string }>();
  private reals = new Map<string, { tuple: string; real: string; parents: Map<string, string> }>();
  private accounts = new Map<string, { ident: string; conn: DatabaseSync; statements: Map<string, StatementSync> }>();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  close(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    for (const path of this.accounts.keys()) this.closeAccount(path);
  }
  private closeAccount(path: string): void {
    const saved = this.accounts.get(path);
    this.accounts.delete(path);
    try { saved?.conn.close(); } catch { /* Already unusable. */ }
    if (!this.accounts.size) { clearTimeout(this.idleTimer); this.idleTimer = undefined; }
  }
  private accountRemote(env: DestinationEnv): boolean {
    if (process.platform === "win32") return destinationAccountRemote(env);
    if (env.OPENCODE_DB === ":memory:") return false;
    const { data } = destinationRoots(env);
    const path = env.OPENCODE_DB ? (isAbsolute(env.OPENCODE_DB) ? env.OPENCODE_DB : join(data, env.OPENCODE_DB)) : join(data, "opencode.db");
    let st: Stats;
    try { st = statSync(path); }
    catch (error) { this.closeAccount(path); return !missing(error); }
    try {
      accessSync(path, constants.R_OK);
      const ident = `${st.dev}:${st.ino}`;
      let saved = this.accounts.get(path);
      if (saved?.ident !== ident) { this.closeAccount(path); saved = undefined; }
      if (!saved) {
        while (this.accounts.size >= 4) this.closeAccount(this.accounts.keys().next().value!);
        saved = { ident, conn: new DatabaseSync(path, { readOnly: true }), statements: new Map() };
      }
      this.accounts.delete(path);
      this.accounts.set(path, saved);
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => this.close(), 60_000);
      this.idleTimer.unref();
      const get = (sql: string) => {
        let statement = saved.statements.get(sql);
        if (!statement) { statement = saved.conn.prepare(sql); saved.statements.set(sql, statement); }
        // get() releases the statement on success and error. Our idle connection pins no snapshot.
        return statement.get();
      };
      const table = get("SELECT name FROM sqlite_master WHERE type='table' AND name='account_state'");
      if (!table) {
        const legacy = get("SELECT name FROM sqlite_master WHERE type='table' AND name='control_account'");
        return Boolean(legacy && get("SELECT 1 FROM control_account WHERE active=1 LIMIT 1"));
      }
      return Boolean(get("SELECT active_org_id FROM account_state WHERE id=1 AND active_account_id IS NOT NULL")?.active_org_id);
    } catch { this.closeAccount(path); return true; }
  }
  read(env: DestinationEnv, cwd: string, cli: string, now = Date.now()): { key: string; cacheable: boolean; settled: boolean } {
    const signature = (st: Stats) => JSON.stringify([st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs, st.mode]);
    const components = new Map<string, Stats>();
    const component = (path: string) => {
      let st = components.get(path);
      if (!st) { st = lstatSync(path); components.set(path, st); }
      return st;
    };
    const realpath = (path: string, st: Stats) => {
      try {
        const tuple = signature(st), saved = this.reals.get(path);
        // Keep stat on every file read. On a warm hit, add one lstat per distinct
        // traversed component across this read (shared ancestors checked once),
        // and zero realpath/readlink calls. Include symlinks and their expanded
        // targets, not just lexical parents: a link target can itself cross links.
        if (saved?.tuple === tuple && [...saved.parents].every(([parent, before]) => signature(component(parent)) === before)) return saved.real;
        this.reals.delete(path);
        const parents = new Map<string, string>();
        let current = parse(path).root, links = 0;
        let pending = path.slice(current.length).split(sep).filter(Boolean);
        parents.set(current, signature(component(current)));
        while (pending.length) {
          const name = pending.shift()!;
          if (name === ".") continue;
          if (name === "..") { current = dirname(current); continue; }
          const next = join(current, name), part = component(next);
          parents.set(next, signature(part));
          if (part.isSymbolicLink()) {
            if (++links > 40) throw new Error("too many destination symlinks");
            const target = readlinkSync(next), root = parse(target).root;
            if (root) { current = root; parents.set(root, signature(component(root))); }
            // Expand before handling .. so intermediate symlinks stay tracked.
            pending = [...target.slice(root.length).split(sep).filter(Boolean), ...pending];
          } else current = next;
        }
        const real = realpathSync(path);
        this.reals.set(path, { tuple, real, parents });
        while (this.reals.size > 64) this.reals.delete(this.reals.keys().next().value!);
        return real;
      } catch {
        // Tracking uncertainty must not change the original path/error semantics.
        this.reals.delete(path);
        return realpathSync(path);
      }
    };
    const hash = createHash("sha256");
    let cacheable = true, settled = true;
    const seen = new Set<string>();
    const scanned = new Set<string>();
    const put = (value: unknown) => hash.update(JSON.stringify(value));
    put([cwd, ...DESTINATION_CONFIG_ENV.map(name => [name, env[name] ?? null])]);
    const file = (path: string, layer: boolean): string | undefined => {
      path = resolve(cwd, path);
      // A file target may also be a later config layer: fingerprint once,
      // but never let that suppress reading its dependency tokens.
      if (seen.has(path) && (!layer || scanned.has(path))) return;
      if (layer) scanned.add(path);
      try {
        const st = statSync(path), real = realpath(path, st);
        const tuple = JSON.stringify([st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs, real]);
        if (!seen.has(path)) { put([path, tuple]); seen.add(path); }
        if (now - Math.max(st.mtimeMs, st.ctimeMs) <= 2000) settled = false;
        if (!st.isFile()) { cacheable = false; return; }
        if (!layer) return;
        let saved = this.texts.get(path);
        if (saved?.tuple !== tuple) { saved = { tuple, text: readFileSync(path, "utf8") }; this.texts.set(path, saved); }
        return saved.text;
      } catch (error) { this.reals.delete(path); this.texts.delete(path); if (!seen.has(path)) { put([path, missing(error) ? "absent" : "unreadable"]); seen.add(path); } if (!missing(error) || !layer) cacheable = false; }
    };
    const tokens = (text: string, base: string) => {
      const expanded = text.replace(/\{env:([^}]+)\}/g, (_, name: string) => { put([name, env[name] ?? ""]); return env[name] ?? ""; });
      if (/\{(?:env|file):(?:\}|$)/.test(expanded) || /\{(?:env|file):[^}]*$/.test(expanded)) cacheable = false;
      for (const match of expanded.matchAll(/\{file:([^}]+)\}/g)) {
        const name = match[1];
        if (name.includes("{") || name.includes("\0")) { cacheable = false; continue; }
        const target = name.startsWith("~/") ? join(destinationRoots(env).home, name.slice(2)) : resolve(base, name);
        file(target, false);
      }
    };
    try {
      file(cli, false);
      for (const path of destinationCandidates(env, cwd)) {
        const text = file(path, true);
        if (text !== undefined) {
          // Managed preferences need plutil decoding (binary or XML entities).
          // Until decoded tokens can be keyed, this layer is never cached.
          if (path.endsWith(".plist")) cacheable = false;
          if (path.endsWith("/auth.json") || path.endsWith("\\auth.json")) { if (inlineAuthRemote(text)) cacheable = false; }
          else tokens(text, dirname(path));
        }
      }
      tokens(env.OPENCODE_CONFIG_CONTENT ?? "", cwd);
      if (inlineAuthRemote(env.OPENCODE_AUTH_CONTENT) || this.accountRemote(env)) cacheable = false;
    } catch { cacheable = false; }
    // Bound layer memoization independently of the number of previous turns.
    while (this.texts.size > 4096) this.texts.delete(this.texts.keys().next().value!);
    return { key: hash.digest("hex"), cacheable, settled };
  }
}
