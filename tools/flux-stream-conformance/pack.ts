// Packs the suite for the Flux team: one directory, flux-stream-conformance/,
// holding run.mjs, fixtures/, manifest.json and README.md, as
// flux-stream-conformance-<version>.tgz, with manifest.json beside it.
//   pnpm flux-stream:conformance:pack            writes dist/flux-stream-conformance/
//   node --experimental-strip-types tools/flux-stream-conformance/pack.ts --out <dir>
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
import { buildSuite, defaultOut, repoRoot } from "./build.ts";

const here = dirname(fileURLToPath(import.meta.url));
const out = process.argv.includes("--out") ? resolve(process.argv[process.argv.indexOf("--out") + 1]) : defaultOut;

// the version lives in run.ts (--version prints it); read it from there
const version = /const VERSION = "(\d+\.\d+\.\d+)"/.exec(readFileSync(join(here, "run.ts"), "utf8"))?.[1];
if (!version) throw new Error("run.ts has no VERSION constant");

await buildSuite(out);
// the check inventory comes from the bundle itself, which also proves it runs
const checkIds = JSON.parse(execFileSync(process.execPath, [join(out, "run.mjs"), "--list-checks"], { encoding: "utf8" })) as string[];

const contractPath = "shared/flux-stream-contract.ts";
const manifest = {
  name: "flux-stream-conformance",
  version,
  contract: { module: contractPath, sha256: createHash("sha256").update(readFileSync(join(repoRoot, contractPath))).digest("hex") },
  checks: checkIds.length,
  check_ids: checkIds,
  node: ">=24",
  run: "node run.mjs --mode acceptance --target flux --url wss://<host>/v1 --key-env FLUX_KEY --key2-env FLUX_KEY2 --free-key-env FLUX_FREE_KEY --restricted-key-env FLUX_RESTRICTED_KEY --flux-faults --report report.json",
  exit_codes: { 0: "pass", 1: "one or more checks or gates failed", 2: "usage error: unknown flag, bad or empty --only, a missing key env var, a bad --mode, --target, --commit, --starts-per-minute or --max-inflight, or a missing --url" },
};

const stage = join(out, ".stage");
const dir = join(stage, "flux-stream-conformance");
safeWipeSync(stage, { within: out });
mkdirSync(dir, { recursive: true });
cpSync(join(out, "run.mjs"), join(dir, "run.mjs"));
cpSync(join(out, "fixtures"), join(dir, "fixtures"), { recursive: true });
cpSync(join(here, "README.md"), join(dir, "README.md"));
const json = `${JSON.stringify(manifest, null, 2)}\n`;
writeFileSync(join(dir, "manifest.json"), json);
writeFileSync(join(out, "manifest.json"), json);

const tgz = join(out, `flux-stream-conformance-${version}.tgz`);
execFileSync("tar", ["czf", tgz, "-C", stage, "flux-stream-conformance"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
safeWipeSync(stage, { within: out });
process.stdout.write(`${tgz}\n${join(out, "manifest.json")}\n`);
