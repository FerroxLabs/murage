// Owner: rig-realsize lane. A replay of a run's evidence must give the verdict the live run gave: the rig and the replay
// both call verdictOfEvidence (verdict.mjs), so an INVALID run can never replay GREEN; and a replay reads only the one sealed
// run it names (openRun / sealRun / replayRun). The fixture (fixture.mjs) is the shape of a small clean run (3 turns,
// 2 delegations, no symptom, every turn finished); the replay is the real CLI on a real evidence root and run id.
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import { GB, VALID, writeCleanRun } from "./fixture.mjs";
import { exitCodeOf, openRun, RUN_COMPLETE, replayRun, sealRun, verdictOfEvidence } from "./verdict.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "verdict.mjs");
const root = mkdtempSync(join(tmpdir(), "rig-replay-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** One finished run, as rig.mts leaves it: a fresh run dir, the evidence, the live verdict sealed last. */
function evidence(name, change = (e) => e) {
  const dir = writeCleanRun(openRun(root, name), change);
  sealRun(dir, name, verdictOfEvidence(dir).verdict);
  return dir;
}
/** The documented replay: the CLI on the evidence root and the run id. */
function replay(dir) {
  const run = spawnSync(process.execPath, [CLI, dirname(dir), basename(dir)], { encoding: "utf8" });
  return { exit: run.status, verdict: /^RIG (\w+)/.exec(run.stdout)?.[1], line: run.stdout };
}
const withFacts = (facts) => (e) => ({ ...e, facts: { ...e.facts, ...facts } });

it("a clean run under full pressure replays GREEN, exit 0 (the rule can pass)", () => {
  const dir = evidence("green");
  expect(verdictOfEvidence(dir)).toMatchObject({ verdict: "GREEN", red: [], invalid: [] });
  expect(replay(dir)).toMatchObject({ exit: 0, verdict: "GREEN" });
});

it("the same clean run with no tracked notebook is INVALID live and replays INVALID, exit 2, never GREEN", () => {
  const dir = evidence("no-notebook", withFacts({ trackedLinks: 0 }));
  const live = verdictOfEvidence(dir);
  expect(live.verdict).toBe("INVALID");
  expect(live.invalid).toEqual(["no tracked notebook"]);
  expect(exitCodeOf(live.verdict)).toBe(2);
  const replayed = replay(dir);
  expect(replayed).toMatchObject({ exit: 2, verdict: "INVALID" });
  expect(replayed.line).toContain("invalid=no tracked notebook");
});

const rules = {
  "no delegation accepted": (e) => ({ ...e, completionInput: { ...e.completionInput, delegations: [] } }),
  "no admission-lock pulse": (e) => ({ ...e, serverLog: "turn dispatch thread=t-a" }),
  "ballast short of RIG_DB_GB": withFacts({ dbBytes: 0.1 * GB }),
  "no turn accepted": (e) => ({ ...e, completionInput: { ...e.completionInput, sends: e.completionInput.sends.map((s) => ({ ...s, status: 503 })) } }),
  "load ended before the run did (exit=1 signal=null)": withFacts({ loadEndedEarly: "ended before the run did (exit=1 signal=null)" }),
  "event stream reconnected 2x (turn ends may be missing)": withFacts({ eventReconnects: 2 }),
};
for (const [reason, change] of Object.entries(rules)) {
  it(`validity rule "${reason}" holds on replay: never GREEN, never exit 0`, () => {
    const dir = evidence(`rule-${Object.keys(rules).indexOf(reason)}`, change);
    const result = verdictOfEvidence(dir);
    expect(result.invalid).toContain(reason);
    expect(result.verdict).not.toBe("GREEN");
    const replayed = replay(dir);
    expect(replayed.exit).not.toBe(0);
    expect(replayed.verdict).toBe(result.verdict);
  });
}

it("evidence written before the validity facts were recorded replays INVALID, not GREEN", () => {
  const result = verdictOfEvidence(evidence("old-evidence", (e) => ({ ...e, facts: undefined })));
  expect(result.verdict).toBe("INVALID");
  expect(result.invalid).toContain("validity-input.json missing from the evidence");
  expect(replay(evidence("old-evidence-cli", (e) => ({ ...e, facts: undefined })))).toMatchObject({ exit: 2, verdict: "INVALID" });
});

it("a fact that is missing or the wrong type is INVALID, never read as fine", () => {
  for (const name of Object.keys(VALID)) {
    const dir = evidence(`fact-${name}`, (e) => { const facts = { ...e.facts }; delete facts[name]; return { ...e, facts }; });
    const result = verdictOfEvidence(dir);
    expect(result.verdict).toBe("INVALID");
    expect(result.invalid).toContain(`${name} not recorded in this evidence`);
  }
  expect(verdictOfEvidence(evidence("fact-string", withFacts({ trackedLinks: "3" }))).verdict).toBe("INVALID");
});

it("missing evidence files are INVALID: a server log alone cannot be given a GREEN", () => {
  const logOnly = evidence("log-only", (e) => ({ serverLog: e.serverLog }));
  expect(replay(logOnly)).toMatchObject({ exit: 2, verdict: "INVALID" });
  expect(verdictOfEvidence(evidence("no-log", (e) => ({ ...e, serverLog: undefined }))).invalid).toContain("server.log missing from the evidence");
  expect(replay(join(root, "no-log"))).toMatchObject({ exit: 2, verdict: "INVALID" });
  expect(verdictOfEvidence(evidence("no-starts", (e) => ({ ...e, completionInput: { ...e.completionInput, starts: undefined } }))).verdict).toBe("INVALID");
  // the old forms (a log file, or a dir with no run id) are refused, not judged
  expect(spawnSync(process.execPath, [CLI, join(logOnly, "server.log")], { encoding: "utf8" }).status).toBe(2);
  expect(spawnSync(process.execPath, [CLI, logOnly], { encoding: "utf8" }).status).toBe(2);
});

it("RED outranks INVALID, live and replayed: a symptom or an unfinished turn in an under-pressured run is still RED, exit 1", () => {
  const symptom = evidence("red-symptom", (e) => ({ ...withFacts({ trackedLinks: 0 })(e), serverLog: `${e.serverLog}\n[mount-relay] mount unavailable mount="ops_metrics" cause=ipc` }));
  expect(verdictOfEvidence(symptom)).toMatchObject({ verdict: "RED", red: ["ownerMountLost"], invalid: ["no tracked notebook"] });
  expect(replay(symptom)).toMatchObject({ exit: 1, verdict: "RED" });
  const unfinished = evidence("red-unfinished", (e) => ({ ...e, rows: e.rows.filter((row) => row.id !== "ev-turn-send-1") }));
  const result = verdictOfEvidence(unfinished);
  expect(result.verdict).toBe("RED");
  expect(result.completion.unfinished.map((u) => u.tag)).toEqual(["rigturn-1-1"]);
  expect(replay(unfinished)).toMatchObject({ exit: 1, verdict: "RED" });
});

// ---- the evidence lifecycle: one fresh dir per run, sealed last; a replay reads only the sealed run it names

it("a run that wrote all its evidence but failed before the seal (e.g. server.stop threw) replays INVALID, never GREEN", () => {
  const dir = writeCleanRun(openRun(root, "unsealed"));
  expect(verdictOfEvidence(dir).verdict).toBe("GREEN"); // the files alone would pass
  const result = replayRun(root, "unsealed");
  expect(result).toMatchObject({ verdict: "INVALID", refused: true });
  expect(result.invalid[0]).toContain(`has no ${RUN_COMPLETE}`);
  expect(replay(dir)).toMatchObject({ exit: 2, verdict: "INVALID" });
});

it("a run dir is never reused: openRun refuses an existing run id and leaves its files as they were", () => {
  const dir = evidence("taken");
  expect(() => openRun(root, "taken")).toThrow(/EEXIST/);
  expect(replay(dir)).toMatchObject({ exit: 0, verdict: "GREEN" });
  for (const bad of ["", "../taken", "a/b", ".hidden", "x".repeat(129)]) expect(() => openRun(root, bad)).toThrow(/run id/);
});

it("a sealed file changed, added to or removed after the seal makes the replay INVALID", () => {
  appendFileSync(join(evidence("changed"), "server.log"), "\nlate line from another run");
  expect(replay(join(root, "changed"))).toMatchObject({ exit: 2, verdict: "INVALID" });
  expect(replayRun(root, "changed").invalid[0]).toContain("server.log changed after run changed was sealed");
  rmSync(join(evidence("removed"), "validity-input.json"));
  expect(replayRun(root, "removed")).toMatchObject({ verdict: "INVALID", refused: true });
  // a seal written before a file existed does not cover a file added later: only the four inputs together are a run
  const early = writeCleanRun(openRun(root, "sealed-early"), (e) => ({ ...e, facts: undefined }));
  sealRun(early, "sealed-early", "GREEN");
  writeCleanRun(early, (e) => ({ facts: e.facts }));
  expect(replayRun(root, "sealed-early")).toMatchObject({ verdict: "INVALID", refused: true });
});

it("a seal copied from another run is refused: the seal names its own run id", () => {
  const a = evidence("seal-a");
  const b = writeCleanRun(openRun(root, "seal-b"));
  copyFileSync(join(a, RUN_COMPLETE), join(b, RUN_COMPLETE));
  expect(replayRun(root, "seal-b")).toMatchObject({ verdict: "INVALID", refused: true });
  expect(replayRun(root, "seal-b").invalid[0]).toContain("belongs to run \"seal-a\"");
  expect(replay(b)).toMatchObject({ exit: 2, verdict: "INVALID" });
});

it("a replay is never kinder than the live verdict: a run sealed RED or INVALID cannot replay GREEN", () => {
  for (const recorded of ["RED", "INVALID"]) {
    const dir = writeCleanRun(openRun(root, `was-${recorded}`));
    sealRun(dir, `was-${recorded}`, recorded);
    expect(replayRun(root, `was-${recorded}`)).toMatchObject({ verdict: "INVALID", recorded });
    expect(replay(dir).exit).toBe(2);
  }
});

it("an unknown run id or a path instead of an id is refused", () => {
  evidence("known");
  expect(replayRun(root, "unknown")).toMatchObject({ verdict: "INVALID", refused: true });
  expect(replayRun(root, "../known")).toMatchObject({ verdict: "INVALID", refused: true });
  expect(spawnSync(process.execPath, [CLI, root, "unknown"], { encoding: "utf8" }).status).toBe(2);
  // the out file may not be written into the run it judges
  expect(spawnSync(process.execPath, [CLI, root, "known", join(root, "known", "verdict.json")], { encoding: "utf8" }).status).toBe(2);
});

it("a replay that crashes on its evidence has no verdict: exit 2, never the RED code 1 or GREEN", () => {
  const dir = evidence("crash");
  rmSync(join(dir, "server.log"));
  mkdirSync(join(dir, "server.log")); // a sealed file that can no longer be read as a file
  const run = spawnSync(process.execPath, [CLI, root, "crash"], { encoding: "utf8" });
  expect(run.status).toBe(2);
  expect(run.stderr).toContain("RIG INVALID replay failed");
});
