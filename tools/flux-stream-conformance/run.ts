// tools/flux-stream-conformance/run.ts
// The conformance suite's command line. From the repo:
//   pnpm flux-stream:conformance -- --mode acceptance --target flux --url wss://<host>/v1 --key-env FLUX_KEY
// From the packaged artifact:
//   node run.mjs --mode acceptance --target flux --url wss://<host>/v1 --key-env FLUX_KEY
// Run `--help` for every flag. Keys come from environment variables, never
// from argv (argv shows in ps). Exit codes: 0 pass, 1 a check or gate failed,
// 2 usage error.
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SESSION_STARTS_PER_MINUTE } from "../../shared/flux-stream-contract.ts";
import { CHECK_IDS, acceptanceFailures, runChecks, type Mode, type Target } from "./checks.ts";
import { loadFixtures } from "./fixtures/analyse.ts";
import { OWNER_TARGETS, ownerPasses, runOwner } from "./owner.ts";

const VERSION = "1.0.2";

/** Flags that take a value, and flags that stand alone. Anything else is a usage error. */
const VALUE_FLAGS = [
  "mode", "target", "base", "url", "key-env", "key2-env", "free-key-env", "restricted-key-env", "commit", "eagerness",
  "min-silence", "max-silence", "only", "owner-recording", "report", "starts-per-minute", "max-inflight",
];
const BOOLEAN_FLAGS = ["sim", "flux-faults", "no-latency", "profile", "help", "version", "list-checks"];

const HELP = `flux-stream-conformance ${VERSION}: the contract A conformance suite for Flux streaming transcription.

usage (from the repo):      pnpm flux-stream:conformance -- [flags]
usage (from the artifact):  node run.mjs [flags]

target
  --url <ws base>             the stream base, ending /v1, for example wss://<host>/v1 (alias: --base)
  --base <ws base>            same as --url

mode
  --mode acceptance|dev       acceptance runs the fixed inventory and fails on any check that
                              did not run; dev is for iteration and says so at the top of its report
                              (default dev)
  --target flux|murage        whose acceptance this is; required in acceptance mode. flux runs the
                              contract checks and the four protocol latency gates; murage adds the profile
  --only P01,T05              run only these check ids (dev mode only; an unknown or empty list exits 2)
  --list-checks               print the check ids as JSON and exit

keys (environment variable NAMES; the key is read from the variable, never from argv)
  --key-env <NAME>            the API key, sent in the Authorization header (default FLUX_KEY)
  --key2-env <NAME>           a key on a second account (check X01)
  --free-key-env <NAME>       a key on a plan without streaming (check A04)
  --restricted-key-env <NAME> a key restricted from streaming (check A07)
  There is no ticket flow for Flux: auth is the API key only.

server capabilities
  --sim                       the base is the simulator (magic keys, sim faults, traces)
  --flux-faults               the server accepts provider fault injection (staging with test faults on)
  --no-latency                a real speech provider is not behind the base: skip the latency and accuracy checks
  --profile                   also run Murage's profile checks (implied by --target murage)
  --starts-per-minute <n>     the server's fleet-wide session start cap (default ${SESSION_STARTS_PER_MINUTE}), used by check L10

session policy
  --eagerness low|medium|high turn eagerness (default medium)
  --min-silence <ms>          min_silence_ms on every session
  --max-silence <ms>          max_silence_ms on every session
  --commit on|off             Murage's punctuation commit in the profile runs (default on)
  --max-inflight <n>          sessions open at once during check L10's burst (default 4, the per-account concurrency limit)

output
  --owner-recording <dir>     the owner-voice qualification (needs --target murage); numbers only
  --report <file>             write the full report as JSON (counts, codes and WER; never transcript text)
  --version                   print the suite version
  --help                      this text

check A06 (client tokens) is report-only: it is skipped by design on a Flux acceptance run and does not fail it.

check L10 (start cap): against a real server it spends cap + 1 short sessions (90 + 1 by default),
each closed at once. The cap is fleet-wide, so on a shared staging fleet other traffic counts too: a
refusal on an earlier attempt is reported as a failure with the attempt number. The check waits for this
run's own earlier starts to leave the 60 s window first, and runs last. The burst is pipelined (at most
--max-inflight sessions open, each closed as soon as it starts). On an early fleet-cap refusal it waits out
the window and retries the burst once.

exit codes: 0 pass; 1 one or more checks or gates failed; 2 usage error (unknown flag, bad --only, missing key
variable, bad --mode, --target, --commit, --starts-per-minute or --max-inflight, missing --url).
`;

function parseArgs(argv: string[]): { values: Map<string, string>; flags: Set<string> } {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const name = a.slice(2);
    if (BOOLEAN_FLAGS.includes(name)) flags.add(name);
    else if (VALUE_FLAGS.includes(name)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`--${name} needs a value`);
      values.set(name, v);
      i += 1;
    } else throw new Error(`unknown flag ${a}`);
  }
  return { values, flags };
}

const usage = (why: string): never => {
  process.stderr.write(`${why}\nrun with --help for every flag\n`);
  process.exit(2);
};

let parsed: ReturnType<typeof parseArgs>;
try {
  parsed = parseArgs(process.argv.slice(2));
} catch (error) {
  parsed = usage(error instanceof Error ? error.message : String(error));
}
const arg = (name: string) => parsed.values.get(name);
const flag = (name: string) => parsed.flags.has(name);
const env = (name: string) => (arg(name) ? process.env[arg(name)!] : undefined);

