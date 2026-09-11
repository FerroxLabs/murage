// Murage's per-folder trust record (0.1.52 FUIGOTRUST1): the scan that names
// what a folder would contribute to a Fuigo turn, the trust key that mirrors
// upstream `workspace_key` (git root, else the folder; home and filesystem
// roots never), and the durable store the driver decides from.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FolderTrustStore,
  canonicalFolder,
  folderTrustKey,
  folderTrustKindNames,
  fuigoHomeFromEnv,
  gitRootOf,
  isUnrecordableTrustRoot,
  managedWorktreeSourceRepo,
  parseUpstreamTrustedFolders,
  readUpstreamTrustedFolders,
  scanFolderTrustSources,
  upstreamTrustsFolder,
} from "./folder-trust.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { PersistedStateRecoveryError } from "./persisted-state.ts";
import {
  FOLDER_TRUST_OPTIONS,
  folderTrustDecision,
  folderTrustDisplayName,
  folderTrustNotice,
  folderTrustQuestion,
  folderTrustWithheldName,
} from "../shared/folder-trust.ts";

let root: string;
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-folder-trust-")));
});
afterEach(async () => {
  await removeTempDir(root);
});

const repo = (name: string) => {
  const dir = join(root, name);
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
};
/** A real git repository with one commit (a linked worktree needs a HEAD)
 * and linked worktrees added with `git worktree add`, the way Murage's own
 * release lanes are laid out. */
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1", HOME: root },
  }).toString();
