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
    expect(pin.run).toMatch(/if \[ "\$previous" = "\$current" \]/);
    expect(pin.run).toMatch(/should_release=false/);
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
    expect(refuse.run).toContain("--repo FerroxLabs/murage-releases");
    expect(refuse.run).toMatch(/exit 1/);
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
