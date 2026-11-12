import { renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
// These additive files do not exist at frozen F0.1. Temporarily remove the new
// implementations from the isolated fixture to reproduce its missing APIs.
const files = ["server/highlevel/returned-identities.ts", "server/highlevel/approval-idempotency.ts", "server/highlevel/operations/returned-identity-schemas.ts"];
const moved = [];
try {
  for (const file of files) { renameSync(file, `${file}.f02-red`); moved.push(file); }
  const run = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "server/highlevel/returned-identities.test.ts", "server/highlevel/approval-idempotency.test.ts"], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  writeFileSync("evidence/f02/red.log", output);
  writeFileSync("evidence/f02/red.rc", `${run.status}\n`);
  if (run.status === 0 || run.error || !/Cannot find module|Failed to resolve|Failed to load/u.test(output)) throw new Error("Missing-API baseline did not go RED as expected");
  console.log("RED: F0.1 lacks returned identity and approval idempotency APIs");
} finally { for (const file of moved.reverse()) renameSync(`${file}.f02-red`, file); }
