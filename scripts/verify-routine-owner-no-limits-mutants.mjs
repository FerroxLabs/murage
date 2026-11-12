import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const evidence = resolve(process.argv[2] ?? "routine-gate-evidence/mutants");
mkdirSync(evidence, { recursive: true });
const approver = "server/auto-approve.ts";
const service = "server/routine-requests.ts";
const originals = new Map([approver, service].map(file => [file, readFileSync(file, "utf8")]));
const run = name => {
  const result = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "server/routine-owner-no-limits.test.ts"], { encoding: "utf8" });
  const log = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  writeFileSync(join(evidence, `${name}.log`), log);
  return { status: result.status, log };
};
const predicate = "ownerNoLimits(authority.bot, authority.context)";
const mutants = [
  ["M1-restore-permission-taint", approver,
    'const decision = finalDecision(reads, tool, { kind: "clean-owner", deny });',
    'if (context?.outsideRead !== null && verdict.approve === null) reads.push(cutRead("held-policy"));\n  const decision = finalDecision(reads, tool, context?.outsideRead === null ? { kind: "clean-owner", deny } : { kind: "tainted-owner" });'],
  ["M2-drop-owner", service, `${predicate} && authority.context.channelOwner !== true`,
    "authority.bot.autoApprove === true && authority.bot.fullAccess === true && authority.bot.noLimits === true"],
  ["M3-drop-level", service, predicate,
    "ownerNoLimits({ ...authority.bot, autoApprove: true, fullAccess: true, noLimits: true }, authority.context)"],
  ["M4-restore-routine-taint", service, predicate, `${predicate} && authority.context.outsideRead === null`],
  ["M5-drop-target-revalidation", service,
    '      if (operation.action === "create" && operation.forBot && this.validateTarget) {\n        const refusal = this.validateTarget(botId, operation.forBot);\n        if (refusal) throw new RoutineRequestError(refusal, 403);\n      }\n', ""],
];
try {
  if (run("baseline").status !== 0) throw new Error("Baseline must pass before mutation testing");
  for (const [name, file, before, after] of mutants) {
    const source = originals.get(file);
    if (source.split(before).length !== 2) throw new Error(`Ambiguous mutation anchor: ${name}`);
    writeFileSync(file, source.replace(before, after));
    try {
      const result = run(name);
      if (result.status === 0 || !result.log.includes("AssertionError")) throw new Error(`Mutant survived or failed without an assertion: ${name}`);
      console.log(`${name}: KILLED`);
    } finally { writeFileSync(file, source); }
  }
} finally {
  for (const [file, source] of originals) writeFileSync(file, source);
}