const realRepo = (name: string, ...initArgs: string[]) => {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", ...initArgs, ".");
  git(dir, "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
};
const linkedWorktree = (main: string, name: string, branch = name) => {
  const dir = join(root, name);
  git(main, "worktree", "add", "-q", "-b", branch, dir);
  return dir;
};

describe("scanFolderTrustSources", () => {
  it("names nothing for a plain folder, so no card is ever raised for it", () => {
    const dir = join(root, "plain");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "README.md"), "hi");
    expect(scanFolderTrustSources(dir)).toEqual({ key: dir, folder: dir, sources: [] });
  });

  it("names the upstream markers by file: instructions first, then rules, skills, config and hooks", () => {
    const dir = repo("full");
    writeFileSync(join(dir, "AGENTS.md"), "# a");
    writeFileSync(join(dir, "CLAUDE.md"), "# c");
    writeFileSync(join(dir, ".mcp.json"), "{}");
    writeFileSync(join(dir, ".envrc"), "export X=1");
    mkdirSync(join(dir, ".fuigo", "skills"), { recursive: true });
    mkdirSync(join(dir, ".claude", "rules"), { recursive: true });
    mkdirSync(join(dir, ".fuigo", "hooks"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.json"), "{}");
    expect(scanFolderTrustSources(dir).sources).toEqual([
      "AGENTS.md",
      "CLAUDE.md",
      ".claude/rules",
      ".fuigo/skills",
      ".mcp.json",
      ".claude/settings.json",
      ".envrc",
      ".fuigo/hooks",
    ]);
  });

  it("walks from a subfolder up to the git root, like the engine's loaders, and keys on the root", () => {
    const dir = repo("walk");
    writeFileSync(join(dir, "AGENTS.md"), "# root instructions");
    const sub = join(dir, "crates", "inner");
    mkdirSync(sub, { recursive: true });
    mkdirSync(join(sub, ".agents", "commands"), { recursive: true });
    expect(scanFolderTrustSources(sub)).toEqual({ key: dir, folder: sub, sources: ["AGENTS.md", ".agents/commands"] });
  });

  it("does not walk past a git root into a parent's markers", () => {
    writeFileSync(join(root, "AGENTS.md"), "# outside");
    const dir = repo("bounded");
    expect(scanFolderTrustSources(dir).sources).toEqual([]);
    // and a folder outside any repository only looks at itself
    const loose = join(root, "loose", "deeper");
    mkdirSync(loose, { recursive: true });
    expect(scanFolderTrustSources(loose)).toEqual({ key: loose, folder: loose, sources: [] });
  });

  it("a clone with its own .git inside a trusted folder is its own workspace", () => {
    const dir = repo("outer");
    writeFileSync(join(dir, "AGENTS.md"), "# outer");
    const clone = join(dir, "vendor", "evil");
    mkdirSync(join(clone, ".git"), { recursive: true });
    writeFileSync(join(clone, "CLAUDE.md"), "# evil");
    expect(folderTrustKey(clone)).toBe(clone);
    expect(scanFolderTrustSources(clone).sources).toEqual(["CLAUDE.md"]);
    expect(gitRootOf(join(clone, "src"))).toBe(clone);
  });
});

describe("trust keys", () => {
  it("never records the home folder or a filesystem root, and reads a home-rooted repo as its folder", () => {
    expect(isUnrecordableTrustRoot(homedir())).toBe(true);
    expect(isUnrecordableTrustRoot(parse(root).root)).toBe(true);
    expect(isUnrecordableTrustRoot("relative/path")).toBe(true);
    expect(isUnrecordableTrustRoot(root)).toBe(false);
    expect(canonicalFolder(join(root, "missing"))).toBe(join(root, "missing"));
  });

  // FUIGOTRUST3 (2): upstream `workspace_key` collapses a linked git
  // worktree onto its MAIN checkout's root, so every worktree of a repo
  // shares one trust key with the checkout `fuigo --trust` was run in.
  // Murage's own release lanes are linked worktrees: without the collapse
  // a standalone grant on the main repo is unseen, the card is raised, and a
  // Don't trust shows the withheld chip while the engine runs trusted.
  it("keys a linked git worktree on its main checkout, like upstream workspace_key", () => {
    const main = realRepo("main");
    const wt1 = linkedWorktree(main, "wt1");
    const wt2 = linkedWorktree(main, "wt2");
    // the main checkout keys off its own root
    expect(folderTrustKey(main)).toBe(main);
    expect(folderTrustKey(join(main, "src"))).toBe(main);
    // each linked worktree collapses onto it, from the root or a subfolder
    expect(gitRootOf(wt1)).toBe(wt1);
    expect(folderTrustKey(wt1)).toBe(main);
    expect(folderTrustKey(wt2)).toBe(main);
    const deep = join(wt1, "server", "drivers");
    mkdirSync(deep, { recursive: true });
    expect(folderTrustKey(deep)).toBe(main);
    expect(scanFolderTrustSources(deep)).toMatchObject({ key: main, folder: deep });
    // the scan still walks the worktree's own tree (the loaders walk the cwd chain)
    writeFileSync(join(wt1, "AGENTS.md"), "# wt1 only");
    expect(scanFolderTrustSources(deep).sources).toEqual(["AGENTS.md"]);
    expect(scanFolderTrustSources(main).sources).toEqual([]);
    // a submodule-shaped .git file (gitdir with no commondir) is not a worktree
    const sub = join(main, "vendor", "lib");
    mkdirSync(sub, { recursive: true });
    mkdirSync(join(main, ".git", "modules", "lib"), { recursive: true });
    writeFileSync(join(sub, ".git"), "gitdir: ../../.git/modules/lib\n");
    expect(folderTrustKey(sub)).toBe(sub);
  });

  it("never widens a worktree of a bare or separate-git-dir repository past its own folder", () => {
    // a bare repo's common dir is the bare dir itself; its parent contains
    // every sibling, so the key stays the worktree's own folder
    const bare = join(root, "repo.git");
    mkdirSync(bare, { recursive: true });
    git(bare, "init", "-q", "--bare", ".");
    const seed = join(root, "seed");
    mkdirSync(seed, { recursive: true });
    git(seed, "init", "-q", ".");
    git(seed, "commit", "-q", "--allow-empty", "-m", "init");
    git(seed, "push", "-q", bare, "HEAD:refs/heads/main");
    const bareWt = join(root, "bare-wt");
    git(bare, "worktree", "add", "-q", bareWt, "main");
    expect(folderTrustKey(bareWt)).toBe(bareWt);
    expect(folderTrustKey(bareWt)).not.toBe(root);
    // `git init --separate-git-dir`: the common dir's inferred workdir is
    // the gitdir's parent, not the checkout, so the layout guard rejects it
    const checkout = join(root, "checkout");
    const gitstore = join(root, "gitstore");
    mkdirSync(checkout, { recursive: true });
    git(checkout, "init", "-q", "--separate-git-dir", gitstore, ".");
    git(checkout, "commit", "-q", "--allow-empty", "-m", "init");
    expect(folderTrustKey(checkout)).toBe(checkout);
    const sepWt = join(root, "sep-wt");
    git(checkout, "worktree", "add", "-q", "-b", "sep", sepWt);
    expect(folderTrustKey(sepWt)).toBe(sepWt);
    expect(folderTrustKey(sepWt)).not.toBe(root);
    expect(dirname(gitstore)).toBe(root);
  });

  it("maps the engine's configKinds to names a person recognises", () => {
    expect(folderTrustKindNames(["instructions", "mcp", "skills", 7, "banana"])).toEqual([
      "AGENTS.md / CLAUDE.md",
      "MCP servers (.mcp.json)",
      "project skills",
      "banana",
    ]);
  });
});

// FUIGOTRUST2 (2): the user's own Fuigo store. The engine answers Trusted
// from `<FUIGO_HOME>/trusted_folders.toml` before it ever asks, so Murage
// reads the same file (read-only) and neither asks nor claims "untrusted"
// for a folder the engine will trust anyway.
// FUIGOTRUST4 (1): upstream `workspace_key` FIRST collapses a fuigo-managed
// worktree (`fuigo -w`, registered in `<FUIGO_HOME>/worktrees.db`) onto its
// recorded source repo's git root — whatever git says about the worktree,
// including a standalone clone git cannot link back. Without the mirror a
// bot in such a worktree of a trusted source repo sees a card and a chip
// while the engine runs trusted.
describe("fuigo-managed worktrees (worktrees.db, read-only)", () => {
  /** `<FUIGO_HOME>/worktrees.db` exactly as the engine's `WorktreeDb::open`
   * creates it (fuigo-fast-worktree/src/db/schema.rs INIT_SQL, verbatim) and
   * `register` fills it (queries.rs, the same column list): one row per
   * managed worktree, `path` and `source_repo` canonical the way
   * `register_worktree` stores them (api.rs). WAL, as the engine sets it. */
  const INIT_SQL = `
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS worktrees (
    id TEXT PRIMARY KEY,
    path TEXT UNIQUE NOT NULL,
    source_repo TEXT NOT NULL,
    repo_name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'session',
    creation_mode TEXT NOT NULL DEFAULT 'linked',
    git_ref TEXT,
    head_commit TEXT,
    session_id TEXT,
    creator_pid INTEGER,
    created_at INTEGER NOT NULL,
    last_accessed_at INTEGER,
    status TEXT NOT NULL DEFAULT 'alive',
    metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_worktrees_repo ON worktrees(repo_name);
CREATE INDEX IF NOT EXISTS idx_worktrees_status_kind ON worktrees(status, kind);
CREATE INDEX IF NOT EXISTS idx_worktrees_session ON worktrees(session_id);
CREATE INDEX IF NOT EXISTS idx_worktrees_created ON worktrees(created_at);
`;
  const writeWorktreesDb = (fuigoHome: string, rows: Array<{ path: string; source: string; mode?: string; status?: string }>) => {
    const db = new DatabaseSync(join(fuigoHome, "worktrees.db"));
    try {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec(INIT_SQL);
      db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?1, ?2)").run("schema_version", "1");
      const insert = db.prepare(
        "INSERT OR REPLACE INTO worktrees (id, path, source_repo, repo_name, kind, creation_mode, git_ref, head_commit, session_id, creator_pid, created_at, last_accessed_at, status, metadata) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
      );
      for (const [i, row] of rows.entries()) {
        insert.run(`wt-${i}`, row.path, row.source, "repo", "session", row.mode ?? "linked", "main", null, null, null, 1789152451, null, row.status ?? "alive", JSON.stringify({ label: `wt-${i}`, label_user_provided: false }));
      }
    } finally {
      db.close();
    }
  };
  /** A managed worktree the way `fuigo -w` lays one out: under
   * `<FUIGO_HOME>/worktrees/<repo slug>/<label>`, here as a STANDALONE clone
   * (its own `.git` directory) — the creation mode git cannot link back to
   * its source, so only the registry knows where it came from. */
  const managedClone = (fuigoHome: string, source: string, label: string) => {
    const dir = join(fuigoHome, "worktrees", "repo", label);
    mkdirSync(dirname(dir), { recursive: true });
    git(root, "clone", "-q", source, dir);
    return realpathSync.native(dir);
  };
  const fuigoHomeIn = (name: string) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  it("keys a managed standalone clone on its recorded source repo's git root, the way the engine does; without the registry it is its own workspace", () => {
    const source = realRepo("source");
    const home = fuigoHomeIn("fuigo-home");
    const clone = managedClone(home, source, "feat");
    writeWorktreesDb(home, [{ path: clone, source, mode: "standalone" }]);
    // git alone: a clone is its own repository, so its own key
    expect(gitRootOf(clone)).toBe(clone);
    expect(folderTrustKey(clone)).toBe(clone);
    // the registry (the engine's first step) collapses it onto the source
    expect(managedWorktreeSourceRepo(clone, home)).toBe(source);
    expect(folderTrustKey(clone, { fuigoHome: home })).toBe(source);
    // from a subfolder too: the engine walks up to the registered path
    const deep = join(clone, "src", "lib");
    mkdirSync(deep, { recursive: true });
    expect(folderTrustKey(deep, { fuigoHome: home })).toBe(source);
    // the source checkout itself, and the source's subfolders, share it
    expect(folderTrustKey(join(source, "sub"), { fuigoHome: home })).toBe(source);
    // the scan describes the engine's key; the store's cascade is judged on it
    expect(scanFolderTrustSources(deep, { fuigoHome: home })).toMatchObject({ key: source, folder: deep });
    expect(upstreamTrustsFolder(new Map([[source, true]]), clone)).toBe(false);
    expect(upstreamTrustsFolder(new Map([[source, true]]), clone, { fuigoHome: home })).toBe(true);
    expect(upstreamTrustsFolder(new Map([[source, false]]), clone, { fuigoHome: home })).toBe(false);
    // a standalone `fuigo --trust` in the source repo covers the managed clone
    writeFileSync(join(home, "trusted_folders.toml"), `[folders."${source}"]\ntrusted = true\ndecided_at = 1789152451\n`);
    expect(scanFolderTrustSources(deep, { fuigoHome: home })).toEqual({ key: source, folder: deep, sources: [], upstreamTrusted: true });
    // a different home (a provider-routed turn's temporary one) has no registry
    expect(scanFolderTrustSources(deep, { fuigoHome: fuigoHomeIn("routed-turn-home") })).toEqual({ key: clone, folder: deep, sources: [] });
    expect(scanFolderTrustSources(deep)).toEqual({ key: clone, folder: deep, sources: [] });
  });

  it("resolves the recorded source repo like upstream: a subdir source keys on its git root, a vanished source keeps the recorded path, an over-broad source falls back to the worktree", () => {
    const source = realRepo("source");
    const home = fuigoHomeIn("fuigo-home");
    const fromSubdir = managedClone(home, source, "from-subdir");
    const orphan = managedClone(home, source, "orphan");
    const fromHome = managedClone(home, source, "from-home");
    const gone = join(root, "deleted-source");
    writeWorktreesDb(home, [
      // `fuigo -w` launched from a subdir records that subdir as the source
      { path: fromSubdir, source: join(source, "packages", "app") },
      // the source repo has since been deleted: the recorded path stands
      { path: orphan, source: gone },
      // a record naming the home folder can never be a trust key
      { path: fromHome, source: homedir() },
    ]);
    expect(folderTrustKey(fromSubdir, { fuigoHome: home })).toBe(source);
    expect(folderTrustKey(orphan, { fuigoHome: home })).toBe(gone);
    expect(folderTrustKey(fromHome, { fuigoHome: home })).toBe(fromHome);
  });

  it("consults the registry only for a folder under <FUIGO_HOME>/worktrees, and reads it read-only: a missing, unreadable or unrelated database changes nothing", () => {
    const source = realRepo("source");
    const home = fuigoHomeIn("fuigo-home");
    const clone = managedClone(home, source, "feat");
    // no database yet: git decides, and none is created by the read
    expect(folderTrustKey(clone, { fuigoHome: home })).toBe(clone);
    expect(() => readFileSync(join(home, "worktrees.db"))).toThrow();
    // a database without this worktree
    writeWorktreesDb(home, [{ path: join(home, "worktrees", "repo", "other"), source }]);
    expect(folderTrustKey(clone, { fuigoHome: home })).toBe(clone);
    // a dead record still maps (the engine does not filter on status)
    writeWorktreesDb(home, [{ path: clone, source, status: "dead" }]);
    expect(folderTrustKey(clone, { fuigoHome: home })).toBe(source);
    // a clone of the same repo OUTSIDE the worktrees dir is never looked up,
    // even when a record names it
    const outside = join(root, "outside-clone");
    git(root, "clone", "-q", source, outside);
    writeWorktreesDb(home, [{ path: realpathSync.native(outside), source }]);
    expect(folderTrustKey(outside, { fuigoHome: home })).toBe(realpathSync.native(outside));
    // a damaged database: the engine logs and falls through to git
    writeFileSync(join(home, "worktrees.db"), "not a database");
    rmSync(join(home, "worktrees.db-wal"), { force: true });
    rmSync(join(home, "worktrees.db-shm"), { force: true });
    expect(folderTrustKey(clone, { fuigoHome: home })).toBe(clone);
    // the worktrees dir itself is not a worktree
    expect(managedWorktreeSourceRepo(join(home, "worktrees"), home)).toBeNull();
  });

  it("the store's lookup cascades from the engine's key to the folder's own, so a picker-trusted clone is not asked again and a decision on the source covers the clone", () => {
    const source = realRepo("source");
    const home = fuigoHomeIn("fuigo-home");
    const clone = managedClone(home, source, "feat");
    writeWorktreesDb(home, [{ path: clone, source, mode: "standalone" }]);
    const store = new FolderTrustStore(join(root, "folder-trust.json"));
    // the picker recorded the clone by its own (git) key
    expect(store.remember(clone, "trust", "picker")).toBe(clone);
    expect(store.decision(clone, { fuigoHome: home })).toBe("trust");
    expect(store.record(clone, { fuigoHome: home })?.folder).toBe(clone);
    // a card on a native turn records the engine's key: the source
    expect(store.remember(clone, "reject", "card", { fuigoHome: home })).toBe(source);
    expect(store.decision(source)).toBe("reject");
    expect(store.decision(clone, { fuigoHome: home })).toBe("reject");
    // ... and not the clone's own key, which a routed turn (no registry) reads
    expect(store.decision(clone)).toBe("trust");
    // Forget with the engine's home clears both
    expect(store.forget(clone, { fuigoHome: home })).toBe(true);
    expect(store.decision(clone, { fuigoHome: home })).toBeUndefined();
    expect(store.decision(clone)).toBeUndefined();
    expect(store.decision(source)).toBeUndefined();
  });
});

