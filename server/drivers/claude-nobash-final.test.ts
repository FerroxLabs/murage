// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WIN-NOBASH-DESIGN-r2 section 14.3 (final additive round, after Astra code3, astra-nobash-code3/OUT.txt), plus the round's items
// 5 and 6 (MurageMain): 1 the complete 2.1.305 login/routing inventory pinned every turn; 2 the sign-in hold card; 3 env: targets
// read as PowerShell's argument mode reads them; 5 the CLI's probes handed the pins like a turn; 6 the PowerShell card offers what
// the Bash card offers. Read loosely so a base without them fails as a test.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { valuePins } from "../../shared/arg-vocabulary.ts";
import { pinOverrideIn } from "../../shared/prompt-capable.ts";
import { approvalKey, exactAllowKeyFor, exactCommandForRequest } from "../auto-approve.ts";
import { invalidateCliVersions } from "../cli-version-cache.ts";
import { ensureDirs } from "../config.ts";
import type { ProviderInstance, RuntimeEvent } from "../contracts.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import * as claude from "./claude.ts";
import { resetClaudeVersionGate } from "./claude-guards.ts";

vi.mock("node:child_process", async (original) => (await import("../testing/exec-check-spy.ts")).withExecCheckSpy(await original()));

const mod = claude as unknown as Record<string, any>;
const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-claude-cli.ts");
const INHERIT = { kind: "powershell-inherit", reason: "no-git-bash" };

function winHand(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { PATH: "C:\\Windows\\System32", USERPROFILE: "C:\\Users\\o", ...extra };
  for (const [name, value] of valuePins("win32")) env[name] = value;
  return env;
}

let dir: string;
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "claude-nobash-final-"))); });
afterEach(() => removeTempDirSync(dir));

function file(name: string, settings: Record<string, unknown>): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(settings));
  return path;
}

// The names 14.3 item 1 adds, read from the 2.1.305 bundle (fhn's vg/U7n/kg, Nl) and its documentation.
const VERTEX_MEMBERS = ["VERTEX_REGION_CLAUDE_3_5_HAIKU", "VERTEX_REGION_CLAUDE_3_5_SONNET", "VERTEX_REGION_CLAUDE_3_7_SONNET", "VERTEX_REGION_CLAUDE_4_0_OPUS", "VERTEX_REGION_CLAUDE_4_0_SONNET", "VERTEX_REGION_CLAUDE_4_1_OPUS", "VERTEX_REGION_CLAUDE_4_5_OPUS", "VERTEX_REGION_CLAUDE_4_5_SONNET", "VERTEX_REGION_CLAUDE_4_6_OPUS", "VERTEX_REGION_CLAUDE_4_6_SONNET", "VERTEX_REGION_CLAUDE_4_7_OPUS", "VERTEX_REGION_CLAUDE_4_8_OPUS", "VERTEX_REGION_CLAUDE_5_5_OPUS", "VERTEX_REGION_CLAUDE_5_5_SONNET", "VERTEX_REGION_CLAUDE_5_OPUS", "VERTEX_REGION_CLAUDE_5_SONNET", "VERTEX_REGION_CLAUDE_FABLE_5", "VERTEX_REGION_CLAUDE_FABLE_5_1", "VERTEX_REGION_CLAUDE_HAIKU_4_5", "VERTEX_REGION_CLAUDE_HAIKU_5_5"];
const AWS_ENDPOINTS = ["AWS_ENDPOINT_URL", "AWS_ENDPOINT_URL_BEDROCK", "AWS_ENDPOINT_URL_BEDROCK_RUNTIME", "AWS_ENDPOINT_URL_STS", "AWS_ENDPOINT_URL_SSO", "AWS_ENDPOINT_URL_SSO_OIDC"];
const ADDED = [
  "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CODE_OAUTH_SCOPES", "CLAUDE_CODE_OAUTH_CLIENT_ID", "CLAUDE_CODE_CUSTOM_OAUTH_URL",
  "CLAUDE_CODE_SESSION_ACCESS_TOKEN", "ANTHROPIC_FOUNDRY_AUTH_TOKEN", "ANTHROPIC_AWS_API_KEY", "CLAUDE_CODE_API_BASE_URL", "ANTHROPIC_UNIX_SOCKET",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", "CLAUDE_CODE_SKIP_MANTLE_AUTH", "CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH", "CLAUDE_CODE_SKIP_ANTHROPIC_GOOGLE_CLOUD_AUTH",
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE", "AWS_ROLE_ARN", "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_EC2_METADATA_SERVICE_ENDPOINT", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT",
  "GOOGLE_CLOUD_QUOTA_PROJECT", "GCE_METADATA_HOST", "CLOUDSDK_CONFIG", "ANTHROPIC_IDENTITY_TOKEN", "ANTHROPIC_FEDERATION_RULE_ID", "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_WORKSPACE_ID", "ANTHROPIC_PROFILE", "ALL_PROXY", "NODE_TLS_REJECT_UNAUTHORIZED", "CLAUDE_CODE_CERT_STORE", "CLAUDE_CODE_HOST_CREDS_FILE",
  "CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL", "CLAUDE_CODE_AUTO_MODE_MODEL", "ANTHROPIC_BEDROCK_SERVICE_TIER", "CLAUDE_BRIDGE_OAUTH_TOKEN",
  ...VERTEX_MEMBERS, ...AWS_ENDPOINTS,
];

