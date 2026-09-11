import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { createHash } from "node:crypto";
import { apiGet, findRelease, inspectReleaseBranch, nextVersion, parseVersion, shouldRelease, uploadDraft } from "./release-guard.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const workflow = (name) => parse(readFileSync(join(ROOT, ".github/workflows", name), "utf8"));

// Execute the checked-in workflow shell with real Node and local command
// doubles. No token, git remote, GitHub call, release, or user data is touched.
function runStep(step, scenario = {}) {
  const dir = mkdtempSync(join(tmpdir(), "murage-release-guard-"));
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "assets"));
  mkdirSync(join(dir, "scripts"));
  copyFileSync(join(ROOT, "scripts/release-guard.mjs"), join(dir, "scripts/release-guard.mjs"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: scenario.current ?? "1.2.3" }));
  writeFileSync(join(dir, "assets", "asset.zip"), "artifact");
  writeFileSync(join(dir, "release-notes.md"), "notes");
  writeFileSync(join(dir, "scenario.json"), JSON.stringify(scenario));
  writeFileSync(join(dir, "output"), "");
  writeFileSync(join(dir, "calls"), "");
  const stub = `#!${process.execPath}
import { readFileSync, appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
const s = JSON.parse(readFileSync(process.env.SCENARIO, 'utf8'));
const tool = process.argv[1].split('/').at(-1);
appendFileSync(process.env.CALLS, JSON.stringify([tool, ...args]) + '\\n');
if (tool === 'git') {
  if (args[0] === 'rev-parse') console.log('a'.repeat(40));
  else if (args[0] === 'show') console.log(JSON.stringify(s.previous ?? {version:'1.2.2'}));
  else if (args[0] === 'ls-remote') process.exit(s.branchExists ? 0 : 2);
  process.exit(0);
}
if (args[0] === 'release' && args[1] === 'view') {
  if (s.apiError || s.missing) process.exit(1);
  console.log(args.includes('--jq') ? String(s.draft ?? true) : JSON.stringify({isDraft:s.draft ?? true}));
  process.exit(0);
}
if (args[0] === 'api') {
  const endpoint = args.find(a => a.startsWith('repos/') || a.startsWith('https://'));
  const method = args[args.indexOf('--method') + 1];
  if (method === 'GET') {
    const status = s.apiError || (s.missing && endpoint.includes('/releases/tags/') ? 404 : 200);
    console.log('HTTP/2.0 ' + status + ' Status\\nContent-Type: application/json\\n\\n' + JSON.stringify(
      status === 200 ? (endpoint.includes('/contents/')
        ? {encoding:'base64',content:Buffer.from(JSON.stringify({version:process.env.VERSION})).toString('base64')}
        : endpoint.includes('/releases?') ? []
        : endpoint.includes('/releases/') ? {id:123,tag_name:'v' + process.env.VERSION,draft:s.draft ?? true,assets:[]}
        : {permissions:{push:true}})
      : {message:'request failed'}));
    process.exit(status === 200 ? 0 : 1);
  }
}
if (args[0] === 'pr' && args[1] === 'list') console.log(JSON.stringify(s.prs ?? []));
process.exit(0);
`;
  for (const command of ["gh", "git"]) writeFileSync(join(dir, "bin", command), stub, { mode: 0o755 });
  try {
    const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", step.run], {
      cwd: dir,
      env: {
        PATH: `${join(dir, "bin")}:${dirname(process.execPath)}:/usr/bin:/bin`,
        GITHUB_EVENT_NAME: "push", BEFORE: "b".repeat(40), VERSION: scenario.current ?? "1.2.3",
        GITHUB_REPOSITORY: "FerroxLabs/murage", GITHUB_OUTPUT: join(dir, "output"),
        GITHUB_STEP_SUMMARY: join(dir, "summary"), RUNNER_TEMP: dir,
        SCENARIO: join(dir, "scenario.json"), CALLS: join(dir, "calls"),
      },
      encoding: "utf8", timeout: 10_000,
    });
    return { ...result, output: readFileSync(join(dir, "output"), "utf8"),
      calls: readFileSync(join(dir, "calls"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The guarded jobs run on Ubuntu and use Bash/POSIX executable stubs. Keep the
// platform-independent helper cases below enabled on the Windows test matrix.
describe.skipIf(process.platform === "win32")("executable release workflow boundaries", () => {
  const release = workflow("release.yml");
  const prepare = workflow("prepare-release.yml");
  const pin = release.jobs.prepare.steps.find(step => step.id === "pin");

  it.each([{version:"1.2.4"}, {}, {version:"undefined"}, {version:"01.2.2"}])(
    "refuses a downgrade or invalid previous version %j", previous => {
      expect(runStep(pin, {previous}).status).not.toBe(0);
    },
  );
  it("skips equality and permits a real version increase", () => {
    const equal = runStep(pin, {previous:{version:"1.2.3"}});
    expect(equal.status, equal.stderr).toBe(0);
    expect(equal.output).toContain("should_release=false");
    const greater = runStep(pin, {previous:{version:"1.2.2"}});
    expect(greater.status, greater.stderr).toBe(0);
    expect(greater.output).toContain("should_release=true");
  });
  it("fails closed on a GitHub lookup outage before branch creation", () => {
    const step = prepare.jobs.prepare.steps.find(step => String(step.name).startsWith("Refuse an existing"));
    expect(runStep(step, {apiError:503}).status).not.toBe(0);
  });
  it("reuses an existing branch without pretending an open PR exists", () => {
    const step = prepare.jobs.prepare.steps.find(step => String(step.name).includes("release branch"));
    const result = runStep(step, {missing:true,branchExists:true,prs:[]});
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toContain("branch_exists=true");
    expect(result.output).toContain("pr_url=\n");
  });
  it("does not upload anything if the draft was published during the builds", () => {
    const step = release.jobs.assemble.steps.find(step => String(step.name).startsWith("Create or update"));
    const result = runStep(step, {draft:false});
    expect(result.status).not.toBe(0);
    expect(result.calls.filter(call => call[1] === "release" && ["upload","create","edit"].includes(call[2]))).toEqual([]);
    expect(result.calls.filter(call => call[1] === "api" && call.includes("POST"))).toEqual([]);
  });
});

const http = (status, body) => ({ status: status === 200 ? 0 : 1,
  stdout: `HTTP/2.0 ${status} Status\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}` });

describe("release guard semantics", () => {
  it.each([undefined, null, 123, "undefined", "", "01.2.3", "1.02.3", "1.2.03", "v1.2.3", "1.2.3-beta.1", "1.2.3\n"])(
    "rejects a noncanonical stable version %j", value => expect(() => parseVersion(value)).toThrow(),
  );
  it("compares numeric components and bumps without rounding", () => {
    expect(shouldRelease("1.10.0", "1.9.9")).toBe(true);
    expect(shouldRelease("2.0.0", "1.999.999")).toBe(true);
    expect(shouldRelease("1.2.3", "1.2.3")).toBe(false);
    expect(() => shouldRelease("1.99.99", "2.0.0")).toThrow(/downgrade/);
    expect(nextVersion("1.2.9007199254740992", "patch")).toBe("1.2.9007199254740993");
    expect(nextVersion("1.2.3", "minor")).toBe("1.3.0");
    expect(nextVersion("1.2.3", "custom", "v2.0.0")).toBe("2.0.0");
    expect(() => nextVersion("1.2.3", "custom", "1.2.3")).toThrow(/newer/);
  });
  it.each([401,403,429,500,503])("never interprets HTTP %s as absence", status => {
    expect(() => apiGet("repos/example/repo", { allow404:true, run:() => http(status,{}) })).toThrow(/lookup failed/);
  });
  it("requires an explicit HTTP 404 for the optional absence result", () => {
    expect(apiGet("missing", {allow404:true,run:()=>http(404,{})})).toBeNull();
    expect(() => apiGet("missing", {run:()=>http(404,{})})).toThrow();
    expect(() => apiGet("missing", {allow404:true,run:()=>({status:1,stderr:"not found",stdout:""})})).toThrow();
    expect(() => apiGet("missing", {allow404:true,run:()=>({status:0,stdout:"garbage"})})).toThrow();
  });
  it("finds an authenticated draft even when the published-tag endpoint returns 404", () => {
    const draft = {id:7,tag_name:"v1.2.3",draft:true,assets:[]};
    const run = (_command,args) => http(args.at(-1).includes("/tags/") ? 404 : 200,
      args.at(-1).includes("/releases?") ? [draft] : {permissions:{push:true}});
    expect(findRelease("1.2.3",run)).toEqual(draft);
  });
  it("requires release write access before interpreting listings", () => {
    expect(() => findRelease("1.2.3",()=>http(200,{permissions:{push:false}}))).toThrow(/push access/);
  });
  it("fails branch inspection on transport errors instead of creating over unknown state", () => {
    expect(() => inspectReleaseBranch("1.2.3","FerroxLabs/murage",()=>({status:128,stdout:""}))).toThrow(/inspect/);
  });
});

describe("draft uploads against a changing remote", () => {
  it.each([
    [{ status: 1, stderr: "HTTP 403: Resource not accessible by personal access token" }, "HTTP=403, reason=resource-access-denied, process=none"],
    [{ status: 1, stderr: "HTTP 422: Validation Failed" }, "HTTP=422, reason=validation-failed, process=none"],
    [{ status: null, error: { code: "ETIMEDOUT" } }, "HTTP=unknown, reason=unclassified, process=ETIMEDOUT"],
  ])("classifies draft creation failures without leaking CLI output or retrying", (failure, expected) => {
    const dir = mkdtempSync(join(tmpdir(), "murage-draft-error-"));
    writeFileSync(join(dir, "asset.zip"), "artifact");
    const calls = [];
    const secret = "private-token-canary-do-not-print";
    const run = (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "release") return { ...failure, stderr: `${failure.stderr ?? ""}\n${secret}`, stdout: secret };
      const endpoint = args.at(-1);
      return endpoint.includes("/tags/") ? http(404, {}) : http(200, endpoint.includes("/releases?") ? [] : { permissions: { push: true } });
    };
    try {
      let error;
      try { uploadDraft("1.2.3", dir, "unused-notes", run); } catch (caught) { error = caught; }
      expect(error.message).toContain(`gh release create failed (`);
      expect(error.message).toContain(expected);
      expect(error.message).not.toContain(secret);
      expect(calls.filter(call => call[1] === "release")).toHaveLength(1);
      expect(calls.flat()).not.toContain("POST");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  function uploadScenario({existing = [], states = [true], collision = false} = {}) {
    const dir = mkdtempSync(join(tmpdir(), "murage-draft-upload-"));
    writeFileSync(join(dir,"asset.zip"),"artifact");
    const calls = [];
    let reads = 0;
    const run = (command,args) => {
      calls.push([command,...args]);
      const endpoint = args.at(-1);
      if (args.includes("POST")) return {status:collision ? 1 : 0,stdout:"{}"};
      if (endpoint.endsWith("/murage-releases")) return http(200,{permissions:{push:true}});
      const draft = endpoint.includes("/tags/") ? true : states[Math.min(reads++,states.length-1)];
      return http(200,{id:7,tag_name:"v1.2.3",draft,assets:existing});
    };
    let error;
    let id;
    try { id = uploadDraft("1.2.3",dir,"unused-notes",run); } catch (caught) { error = caught; }
    finally { rmSync(dir,{recursive:true,force:true}); }
    return {calls,error,id};
  }
  it("re-reads an eventually consistent listing before declaring the created draft absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "murage-draft-upload-"));
    writeFileSync(join(dir, "asset.zip"), "artifact");
    const calls = [];
    let created = false;
    let listings = 0;
    const run = (command, args) => {
      calls.push([command, ...args]);
      const endpoint = args.at(-1);
      if (args[0] === "release" && args[1] === "create") { created = true; return { status: 0, stdout: "" }; }
      if (args.includes("POST")) return { status: 0, stdout: "{}" };
      if (endpoint.endsWith("/murage-releases")) return http(200, { permissions: { push: true } });
      if (endpoint.includes("/tags/")) return http(404, {});
      if (endpoint.includes("/releases?")) {
        // The draft shows up in the listing only on the third read after creation.
        listings++;
        return http(200, created && listings >= 4 ? [{ id: 7, tag_name: "v1.2.3", draft: true, assets: [] }] : []);
      }
      return http(200, { id: 7, tag_name: "v1.2.3", draft: true, assets: [] });
    };
    let error; let id;
    try { id = uploadDraft("1.2.3", dir, "unused-notes", run); } catch (caught) { error = caught; }
    finally { rmSync(dir, { recursive: true, force: true }); }
    expect(error).toBeUndefined();
    expect(id).toBe(7);
    expect(calls.filter(call => call[2] === "create")).toHaveLength(1);
  });
  it("still refuses when the created draft never appears", () => {
    const dir = mkdtempSync(join(tmpdir(), "murage-draft-upload-"));
    writeFileSync(join(dir, "asset.zip"), "artifact");
    const calls = [];
    const run = (command, args) => {
      calls.push([command, ...args]);
      const endpoint = args.at(-1);
      if (args[0] === "release" && args[1] === "create") return { status: 0, stdout: "" };
      if (endpoint.endsWith("/murage-releases")) return http(200, { permissions: { push: true } });
      if (endpoint.includes("/tags/")) return http(404, {});
      return http(200, []);
    };
    let error;
    try { uploadDraft("1.2.3", dir, "unused-notes", run); } catch (caught) { error = caught; }
    finally { rmSync(dir, { recursive: true, force: true }); }
    expect(error.message).toMatch(/could not be confirmed/);
    expect(calls.filter(call => call[2] === "create")).toHaveLength(1);
    expect(calls.flat()).not.toContain("POST");
  });
  it("stops before uploading when publication happens after initial lookup", () => {
    const result = uploadScenario({states:[false]});
    expect(result.error.message).toMatch(/published/);
    expect(result.calls.filter(call=>call.includes("POST"))).toEqual([]);
  });
  it("binds a non-overwriting upload to the numeric draft ID", () => {
    const result = uploadScenario();
    expect(result.error).toBeUndefined();
    expect(result.id).toBe(7);
    const [upload] = result.calls.filter(call=>call.includes("POST"));
    expect(upload).toContain("https://uploads.github.com/repos/FerroxLabs/murage-releases/releases/7/assets?name=asset.zip");
    expect(result.calls.flat()).not.toContain("--clobber");
    expect(result.calls.flat()).not.toContain("DELETE");
  });
  it("detects an external publication during the upload without claiming to undo the race", () => {
    const result = uploadScenario({states:[true,false]});
    expect(result.error.message).toMatch(/published/);
    expect(result.calls.filter(call=>call.includes("POST"))).toHaveLength(1);
  });
  it("reuses only a byte-identical uploaded asset", () => {
    const digest = `sha256:${createHash("sha256").update("artifact").digest("hex")}`;
    const result = uploadScenario({existing:[{name:"asset.zip",state:"uploaded",size:8,digest}]});
    expect(result.error).toBeUndefined();
    expect(result.calls.filter(call=>call.includes("POST"))).toEqual([]);
    const changed = uploadScenario({existing:[{name:"asset.zip",state:"uploaded",size:8,digest:"sha256:wrong"}]});
    expect(changed.error.message).toMatch(/differs/);
    expect(changed.calls.filter(call=>call.includes("POST"))).toEqual([]);
  });
  it("does not delete or retry an upload name collision", () => {
    const result = uploadScenario({collision:true});
    expect(result.error).toBeDefined();
    expect(result.calls.filter(call=>call.includes("POST"))).toHaveLength(1);
    expect(result.calls.flat()).not.toContain("DELETE");
  });
});
