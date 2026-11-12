// Fakes only. Run in an isolated checkout/container, never in a live app.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
const output = process.argv[2];
if (!output) throw Error("usage: node s0-mutants.mjs <evidence-dir>");
mkdirSync(output, { recursive: true });
const cases = [
  ["M3", "socket.ts", 'finish(denied(id, "socket-error"))', 'finish({ allow: true, callId: id, operationSha256: operationSha256(request) })', "socket.test.ts", "socket down"],
  ["M6", "backstop.ts", 'const found = await (deps.read ?? readNativeCommand)', 'const found = command.startsWith("sh -c") ? null : await (deps.read ?? readNativeCommand)', "backstop.test.ts", "denies"],
  ["M12", "backstop.ts", 'if (!complete(args))', 'if ("outside" in request && request.outside) return deny(id, "outside");\n  if (!complete(args))', "backstop.test.ts", "M12"],
  ["M13", "compile.ts", 'scope: cls === "system" ? "descendants" as const : "self" as const', 'scope: "descendants" as const', "compile.test.ts", "T-DS-1"],
  ["M14", "compile.ts", 'except: cls === "system" ? [...metadata.exceptions] : []', 'except: []', "compile.test.ts", "T-DS-1"],
  ["M19", "backstop.ts", 'if (session.seen.has(id))', 'if (false)', "backstop.test.ts", "rejects missing fields"],
  ["M20", "backstop.ts", 'return !Object.hasOwn(args, "truncated") && !Object.hasOwn(args, "inputMissing") && !Object.hasOwn(args, "toolInputMissing") && !Object.hasOwn(args, "_truncated");', 'return true;', "backstop.test.ts", "incomplete arguments"],
  ["M25", "backstop.ts", 'return args.chars === "" ?', 'return typeof args.chars === "string" ?', "backstop.test.ts", "M25"],
  ["M26", "backstop.ts", 'NATIVE_DENY_DEADLINE_MS = 10_000;', 'NATIVE_DENY_DEADLINE_MS = 20 * 24 * 60 * 60 * 1000;', "backstop.test.ts", "fails closed on reader throw"],
];
const results = [];
for (const [id, name, from, to, test, match] of cases) {
  const file = join("server/native-deny", name), before = readFileSync(file, "utf8");
  const count = before.split(from).length - 1;
  // M3 mutates both error fallback sites to model the same fail-open behavior.
  if (count !== 1 && !(id === "M3" && count === 2)) throw Error(`${id}: mutation anchor count ${count}`);
  try {
    writeFileSync(file, before.replaceAll(from, to));
    const result = spawnSync("node_modules/.bin/vitest", ["run", join("server/native-deny", test), "-t", match], { encoding: "utf8", timeout: 120_000 });
    const log = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    writeFileSync(join(output, `${id}.log`), log);
    const killed = result.status !== 0 && result.status !== null && /AssertionError/.test(log) && /Tests\s+.*failed/.test(log);
    results.push({ id, killed, exit: result.status });
    process.stdout.write(`${id} ${killed ? "KILLED" : "SURVIVED/INVALID"}\n`);
  } finally { writeFileSync(file, before); }
}
writeFileSync(join(output, "results.json"), JSON.stringify(results, null, 2) + "\n");
if (results.some(result => !result.killed)) process.exitCode = 1;