describe("the upstream trusted_folders.toml (read-only)", () => {
  const fuigoHomeIn = (name: string) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  it("resolves the Fuigo home the way the engine does: FUIGO_HOME verbatim, else <home>/.fuigo", () => {
    expect(fuigoHomeFromEnv({ FUIGO_HOME: "/custom/home", HOME: "/Users/x" })).toBe("/custom/home");
    expect(fuigoHomeFromEnv({ FUIGO_HOME: "", HOME: "/Users/x" })).toBe(join("/Users/x", ".fuigo"));
    expect(fuigoHomeFromEnv({ HOME: "/Users/x" })).toBe(join("/Users/x", ".fuigo"));
  });

  it("parses what the engine's serializer writes, and the hand-edit spellings a TOML reader accepts", () => {
    const written = `[folders."/Volumes/Mando/picked project"]\ntrusted = true\ndecided_at = 1789152451\n\n[folders."/tmp/declined"]\ntrusted = false\ndecided_at = 1789152424\n`;
    expect(parseUpstreamTrustedFolders(written)).toEqual(new Map([["/Volumes/Mando/picked project", true], ["/tmp/declined", false]]));
    // no decided_at, a comment, a literal-string key, a Windows key with escapes
    const sparse = `# grants\n[folders.'/a/b']\ntrusted = true # standalone\n[folders."C:\\\\Users\\\\x\\\\repo"]\ntrusted = true\n`;
    expect(parseUpstreamTrustedFolders(sparse)).toEqual(new Map([["/a/b", true], ["C:\\Users\\x\\repo", true]]));
    const inline = `[folders]\n"/x/y" = { trusted = true, decided_at = 1 }\n"/x/z".trusted = false\n"/x/z".decided_at = 2\n`;
    expect(parseUpstreamTrustedFolders(inline)).toEqual(new Map([["/x/y", true], ["/x/z", false]]));
    // a section this reader does not know is skipped, not a failure
    expect(parseUpstreamTrustedFolders(`[meta]\nversion = 2\n[folders."/p"]\ntrusted = true\n`)).toEqual(new Map([["/p", true]]));
  });

  it("treats a document it cannot read exactly as empty — never a grant the engine might not give", () => {
    for (const bad of [
      `[folders."/p"]\ntrusted = yes\n`,
      `[folders."/p"]\ntrusted = true\nextra = 1\n`,
      `[folders."/p"\ntrusted = true\n`,
      `[folders."/p"]\ntrusted = true\nthis is not toml\n`,
      `[[folders]]\ntrusted = true\n`,
      `trusted = true\n`,
      `[folders."/p"]\ntrusted = true\ndecided_at = soon\n`,
    ]) expect(parseUpstreamTrustedFolders(bad), bad).toBeNull();
    const home = fuigoHomeIn("bad-home");
    writeFileSync(join(home, "trusted_folders.toml"), `[folders."/p"]\ntrusted = maybe\n`);
    expect(readUpstreamTrustedFolders(home)).toEqual(new Map());
    expect(readUpstreamTrustedFolders(join(root, "no-such-home"))).toEqual(new Map());
    writeFileSync(join(home, "trusted_folders.toml"), "   \n");
    expect(readUpstreamTrustedFolders(home)).toEqual(new Map());
  });

  it("decides like upstream is_trusted: the deepest covering record of the same workspace; a nested repo is not covered; ties fail closed; broad keys are ignored", () => {
    const repoDir = repo("mono");
    const pkg = join(repoDir, "packages", "app");
    mkdirSync(pkg, { recursive: true });
    const nested = join(repoDir, "vendor", "lib");
    mkdirSync(join(nested, ".git"), { recursive: true });
    const plain = join(root, "plain");
    mkdirSync(plain, { recursive: true });

    expect(upstreamTrustsFolder(new Map([[repoDir, true]]), repoDir)).toBe(true);
    // a grant on the root covers a package inside the same repo…
    expect(upstreamTrustsFolder(new Map([[repoDir, true]]), pkg)).toBe(true);
    // …but not a nested repository with its own workspace key
    expect(upstreamTrustsFolder(new Map([[repoDir, true]]), nested)).toBe(false);
    expect(upstreamTrustsFolder(new Map([[nested, true]]), nested)).toBe(true);
    // FUIGOTRUST3 (2): upstream `is_trusted` queries the WORKSPACE KEY (the
    // root), not the cwd, so a hand-edited record below the root never
    // covers a query and never overrides the root's grant — the engine
    // trusts the package; Murage must say the same or its chip would lie
    expect(upstreamTrustsFolder(new Map([[repoDir, true], [pkg, false]]), pkg)).toBe(true);
    expect(upstreamTrustsFolder(new Map([[repoDir, true], [pkg, false]]), join(repoDir, "packages"))).toBe(true);
    expect(upstreamTrustsFolder(new Map([[pkg, true]]), pkg)).toBe(false);
    // a hand-edited alias that ties on depth and contradicts fails closed
    expect(upstreamTrustsFolder(new Map([[plain, true], [`${plain}/`, false]]), plain)).toBe(false);
    expect(upstreamTrustsFolder(new Map([[plain, true], [`${plain}/`, true]]), plain)).toBe(true);
    // over-broad keys never trust anything, whatever the file says
    expect(upstreamTrustsFolder(new Map([[parse(root).root, true], [homedir(), true], ["relative/path", true]]), plain)).toBe(false);
    // a sibling is not covered, and an empty store trusts nothing
    expect(upstreamTrustsFolder(new Map([[plain, true]]), repoDir)).toBe(false);
    expect(upstreamTrustsFolder(new Map(), plain)).toBe(false);
  });

  it("a standalone `fuigo --trust` on the main checkout covers its linked worktrees, and the record's cascade is judged on the workspace key like upstream", () => {
    const main = realRepo("main");
    const wt = linkedWorktree(main, "lane");
    const deep = join(wt, "server");
    mkdirSync(deep, { recursive: true });
    // the grant standalone Fuigo wrote from the main checkout
    expect(upstreamTrustsFolder(new Map([[main, true]]), wt)).toBe(true);
    expect(upstreamTrustsFolder(new Map([[main, true]]), deep)).toBe(true);
    // a grant written from inside the worktree is keyed on main too, so it
    // covers the main checkout and the other worktrees
    expect(upstreamTrustsFolder(new Map([[main, true]]), main)).toBe(true);
    // a declined main checkout declines its worktrees
    expect(upstreamTrustsFolder(new Map([[main, false]]), wt)).toBe(false);
    // a hand-edited record on the worktree's own path is not the workspace
    // key (the engine never writes one): upstream is_trusted queries the
    // key, so it neither covers nor overrides
    expect(upstreamTrustsFolder(new Map([[wt, true]]), wt)).toBe(false);
    expect(upstreamTrustsFolder(new Map([[main, true], [wt, false]]), wt)).toBe(true);
    const home = fuigoHomeIn("fuigo-home-wt");
    writeFileSync(join(home, "trusted_folders.toml"), `[folders."${main}"]\ntrusted = true\ndecided_at = 1789152451\n`);
    expect(scanFolderTrustSources(deep, { fuigoHome: home })).toEqual({ key: main, folder: deep, sources: [], upstreamTrusted: true });
  });

  it("the scan reports upstreamTrusted only when a Fuigo home is given and its store trusts the workspace", () => {
    const dir = repo("granted");
    writeFileSync(join(dir, "AGENTS.md"), "# a");
    const home = fuigoHomeIn("fuigo-home");
    writeFileSync(join(home, "trusted_folders.toml"), `[folders."${dir}"]\ntrusted = true\ndecided_at = 1789152451\n`);
    expect(scanFolderTrustSources(dir)).toEqual({ key: dir, folder: dir, sources: ["AGENTS.md"] });
    expect(scanFolderTrustSources(dir, { fuigoHome: null })).toEqual({ key: dir, folder: dir, sources: ["AGENTS.md"] });
    expect(scanFolderTrustSources(dir, { fuigoHome: home })).toEqual({ key: dir, folder: dir, sources: ["AGENTS.md"], upstreamTrusted: true });
    expect(scanFolderTrustSources(join(dir, "sub"), { fuigoHome: home })).toMatchObject({ upstreamTrusted: true });
    // a declined record upstream is no grant; Murage's own record still governs
    writeFileSync(join(home, "trusted_folders.toml"), `[folders."${dir}"]\ntrusted = false\n`);
    expect(scanFolderTrustSources(dir, { fuigoHome: home })).toEqual({ key: dir, folder: dir, sources: ["AGENTS.md"] });
    // an empty (provider-routed) home trusts nothing
    expect(scanFolderTrustSources(dir, { fuigoHome: fuigoHomeIn("routed-turn-home") })).toEqual({ key: dir, folder: dir, sources: ["AGENTS.md"] });
  });
});

