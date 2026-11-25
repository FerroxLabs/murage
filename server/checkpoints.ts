import { withHideInherit } from "../shared/win-hide-child-process.mjs";
// Per-turn workspace checkpoints: a shadow git repository per bot+folder.
//
// Before a turn's engine can touch files, the working folder is snapshotted
// into a shadow repo at DATA_DIR/checkpoints/<botId>/<sha256(cwd)[..16]>/.git.
// The user's own .git (if the folder is a repository) is never read, written,
// or locked: every git call runs with GIT_DIR pointing at the shadow repo and
// GIT_WORK_TREE pointing at the folder, so the shadow index is the only index
// involved — and git always skips directories named .git when walking a work
// tree, so the user's repository internals are invisible to the snapshot.
//
// Restore is redo-friendly on purpose: it commits a safety point, then moves
// the index and work tree back with `git restore --source` (no clean: q1022-disk)
// while HEAD stays put — so the state that was just replaced is itself a
// checkpoint, and "undo the undo" is one more restore. Ignored/excluded files
// (node_modules, .env, media) are never snapshotted and never removed by one.
//
// Failure policy: checkpointing is best-effort convenience, never load-bearing.
// Any git failure disables the feature for that bot for the rest of the
// session and logs — nothing here ever throws into the turn path.
//
// Adapted from the checkpoint designs of Cline, Roo-Code, and Gemini CLI
// (all Apache-2.0): the per-call GIT_DIR/GIT_WORK_TREE/GIT_CONFIG_* env
// override and restore shape follow Gemini CLI's gitService, the sanitized
// GIT_* env list and the exclude categories follow Roo-Code's checkpoint
// service, and the snapshot-before-every-turn cadence follows Cline.
import { engineStderrRedacted } from "./drivers/acp/core.ts";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "./counted-fs.ts";
import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, parse, resolve } from "node:path";

import { samePath } from "../shared/path-identity.mjs";
import { DATA_DIR } from "./config.ts";
import { cachedProtectedFolders, volumeRootReason } from "./protected-folders.ts";

export const CHECKPOINTS_DIR = join(DATA_DIR, "checkpoints");

export type Checkpoint = { hash: string; at: number; label: string };
export type RestoreResult = { ok: true } | { ok: false; error: string };

/** Full sha1 hex only. The API hands out full hashes; accepting anything
 * looser would let arbitrary revspecs ("HEAD~3", "main@{u}") reach git. */
const COMMIT_HASH = /^[0-9a-f]{40}$/;

// What a checkpoint deliberately does not carry. Restores must never delete
// these either: restore touches no untracked file (no clean), so
// everything listed here survives a rollback untouched. Categories follow
// Roo-Code's checkpoint excludes: VCS internals, dependency trees, build
// output, caches, logs, secrets, media, archives, databases, model weights.
const EXCLUDES = `# Murage checkpoint excludes: never snapshotted, never removed by restore
.git/
.svn/
.hg/
node_modules/
bower_components/
.pnpm-store/
.venv/
venv/
.direnv/
__pycache__/
.pytest_cache/
.mypy_cache/
.ruff_cache/
.tox/
.gradle/
Pods/
dist/
build/
out/
.next/
.nuxt/
.output/
.svelte-kit/
target/
coverage/
.cache/
.parcel-cache/
.turbo/
.vite/
.terraform/
*.log
logs/
*.tmp
*.swp
.DS_Store
Thumbs.db
*.env*
.env
.env.*
*.pem
*.key
*.jpg
*.jpeg
*.png
*.gif
*.bmp
*.tiff
*.webp
*.ico
*.icns
*.psd
*.mp3
*.wav
*.flac
*.ogg
*.mp4
*.mov
*.avi
*.mkv
*.webm
*.zip
*.tar
*.gz
*.tgz
*.bz2
*.xz
*.7z
*.rar
*.jar
*.iso
*.dmg
*.sqlite
*.sqlite3
*.db
*.parquet
*.onnx
*.safetensors
*.gguf
`;

// gpgsign off: the user's global config may demand signing, and a shadow
// commit must never block on a passphrase prompt. gc off: background gc in
// a repo we treat as disposable only risks lock contention with snapshots.
const GITCONFIG = "[commit]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n[gc]\n\tauto = 0\n";

/** One failed git call disables checkpoints for that bot until restart —
 * a broken shadow repo must cost the user one log line, not a failed turn. */
