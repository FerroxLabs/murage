// SPDX-License-Identifier: AGPL-3.0-or-later
// FUIGO-TRUST-V2 R4, R5: a home Murage created for one provider-routed turn starts
// empty, so the engine would ask about everything and hold no earlier "no". The core
// carries Murage's stored answers into that home as Fuigo's own trusted_folders.toml.
// Only stored records and the turn's own policy folder reach this file. The owner's
// own Fuigo home is never written.
import { randomBytes } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { cloudTurnRender } from "./cloud-home/turn-process.ts";
import { folderTrustKey, folderTrustRejectFor, isUnrecordableTrustRoot, type FolderTrustReject } from "./folder-trust.ts";

export const FUIGO_TRUST_FILE = "trusted_folders.toml";
/** The launcher's limits, deploy/cloud-home/murage-turn-launch.py. */
export const CLOUD_SEED_MAX_PATHS = 1024;
export const CLOUD_SEED_MAX_PATH_BYTES = 4096;
/** Half the launcher's RENDER_MAX, so the route beside the seeds always fits: past
 * it the launcher would refuse every turn, where a skipped seed falls back to R3. */
export const CLOUD_SEED_MAX_BYTES = 256 * 1024;
const POLICY_WALK_MAX_ENTRIES = 10_000;
const POLICY_WALK_MAX_MS = 2_000;

export interface FuigoSeedRecords {
  trustKeys: readonly string[];
  rejects: readonly FolderTrustReject[];
  realCwd: string;
}

export interface FuigoSeedPlan {
  trusts: string[];
  declines: string[];
  /** a decline stayed out, so nothing else may be seeded and R3 answers instead */
  declineSkipped: boolean;
  policySeeded: boolean;
}

/** R4 validation. A string that fails is never written. */
export function fuigoSeedPathValid(path: string, cloudHome: string | null = null): boolean {
  if (typeof path !== "string" || /[\u0000-\u001f\u007f]/u.test(path) || /\p{Cs}/u.test(path)) return false;
  if (isUnrecordableTrustRoot(path)) return false;
  if (cloudHome === null) return true;
  return path !== cloudHome && Buffer.byteLength(path, "utf8") <= CLOUD_SEED_MAX_PATH_BYTES;
}

/** What this turn's seed holds. `policyFolder` is the R5 folder when R5 allows it. */
export function planFuigoSeeds(records: FuigoSeedRecords, policyFolder: string | null, cloudHome: string | null = null): FuigoSeedPlan {
  const bounded = cloudHome !== null;
  let spent = 0;
  const fits = (path: string, count: number) => {
    if (!bounded) return true;
    const cost = Buffer.byteLength(JSON.stringify(path), "utf8") + 1;
    if (count >= CLOUD_SEED_MAX_PATHS || spent + cost > CLOUD_SEED_MAX_BYTES) return false;
    spent += cost;
    return true;
  };
  // Every reject, stamped or legacy, at its key AND at its folder.
  const declines: string[] = [];
  let declineSkipped = false;
  for (const path of new Set(records.rejects.flatMap((reject) => [reject.key, reject.folder]))) {
    if (fuigoSeedPathValid(path, cloudHome) && fits(path, declines.length)) declines.push(path);
    else declineSkipped = true;
  }
  if (declineSkipped) return { trusts: [], declines, declineSkipped, policySeeded: false };
  const taken = new Set(declines);
  const trusts: string[] = [];
  const addTrust = (path: string) => {
    // One table per string: a string that is also a decline stays a decline.
    if (taken.has(path) || !fuigoSeedPathValid(path, cloudHome)) return false;
    // Path-of-cwd: the engine must ask for T, so rule 2 can say no to a reject its coverage would miss.
    if (folderTrustRejectFor(records.rejects, path, records.realCwd)) return false;
    if (!fits(path, trusts.length)) return false;
    taken.add(path);
    trusts.push(path);
    return true;
  };
  for (const key of records.trustKeys) addTrust(key);
  const policySeeded = policyFolder !== null && (trusts.includes(policyFolder) || addTrust(policyFolder));
  return { trusts, declines, declineSkipped, policySeeded };
}

/** Fuigo's store: `set_untrusted` and a grant both write consent 2. `decided_at` is optional. */
export function fuigoSeedText(plan: Pick<FuigoSeedPlan, "trusts" | "declines">): string {
  const table = (path: string, trusted: boolean) => `[folders.${JSON.stringify(path)}]\ntrusted = ${trusted}\nconsent = 2\n`;
  return [...plan.declines.map((path) => table(path, false)), ...plan.trusts.map((path) => table(path, true))].join("\n");
}