describe("14.3 item 1: the complete 2.1.305 login and routing inventory, pinned every turn", () => {
  it("names every added family member exactly, with a reason per row", () => {
    const table = mod.CLAUDE_OWNER_ROUTING_NAMES["2.1.305"] as Array<{ name: string; prefix?: true; members?: string[]; why: string }>;
    for (const row of table) expect(row.why, row.name).toBeTruthy();
    expect([...table.find((row) => row.name === "VERTEX_REGION_CLAUDE_")!.members!].sort()).toEqual([...VERTEX_MEMBERS].sort());
    for (const name of ADDED) expect(mod.isClaudeOwnerRoutingName(name, "2.1.305", "linux"), name).toBe(true);
  });

  it("with no settings file and no owner value, every added name is left out (14.6: never \"\")", () => {
    const overlay = mod.claudeOverlayEnv("win32", INHERIT, winHand(), []);
    for (const name of ADDED) expect(overlay.env[name], name).toBeUndefined();
  });

  it("each added name a repository's project settings set is pinned to the owner's value, or left out when the owner has none (14.6)", () => {
    const owner = Object.fromEntries(ADDED.filter((_, i) => i % 2 === 0).map((name) => [name, `owner-${name.toLowerCase()}`]));
    const user = file("user.json", { env: owner });
    const project = file("project.json", { env: Object.fromEntries(ADDED.map((name) => [name, `repo-${name.toLowerCase()}`])) });
    const overlay = mod.claudeOverlayEnv("win32", INHERIT, winHand(), [{ path: user, source: "user" }, { path: project, source: "project" }]);
    for (const name of ADDED) expect(overlay.env[name], name).toBe(owner[name]);
  });

  it("names whose empty value counts as set are not pinned (the owner's login store stays where it is)", () => {
    const overlay = mod.claudeOverlayEnv("win32", INHERIT, winHand(), []);
    for (const name of mod.CLAUDE_SIGNIN_UNPINNED_NAMES as string[]) {
      expect(mod.isClaudeOwnerRoutingName(name, "2.1.305", "win32"), name).toBe(false);
      if (name !== "USERPROFILE") expect(overlay.env[name], name).toBeUndefined();
    }
  });
});

const SIGNIN_KEYS = ["apiKeyHelper", "awsAuthRefresh", "awsCredentialExport", "gcpAuthRefresh", "otelHeadersHelper", "modelOverrides"];
const SENTINEL = "signin-sentinel-7f3a9c";

