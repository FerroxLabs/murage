import * as fs from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { ACCOUNTING_KEYS, scrubCore, safeAccounting } from "./scrub-accounting.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const selected = name => /^(server-.*\.log|failed-turns-.*\.jsonl|results-.*\.json|gate-.*\.md|verdict-.*\.json)$/s.test(name);
const identity = s => [s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs].join(":");
const inspect = path => fs.lstatSync(path, { bigint: true });


// Buffer names preserve the snapshot's raw filename bytes.
export function enumerate(root) {
  let rootStat;
  try { rootStat = inspect(root); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw Error("invalid input directory");
  const rows = [];
  rows.directories = [[Buffer.alloc(0), identity(inspect(root))]];
  const walk = (dir, prefix = Buffer.alloc(0), debug = false) => {
    for (const name of fs.readdirSync(dir, { encoding: "buffer" })) {
      const rel = Buffer.concat([prefix, name]), path = Buffer.concat([Buffer.from(root + sep), rel]);
      if (!debug && name.toString() !== "debug" && !selected(name.toString())) continue;
      const stat = inspect(path);
      if (stat.isSymbolicLink()) throw Error("selected symlink");
      if (stat.isDirectory() && (debug || name.toString() === "debug")) {
        rows.directories.push([rel, identity(stat)]);
        walk(path, Buffer.concat([rel, Buffer.from("/")]), true);
      }
      else if (stat.isFile() && (debug || name.toString() !== "debug")) rows.push({ rel, path, stat });
      else throw Error("selected special file or directory");
    }
  };
  walk(root);
  return rows.sort((a, b) => Buffer.compare(a.rel, b.rel));
}

export function capture(root, view) {
  const before = enumerate(root), tuples = [];
  for (const row of before) {
    if (/^server-.*\.log$/s.test(row.rel.toString()) && row.stat.size > 256n * 1024n * 1024n) throw Error("server log exceeds 256 MiB");
    const fd = fs.openSync(row.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let bytes;
    try {
      if (identity(fs.fstatSync(fd, { bigint: true })) !== identity(row.stat)) throw Error("source changed");
      bytes = fs.readFileSync(fd);
      if (identity(fs.fstatSync(fd, { bigint: true })) !== identity(row.stat)) throw Error("source changed");
    } finally { fs.closeSync(fd); }
    tuples.push(row.rel, Buffer.from("\0" + bytes.length + "\0" + hash(bytes) + "\0"));
    if (view) {
      const dest = Buffer.concat([Buffer.from(view + "/"), row.rel]);
      // Directory names emitted by the enumerator are data, never shell input.
      const slash = dest.lastIndexOf(47);
      fs.mkdirSync(dest.subarray(0, slash), { recursive: true, mode: 0o700 });
      fs.writeFileSync(dest, bytes, { flag: "wx", mode: 0o600 });
    }
  }
  const after = enumerate(root);
  const dirs = rows => (rows.directories ?? []).map(([name, id]) => name.toString("hex") + ":" + id).sort().join("\n");
  if (dirs(before) !== dirs(after)) throw Error("source directory changed");
  if (before.length !== after.length || before.some((r, i) => !r.rel.equals(after[i].rel) || identity(r.stat) !== identity(after[i].stat))) throw Error("source enumeration changed");
  return hash(Buffer.concat(tuples));
}

export function scrubRecord(value, validate = false) {
  if (typeof value === "string") {
    if (validate) { if (!safeAccounting(value)) throw Error("unsafe journal string"); return value; }
    // Preserve validated production strings, including terminal accounting cuts.
    return safeAccounting(value) ? value : scrubCore(value);
  }
  if (Array.isArray(value)) return value.map(v => scrubRecord(v, validate));
  if (value === null || typeof value !== "object") return value;
  const out = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    const name = scrubRecord(key, validate);
    if (Object.hasOwn(out, name)) throw Error("transformed journal key collision");
    if (ACCOUNTING_KEYS.has(key.toLowerCase())) {
      if (validate && item !== "x") throw Error("unsafe accounting property");
      out[name] = "x";
    } else out[name] = scrubRecord(item, validate);
  }
  return out;
}
export function scrubJournal(text) {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const output = lines.map(line => {
    const record = JSON.parse(line);
    if (!record || typeof record !== "object" || Array.isArray(record)) throw Error("journal record must be an object");
    const encoded = JSON.stringify(scrubRecord(record));
    const decoded = JSON.parse(encoded);
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw Error("serialized journal record must be an object");
    scrubRecord(decoded, true);
    return encoded;
  });
  return { text: output.join("\n") + (output.length ? "\n" : ""), linesIn: lines.length, linesKept: output.length, linesDropped: 0 };
}

export function keep(out, root, id, suppliedStage) {
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id === "." || id === "..") throw Object.assign(Error("bad run id"), { status: 2 });
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (inspect(out).isSymbolicLink()) throw Error("input directory symlink");
  out = fs.realpathSync(out); root = fs.realpathSync(root);
  if ((root + sep).startsWith(out + sep) || (out + sep).startsWith(root + sep)) throw Object.assign(Error("overlapping roots"), { status: 2 });
  const dest = join(root, id);
  if (fs.existsSync(dest)) throw Object.assign(Error("archive exists"), { status: 2 });
  const tmp = suppliedStage ? fs.realpathSync(suppliedStage) : fs.mkdtempSync(join(root, ".keep-" + id + "-"));
  if (suppliedStage && (!tmp.startsWith(root + sep + ".keep-" + id + ".") || !inspect(tmp).isDirectory() || fs.readdirSync(tmp).length)) throw Error("invalid private stage");
  let failure;
  try {
    const view = join(tmp, "input"), archive = join(tmp, "archive");
    fs.mkdirSync(view, { mode: 0o700 }); fs.mkdirSync(archive, { mode: 0o700 });
    const snapshot = capture(out, view), manifest = { version: 2, snapshot, logs: [], journals: [] };
    for (const row of enumerate(view)) {
      const name = row.rel.toString(), destPath = Buffer.concat([Buffer.from(archive + "/"), row.rel]);
      fs.mkdirSync(destPath.subarray(0, destPath.lastIndexOf(47)), { recursive: true, mode: 0o700 });
      let bytes = fs.readFileSync(row.path);
      if (/^server-.*\.log$/s.test(name)) {
        if (bytes.length > 256 * 1024 * 1024) throw Error("server log exceeds 256 MiB");
        bytes = Buffer.from(scrubCore(bytes.toString("utf8")));
        if (!safeAccounting(bytes.toString("utf8"))) throw Error("server log validation failed");
        manifest.logs.push(name);
      } else if (/^failed-turns-.*\.jsonl$/s.test(name)) {
        const journal = scrubJournal(bytes.toString("utf8"));
        bytes = Buffer.from(journal.text);
        manifest.journals.push({ name, linesIn: journal.linesIn, linesKept: journal.linesKept, linesDropped: 0 });
      }
      fs.writeFileSync(destPath, bytes, { mode: 0o600, flag: "wx" });
    }
    if (!manifest.logs.length && !manifest.journals.length) throw Object.assign(Error("no server log or journal"), { status: 3 });
    fs.writeFileSync(join(archive, "manifest.json"), JSON.stringify(manifest) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(archive, dest);
  } catch (error) { failure = error; }
  try { fs.rmSync(tmp, { recursive: true }); } catch (error) { failure ??= error; }
  if (failure) throw failure;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.umask(0o077);
  try {
    if (process.argv[2] === "--capture") console.log(capture(process.argv[3], process.argv[4]));
    else keep(...process.argv.slice(2));
  } catch (error) { console.error("keep-logs: " + error.message); process.exitCode = error.status ?? 4; }
}