const disabledBots = new Set<string>();

function disable(botId: string, message: string): void {
  disabledBots.add(botId);
  console.warn(`workspace checkpoints disabled for bot ${botId} this session: ${message}`);
}

// probed once: either the system has a usable git or checkpoints stay off
let gitProbe: Promise<boolean> | null = null;
function gitAvailable(): Promise<boolean> {
  gitProbe ??= new Promise((resolveProbe) => {
    execFile("git", ["--version"], { windowsHide: true }, (err) => resolveProbe(!err));
  });
  return gitProbe;
}

/** Folders a checkpoint must never be taken in: missing paths, the sprawling
 * personal folders (home, Desktop, Documents, Downloads and the rest — see
 * protected-folders.ts, which finds where they really are on each platform),
 * and the filesystem, volume or home root — snapshotting those would trawl
 * unbounded personal data into a repo, and a restore's rewrite there
 * would be an act of vandalism. */
export function refusalReason(cwd: string): string | null {
  if (!isAbsolute(cwd)) return "the working folder must be an absolute path";
  const requested = resolve(cwd);
  let stat;
  let dir: string;
  try {
    stat = statSync(requested);
    // Native realpath, not the JavaScript one: on Windows only the native call
    // hands back the folder's real casing and long name, which is what makes
    // the comparisons below see through 8.3 aliases and odd capitalisation.
    dir = realpathSync.native(requested);
  } catch {
    return "the working folder does not exist";
  }
  if (!stat.isDirectory()) return "the working folder is not a folder";
  // Compare canonical paths too: otherwise /tmp/home-link -> $HOME bypasses
  // the refusal while git still follows the symlink into the protected tree.
  if (samePath(dir, parse(dir).root)) return "checkpoints are not taken at the filesystem root";
  const requestedHome = resolve(homedir());
  const home = existsSync(requestedHome) ? realpathSync.native(requestedHome) : requestedHome;
  if (samePath(requested, requestedHome) || samePath(dir, home)) {
    return "checkpoints are not taken in the home folder";
  }
  for (const folder of cachedProtectedFolders(requestedHome)) {
    // A protected folder that does not exist still has to be refused by name:
    // on Windows with Known Folder Move the *default* location is often gone,
    // and a bot pointed at it would otherwise be told yes.
    const protectedDir = existsSync(folder.path) ? realpathSync.native(folder.path) : folder.path;
    if (samePath(requested, folder.path) || samePath(dir, protectedDir)) {
      return `checkpoints are not taken in the ${folder.label} folder`;
    }
  }
  // "/Volumes/Work" and "/Users/someone-else" are roots too; parse() cannot see it.
  return volumeRootReason(dir) ?? volumeRootReason(requested);
}

/** The shadow repo for a folder — and, through `serialize`, the lock that
 * keeps two turns in that folder off one work tree. Callers must hand this a
 * `realpathSync.native` path: the key is a digest of the string, so a second
 * spelling of one folder would otherwise open a second repo, hiding the
 * folder's checkpoints ("no checkpoints exist for this folder") and letting a
 * restore rewrite files beside a snapshot it never waited for. */
function shadowDir(botId: string, cwd: string): string {
  const key = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 16);
  return join(CHECKPOINTS_DIR, botId, key);
}

function gitEnv(shadow: string, cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Git has several redirection/config environment variables beyond the
  // common GIT_DIR set (for example GIT_COMMON_DIR and GIT_CONFIG_KEY_*).
  // None are needed by a local shadow repo, so clear the complete namespace
  // before installing the small, explicit environment below.
  for (const name of Object.keys(env)) {
    if (name.startsWith("GIT_")) delete env[name];
  }
  env.GIT_DIR = join(shadow, ".git");
  env.GIT_WORK_TREE = resolve(cwd);
  env.GIT_CONFIG_GLOBAL = join(shadow, "gitconfig");
  env.GIT_CONFIG_SYSTEM = join(shadow, "gitconfig_empty");
  env.GIT_AUTHOR_NAME = "Murage Checkpoint";
  env.GIT_AUTHOR_EMAIL = "checkpoint@murage.local";
  env.GIT_COMMITTER_NAME = "Murage Checkpoint";
  env.GIT_COMMITTER_EMAIL = "checkpoint@murage.local";
  return env;
}