describe("FolderTrustStore", () => {
  it("remembers a decision for the folder's whole workspace and persists it with the data", () => {
    const dir = repo("kept");
    const sub = join(dir, "pkg");
    mkdirSync(sub, { recursive: true });
    const file = join(root, "folder-trust.json");
    const store = new FolderTrustStore(file);
    expect(store.decision(dir)).toBeUndefined();
    expect(store.remember(sub, "trust", "picker")).toBe(dir);
    expect(store.decision(dir)).toBe("trust");
    expect(store.decision(sub)).toBe("trust");
    expect(store.record(sub)).toMatchObject({ decision: "trust", source: "picker", folder: sub });
    const reopened = new FolderTrustStore(file);
    expect(reopened.decision(join(dir, "another", "deeper"))).toBe("trust");
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ version: 1, folders: { [dir]: { decision: "trust" } } });
    // a later answer replaces the earlier one; forget asks again next time
    reopened.remember(dir, "reject", "card");
    expect(new FolderTrustStore(file).decision(sub)).toBe("reject");
    expect(reopened.forget(sub)).toBe(true);
    expect(new FolderTrustStore(file).decision(dir)).toBeUndefined();
    expect(reopened.forget(sub)).toBe(false);
  });

  it("refuses to record the home folder, and treats a damaged file as state to recover, never as empty", () => {
    const file = join(root, "folder-trust.json");
    const store = new FolderTrustStore(file);
    expect(store.remember(homedir(), "trust", "picker")).toBeNull();
    expect(store.decision(homedir())).toBeUndefined();
    writeFileSync(file, "{not json");
    expect(() => new FolderTrustStore(file)).toThrow(PersistedStateRecoveryError);
  });

  it("seeds pre-0.1.52 working folders once, never overrides a later Forget, and never re-runs (FUIGOTRUST2)", () => {
    const picked = repo("picked-before-upgrade");
    const other = join(root, "other-before-upgrade");
    mkdirSync(join(other, "sub"), { recursive: true });
    const decided = repo("already-decided");
    const file = join(root, "folder-trust.json");
    const store = new FolderTrustStore(file);
    store.remember(decided, "reject", "card");
    // first boot: every folder recorded, keyed on its workspace; an already
    // decided folder keeps its decision; home is never recorded
    expect(store.seedOnce([join(picked, "src"), join(other, "sub"), other, decided, homedir()], "0.1.52")).toBe(3);
    expect(store.record(picked)).toMatchObject({ decision: "trust", source: "upgrade", folder: join(picked, "src") });
    // outside a repository each folder is its own key
    expect(store.record(join(other, "sub"))).toMatchObject({ decision: "trust", source: "upgrade", folder: join(other, "sub") });
    expect(store.record(other)).toMatchObject({ decision: "trust", source: "upgrade", folder: other });
    expect(store.record(decided)).toMatchObject({ decision: "reject", source: "card" });
    expect(store.seeded).toBe("0.1.52");
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ version: 1, seededFrom: "0.1.52" });
    // a second boot with the same store changes nothing
    const second = new FolderTrustStore(file);
    expect(second.seeded).toBe("0.1.52");
    expect(second.seedOnce([picked, join(root, "new-folder")], "0.1.52")).toBe(-1);
    expect(second.record(join(root, "new-folder"))).toBeUndefined();
    // Forget survives a restart: the seed does not put the folder back
    expect(second.forget(picked)).toBe(true);
    const third = new FolderTrustStore(file);
    expect(third.seedOnce([picked], "0.1.52")).toBe(-1);
    expect(third.record(picked)).toBeUndefined();
    expect(third.seeded).toBe("0.1.52");
    // a store with nothing to seed still writes the marker so it never re-runs
    const empty = new FolderTrustStore(join(root, "empty-trust.json"));
    expect(empty.seedOnce([], "0.1.52")).toBe(0);
    expect(new FolderTrustStore(join(root, "empty-trust.json")).seeded).toBe("0.1.52");
  });

  it("ignores records that do not carry a decision", () => {
    const file = join(root, "folder-trust.json");
    writeFileSync(file, JSON.stringify({ version: 1, folders: { [root]: { decision: "maybe", decidedAt: 1, folder: root }, [join(root, "ok")]: { decision: "reject", decidedAt: 1, source: "card", folder: join(root, "ok") } } }));
    const store = new FolderTrustStore(file);
    expect(store.list().map((r) => r.key)).toEqual([join(root, "ok")]);
  });
});

