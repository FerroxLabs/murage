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

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflows = join(dirname(dirname(fileURLToPath(import.meta.url))), ".github", "workflows");
const read = (name) => readFileSync(join(workflows, name), "utf8");
const load = (name) => parse(read(name));

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
    for (const job of ["mac", "windows", "linux", "assemble"]) {
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
  const workflow = load("ci.yml");
  const steps = workflow.jobs.test.steps;
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
    const full = steps.find(step => step.name === "Run tests");
    expect(full.if).toBe("inputs.vitest_file == ''");
    expect(full.run).toBe("pnpm test");
    const scoped = steps.find(step => step.name === "Scoped Vitest confirmation and required downstream suites");
    expect(scoped.if).toBe("inputs.vitest_file != ''");
    expect(scoped.env.VITEST_FILE).toBe("${{ inputs.vitest_file }}");
    expect(scoped.env.MURAGE_SKIP_REAL_ELECTRON_BROWSER_FIXTURE).toBe("${{ matrix.os == 'windows-latest' && '1' || '0' }}");
    expect(scoped.run.trim().split("\n").slice(1)).toEqual([
      'test_paths=(); while IFS= read -r test_path; do test_paths+=("$test_path"); done <<< "$VITEST_FILE"', "pnpm check:contrast", 'pnpm exec vitest run "${test_paths[@]}"', "pnpm broker:check", "pnpm broker:test",
      "pnpm test:electron", "pnpm test:packaged-server",
    ]);
    expect(workflow.jobs.test.name).toContain("Scoped CI confirmation");
    expect(steps.some(step => step.run === "pnpm typecheck")).toBe(true);
    // The Worker is compiled on every run (FLUXCFG follow-up 6): broker:check
    // sits between the repo typecheck and the tests, on every platform.
    const brokerCheck = steps.findIndex(step => step.run === "pnpm broker:check");
    expect(brokerCheck).toBeGreaterThan(steps.findIndex(step => step.run === "pnpm typecheck"));
    expect(brokerCheck).toBeLessThan(steps.indexOf(full));
    expect(steps[brokerCheck].if).toBeUndefined();
    expect(steps.some(step => step.run === "pnpm check:electron")).toBe(true);
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
    expect(ci.jobs.test.strategy.matrix.os).toBe('${{ fromJSON(inputs.windows_only && \'["windows-latest"]\' || \'["macos-latest","ubuntu-latest","windows-latest"]\') }}');
    expect(ci.jobs.test.steps.find(step => step.name === "Run tests").run).toBe("pnpm test");
    expect(ci.jobs['control-plane'].if).toBe('${{ !inputs.windows_only && !inputs.human_files }}');
    expect(ci.jobs['package-linux'].if).toBe('${{ !inputs.windows_only && !inputs.human_files }}');
  });
});

describe("scoped Ubuntu human confirmation", () => {
  it("uses explicit manual selection while preserving default CI", () => {
    const ci = load("ci.yml");
    expect(triggers(ci).workflow_dispatch.inputs.human_files.type).toBe("string");
    expect(ci.jobs.test.if).toBe('${{ !inputs.human_files }}');
    const job = ci.jobs["human-confirmation"];
    expect(job.if).toBe("${{ github.event_name == 'workflow_dispatch' && inputs.human_files != '' }}");
    expect(job["runs-on"]).toBe("ubuntu-latest");
    expect(job.steps.find(step => step.name === "Confirm selected human specs").run).toContain('playwright test "${human_paths[@]}" --retries=0 --trace=on');
    expect(job.steps.find(step => step.name === "Upload human screenshots and traces").if).toBe("always()");
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