/** Run one git command against the shadow repo. cwd is the WORK TREE — the
 * "." pathspec in add/restore resolves relative to it. A hung git (index
 * lock, dead network filesystem) would otherwise jam the per-repo queue for
 * the whole session, so every call carries a hard timeout. */
function runGit(args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout = 120_000): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "git",
      [...args],
      withHideInherit({ cwd, env, windowsHide: true, encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 }),
      (err, stdout, stderr) => {
        if (err) rejectPromise(new Error(`git ${args[0]}: ${engineStderrRedacted(stderr || err.message, false).trim().slice(0, 400)}`));
        else resolvePromise(stdout);
      },
    );
  });
}

/** `git diff --cached --quiet`: is there anything staged beyond HEAD? Used
 * instead of `status --porcelain` emptiness on purpose — a nested repo with
 * a dirty work tree shows up in status forever while staging nothing, which
 * would either commit empty churn every turn or fail the commit outright. */
function hasStagedChanges(cwd: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "git",
      ["diff", "--cached", "--quiet", "--ignore-submodules=dirty"],
      withHideInherit({ cwd, env, windowsHide: true, encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }),
      (err, _stdout, stderr) => {
        if (err === null) resolvePromise(false);
        else if (err.code === 1) resolvePromise(true);
        else rejectPromise(new Error(`git diff: ${engineStderrRedacted(stderr || err.message, false).trim().slice(0, 400)}`));
      },
    );
  });
}

// One operation at a time per shadow repo: snapshots and restores against the
// same folder queue behind each other (git's index lock would fail the loser
// anyway — this turns a crash into a wait). The stored tail never rejects, so
// one failed operation can't poison the queue.
const chains = new Map<string, Promise<void>>();
function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const tail = chains.get(key) ?? Promise.resolve();
  const run = tail.then(fn);
  chains.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/** Create the shadow repo on first use; self-heal its config files on every
 * use (they are tiny, and rewriting them lets exclude-list updates reach
 * shadows that already exist). The base commit is an EMPTY marker so HEAD
 * always resolves — it is filtered from listings and refused as a restore
 * target, because "restore to empty" on a user's own project folder would
 * delete their files. */
async function ensureShadow(cwd: string, env: NodeJS.ProcessEnv, shadow: string): Promise<void> {
  mkdirSync(shadow, { recursive: true, mode: 0o700 });
  writeFileSync(join(shadow, "gitconfig"), GITCONFIG, { mode: 0o600 });
  writeFileSync(join(shadow, "gitconfig_empty"), "", { mode: 0o600 });
  if (!existsSync(join(shadow, ".git", "HEAD"))) {
    // --template= keeps the user's init.templateDir hooks/config out
    await runGit(["init", "--initial-branch=main", "--template="], cwd, env);
  }
  mkdirSync(join(shadow, ".git", "info"), { recursive: true });
  writeFileSync(join(shadow, ".git", "info", "exclude"), EXCLUDES);
  try {
    await runGit(["rev-parse", "--verify", "HEAD"], cwd, env);
  } catch {
    // brand-new repo (or a crash between init and first commit)
    await runGit(["commit", "--no-verify", "--allow-empty", "-m", "checkpoint base"], cwd, env);
  }
}

type CommitResult = { hash: string; complete: boolean; large: string[] };

/** q1022-disk: retention and size bounds of a shadow repo. A checkpoint is kept while it is one of the newest
 * CHECKPOINT_KEEP or younger than CHECKPOINT_KEEP_MS (whichever keeps more); older history leaves once
 * CHECKPOINT_PRUNE_SLACK more have piled up behind it. A file over CHECKPOINT_MAX_FILE_BYTES is never copied in. */
export const CHECKPOINT_KEEP = 50;
export const CHECKPOINT_KEEP_MS = 14 * 24 * 60 * 60 * 1000;
export const CHECKPOINT_PRUNE_SLACK = 10;
export const CHECKPOINT_MAX_FILE_BYTES = 20 * 1024 * 1024;

/** Paths (relative, as git names them) of the folder's files over the size cap that git would otherwise copy in. */
async function largeFiles(cwd: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const out = await runGit(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd, env);
  const large = new Set<string>();
  for (const rel of out.split("\0")) {
    if (!rel) continue;
    try { const seen = lstatSync(join(cwd, rel)); if (seen.isFile() && seen.size > CHECKPOINT_MAX_FILE_BYTES) large.add(rel); } catch { /* gone since the listing */ }
  }
  return [...large].sort();
}
/** What a restore to `source` must leave alone: the large files already known (`large`), every source path the folder has as
 * a file that the safety point does not hold (ignored, excluded or over the size cap: restore would write the source's copy
 * over bytes no checkpoint has, Astra 48618e0c2f and 49e82fb258), the same for a name above a source path, and a source file
 * where the folder now has a directory holding anything no checkpoint has. */