/** Rename onto a name that must not exist yet. Any failure leaves no file, so the
 * engine asks and R3 answers: a partial store would neither trust nor ask (F8). */
export function writeFuigoSeed(home: string, text: string): boolean {
  const file = join(home, FUIGO_TRUST_FILE);
  try {
    lstatSync(file);
    console.warn("[folder-trust] a fresh Fuigo home already holds a trust file; nothing seeded");
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[folder-trust] could not check a fresh Fuigo home: ${(error as NodeJS.ErrnoException).code ?? "unknown"}`);
      return false;
    }
  }
  const temp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  let fd: number | null = null;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const bytes = Buffer.from(text, "utf8");
    for (let at = 0; at < bytes.length; ) at += writeSync(fd, bytes, at);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temp, file);
    return true;
  } catch (error) {
    if (fd !== null) { try { closeSync(fd); } catch { /* it is being removed */ } }
    rmSync(temp, { force: true });
    console.warn(`[folder-trust] could not write a Fuigo seed: ${(error as NodeJS.ErrnoException).code ?? "unknown"}`);
    return false;
  }
}

function pathsToRoot(folder: string): string[] {
  const paths = [folder];
  for (let parent = dirname(folder); parent !== paths[paths.length - 1]; parent = dirname(parent)) paths.push(parent);
  return paths;
}

const present = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
};

/** Whether anything named `.git` sits below `folder`. A directory entry's type is
 * lstat's, so a symlink is never followed; a walk that stops early or errs counts
 * as found. Awaited, so a large folder never holds the server for the 2 s budget. */
async function gitBelow(folder: string): Promise<boolean> {
  const deadline = Date.now() + POLICY_WALK_MAX_MS;
  const pending = [folder];
  let seen = 0;
  try {
    while (pending.length) {
      const current = pending.pop()!;
      for await (const entry of await opendir(current)) {
        if (entry.name === ".git" || ++seen > POLICY_WALK_MAX_ENTRIES || Date.now() > deadline) return true;
        if (entry.isDirectory()) pending.push(join(current, entry.name));
      }
    }
    return false;
  } catch {
    return true;
  }
}

/** R5's two conditions on the policy folder `realpath(cwd)`. */
export async function folderPolicySeedAllowed(realCwd: string, rejects: readonly FolderTrustReject[]): Promise<boolean> {
  const onPath = pathsToRoot(realCwd);
  if (rejects.length) {
    const covered = new Set(onPath.flatMap((path) => [path, folderTrustKey(path)]));
    if (rejects.some((reject) => covered.has(reject.key) || covered.has(reject.folder))) return false;
  }
  for (const path of onPath) if (await present(join(path, ".git"))) return false;
  return !(await gitBelow(realCwd));
}

export interface FuigoSeedOutcome extends FuigoSeedPlan {
  /** R4: every Murage decline reached this home. Read by R3 rule 3 and the card. */
  declinesSeeded: boolean;
  /** The stored key the S5a chip names, or null. */
  chipKey: string | null;
}

/** R4 end to end for one fresh home. A Cloud home's seed is only planned here: the
 * caller renders it, and the launcher fails the turn rather than start it without it. */
export async function seedFuigoHome(
  home: { path: string; cloud: boolean },
  input: FuigoSeedRecords & { policyGrant: boolean; cloudHome: string | null },
): Promise<FuigoSeedOutcome> {
  const { trustKeys, rejects, realCwd, policyGrant, cloudHome } = input;
  const policyFolder = policyGrant && await folderPolicySeedAllowed(realCwd, rejects) ? realCwd : null;
  const plan = planFuigoSeeds({ trustKeys, rejects, realCwd }, policyFolder, cloudHome);
  const seeded = plan.trusts.length + plan.declines.length > 0;
  const written = seeded && (home.cloud || writeFuigoSeed(home.path, fuigoSeedText(plan)));
  if (seeded && !written) return { ...plan, trusts: [], declines: [], policySeeded: false, declinesSeeded: false, chipKey: null };
  const chip = written && plan.declines.includes(realCwd) ? rejects.find((reject) => reject.key === realCwd || reject.folder === realCwd) : undefined;
  return { ...plan, declinesSeeded: !plan.declineSkipped, chipKey: chip?.key ?? null };
}

/** The typed render keys of a Cloud turn; the launcher writes the file inside the namespace. */
export function cloudRenderFuigoSeed(env: NodeJS.ProcessEnv, seed: Pick<FuigoSeedPlan, "trusts" | "declines">): void {
  if (seed.declines.length) cloudTurnRender(env, "fuigoDeclinedFolders", seed.declines);
  if (seed.trusts.length) cloudTurnRender(env, "fuigoTrustedFolders", seed.trusts);
}