describe("14.3 item 2: the sign-in hold", () => {
  const hold = (files: Array<{ path: string; source: string }>, handed: Record<string, string> = { PATH: "/bin" }, managed: string[] = []) => mod.claudeSigninHold("linux", handed, files, managed);

  it("each sign-in settings key a project or local file sets holds the turn", () => {
    for (const key of SIGNIN_KEYS) {
      for (const source of ["project", "local"]) {
        const value = key === "modelOverrides" ? { "claude-opus-5-5": `${SENTINEL}-model` } : `${SENTINEL}-${key}`;
        const repo = file(`${source}-${key}.json`, { [key]: value });
        expect(hold([{ path: repo, source }]), `${key} ${source}`).toEqual({ keys: [key], env: [] });
      }
    }
  });

  it("each inventory env name a repository file sets to a value the owner does not have holds the turn", () => {
    const names = [...ADDED, "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", "SSL_CERT_FILE"];
    for (const name of names) {
      const repo = file(`p-${name}.json`, { env: { [name]: SENTINEL } });
      expect(hold([{ path: repo, source: "project" }]), name).toEqual({ keys: [], env: [name] });
    }
    // an ordinary name does not
    expect(hold([{ path: file("plain.json", { env: { MY_TOOL_FLAG: "1" } }), source: "project" }])).toBeNull();
  });

  it("a value the same as the owner's does not hold (user settings, the hand, managed settings)", () => {
    const user = file("user.json", { apiKeyHelper: "/owner/helper", modelOverrides: { a: "b", c: "d" }, env: { ANTHROPIC_BASE_URL: "https://owner.example" } });
    const repo = file("repo.json", { apiKeyHelper: "/owner/helper", modelOverrides: { c: "d", a: "b" }, env: { ANTHROPIC_BASE_URL: "https://owner.example", HTTPS_PROXY: "http://handed:3128", ANTHROPIC_MODEL: "" } });
    expect(hold([{ path: user, source: "user" }, { path: repo, source: "local" }], { PATH: "/bin", HTTPS_PROXY: "http://handed:3128" })).toBeNull();
    const managed = file("managed.json", { gcpAuthRefresh: "org-refresh", env: { CLOUD_ML_REGION: "org-region" } });
    const repo2 = file("repo2.json", { gcpAuthRefresh: SENTINEL, env: { CLOUD_ML_REGION: SENTINEL } });
    expect(hold([{ path: repo2, source: "project" }], { PATH: "/bin" }, [managed])).toBeNull();
  });

  it("no project or local settings does not hold, whatever the owner's own file says", () => {
    const user = file("user-only.json", { apiKeyHelper: "/owner/helper", env: { ANTHROPIC_BASE_URL: "https://owner.example" } });
    expect(hold([{ path: user, source: "user" }])).toBeNull();
    expect(hold([{ path: join(dir, "missing.json"), source: "project" }])).toBeNull();
  });

  it("the hold carries names only, never a value; the card says it in plain words", () => {
    const repo = file("vals.json", { apiKeyHelper: SENTINEL, env: { ANTHROPIC_AUTH_TOKEN: SENTINEL } });
    const result = hold([{ path: repo, source: "project" }]);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    const question = mod.claudeSigninQuestion();
    expect(question.question).toBe("This project's settings change how Claude signs in. Allow?");
    expect(mod.CLAUDE_SIGNIN_DENIED).not.toMatch(/[A-Z]{2,}_[A-Z_]+|apiKeyHelper|\bMURAGE_/);
    expect(mod.claudeSigninAllowed({ behavior: "answer", answers: [{ id: question.id, selected: ["Allow"] }] })).toBe(true);
    expect(mod.claudeSigninAllowed({ behavior: "answer", answers: [{ id: question.id, selected: ["Don't allow"] }] })).toBe(false);
    expect(mod.claudeSigninAllowed({ behavior: "deny" })).toBe(false);
  });
});

