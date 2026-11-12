// Run only in an isolated fixture container. Every kill requires an assertion.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
const output = process.argv[2], filter = process.argv[3] ?? "";
if (!output) throw Error("usage: node fix-mutants.mjs <evidence-dir> [id-prefix]");
mkdirSync(output, { recursive: true });
const cases = [
  ["F1-raw", "upstream.ts", "noLimitsCode(identity, source)", "noLimitsCode(identity, { code: source })", "F1 direct code identity"],
  ["F1-language", "backstop.ts", 'if (args.language !== undefined && args.language !== "python")', "if (false)", "conflicting or unknown language"],
  ["F2-code", "backstop.ts", 'if (code.incomplete) return deny(id, "truncated");', 'if (code.incomplete) return { allow: true, callId: id };', "over-reader-budget code"],
  ["F2-work", "backstop.ts", 'if (code.incomplete) return deny(id, "truncated");', 'if (code.incomplete) return { allow: true, callId: id };', "work exhaustion below"],
  ["F2-shell", "backstop.ts", 'if (source.incomplete) return deny(id, "truncated");', 'if (source.incomplete) return { allow: true, callId: id };', "over-reader-budget shell"],
  ["F2-proxy", "upstream.ts", 'result.cls === "plainWipe" && readCode(identity, source).reads.some(read => read.state === "cut")', "false", "word proxy hide a nested reader cut"],
  ["F3-placement", "backstop.ts", "return pathAliases(rawPath);", "return pathAliases(p.path);", "F3 symlink before dot-dot"],
  ["F3-components", "compile.ts", 'const pending = raw.split("/").reverse();', 'const pending = lexical.split("/").reverse();', "F3 symlink before dot-dot"],
  ["F4-before", "backstop.ts", 'if (!verifyNativeDenyIntegrity(session)) return deny(id, "retired-or-tamper");', 'if (false) return deny(id, "retired-or-tamper");', "request use point before"],
  ["F4-after", "backstop.ts", "session.generation !== generation || !verifyNativeDenyIntegrity(session)", "session.generation !== generation", "pending allow use point"],
  ["F4-bytes", "backstop.ts", "sha256(readFileSync(pin.path)) !== pin.hash", "false", "F4 binding amendment 4"],
];
const results = [];
for (const [id, name, from, to, match] of cases.filter(([id]) => id.startsWith(filter))) {
  const file = join("server/native-deny", name), original = readFileSync(file, "utf8");
  if (original.split(from).length !== 2) throw Error(`${id}: ambiguous or missing mutation anchor`);
  try {
    writeFileSync(file, original.replace(from, to));
    const result = spawnSync("node_modules/.bin/vitest", ["run", "server/native-deny/fix-regressions.test.ts", "-t", match], { encoding: "utf8", timeout: 120_000 });
    const log = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    writeFileSync(join(output, `${id}.log`), log);
    const killed = result.status !== 0 && result.status !== null && /AssertionError/.test(log) && /Tests\s+.*failed/.test(log);
    results.push({ id, killed, exit: result.status });
    process.stdout.write(`${id} ${killed ? "KILLED" : "SURVIVED/INVALID"}\n`);
  } finally { writeFileSync(file, original); }
}
if (!results.length) throw Error("empty mutation selection");
writeFileSync(join(output, "results.json"), JSON.stringify(results, null, 2) + "\n");
if (results.some(result => !result.killed)) process.exitCode = 1;