if (flag("help")) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (flag("version")) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}
if (flag("list-checks")) {
  process.stdout.write(`${JSON.stringify(CHECK_IDS)}\n`);
  process.exit(0);
}

const mode = (arg("mode") ?? "dev") as Mode;
const target = arg("target") as Target | undefined;
if (arg("base") && arg("url") && arg("base") !== arg("url")) usage("--base and --url are the same flag: give one");
const base = arg("url") ?? arg("base");
const keyEnv = arg("key-env") ?? "FLUX_KEY";
const key = process.env[keyEnv];
if (!base) usage("--url <ws base> is required");
if (!key) usage(`the API key is read from the environment variable ${keyEnv}, and it is not set`);
if (mode !== "acceptance" && mode !== "dev") usage("--mode is acceptance or dev");
if (target !== undefined && target !== "flux" && target !== "murage") usage("--target is flux or murage");
if (mode === "acceptance" && !target) usage("acceptance mode needs --target flux or --target murage");
if (arg("commit") !== undefined && arg("commit") !== "on" && arg("commit") !== "off") usage("--commit is on or off");
const maxInflight = arg("max-inflight") === undefined ? undefined : Number(arg("max-inflight"));
if (maxInflight !== undefined && !(Number.isInteger(maxInflight) && maxInflight >= 1)) usage("--max-inflight is a whole number of 1 or more");
const startsPerMinute = arg("starts-per-minute") === undefined ? undefined : Number(arg("starts-per-minute"));
if (startsPerMinute !== undefined && !(Number.isInteger(startsPerMinute) && startsPerMinute >= 1)) usage("--starts-per-minute is a whole number of 1 or more");
if (target === "flux" && (flag("profile") || arg("owner-recording"))) {
  usage("--target flux runs the contract inventory: Murage's profile and owner-voice runs belong to --target murage");
}
const extraQuery: Record<string, string> = {};
if (arg("min-silence")) extraQuery.min_silence_ms = arg("min-silence")!;
if (arg("max-silence")) extraQuery.max_silence_ms = arg("max-silence")!;

// the fixtures sit in a fixtures/ directory next to this file, in the repo and in the artifact
const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "fixtures");
if (!existsSync(join(fixturesDir, "manifest.json"))) usage(`no fixtures next to ${here}`);

let report;
try {
  report = await runChecks(
    {
      mode,
      target,
      base: base!,
      key: key!,
      key2: env("key2-env"),
      freeKey: env("free-key-env"),
      restrictedKey: env("restricted-key-env"),
      sim: flag("sim"),
      fluxFaults: flag("flux-faults"),
      latency: !flag("no-latency"),
      profile: target === "murage" || flag("profile"),
      commit: arg("commit") !== "off",
      eagerness: arg("eagerness"),
      extraQuery,
      startsPerMinute,
      maxInflight,
      fixtures: loadFixtures(fixturesDir),
    },
    arg("only")?.split(",").filter(Boolean),
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}

const mark = (s: string) => (s === "pass" ? "✅" : s === "fail" ? "❌" : "⬜");
const lines = [
  mode === "acceptance" ? "# Conformance: acceptance run" : "# Conformance: dev run (not an acceptance run)",
  "",
  `| check | status | ms | detail |`,
  `|---|---|---|---|`,
  ...report.results.map((r) => `| ${r.id} | ${mark(r.status)} ${r.status} | ${r.ms} | ${r.detail ?? ""} |`),
  "",
  `| metric | p50 | p90 | n |`,
  `|---|---|---|---|`,
  ...Object.entries(report.metrics).map(([k, v]) => `| ${k} | ${Math.round(v.p50 * 100) / 100} | ${Math.round(v.p90 * 100) / 100} | ${v.n} |`),
  "",
  `| gate | value | limit | samples | pass |`,
  `|---|---|---|---|---|`,
  ...report.gates.map((g) => `| ${g.id} | ${Math.round(g.value)} | ${g.limit} | ${g.samples}/${g.needed} | ${g.pass ? "✅" : "❌"} |`),
];
// the owner-voice qualification (spec E.4, F), run with the SAME session policy
// as this run (its query and commit setting): per condition, every line scored
const policy = { query: { eagerness: arg("eagerness") ?? "medium", ...extraQuery }, commit: arg("commit") !== "off" };
const owner = arg("owner-recording") ? await runOwner(base!, key!, arg("owner-recording")!, policy) : [];
for (const o of owner) {
  const limit = OWNER_TARGETS[o.condition];
  lines.push(`| owner ${o.condition} | p50 ${Math.round(o.p50)} / p90 ${Math.round(o.p90)} ms | target p50 ${limit} | WER ${(o.wer * 100).toFixed(1)} % | splits ${o.splits}/${o.pauseLines} | anomalies ${o.anomalies.length} | missing ${o.missing.length} | ${ownerPasses(o) ? "✅" : "❌"} |`);
}
const failures = mode === "acceptance" ? acceptanceFailures(report, target!) : [
  ...report.results.filter((r) => r.status === "fail").map((r) => `check ${r.id}`),
  ...report.gates.filter((g) => !g.pass).map((g) => `gate ${g.id}`),
];
failures.push(...owner.filter((o) => !ownerPasses(o)).map((o) => `owner ${o.condition}`));
if (failures.length) lines.push("", "Failed:", ...failures.map((f) => `- ${f}`));
process.stdout.write(`${lines.join("\n")}\n`);
if (arg("report")) writeFileSync(arg("report")!, JSON.stringify({ ...report, owner, failures }, null, 2));
process.exit(failures.length ? 1 : 0);
