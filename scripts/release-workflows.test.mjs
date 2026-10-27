// Static assertions over the release workflows.
//
// These exist because merging a version bump to main now auto-starts a signed,
// notarized build that uploads to a public releases repo. Nothing in the repo
// executes that path before it runs for real, so the properties that keep it
// safe are asserted here instead of discovered in production:
//
//   - the push trigger is narrow (main + package.json only)
//   - a push-started run cannot publish; `publish` is a dispatch input only
//   - the release repo is ours, reached with RELEASES_PAT
//   - the should_release guard fails closed when the pre-push blob is missing
//   - every expensive job is gated on that guard
//   - no upstream identity survived the port
//
// Parsing, not grepping: an `if:` in the wrong place still greps fine.

import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { removeTempDirSync } from "../server/testing/cleanup.ts";
import { check, deriveOses, readLists, select } from "./ci-test-tiers.mjs";

describe("WhatsApp final release evidence", () => {
  const jobs = parse(readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8")).jobs;
  it.each(["mac", "mac-x64", "windows", "linux"])("uploads WhatsApp reports and probe diagnostics after failure on %s", job => {
    const steps = jobs[job].steps;
    const evidence = steps.find(step => step.with?.name === `${job}-whatsapp-gepa-evidence`);
    expect(evidence.if).toBe("always()");
    expect(evidence.with.path).toBe(job === "mac-x64" ? "qualification-evidence/whatsapp-*\nqualification-evidence/memory-*\n" : "qualification-evidence/whatsapp-*");
    for (const gate of steps.filter(step => step.run?.includes("scripts/smoke-whatsapp-packaged.mjs"))) {
      expect(gate.if).toBeUndefined(); expect(gate["continue-on-error"]).toBeUndefined();
      expect(gate.run).toMatch(/2> qualification-evidence\/whatsapp-[\w-]+-probe\.log/);
    }
  });
  it.each(["mac", "mac-x64", "windows", "linux"])("binds final bytes and retains failure diagnostics for %s", job => {
    const steps = jobs[job].steps;
    const bind = steps.find(step => step.name === "Bind WhatsApp reports to final artifacts");
    expect(bind).toBeDefined();
    expect(bind.if).toBeUndefined(); expect(bind["continue-on-error"]).toBeUndefined();
    expect(bind.run).toContain("set -euo pipefail");
    const copies = steps.findIndex(step => step.name?.startsWith("Stable-named"));
    if (job !== "mac-x64") expect(steps.indexOf(bind)).toBeGreaterThan(copies);
    if (job === "mac") expect(steps.indexOf(bind)).toBeGreaterThan(steps.findIndex(step => step.name?.startsWith("Staple, re-zip")));
    if (job === "mac-x64") expect(jobs["mac-x64"].needs).toContain("mac");
    const evidence = steps.find(step => step.with?.name === `${job}-whatsapp-gepa-evidence`);
    expect(evidence.if).toBe("always()");
    expect(evidence.with.path).toBe(job === "mac-x64" ? "qualification-evidence/whatsapp-*\nqualification-evidence/memory-*\n" : "qualification-evidence/whatsapp-*");
    expect(steps.indexOf(evidence)).toBeGreaterThan(steps.indexOf(bind));
    const targets = job === "mac" ? ["darwin-arm64"] : job === "mac-x64" ? ["darwin-x64"] : [job === "windows" ? "win32-x64" : "linux-x64"];
    for (const target of targets) {
      expect(bind.run).toContain(`scripts/bind-whatsapp-artifacts.mjs qualification-evidence/whatsapp-${target}.json release/`);
      const gate = steps.find(step => step.run?.includes(`> qualification-evidence/whatsapp-${target}.json`));
      expect(gate.if).toBeUndefined(); expect(gate["continue-on-error"]).toBeUndefined();
      expect(gate.run).toContain(`2> qualification-evidence/whatsapp-${target}-probe.log`);
      expect(gate.run).toContain("set -euo pipefail");
    }
    for (const extension of job === "mac" || job === "mac-x64" ? [".dmg", ".zip", ".blockmap"] : job === "windows" ? [".exe", ".blockmap"] : [".deb", ".AppImage"]) expect(bind.run).toContain(extension);
  });

  it("records final file hashes and preserves qualification fields", async () => {
    const { bindWhatsAppArtifacts } = await import("./bind-whatsapp-artifacts.mjs");
    const dir = mkdtempSync(join(tmpdir(), "whatsapp-artifacts-"));
    try {
      const report = join(dir, "report.json"), dmg = join(dir, "Murage.dmg"), zip = join(dir, "Murage.zip");
      const qualification = { platform: "darwin", arch: "arm64", socketFree: true, electronVersion: "43.4.0" };
      writeFileSync(report, JSON.stringify(qualification)); writeFileSync(dmg, "before staple"); writeFileSync(zip, "before archive");
      writeFileSync(dmg, "final stapled bytes"); writeFileSync(zip, "final archive bytes");
      await bindWhatsAppArtifacts(report, [dmg, zip]);
      expect(JSON.parse(readFileSync(report))).toEqual({ ...qualification, artifacts: [
        { name: "Murage.dmg", sha256: createHash("sha256").update("final stapled bytes").digest("hex") },
        { name: "Murage.zip", sha256: createHash("sha256").update("final archive bytes").digest("hex") },
      ] });
      const bytes = readFileSync(report, "utf8");
      await bindWhatsAppArtifacts(report, [dmg, zip]); expect(readFileSync(report, "utf8")).toBe(bytes);
      await expect(bindWhatsAppArtifacts(report, [dmg, join(dir, "missing.zip")])).rejects.toThrow();
      expect(readFileSync(report, "utf8")).toBe(bytes);
    } finally { removeTempDirSync(dir); }
  });
  // The x64 package step on the arm64 runner runs the x64 app through Rosetta
  // (1.0.2). It is installed only when the runner lacks it, then verified.
  it("installs Rosetta only when missing, and verifies it before packaging", () => {
    const steps = Object.values(jobs).flatMap((job) => job?.steps ?? []).filter((step) => String(step?.run ?? "").includes("install-rosetta"));
    expect(steps.length).toBeLessThanOrEqual(1);
    for (const step of steps) {
      expect(step.run).toMatch(/if ! \/usr\/bin\/arch -x86_64 \/usr\/bin\/true[^\n]*; then\n\s*sudo softwareupdate --install-rosetta/);
      expect(step.run).toMatch(/\/usr\/bin\/arch -x86_64 \/usr\/bin\/true && echo "Rosetta ready"/);
    }
  });
});

const workflows = join(dirname(dirname(fileURLToPath(import.meta.url))), ".github", "workflows");
const read = (name) => readFileSync(join(workflows, name), "utf8");
const load = (name) => parse(read(name));

describe("Linux Vitest cage preparation", () => {
  const repo = dirname(workflows);
  const action = name => parse(readFileSync(join(repo, "actions", name, "action.yml"), "utf8"));
  const linuxStep = step => !/(?:runner\.os|matrix\.os)\s*==\s*['"](?:Windows|macOS|windows-[^'"]+|macos-[^'"]+)['"]/.test(step.if ?? "");
  const expand = steps => steps.filter(linuxStep).flatMap(step => {
    if (step.uses?.startsWith("./.github/actions/")) {
      // The parent must run on Linux too; do not count a guarded build as a
      // prerequisite for tests that run without that guard.
      expect([undefined, "runner.os == 'Linux'"]).toContain(step.if);
      expect(step["continue-on-error"]).toBeUndefined();
      return expand(action(step.uses.split("/").at(-1)).runs.steps);
    }
    return [step];
  });
  const invokesVitest = run => /\bvitest(?:\s|\/vitest\.mjs)|\bpnpm (?:test(?:\s|$)|broker:test|control-plane:test)|scripts\/scale\/hz-vitest\.sh/.test(run ?? "");

  it("builds before every Linux test invocation, including nested actions and remote perf", () => {
    const covered = [];
    for (const file of readdirSync(workflows).filter(name => /\.ya?ml$/.test(name))) {
      for (const [name, job] of Object.entries(load(file).jobs ?? {})) {
        if (!/ubuntu|linux/i.test(JSON.stringify([job["runs-on"], job.strategy?.matrix]))) continue;
        let built = false;
        for (const step of expand(job.steps ?? [])) {
          if (step.run === "pnpm build:murage-cage") {
            expect([undefined, "runner.os == 'Linux'"]).toContain(step.if);
            expect(step["continue-on-error"]).toBeUndefined();
            built = true;
          }
          if (invokesVitest(step.run)) {
            expect(built, `${file}:${name} must build the cage before ${step.name ?? step.run}`).toBe(true);
            covered.push(`${file}:${name}`);
          }
          if (/\bpnpm clean\b|rm -rf[^\n]*dist-native/.test(step.run ?? "")) built = false;
        }
      }
    }
    expect(covered).toEqual(expect.arrayContaining([
      "ci.yml:quality", "ci.yml:vitest", "ci.yml:extended", "ci.yml:control-plane", "ci.yml:mobile",
      "nightly.yml:slow", "nightly-perf.yml:perf-budget", "package-linux.yml:package",
      "memory-timing-nightly.yml:timing", "memory-timing-nightly.yml:wasm-parity", "flux-contract-daily.yml:contract",
    ]));
    for (const name of readdirSync(join(repo, "actions"))) {
      let built = false;
      for (const step of expand(action(name).runs.steps ?? [])) {
        if (step.run === "pnpm build:murage-cage") built = true;
        if (invokesVitest(step.run)) expect(built, name).toBe(true);
      }
    }
  });

  it("keeps preparation Linux-only and carries the cage into remote test checkouts", () => {
    for (const step of action("linux-cage").runs.steps) {
      expect(step.if).toBe("runner.os == 'Linux'");
      expect(step.shell).toBe("bash");
    }
    expect(action("linux-cage").runs.steps[0].run).toContain("libseccomp-dev");
    const remote = readFileSync(new URL("./scale/hz-vitest.sh", import.meta.url), "utf8");
    const transfer = remote.indexOf('tar -C "$top" -czf - dist-native/cage/linux-x64');
    expect(transfer).toBeGreaterThan(-1);
    expect(transfer).toBeLessThan(remote.indexOf("pnpm exec vitest run"));
  });

  it("installs the source-path AppArmor profile after building and requires a bwrap smoke before tests", () => {
    const steps = action("linux-cage").runs.steps;
    const build = steps.findIndex(step => step.run === "pnpm build:murage-cage");
    const install = steps.findIndex(step => step.run?.includes("pnpm cage:apparmor"));
    const smoke = steps.findIndex(step => step.run?.includes('if ! "$bwrap" --unshare-user'));
    expect(build).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(build);
    expect(smoke).toBeGreaterThan(install);
    expect(steps[install].run).toContain('if [[ -d /sys/kernel/security/apparmor ]] && [[ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || true)" == "1" ]]; then\n  ');
    expect(steps[install].run).toMatch(/\n\s+pnpm cage:apparmor\nfi/);
    // Follow the package command to the installer; comments alone do not prove
    // that the profile is written or loaded with the required privilege.
    const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(scripts["cage:apparmor"]).toBe("node scripts/cage-apparmor.mjs");
    const installer = readFileSync(new URL("./cage-apparmor.mjs", import.meta.url), "utf8");
    expect(installer).toContain('"/etc/apparmor.d/murage-src-cage"');
    expect(installer).toContain('exec("sudo", ["tee", SOURCE_CAGE_PROFILE]');
    expect(installer).toContain('exec("sudo", ["apparmor_parser", "-r", SOURCE_CAGE_PROFILE]');
    expect(steps[smoke].run).toContain('arch="$(node -p \'process.arch\')"');
    expect(steps[smoke].run).toContain('bwrap="$PWD/dist-native/cage/linux-$arch/bwrap"');
    expect(steps[smoke].run).toContain('if ! "$bwrap" --unshare-user --unshare-pid --ro-bind / / --proc /proc --dev /dev true; then');
    expect(steps[smoke].run).toMatch(/::error::[^\n]+\n\s+exit 1\nfi/);
    for (const step of steps) {
      expect(step["continue-on-error"]).toBeUndefined();
      expect(step.run).not.toMatch(/sysctl\s+(?:-w|--write)|apparmor_restrict_unprivileged_userns\s*=\s*0/);
    }
  });
});

// `on:` is YAML 1.1's boolean true. The yaml package parses 1.2 (string key),
// but read both so this does not silently assert on `undefined`.
const triggers = (doc) => doc.on ?? doc[true];

describe("release.yml push trigger", () => {
  const release = load("release.yml");

  it("starts only on main, and only when package.json changed", () => {
    const push = triggers(release).push;
    expect(push.branches).toEqual(["main"]);
    expect(push.paths).toEqual(["package.json"]);
  });

  it("keeps publish a manual input, so a merge can only ever draft", () => {
    const on = triggers(release);
    expect(Object.keys(on.workflow_dispatch.inputs)).toContain("publish");
    expect(on.workflow_dispatch.inputs.publish.default).toBe(false);
    // If `publish` were readable on a push it would be the empty string, and
    // every `inputs.publish` check downstream would have to be falsy-safe.
    // It is not settable from `push` at all: assert nothing added it there.
    expect(on.push.inputs).toBeUndefined();
  });

  it("pins the exact pushed commit rather than a moving branch tip", () => {
    const checkout = release.jobs.prepare.steps.find((step) => String(step.uses || "").startsWith("actions/checkout"));
    expect(checkout.with.ref).toBe("${{ inputs.ref || github.sha }}");
    // The should_release guard reads a blob from before the push.
    expect(checkout.with["fetch-depth"]).toBe(0);
    expect(checkout.with["persist-credentials"]).toBe(false);
  });
});

describe("release.yml should_release guard", () => {
  const release = load("release.yml");
  const pin = release.jobs.prepare.steps.find((step) => step.id === "pin");

  it("is published as a job output", () => {
    expect(release.jobs.prepare.outputs.should_release).toBe("${{ steps.pin.outputs.should_release }}");
  });

  it("fails closed when the pre-push package.json is unreachable", () => {
    // The `||` block must EXIT, not fall through to a default of true.
    expect(pin.run).toMatch(/git cat-file -e "\$BEFORE:package\.json"[^\n]*\|\|\s*\{/);
    const failClosed = pin.run.slice(pin.run.indexOf("git cat-file -e"));
    expect(failClosed.slice(0, failClosed.indexOf("}"))).toMatch(/exit 1/);
  });

  it("skips the release when the version did not actually move", () => {
    // The helper is executed against downgrade/equality/invalid-version
    // fixtures in release-guard.test.mjs; this pins the workflow connection.
    expect(pin.run).toContain('node scripts/release-guard.mjs should-release "$current" "$previous"');
    expect(pin.run).toContain("node scripts/release-guard.mjs version");
  });

  it("only applies the guard to push events", () => {
    expect(pin.run).toMatch(/if \[ "\$GITHUB_EVENT_NAME" = push \]/);
  });

  it("gates every job that signs, builds or uploads", () => {
    for (const job of ["mac", "mac-x64", "windows", "linux", "ci-gate", "assemble"]) {
      expect(release.jobs[job].if, job).toBe("needs.prepare.outputs.should_release == 'true'");
    }
    const refuse = release.jobs.prepare.steps.find((step) => String(step.name || "").startsWith("Refuse to overwrite"));
    expect(refuse.if).toBe("steps.pin.outputs.should_release == 'true'");
  });
});

describe("prepare-release.yml", () => {
  const prepare = load("prepare-release.yml");
  const source = read("prepare-release.yml");

  it("is manual only — it never fires off a push", () => {
    expect(Object.keys(triggers(prepare))).toEqual(["workflow_dispatch"]);
  });

  it("claims no more permission than it needs to open a PR", () => {
    expect(prepare.permissions).toEqual({
      actions: "write",
      contents: "write",
      "pull-requests": "write",
    });
  });

  it("checks our own releases repo, with the secret release.yml already uses", () => {
    const refuse = prepare.jobs.prepare.steps.find((step) => String(step.name || "").startsWith("Refuse an existing"));
    expect(refuse.env.GH_TOKEN).toBe("${{ secrets.RELEASES_PAT }}");
    expect(refuse.run).toContain('node scripts/release-guard.mjs absent "$VERSION"');
  });

  it("names Murage in the PR it opens, and promises only a draft", () => {
    const pr = prepare.jobs.prepare.steps.find((step) => step.id === "pr");
    expect(pr.run).toContain("Bumps Murage to");
    expect(pr.run).toContain("FerroxLabs/murage-releases");
    expect(pr.run).toMatch(/DRAFT/);
  });

  it("passes workflow inputs through env, never straight into a run body", () => {
    // ${{ inputs.version }} interpolated into a shell line is a command
    // injection; every use here is an env binding read as "$VAR".
    for (const step of prepare.jobs.prepare.steps) {
      expect(String(step.run || ""), step.name).not.toMatch(/\$\{\{\s*inputs\./);
    }
    expect(source).toContain("CUSTOM_VERSION: ${{ inputs.version }}");
  });

  it("dispatches CI, which is why ci.yml grew a manual trigger", () => {
    const start = prepare.jobs.prepare.steps.at(-1);
    expect(start.run).toContain("gh workflow run ci.yml");
    expect(Object.keys(triggers(load("ci.yml")))).toContain("workflow_dispatch");
  });
});

describe("release mutation boundaries", () => {
  const release = load("release.yml");
  const assemble = release.jobs.assemble;
  it("serializes assembly and publication by version", () => {
    expect(assemble.concurrency.group).toBe("release-assemble-v${{ needs.prepare.outputs.version }}");
    expect(assemble.concurrency["cancel-in-progress"]).toBe(false);
  });
  it("checks out the pinned guard and carries the exact draft ID through publication", () => {
    const checkout = assemble.steps.find(step => String(step.uses).startsWith("actions/checkout"));
    expect(checkout.with.ref).toBe("${{ needs.prepare.outputs.sha }}");
    const upload = assemble.steps.find(step => step.id === "upload");
    expect(upload.run).toContain("node scripts/release-guard.mjs upload");
    const publish = assemble.steps.find(step => String(step.name).startsWith("Publish"));
    expect(publish.env.RELEASE_ID).toBe("${{ steps.upload.outputs.release_id }}");
    expect(publish.run).toContain('node scripts/release-guard.mjs publish "$VERSION" "$RELEASE_ID"');
  });
  it("only creates a release branch when the inspected branch is absent", () => {
    const prepare = load("prepare-release.yml");
    const commit = prepare.jobs.prepare.steps.find(step => step.name === "Commit the version bump");
    expect(commit.if).toBe("steps.branch.outputs.branch_exists != 'true'");
    expect(prepare.jobs.prepare.steps.find(step => step.id === "pr").env.EXISTING_PR)
      .toBe("${{ steps.branch.outputs.pr_url }}");
  });
});

describe("published Linux artifact verification", () => {
  const workflow = load("package-linux.yml");
  const verify = workflow.jobs["verify-published"];
  const guard = verify.steps.find(step => step.id === "source");
  const javascript = guard.run.split("<<'EOF'\n")[1].split("\nEOF")[0];

  it("keeps ordinary builds and explicit verification mutually exclusive", () => {
    expect(workflow.jobs.package.if).toBe("inputs.source_run_id == '' && inputs.expected_version == ''");
    expect(verify.if).toBe("inputs.source_run_id != '' || inputs.expected_version != ''");
    expect(verify.permissions).toEqual({ contents: "read", actions: "read" });
    const run = verify.steps.find(step => step.name === "Prove the published GitHub feed and installed path").run;
    expect(run).toBe('pnpm smoke:linux-update --expected-version="$EXPECTED_VERSION"');
    expect(run).not.toContain("--candidate-feed");
    expect(verify.steps.some(step => /pnpm (?:package|build):/.test(step.run ?? ""))).toBe(false);
  });

  it.each([
    [{ SOURCE_RUN_ID: "" }, "source_run_id is required"],
    [{ SOURCE_RUN_ID: "123; echo unsafe" }, "source_run_id is required"],
    [{ SOURCE_SHA: "main" }, "ref must be the full accepted source SHA"],
    [{ EXPECTED_VERSION: "v0.1.45" }, "expected_version must be stable X.Y.Z"],
  ])("rejects incomplete or malformed verification inputs before GitHub access: %j", (overrides, expected) => {
    const result = spawnSync(process.execPath, ["--input-type=module", "-"], {
      input: javascript, encoding: "utf8",
      env: { SOURCE_RUN_ID: "123", SOURCE_SHA: "a".repeat(40), EXPECTED_VERSION: "0.1.45",
        GITHUB_REPOSITORY: "FerroxLabs/murage", ...overrides },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(expected);
    expect(result.stderr).not.toContain("spawnSync gh");
  });

  it("requires exact successful Linux provenance before selecting the artifact", () => {
    expect(javascript).toContain("assert.equal(run.head_sha, sha");
    expect(javascript).toContain("assert.equal(matchingJobs[0].conclusion, 'success'");
    expect(javascript).toContain("assert.equal(artifact.workflow_run?.id, Number(id))");
    expect(javascript).toContain("assert.equal(artifact.workflow_run?.head_sha, sha)");
    const download = verify.steps.find(step => String(step.uses).startsWith("actions/download-artifact"));
    expect(download.with["artifact-ids"]).toBe("${{ steps.source.outputs.artifact_id }}");
    const smoke = readFileSync(join(workflows, "../../scripts/smoke-linux-update.mjs"), "utf8");
    expect(smoke).toContain('assert.equal(offered, expectedVersion, "live feed offered a different release")');
  });
});

describe("scoped CI confirmation", () => {
  // CI is split into quality (all OSes: validator, typecheck, lint, broker,
  // Electron and packaged-server gates), vitest (sharded, needs quality) and
  // human jobs; scoped confirmation narrows only the Vitest step.
  const workflow = load("ci.yml");
  const steps = workflow.jobs.quality.steps;
  const guard = steps.find(step => step.name === "Validate scoped CI confirmation input");
  const javascript = guard.run.split("<<'EOF'\n")[1].split("\nEOF")[0];
  const validate = (env) => spawnSync(process.execPath, ["--input-type=module", "-"], {
    input: javascript, encoding: "utf8", cwd: join(workflows, "../.."),
    env: { GITHUB_EVENT_NAME: "workflow_dispatch", WINDOWS_ONLY: "true",
      VITEST_FILE: "scripts/release-workflows.test.mjs", ...env },
  });

  it("accepts real files for explicit all-platform or Windows-only dispatches", () => {
    const valid = validate({});
    expect(valid.status).toBe(0);
    expect(validate({ WINDOWS_ONLY: "false" }).status).toBe(0);
    expect(valid.stdout).toContain("unaffected Vitest results are reused, not rerun");
    expect(validate({ VITEST_FILE: "server/drivers/acp\nscripts/release-workflows.test.mjs" }).status).toBe(0);
    expect(validate({ VITEST_FILE: "", WINDOWS_ONLY: "false", GITHUB_EVENT_NAME: "push" }).status).toBe(0);
  });

  it.each([
    [{ GITHUB_EVENT_NAME: "pull_request" }, "manual dispatch"],
    [{ VITEST_FILE: "server/../index.test.ts" }, "repository-relative test file"],
    [{ VITEST_FILE: "server/*.test.ts" }, "repository-relative test file"],
    [{ VITEST_FILE: "server/index.test.ts; echo unsafe" }, "repository-relative test file"],
    [{ VITEST_FILE: "/tmp/example.test.ts" }, "repository-relative test file"],
    [{ VITEST_FILE: "server/drivers/acp\n../outside" }, "repository-relative test file"],
    [{ VITEST_FILE: "server/drivers/acp\n" }, "repository-relative test file"],
    [{ VITEST_FILE: "server/nonexistent-scoped-confirmation.test.ts" }, "ENOENT"],
  ])("rejects unsafe or unsupported scoped input %j", (env, expected) => {
    const result = validate(env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(expected);
  });

  it("preserves the default test chain and every downstream gate during scoped confirmation", () => {
    const vitest = workflow.jobs.vitest;
    expect(vitest.needs).toBe("quality");
    expect(vitest.name).toContain("Scoped Vitest confirmation");
    expect(vitest.strategy.matrix.vitest_shard).toBe("${{ fromJSON(inputs.vitest_file && '[1]' || '[1,2,3,4,5,6,7,8,9,10,11,12]') }}");
    // Windows runs twelve shards; macOS and ubuntu keep ten, so their 11 and 12 are excluded.
    expect(vitest.strategy.matrix.exclude).toEqual([
      { os: "macos-latest", vitest_shard: 11 }, { os: "macos-latest", vitest_shard: 12 },
      { os: "ubuntu-24.04", vitest_shard: 11 }, { os: "ubuntu-24.04", vitest_shard: 12 },
    ]);
    const full = vitest.steps.find(step => step.name === "Run Vitest shard");
    expect(full.if).toBe("inputs.vitest_file == ''");
    // The blocking shards run only GATE files, each on the OSes ci/gate-tests.txt names for it.
    expect(full.run).toContain('node scripts/ci-test-tiers.mjs list --tier gate --os "$os" --shard "$SHARD"');
    expect(full.run).toContain("node node_modules/vitest/vitest.mjs run --tags-filter='!nightly && !perf-budget' \"${args[@]}\"");
    expect(full.env.SHARD).toBe("${{ matrix.vitest_shard }}/${{ matrix.os == 'windows-latest' && 12 || 10 }}");
    expect(full.env.MURAGE_SKIP_REAL_ELECTRON_BROWSER_FIXTURE).toBe("${{ matrix.os == 'windows-latest' && '1' || '0' }}");
    // EXTENDED files run on Linux in a job that never fails the run, and `required` does not wait on it.
    const extended = workflow.jobs.extended;
    expect(extended["continue-on-error"]).toBe(true);
    expect(extended["runs-on"]).toBe("ubuntu-24.04");
    expect(workflow.jobs.required.needs).not.toContain("extended");
    expect(extended.steps.find(step => step.name === "Run extended shard").run).toContain("--tier extended");
    // The one file the extended shards leave out runs as root on one of them, so nothing is skipped.
    const root = extended.steps.find(step => step.name === "Run the root-only app-health test as root");
    expect(root.if).toBe("${{ !cancelled() && matrix.extended_shard == 1 }}");
    expect(root.run).toContain("node_modules/vitest/vitest.mjs run server/cloud-home/app-health.test.ts");
    expect(root.run.startsWith("sudo -E ")).toBe(true);
    const scoped = vitest.steps.find(step => step.name === "Scoped Vitest confirmation");
    expect(scoped.if).toBe("inputs.vitest_file != ''");
    expect(scoped.env.VITEST_FILE).toBe("${{ inputs.vitest_file }}");
    expect(scoped.env.MURAGE_SKIP_REAL_ELECTRON_BROWSER_FIXTURE).toBe("${{ matrix.os == 'windows-latest' && '1' || '0' }}");
    expect(scoped.run.trim().split("\n").slice(1)).toEqual([
      'test_paths=(); while IFS= read -r test_path; do test_paths+=("$test_path"); done <<< "$VITEST_FILE"', 'pnpm exec vitest run "${test_paths[@]}"',
    ]);
    // Every downstream gate still runs, unconditionally, in the quality job.
    for (const run of ["pnpm typecheck", "pnpm check:contrast", "pnpm broker:check", "pnpm broker:test", "pnpm test:electron", "pnpm test:packaged-server", "pnpm check:electron"]) {
      const step = steps.find(item => item.run === run);
      expect(step, run).toBeDefined();
      expect(step.if, run).toBeUndefined();
    }
    // The Worker is compiled on every run (FLUXCFG follow-up 6): broker:check
    // sits between the repo typecheck and the tests, on every platform.
    const brokerCheck = steps.findIndex(step => step.run === "pnpm broker:check");
    expect(brokerCheck).toBeGreaterThan(steps.findIndex(step => step.run === "pnpm typecheck"));
    expect(brokerCheck).toBeLessThan(steps.findIndex(step => step.run === "pnpm test:electron"));
  });
});

describe("public release download-back verification", () => {
  const steps = load("package-linux.yml").jobs["verify-published"].steps;
  const step = steps.find(item => item.name === "Download back and verify all public feed assets");
  const javascript = step.run.split("<<'EOF'\n")[1].split("\nEOF")[0];
  const version = "0.1.45";
  const names = {
    "latest-mac.yml": ["Murage-0.1.45-x64.zip", "Murage-0.1.45-arm64.zip", "Murage-0.1.45-x64.dmg", "Murage-0.1.45-arm64.dmg"],
    "latest.yml": ["Murage-0.1.45-setup.exe"],
    "latest-linux.yml": ["Murage-0.1.45-x86_64.AppImage", "Murage-0.1.45-amd64.deb"],
  };
  function verify(mutate = () => {}) {
    const downloads = {}, feeds = {};
    for (const [feed, assets] of Object.entries(names)) {
      feeds[feed] = { version, files: assets.map(url => {
        const body = `fixture bytes: ${url}: π`;
        downloads[url] = body;
        return { url, size: Buffer.byteLength(body), sha512: createHash("sha512").update(body).digest("base64") };
      }) };
    }
    mutate(feeds, downloads);
    for (const [feed, metadata] of Object.entries(feeds)) downloads[feed] = JSON.stringify(metadata);
    const fakeFetch = `
      const downloads = ${JSON.stringify(downloads)};
      globalThis.fetch = async (url, options) => {
        if (options.headers) throw new Error('Public download received headers');
        const base = 'https://github.com/FerroxLabs/murage-releases/releases/download/v0.1.45/';
        if (!url.startsWith(base)) throw new Error('Unexpected download origin');
        const value = downloads[url.slice(base.length)];
        return new Response(value ?? '', {status: value === undefined ? 404 : 200});
      };
    `;
    return spawnSync(process.execPath, ["--input-type=module", "-"], {
      input: fakeFetch + javascript, encoding: "utf8", cwd: join(workflows, "../.."),
      env: { EXPECTED_VERSION: version },
    });
  }

  it("streams and verifies exactly seven downloaded assets without credentials", () => {
    const result = verify();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.match(/Public bytes verified:/g)).toHaveLength(7);
    expect(step.env).toEqual({ EXPECTED_VERSION: "${{ inputs.expected_version }}" });
    expect(steps.indexOf(step)).toBeLessThan(steps.findIndex(item => item.name === "Prove the published GitHub feed and installed path"));
  });

  it.each(["version", "url", "hash", "size", "missing"])("rejects a public %s mismatch", (kind) => {
    const result = verify((feeds, downloads) => {
      const feed = feeds["latest-mac.yml"], asset = feed.files[0];
      if (kind === "version") feed.version = "0.1.44";
      if (kind === "url") asset.url = "https://example.invalid/untrusted.zip";
      if (kind === "hash") asset.sha512 = "A".repeat(86) + "==";
      if (kind === "size") asset.size++;
      if (kind === "missing") delete downloads[asset.url];
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/wrong version|unexpected asset URLs|wrong downloaded SHA512|wrong downloaded size|public download failed/);
  });
});

describe("scoped Windows confirmation", () => {
  it("keeps default CI complete and retains the full test command", () => {
    const ci = load("ci.yml");
    expect(triggers(ci).workflow_dispatch.inputs.windows_only.default).toBe(false);
    for (const job of ["quality", "vitest"]) expect(ci.jobs[job].strategy.matrix.os, job).toBe('${{ fromJSON(inputs.windows_only && \'["windows-latest"]\' || \'["macos-latest","ubuntu-24.04","windows-latest"]\') }}');
    expect(ci.jobs.vitest.steps.find(step => step.name === "Run Vitest shard").run).toContain("--tier gate");
    expect(ci.jobs.quality.steps.some(step => step.run === "pnpm test:electron")).toBe(true);
    expect(ci.jobs['control-plane'].if).toBe('${{ !inputs.windows_only && !inputs.human_files }}');
    expect(ci.jobs['package-linux'].if).toBe('${{ !inputs.windows_only && !inputs.human_files }}');
  });
});

describe("scoped Ubuntu human confirmation", () => {
  it("uses explicit manual selection while preserving default CI", () => {
    const ci = load("ci.yml");
    expect(triggers(ci).workflow_dispatch.inputs.human_files.type).toBe("string");
    for (const job of ["quality", "vitest"]) expect(ci.jobs[job].if, job).toBe('${{ !inputs.human_files }}');
    expect(ci.jobs.human.if).toBe('${{ !inputs.windows_only && !inputs.human_files }}');
    const job = ci.jobs["human-confirmation"];
    expect(job.if).toBe("${{ github.event_name == 'workflow_dispatch' && inputs.human_files != '' }}");
    expect(job["runs-on"]).toBe("ubuntu-24.04");
    expect(job.steps.find(step => step.name === "Confirm selected human specs").run).toContain('playwright test "${shared_paths[@]}" --retries=0 --trace=on');
    expect(job.steps.find(step => step.name === "Confirm selected human specs").run).toContain('node scripts/run-isolated-human-specs.mjs "${human_paths[@]}" -- --retries=0 --trace=on');
    expect(job.steps.find(step => step.name === "Upload human screenshots and traces").if).toBe("always()");
  });

  // FOLLOW4 (CLAC3 verifier): the root playwright.config.ts routes its
  // outputDir through src/e2e/evidence.ts, which refuses to run without
  // MURAGE_E2E_DATA_DIR, so every CI step that runs it sets the variable to
  // a directory outside the checkout and uploads that directory's
  // human-results, not test-results/ from the repository.
  it("runs the human specs with their evidence outside the checkout", () => {
    const ci = load("ci.yml");
    // SAFEWIPE1: the rig wipes this directory, so the name carries a "scratch" segment.
    const evidence = "${{ runner.temp }}/murage-e2e-scratch";
    const scoped = ci.jobs["human-confirmation"];
    expect(scoped.steps.find(step => step.name === "Confirm selected human specs").env.MURAGE_E2E_DATA_DIR).toBe(evidence);
    expect(scoped.steps.find(step => step.name === "Upload human screenshots and traces").with.path).toBe(`${evidence}/human-results\n${evidence}/isolated-results\n`);
    const test = ci.jobs.human;
    expect(test.steps.find(step => step.name === "Run human specs").env.MURAGE_E2E_DATA_DIR).toBe(evidence);
    expect(test.steps.find(step => step.name === "Upload human spec traces on failure").with.path).toBe(`${evidence}/human-results\n${evidence}/isolated-results\n`);
    for (const job of Object.values(ci.jobs)) {
      for (const step of job.steps ?? []) expect(String(step.with?.path ?? ""), step.name).not.toMatch(/(^|\n)\s*test-results\s*($|\n)/);
    }
  });

  // The full suite outgrew one 30-minute job on one worker, so it is split
  // with Playwright's --shard. A matrix that disagrees with the shard total
  // would silently skip (or repeat) part of the suite and still go green.
  it("shards the full human suite so every shard runs and each spec runs once", () => {
    const ci = load("ci.yml");
    const job = ci.jobs.human;
    const shards = job.strategy.matrix.human_shard;
    expect(shards.length).toBeGreaterThan(1);
    expect(shards).toEqual(Array.from({ length: shards.length }, (_, index) => index + 1));
    // One red shard must not cancel the others: their results are the evidence.
    expect(job.strategy["fail-fast"]).toBe(false);
    const step = job.steps.find(item => item.name === "Run human specs");
    expect(step.env.HUMAN_SHARD).toBe(`\${{ matrix.human_shard }}/${shards.length}`);
    expect(step.run).toBe('pnpm test:human --shard="$HUMAN_SHARD"');
    expect(job.name).toContain(`\${{ matrix.human_shard }}/${shards.length}`);
    // upload-artifact refuses a second artifact with the same name in a run.
    expect(job.steps.find(item => item.name === "Upload human spec traces on failure").with.name).toContain("${{ matrix.human_shard }}");
    expect(ci.jobs.required.needs).toContain("human");
    expect(ci.jobs.required.steps[0].env.HUMAN).toBe("${{ needs.human.result }}");
  });
});

describe("no upstream identity ships in .github/", () => {
  it.each(["release.yml", "prepare-release.yml", "ci.yml"])("%s is clean", (name) => {
    expect(read(name)).not.toMatch(/openmausbot|milind-soni|openmaus|omb_|ogb_/i);
  });

  it("every release repo reference is ours", () => {
    for (const name of ["release.yml", "prepare-release.yml"]) {
      for (const match of read(name).matchAll(/([\w.-]+)\/murage-releases/g)) {
        expect(match[1], name).toBe("FerroxLabs");
      }
    }
  });
});

// 0.1.62 audit C8: a release must not start from a commit CI never passed,
// and the Linux checksums must be signed by a key a downloader can check.
describe("release.yml provenance gates (audit C8)", () => {
  const release = load("release.yml");
  const stepBy = (job, needle) => release.jobs[job].steps.find(step => String(step.name ?? "").includes(needle));

  it.each(["mac", "windows", "linux"])("%s checks the shipped publisher key before packaging", (job) => {
    const steps = release.jobs[job].steps;
    const guard = steps.find(step => step.run === "node scripts/check-release-key.mjs");
    expect(guard).toBeDefined();
    expect(guard.if).toBeUndefined();
    expect(steps.indexOf(guard)).toBeLessThan(steps.findIndex(step => step.name?.startsWith("Package")));
  });

  it("a CI gate job refuses a pinned commit CI did not pass, beside the builds", () => {
    const step = stepBy("ci-gate", "CI passed");
    expect(step, "a step named for the CI gate").toBeDefined();
    expect(step.run).toContain("scripts/release-ci-gate.mjs");
    expect(step.env.SHA).toBe("${{ needs.prepare.outputs.sha }}");
    expect(step.env.GH_TOKEN).toBe("${{ github.token }}");
    // reading workflow runs needs actions: read, and nothing wider
    expect(release.jobs["ci-gate"].permissions).toEqual({ contents: "read", actions: "read" });
    // it waits for the CI run a push starts alongside this one
    expect(release.jobs["ci-gate"]["timeout-minutes"]).toBeGreaterThanOrEqual(60);
    expect(step.env.CI_WORKFLOW).toBe("ci.yml");
    expect(load("ci.yml").name).toBe("CI");
    // pinning no longer waits for CI
    expect(release.jobs.prepare.steps.some(s => String(s.run ?? "").includes("release-ci-gate"))).toBe(false);
    expect(release.jobs.prepare["timeout-minutes"]).toBeLessThanOrEqual(30);
  });

  it("platform builds start on the pin; only assemble waits for CI", () => {
    const needs = job => [release.jobs[job].needs].flat();
    for (const job of ["mac", "windows", "linux"]) {
      expect(needs(job), job).toEqual(["prepare"]);
    }
    expect(needs("mac-x64")).toEqual(["prepare", "mac"]);
    expect(needs("assemble")).toEqual(expect.arrayContaining(["ci-gate", "mac", "mac-x64", "windows", "linux"]));
    // nothing that creates a draft or touches murage-releases runs before assemble
    for (const job of ["mac", "mac-x64", "windows", "linux"]) {
      expect(JSON.stringify(release.jobs[job]), job).not.toContain("RELEASES_PAT");
      expect(JSON.stringify(release.jobs[job]), job).not.toContain("release-guard.mjs upload");
    }
    const abort = release.jobs["abort-on-ci-failure"];
    expect(abort.permissions).toEqual({ actions: "write" });
    expect(abort.if).toContain("needs.ci-gate.result == 'failure'");
  });

  it("the x64 smoke runs natively on an Intel runner with one retry", () => {
    const job = release.jobs["mac-x64"];
    expect(job["runs-on"]).toBe("macos-15-intel");
    const smoke = stepBy("mac-x64", "Qualify packaged WhatsApp (darwin-x64)");
    expect(smoke.run).toContain("for attempt in 1 2");
    expect(smoke.run).not.toContain("arch -x86_64");
    expect(JSON.stringify(release.jobs.mac)).not.toContain("--arch x64");
    const handoff = release.jobs.mac.steps.find(s => s.with?.name === "mac-x64-app-smoke");
    expect(handoff).toBeDefined();
  });

  it("the Linux job signs SHA256SUMS and ships the signature", () => {
    const sign = stepBy("linux", "Sign the checksums");
    expect(sign, "a signing step").toBeDefined();
    expect(sign.env.GPG_PRIVATE_KEY).toBe("${{ secrets.RELEASE_GPG_PRIVATE_KEY }}");
    expect(sign.run).toContain("--detach-sign");
    expect(sign.run).toContain("SHA256SUMS-ubuntu-x64.txt.asc");
    // no unsigned Linux release: the app ships the release key and refuses an unsigned update
    expect(sign.run).toMatch(/RELEASE_GPG_PRIVATE_KEY is not set[^\n]*\n\s*exit 1/);
    // the signature is checked the way a Linux install checks it: Murage's verifier and the shipped key
    expect(sign.run).toContain("verifyDetachedSignature");
    expect(sign.run).toContain("electron/release-key.asc");
    const upload = release.jobs.linux.steps.find(step => step.with?.name === "linux-release");
    expect(upload.with.path).toContain("release/SHA256SUMS-ubuntu-x64.txt.asc");
  });

  it("the Linux job attests build provenance with a full-SHA pin and only the permissions it needs", () => {
    const step = release.jobs.linux.steps.find(item => String(item.uses ?? "").startsWith("actions/attest-build-provenance@"));
    expect(step, "an attestation step").toBeDefined();
    expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
    expect(step.with["subject-path"]).toContain("release/*.AppImage");
    expect(release.jobs.linux.permissions).toEqual({ contents: "read", "id-token": "write", attestations: "write" });
  });

  it("assembly requires the signature whenever one was made, and never lets a stray file through", () => {
    const gate = release.jobs.assemble.steps.find(step => String(step.name).startsWith("Refuse an incomplete installer"));
    expect(gate.run).toContain("SHA256SUMS-ubuntu-x64.txt.asc");
    expect(gate.run).toContain("required+=(");
    expect(gate.run).toContain('"${#required[@]}"');
  });
});

describe("release-ci-gate verdict (audit C8)", () => {
  let ciVerdict;
  beforeAll(async () => { ({ ciVerdict } = await import("./release-ci-gate.mjs")); });
  const SHA = "a".repeat(40);
  const run = (over = {}) => ({ head_sha: SHA, status: "completed", conclusion: "success", event: "push", ...over });

  it("passes when a CI run on that commit concluded success", () => {
    expect(ciVerdict([run()], SHA)).toEqual({ state: "pass", reason: expect.any(String) });
  });
  it("fails on a failed run, even next to an older green one", () => {
    expect(ciVerdict([run({ conclusion: "failure" })], SHA).state).toBe("fail");
    expect(ciVerdict([run({ conclusion: "failure", run_attempt: 1 }), run({ run_attempt: 2 })], SHA).state).toBe("pass");
  });
  it("waits while the run is queued or in progress, and fails with none at all", () => {
    expect(ciVerdict([run({ status: "in_progress", conclusion: null })], SHA).state).toBe("wait");
    expect(ciVerdict([], SHA).state).toBe("none");
  });
  it("ignores runs for other commits and cancelled or skipped runs", () => {
    expect(ciVerdict([run({ head_sha: "b".repeat(40) })], SHA).state).toBe("none");
    expect(ciVerdict([run({ conclusion: "cancelled" })], SHA).state).toBe("fail");
    expect(ciVerdict([run({ conclusion: "skipped" })], SHA).state).toBe("fail");
  });
});

describe("tests CI's shards leave out still run (nightly.yml)", () => {
  const ci = load("ci.yml");
  const nightly = load("nightly.yml");
  const root = dirname(workflows).replace(/[\\/]\.github$/, "");
  const viteConfig = readFileSync(join(root, "vite.config.ts"), "utf8");

  it("CI's shards leave out exactly the two tags vite.config.ts defines, and nightly runs each of them", () => {
    for (const tag of ["nightly", "perf-budget"]) expect(viteConfig).toContain(`name: "${tag}"`);
    for (const [job, name] of [["vitest", "Run Vitest shard"], ["extended", "Run extended shard"]]) {
      expect(ci.jobs[job].steps.find(step => step.name === name).run, job).toContain("--tags-filter='!nightly && !perf-budget'");
    }
    const slow = nightly.jobs.slow;
    expect(slow.strategy.matrix.os).toEqual(["macos-latest", "ubuntu-24.04", "windows-latest"]);
    expect(slow.steps.some(step => step.uses === "./.github/actions/vitest-runtime")).toBe(true);
    expect(slow.steps.find(step => step.name === "Run the nightly tests").run).toContain("--tags-filter=nightly");
    expect(slow.steps.find(step => step.name === "Run the whole-file scale tests").run).toContain("ci-test-tiers.mjs list --tier nightly");
    // The perf-budget job needs host and SSH secrets, so it lives in a private-only workflow that the public
    // scrub removes (scrub.sh). Public nightly.yml must never hold it; when the private file exists, check it.
    expect(nightly.jobs).not.toHaveProperty("perf-budget");
    const perfPath = join(workflows, "nightly-perf.yml");
    if (existsSync(perfPath)) {
      const perf = load("nightly-perf.yml").jobs["perf-budget"].steps.find(step => step.name === "Run the perf-budget tests on dedicated hardware");
      expect(perf.run).toContain("scripts/scale/hz-vitest.sh");
      expect(perf.run).toMatch(/ perf-budget$/m);
    }
  });

  it("runs nightly and on demand, and its one result fails when the slow job fails", () => {
    expect(triggers(nightly).schedule?.length).toBeGreaterThan(0);
    expect(triggers(nightly)).toHaveProperty("workflow_dispatch");
    expect(nightly.jobs.nightly.needs).toEqual(["slow"]);
    expect(nightly.jobs.nightly.if).toBe("${{ always() }}");
    expect(nightly.jobs.nightly.steps[0].run).toContain('test "$SLOW" = success');
  });

  it("the release gate reads this workflow", () => {
    const release = load("release.yml");
    const gate = release.jobs["ci-gate"].steps.find(step => step.id === "gate");
    expect(gate.env.NIGHTLY_WORKFLOW).toBe("nightly.yml");
  });

  it("shard caps sit above the slowest expected shard, and a cancelled shard is never the plan", () => {
    expect(ci.jobs.vitest.strategy.matrix.vitest_shard).toContain("[1,2,3,4,5,6,7,8,9,10,11,12]");
    expect(ci.jobs.vitest["timeout-minutes"]).toBe("${{ matrix.os == 'windows-latest' && 60 || matrix.os == 'macos-latest' && 45 || 40 }}");
    expect(nightly.jobs.slow["timeout-minutes"]).toBeGreaterThanOrEqual(120);
  });
});

describe("only GATE tests block CI (ci/gate-tests.txt)", () => {
  it("classifies every Vitest file exactly once, each gate file with its OSes and the failure it prevents", () => {
    expect(check().problems).toEqual([]);
  });

  it("runs Cloud home GATE tests on Linux only, and every GATE file on at least one OS", () => {
    const { gate } = readLists();
    for (const [path, entry] of gate) {
      expect(entry.oses.length, path).toBeGreaterThan(0);
      if (path.startsWith("server/cloud-home/")) expect(entry.oses, path).toEqual(["linux"]);
    }
    const count = os => (os === "windows" ? 12 : 10);
    const shards = os => Array.from({ length: count(os) }, (_, i) => select({ tier: "gate", os, shard: `${i + 1}/${count(os)}` }).files).flat();
    const all = new Set(["linux", "mac", "windows"].flatMap(shards));
    expect(all).toEqual(new Set(gate.keys()));
    const linux = shards("linux");
    expect(new Set(linux).size).toBe(linux.length);
  });

  it("derives a file's OSes from its own top-level platform guards, and is unsure means all", () => {
    expect(deriveOses("server/cloud-home/x.test.ts", "describe('x', () => {});")).toBe("linux");
    expect(deriveOses("server/a.test.ts", 'describe.skipIf(process.platform === "win32")("a", () => {});')).toBe("linux+mac");
    expect(deriveOses("server/a.test.ts", 'describe.runIf(process.platform === "darwin")("a", () => {});')).toBe("mac");
    expect(deriveOses("server/a.test.ts", 'describe.skipIf(process.platform !== "linux")("a", () => {});\ndescribe("b", () => {});')).toBe("all");
    expect(deriveOses("server/a.test.ts", "const x = 1;")).toBe("all");
  });
});

describe("native arm64 S4 power qualification", () => {
  it("builds the cage, enables its source-path userns profile and smokes it before the focused tests", () => {
    const ci = load("ci.yml");
    const job = ci.jobs["host-power-arm64"];
    expect(job["runs-on"]).toBe("ubuntu-24.04-arm");
    expect(Object.values(ci.jobs).filter(job => job["runs-on"] === "ubuntu-24.04-arm")).toHaveLength(1);
    expect(job.if).toBe('${{ !inputs.windows_only && !inputs.human_files }}');
    expect(job["continue-on-error"]).toBeUndefined();
    const steps = job.steps;
    const install = steps.findIndex(step => step.run === "pnpm install --frozen-lockfile");
    const build = steps.findIndex(step => step.run === "pnpm build:murage-cage");
    const profile = steps.findIndex(step => step.run?.includes("sudo apparmor_parser -r"));
    const smoke = steps.findIndex(step => step.run === "dist-native/cage/linux-arm64/bwrap --unshare-user --unshare-pid --ro-bind / / --proc /proc --dev /dev true");
    const test = steps.findIndex(step => step.run === "pnpm exec vitest run server/host-power.test.ts server/procs.test.ts scripts/build-murage-cage.test.mjs scripts/power-seccomp.test.mjs");
    expect(install).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(install);
    expect(profile).toBeGreaterThan(build);
    expect(smoke).toBeGreaterThan(profile);
    expect(test).toBeGreaterThan(smoke);
    expect(steps[profile].run).toContain('[ -d /sys/kernel/security/apparmor ]');
    expect(steps[profile].run).toContain('realpath dist-native/cage/linux-arm64/bwrap');
    expect(steps[profile].run).toContain('profile murage-src-cage-bwrap "%s" flags=(unconfined) { userns, }');
    expect(steps[test].env.MURAGE_TEST_REQUIRE_HOST_POWER_CAGE).toBe("1");
    for (const step of steps.slice(install)) {
      expect(step.if).toBeUndefined();
      expect(step["continue-on-error"]).toBeUndefined();
    }
    expect(ci.jobs.required.needs).toContain("host-power-arm64");
    expect(ci.jobs.required.steps[0].env.HOST_POWER_ARM64).toBe("${{ needs.host-power-arm64.result }}");
    expect(ci.jobs.required.steps[0].run).toContain('test "$HOST_POWER_ARM64" = success');
  });
});