describe("14.3 item 2 and item 5 through the driver (fake CLI)", () => {
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;
  const saved: Record<string, string | undefined> = {};
  const setEnv = (name: string, value: string) => { if (!(name in saved)) saved[name] = process.env[name]; process.env[name] = value; };

  const create = async () => {
    instance = await claude.ClaudeDriver.create({ instanceId: "claude-final-test", displayName: "Claude Final Test", environment: {}, enabled: true, config: { cli: FAKE_CLI, permissionMode: "acceptEdits" } });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    invalidateCliVersions();
    resetClaudeVersionGate();
  });

  afterEach(async () => {
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; delete saved[name]; }
    recorder?.stop();
    await instance?.dispose();
    instance = undefined;
    vi.restoreAllMocks();
    invalidateCliVersions();
    resetClaudeVersionGate();
  });

  const repoWith = (settings: Record<string, unknown>): string => {
    const cwd = join(dir, "repo");
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify(settings));
    return cwd;
  };

  const logged = () => {
    const lines: string[] = [];
    for (const level of ["info", "warn", "error", "log"] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
    return lines;
  };

  it("a project's apiKeyHelper holds the turn on the card; Don't allow ends it before anything launches, with no value logged", async () => {
    const lines = logged();
    await create();
    const dump = join(dir, "dump.json");
    setEnv("FAKE_CLAUDE_DUMP", dump);
    const cwd = repoWith({ apiKeyHelper: `/repo/${SENTINEL}`, env: { ANTHROPIC_BASE_URL: `https://${SENTINEL}.example` } });
    // the turn waits on the card before it launches: sendTurn settles once the card is answered
    const sent = instance!.adapter.sendTurn({ threadId: "t-signin-deny", text: "hi", cwd });
    const opened = await recorder!.until((e) => e.type === "request.opened" && e.threadId === "t-signin-deny") as Extract<RuntimeEvent, { type: "request.opened" }>;
    expect(opened.requestType).toBe("question");
    expect(opened.summary).toBe("This project's settings change how Claude signs in. Allow?");
    expect(await instance!.adapter.respondToRequest("t-signin-deny", opened.requestId!, { behavior: "answer", answers: [{ id: "signin", selected: ["Don't allow"] }] })).toBe("rejected");
    await sent;
    const done = await recorder!.until((e) => e.type === "turn.completed" && e.threadId === "t-signin-deny");
    expect(done).toMatchObject({ ok: false });
    expect(JSON.stringify(recorder!.events)).toContain("you chose not to allow that");
    expect(existsSync(dump)).toBe(false);
    expect(JSON.stringify(recorder!.events)).not.toContain(SENTINEL);
    expect(lines.join("\n")).not.toContain(SENTINEL);
    expect(lines.join("\n")).toContain("claude sign-in hold: project settings set apiKeyHelper,ANTHROPIC_BASE_URL");
  });

  it("Allow runs the turn, with the repository's value of the names it asked about let through", async () => {
    logged();
    await create();
    const dump = join(dir, "dump-allow.json");
    setEnv("FAKE_CLAUDE_DUMP", dump);
    const cwd = repoWith({ env: { ANTHROPIC_MODEL: "repo-model" } });
    // the turn waits on the card before it launches: sendTurn settles once the card is answered
    const sent = instance!.adapter.sendTurn({ threadId: "t-signin-allow", text: "hi", cwd });
    const opened = await recorder!.until((e) => e.type === "request.opened" && e.threadId === "t-signin-allow");
    expect(await instance!.adapter.respondToRequest("t-signin-allow", (opened as { requestId: string }).requestId, { behavior: "answer", answers: [{ id: "signin", selected: ["Allow"] }] })).toBe("answered");
    await sent;
    await recorder!.until((e) => e.type === "turn.completed" && e.threadId === "t-signin-allow");
    const files = (JSON.parse(readFileSync(dump, "utf8")) as { settingsFiles: Array<{ env?: Record<string, string> } | null> }).settingsFiles;
    // the overlay is the settings object carrying the plugin-directory pin (14.6: routing names with no owner value are absent)
    const overlay = files.find((settings) => settings?.env && "CLAUDE_CODE_PLUGIN_DIRS" in settings.env)!;
    expect(overlay).toBeDefined();
    expect(overlay.env).not.toHaveProperty("ANTHROPIC_MODEL");
    expect(overlay.env).not.toHaveProperty("ANTHROPIC_BASE_URL"); // 14.6: no owner value, left out, never ""
  });

  it("no project settings: no card, the turn runs", async () => {
    logged();
    await create();
    await instance!.adapter.sendTurn({ threadId: "t-signin-none", text: "hi", cwd: repoWith({ env: { MY_TOOL_FLAG: "1" } }) });
    await recorder!.until((e) => e.type === "turn.completed" && e.threadId === "t-signin-none");
    expect(recorder!.events.some((e) => e.type === "request.opened")).toBe(false);
  });

  // item 5: the live proof saw these sentinels in the probes
  const SENTINELS: Record<string, string> = { BASH_ENV: "/tmp/probe-sentinel-bash-env", CLAUDE_ENV_FILE: "/tmp/probe-sentinel-env-file", GIT_EDITOR: "probe-sentinel-editor", GIT_SSH: "/tmp/probe-sentinel-ssh", PAGER: "probe-sentinel-pager" };
  const probes = (log: string) => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { probe: string; env: Record<string, string> }) : [];
  const expectPinned = (seen: Array<{ probe: string; env: Record<string, string> }>, kinds: string[]) => {
    for (const kind of kinds) expect(seen.some((entry) => entry.probe === kind), kind).toBe(true);
    for (const { probe, env } of seen) {
      for (const [name, value] of Object.entries(SENTINELS)) expect(env[name], `${probe} ${name}`).not.toBe(value);
      expect(env.PAGER, probe).toBe("cat");
      expect(env.CLAUDE_ENV_FILE, probe).toBeUndefined();
    }
  };

  it("item 5: the snapshot's --version and auth status probes are handed the pins, never the owner's raw environment", async () => {
    for (const [name, value] of Object.entries(SENTINELS)) setEnv(name, value);
    const log = join(dir, "probes.jsonl");
    setEnv("FAKE_CLAUDE_PROBE_LOG", log);
    await create();
    expect(await instance!.snapshot()).toMatchObject({ state: "available" });
    expectPinned(probes(log), ["version", "auth"]);
  });

  it("item 5: a turn's version check is handed the pins", async () => {
    logged();
    for (const [name, value] of Object.entries(SENTINELS)) setEnv(name, value);
    const log = join(dir, "probes-turn.jsonl");
    setEnv("FAKE_CLAUDE_PROBE_LOG", log);
    await create();
    await instance!.adapter.sendTurn({ threadId: "t-probe-turn", text: "hi", cwd: dir });
    await recorder!.until((e) => e.type === "turn.completed" && e.threadId === "t-probe-turn");
    expectPinned(probes(log), ["version"]);
  });

  it("item 5: a review call's version check is handed the pins", async () => {
    logged();
    for (const [name, value] of Object.entries(SENTINELS)) setEnv(name, value);
    const log = join(dir, "probes-review.jsonl");
    setEnv("FAKE_CLAUDE_PROBE_LOG", log);
    await create();
    await instance!.generateText!("say hi");
    expectPinned(probes(log), ["version"]);
  });
});