async function restoreKeepOut(cwd: string, env: NodeJS.ProcessEnv, source: string, safety: string, large: readonly string[]): Promise<string[]> {
  const listed = async (rev: string) => (await runGit(["ls-tree", "-r", "-z", "--name-only", "--full-tree", rev], cwd, env)).split("\0").filter(Boolean);
  const paths = await listed(source), held = new Set(await listed(safety)), seen = new Map<string, boolean>();
  const unheld = (rel: string) => {
    if (held.has(rel)) return false;
    let answer = seen.get(rel);
    if (answer === undefined) {
      try { answer = !lstatSync(join(cwd, rel)).isDirectory(); } catch { answer = false; }
      seen.set(rel, answer);
    }
    return answer;
  };
  const folders = (rel: string) => rel.split("/").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("/"));
  const out = new Set(large);
  for (const rel of paths) {
    if (unheld(rel)) out.add(rel);
    for (const folder of folders(rel)) if (unheld(folder)) out.add(folder);
  }
  // a source file where the folder now has a directory: writing it would delete the directory, and whatever in it is in no
  // checkpoint (ignored or excluded files, large ones) has no copy anywhere, so such a directory stays as it is
  for (const rel of paths) {
    if (out.has(rel)) continue;
    let folder = false;
    try { folder = lstatSync(join(cwd, rel)).isDirectory(); } catch { /* not there */ }
    if (folder && (await runGit(["ls-files", "-z", "--others", "--", `:(literal)${rel}`], cwd, env)) !== "") out.add(rel);
  }
  return [...out];
}
/** Pathspecs that keep the large files out of add and restore (argv carries any name, line breaks included). */
const keepOut = (large: readonly string[]) => large.map(rel => `:(exclude,literal)${rel}`);

/** A large file is kept out by pathspecs (add, restore), never by an ignore line: the folder's own .gitignore can
 * re-include what info/exclude names (a "!name" there wins), and an ignored file would drop out of the listing above. It is
 * dropped from the index once, so it stays untracked: listed every time it is unignored, never added. */
async function excludeLarge(cwd: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const large = await largeFiles(cwd, env);
  if (!large.length) return large;
  await runGit(["rm", "--cached", "-q", "--ignore-unmatch", "--", ...large.map(rel => `:(literal)${rel}`)], cwd, env);
  // a tracked large file the folder ignores since: git add never adds it, and naming it to add, even as an exclude, fails the
  // add (a restore safety point would refuse); restore checks every source path's size on its own (restoreKeepOut)
  const ignored = new Set((await runGit(["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", ...large.map(rel => `:(literal)${rel}`)], cwd, env)).split("\0"));
  return large.filter(rel => !ignored.has(rel));
}

/** Drop history behind the kept checkpoints: the newest kept-out commit becomes the shallow boundary (the repo's new base,
 * which listing and restore already treat as the marker, not a checkpoint), so kept checkpoints keep their hashes; then
 * the reflog lets go and gc prunes what is no longer reachable. Runs on the shadow's own queue after the snapshot returned. */
async function pruneHistory(cwd: string, env: NodeJS.ProcessEnv, now: number): Promise<void> {
  const rows = (await runGit(["log", "--format=%H %ct"], cwd, env)).split("\n").filter(Boolean).map(line => line.split(" "));
  let keep = CHECKPOINT_KEEP;
  while (keep < rows.length && now - Number(rows[keep]![1]) * 1000 < CHECKPOINT_KEEP_MS) keep++;
  // rows[keep] is the new base; prune only once SLACK commits sit behind it
  if (rows.length - 1 - keep < CHECKPOINT_PRUNE_SLACK) return;
  writeFileSync(join(env.GIT_DIR!, "shallow"), `${rows[keep]![0]}\n`);
  // Collecting is the costly half, and the next turn's snapshot waits for it on this queue. The shadow repo is never
  // packed (gc.auto=0), so its objects are loose and prune alone frees the pruned history: a reachability walk plus
  // deletes, no repack and no rewrite of what is kept. It has its own bound, and after a failure this shadow skips it for
  // a day (the boundary above still moved, so the list stays bounded; the next turns do not wait on one that keeps failing).
  const gitDir = env.GIT_DIR!;
  if ((gcFailedAt.get(gitDir) ?? -Infinity) > now - GC_RETRY_MS) return;
  try {
    await runGit(["reflog", "expire", "--expire=now", "--all"], cwd, env, GC_TIMEOUT_MS);
    await runGit(["prune", "--expire=now"], cwd, env, GC_TIMEOUT_MS);
    gcFailedAt.delete(gitDir);
  } catch (e) { gcFailedAt.set(gitDir, now); throw e; }
}
const GC_TIMEOUT_MS = 5 * 60 * 1000;
const GC_RETRY_MS = 24 * 60 * 60 * 1000;
const gcFailedAt = new Map<string, number>();

