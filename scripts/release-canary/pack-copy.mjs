import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { classifyDataDirEntry, isRestorableDataDirName } from "../../server/data-dir-inventory.ts";

const DERIVED = new Set([
  "data-version.json", "memory-index", "memory-index.db", "memory-index.db-walstop",
  "memory-index.db-walok", "memory-index.db-walattempt", "search.db", "search.db-wal",
  "search.db-shm", "memory-upgrade-overall.json", "memory-upgrade-counts.json",
  "memory-upgrade-status.json", "memory-repairs.json",
]);
const AUTHORITY = /^(?:mcp-access\.token|sentinel-io|mcp-grants\.json|pending-grants\.json|claude-signin-answers\.json|claude-private|env|cloud-computer-turns\.json|decision-gate\.jsonl|pending-deletions\.json|news-signup\.json)(?:\.|$)/i;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function allowed(name, info, topLevel) {
  if (AUTHORITY.test(name) || !(info.isDirectory() || (info.isFile() && info.nlink === 1))) return false;
  if (!topLevel) return true;
  const kind = classifyDataDirEntry(name)?.backup;
  if (!kind || (!isRestorableDataDirName(name) && kind !== "sidecar" && !DERIVED.has(name))) return false;
  return info.isDirectory() === (kind === "owner-folder" || name === "memory-index");
}

async function* entries(root, parent = "") {
  const directory = join(root, parent);
  for (const name of await readdir(directory)) {
    const path = parent ? `${parent}/${name}` : name;
    const info = await lstat(join(root, path));
    const include = allowed(name, info, !parent);
    yield { path, include, directory: info.isDirectory() };
    if (include && info.isDirectory()) yield* entries(root, path);
  }
}

async function readBots(root) {
  const bots = JSON.parse(await readFile(join(root, "bots.json"), "utf8"));
  if (!Array.isArray(bots) || !bots.every(record)) throw new Error("INVALID_PACK_BOTS");
  return bots;
}

export async function packInventoryViolations(root) {
  const violations = [];
  if (!(await lstat(root)).isDirectory()) throw new Error("INVALID_PACK_DIRECTORY");
  for await (const { path, include } of entries(root)) {
    if (!include) violations.push(path);
    else if (path === "queued-messages.json") {
      const queue = JSON.parse(await readFile(join(root, path), "utf8"));
      if (!Array.isArray(queue) || queue.length) violations.push(path);
    } else if (path === "bots.json") {
      if ((await readBots(root)).some((bot) =>
        Object.hasOwn(bot, "pendingHeldWork") && (!Array.isArray(bot.pendingHeldWork) || bot.pendingHeldWork.length))) {
        violations.push(path);
      }
    }
  }
  return violations;
}

export async function copySyntheticPack({ kind, source, destination }) {
  if (kind !== "synthetic") throw new Error("DATA_NOT_ALLOWED");
  if (!(await lstat(source)).isDirectory()) throw new Error("INVALID_PACK_DIRECTORY");
  const input = await realpath(source);
  const target = resolve(await realpath(dirname(destination)), basename(destination));
  const subpath = relative(input, target);
  if (!subpath || (subpath !== ".." && !subpath.startsWith(`..${sep}`) && !isAbsolute(subpath))) {
    throw new Error("PACK_DESTINATION_IN_SOURCE");
  }

  await mkdir(target, { mode: 0o700 });
  const skipped = [];
  const emptied = [];
  try {
    for await (const { path, include, directory } of entries(input)) {
      if (!include) {
        skipped.push(path);
        continue;
      }
      const output = join(target, path);
      if (directory) await mkdir(output, { mode: 0o700 });
      else if (path === "queued-messages.json") {
        await writeFile(output, "[]", { flag: "wx", mode: 0o600 });
        emptied.push(path);
      } else if (path === "bots.json") {
        const bots = await readBots(input);
        for (const bot of bots) {
          if (Object.hasOwn(bot, "pendingHeldWork")) {
            bot.pendingHeldWork = [];
            if (!emptied.includes(path)) emptied.push(path);
          }
        }
        await writeFile(output, JSON.stringify(bots), { flag: "wx", mode: 0o600 });
      } else await copyFile(join(input, path), output, constants.COPYFILE_EXCL);
    }
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
  return { skipped, emptied };
}