describe("14.3 item 3: env: targets unquoted and unescaped as PowerShell's argument mode reads them", () => {
  const pins = valuePins("win32");
  it("a quoted or escaped provider prefix still names the pin, in any case", () => {
    for (const command of [
      "Set-Item en\"v\":git_ssh_command x",
      "Set-Item e`nv:GIT_SSH_COMMAND x",
      "Set-Item 'env':git_ssh_command x",
      "Set-Item \"env\":Pager less",
      "Set-Item EnV:Git_Ssh_Command x",
      "Set-Item en\u201Cv\u201D:git_ssh_command x",
      "Set-Item \u2018env\u2019:PAGER less",
      "Set-Item -Path:en\"v\":PAGER -Value less",
      "si e'n'v:git_editor x",
      "Set-Location en\"v\":; Set-Item PAGER less",
      "Set-Item \"en$x:PAGER\" less",
      "Set-Item 'env:pa'ger less",
    ]) expect(pinOverrideIn(command, pins, "pwsh"), command).not.toBeNull();
  });

  it("benign commands still pass", () => {
    for (const command of [
      "Get-ChildItem",
      "git status",
      "Write-Output \"hello $name\"",
      "Set-Item env:MY_FLAG 1",
      "Set-Item \"env:MY_FLAG\" 1",
      "Set-Item en\"v\":MY_FLAG 1",
      "$env:FOO = 'x'",
      "Get-ChildItem env:",
      "echo 'a b' \"c d\"",
      "npm test -- --reporter=dot",
      "(Get-Item 'env:Path').Value",
    ]) expect(pinOverrideIn(command, pins, "pwsh"), command).toBeNull();
  });
});

describe("item 6: the PowerShell ask card offers what the Bash ask card offers", () => {
  it("the same remembered-grant keys, for the same command, from the same engine and folder", () => {
    for (const command of ["git status", "npm test", "node build.js"]) {
      const offers = (tool: string) => {
        const toolCall = { name: tool, input: { command } };
        const exact = exactCommandForRequest({ tool, toolCall, engine: "claude", turnCwd: dir });
        return { always: approvalKey(tool, command, undefined, { toolCall } as never) !== undefined, exact: exactAllowKeyFor(tool, command, exact) !== undefined };
      };
      expect(offers("PowerShell"), command).toEqual(offers("Bash"));
      expect(offers("Bash").exact, command).toBe(true);
    }
  });
});