/** Stage everything and commit if anything actually changed. `complete`
 * records whether every path was indexable: ordinary snapshots may keep the
 * useful subset, but restore must not delete files its safety point missed. */
async function commitAll(cwd: string, env: NodeJS.ProcessEnv, label: string): Promise<CommitResult> {
  // --ignore-errors skips files git cannot index (unreadable, FIFOs) instead
  // of aborting — but still exits 1 when it skipped an unreadable file, so
  // the exit code is retained even though a partial snapshot remains useful.
  // Restore treats an incomplete safety point as a hard stop before touching
  // the work tree.
  let complete = true;
  const large = await excludeLarge(cwd, env);
  await runGit(["add", "-A", "--ignore-errors", "--", ".", ...keepOut(large)], cwd, env).catch(() => {
    complete = false;
  });
  if (await hasStagedChanges(cwd, env)) {
    await runGit(["commit", "--no-verify", "-m", label], cwd, env);
  }
  return { hash: (await runGit(["rev-parse", "HEAD"], cwd, env)).trim(), complete, large };
}

/** Snapshot the folder. Returns the checkpoint hash, or null when the
 * feature is off for this bot, git is missing, or the folder is refused.
 * Never throws — this is called fire-and-forget on the turn path. */
export async function snapshot(botId: string, cwd: string, label: string): Promise<string | null> {
  if (disabledBots.has(botId)) return null;
  if (!(await gitAvailable())) return null;
  if (refusalReason(cwd) !== null) return null;
  try {
    const worktree = realpathSync.native(resolve(cwd));
    const shadow = shadowDir(botId, worktree);
    const env = gitEnv(shadow, worktree);
    const hash = await serialize(shadow, async () => {
      await ensureShadow(worktree, env, shadow);
      return (await commitAll(worktree, env, label)).hash;
    });
    // background: the turn has its checkpoint; the next snapshot of this folder queues behind the prune
    void serialize(shadow, () => pruneHistory(worktree, env, Date.now()))
      .catch(e => console.warn(`workspace checkpoint prune skipped for bot ${botId}: ${e instanceof Error ? e.message : String(e)}`));
    return hash;
  } catch (e) {
    disable(botId, e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** Every checkpoint for this bot+folder, newest first. Empty when nothing
 * was ever snapshotted (listing never creates the shadow repo). The empty
 * base marker is omitted — it is not a state anyone should return to. */
export async function listCheckpoints(botId: string, cwd: string): Promise<Checkpoint[]> {
  if (disabledBots.has(botId)) return [];
  if (!(await gitAvailable())) return [];
  if (refusalReason(cwd) !== null) return [];
  try {
    const worktree = realpathSync.native(resolve(cwd));
    const shadow = shadowDir(botId, worktree);
    if (!existsSync(join(shadow, ".git", "HEAD"))) return [];
    return await serialize(shadow, async () => {
      const env = gitEnv(shadow, worktree);
      const out = await runGit(["log", "--format=%H%x09%ct%x09%s"], worktree, env);
      const lines = out.split("\n").filter((line) => line.trim() !== "");
      lines.pop(); // the root of the log is always the empty base marker
      return lines.flatMap((line) => {
        const [hash, seconds, ...subject] = line.split("\t");
        if (!hash || !COMMIT_HASH.test(hash)) return [];
        return [{ hash, at: Number(seconds) * 1000, label: subject.join("\t") }];
      });
    });
  } catch (e) {
    disable(botId, e instanceof Error ? e.message : String(e));
    return [];
  }
}

/** Can this bot take/restore checkpoints in this folder right now? */
export async function checkpointsEnabled(botId: string, cwd: string): Promise<boolean> {
  return !disabledBots.has(botId) && (await gitAvailable()) && refusalReason(cwd) === null;
}

/** Move the folder's files back to a checkpoint. The current state is
 * committed first ("before restore"), so the restore itself shows up as a
 * checkpoint and can be undone; HEAD never moves backwards, only forward
 * over the "restored" commit. Excluded and gitignored files are untouched. */
export async function restore(botId: string, cwd: string, hash: string, options: { assertCurrent?: () => void } = {}): Promise<RestoreResult> {
  if (disabledBots.has(botId)) {
    return { ok: false, error: "checkpoints are disabled for this bot until the app restarts (an earlier snapshot failed: see the server log)" };
  }
  if (!(await gitAvailable())) return { ok: false, error: "git is not installed on this machine" };
  const reason = refusalReason(cwd);
  if (reason !== null) return { ok: false, error: reason };
  if (!COMMIT_HASH.test(hash)) return { ok: false, error: "hash must be a full 40-character checkpoint hash" };
  try {
    const worktree = realpathSync.native(resolve(cwd));
    const shadow = shadowDir(botId, worktree);
    if (!existsSync(join(shadow, ".git", "HEAD"))) {
      return { ok: false, error: "no checkpoints exist for this folder" };
    }
    return await serialize(shadow, async (): Promise<RestoreResult> => {
      options.assertCurrent?.();
      const env = gitEnv(shadow, worktree);
      try {
        await runGit(["cat-file", "-e", `${hash}^{commit}`], worktree, env);
      } catch {
        return { ok: false, error: "no such checkpoint" };
      }
      const base = (await runGit(["rev-list", "--max-parents=0", "HEAD"], worktree, env)).trim();
      if (base === hash) return { ok: false, error: "that is the empty base marker, not a checkpoint" };
      // a commit behind the kept history (pruned, its objects not yet collected) is no checkpoint any more (q1022-disk)
      try { await runGit(["merge-base", "--is-ancestor", hash, "HEAD"], worktree, env); } catch { return { ok: false, error: "no such checkpoint" }; }
      // safety point: whatever is about to be overwritten becomes restorable
      const safety = await commitAll(worktree, env, "before restore");
      if (!safety.complete) {
        return {
          ok: false,
          error: "restore stopped because some current files could not be added to the checkpoint taken before a restore",
        };
      }
      // Index AND work tree move to the source; HEAD stays put. --staged
      // matters: with a work-tree-only restore, a file that exists in the
      // source but not in the index (deleted in a later checkpoint, now
      // resurrected) would be untracked the moment restore recreates it.
      // Restoring the index too removes every file the safety point holds
      // that the source lacks; untracked files are left alone (see below).
      options.assertCurrent?.();
      // a file over the size cap is in no checkpoint as it is now, so restore leaves it as it is (q1022-disk), ignored or not
      const large = await restoreKeepOut(worktree, env, hash, safety.hash, safety.large);
      // the keep-out scan awaits git: the folder may have been replaced meanwhile, so the lease is checked again right
      // before restore writes (Astra 57a91517c8: otherwise the replacement folder is overwritten and only caught after)
      options.assertCurrent?.();
      // a file saved during the scan is in no safety point: refuse rather than overwrite it (Astra f382199d76)
      try {
        await runGit(["diff", "--quiet", safety.hash, "--", ".", ...keepOut(large)], worktree, env);
      } catch {
        return { ok: false, error: "files in this folder changed while the restore was starting, so nothing was restored; try again" };
      }
      options.assertCurrent?.();
      await runGit(["restore", "--source", hash, "--staged", "--worktree", "--", ".", ...keepOut(large)], worktree, env);
      options.assertCurrent?.();
      // No clean (q1022-disk, Astra e40607932a): restore already removed every file the safety point held that the source
      // lacks, so whatever untracked file is left is one no checkpoint holds (ignored, excluded, over the size cap, made
      // unignored by the restore's own .gitignore change, or written after the safety point). Removing it would lose data.
      // record the post-restore state (also re-syncs the index with the
      // deletions restore made), so the timeline shows the rollback
      await commitAll(worktree, env, `restored ${hash.slice(0, 8)}`);
      return { ok: true };
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    disable(botId, message);
    return { ok: false, error: `restore failed: ${message}` };
  }
}