describe("the card and the chip (shared)", () => {
  it("asks one question about the folder with the two answers and no free text", () => {
    const question = folderTrustQuestion({ key: "/repo", folder: "/repo/app", sources: ["AGENTS.md", ".mcp.json"] });
    expect(question).toMatchObject({ id: "folderTrust", header: "Folder trust", multiSelect: false, allowOther: false });
    expect(question.question).toContain("/repo/app");
    expect(question.question).toContain("AGENTS.md, .mcp.json");
    expect(question.options.map((o) => o.label)).toEqual([FOLDER_TRUST_OPTIONS.trust, FOLDER_TRUST_OPTIONS.reject]);
    expect(folderTrustDecision([{ id: "folderTrust", selected: [FOLDER_TRUST_OPTIONS.trust] }])).toBe("trust");
    expect(folderTrustDecision([{ id: "folderTrust", selected: [FOLDER_TRUST_OPTIONS.reject] }])).toBe("reject");
    expect(folderTrustDecision([{ id: "folderTrust", selected: ["Yes"] }])).toBeNull();
    expect(folderTrustDecision([])).toBeNull();
  });

  it("names what was withheld, bounded, and reads it back for the transcripts", () => {
    const name = folderTrustWithheldName(["AGENTS.md", "CLAUDE.md", ".mcp.json", ".fuigo/skills", ".claude/rules", ".envrc", ".fuigo/hooks", ".fuigo/agents"]);
    expect(name).toBe("untrusted folder: AGENTS.md, CLAUDE.md, .mcp.json, .fuigo/skills, .claude/rules, .envrc and 2 more");
    expect(folderTrustNotice(name)).toEqual({ kind: "withheld", sources: "AGENTS.md, CLAUDE.md, .mcp.json, .fuigo/skills, .claude/rules, .envrc and 2 more" });
    expect(folderTrustDisplayName("trusted folder: AGENTS.md")).toBe("Folder trusted — AGENTS.md apply from the next turn");
    expect(folderTrustNotice("stopped: the model connection was turned off")).toBeUndefined();
    expect(folderTrustNotice("error: boom")).toBeUndefined();
    expect(folderTrustNotice(undefined)).toBeUndefined();
  });
});
