import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
// These cases isolate digest/draft semantics after qualification. The real
// mandatory check and its CLI refusal are exercised in signal-release-* tests.
vi.mock("./signal-release-prerequisites.mjs", () => ({ assertSignalReleaseReady() {} }));
import { parse } from "yaml";
import { createHash } from "node:crypto";
import { apiGet, probeReleaseToken, generateReleaseNotes, bootstrapDependencies, prepareReleaseNotes, downloadPreparedAssets, assertReleaseUpdateFeed, findRelease, inspectReleaseBranch, nextVersion, parseVersion, setReleaseBody, shouldRelease, uploadDraft, verifyReleaseTag } from "./release-guard.mjs";
import { mkdtempSync as mkdtempBody, writeFileSync as writeBody } from "node:fs";
import { tmpdir as tmpBody } from "node:os";
import { join as joinBody } from "node:path";
import { removeTempDirSync } from "../server/testing/cleanup.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const workflow = (name) => parse(readFileSync(join(ROOT, ".github/workflows", name), "utf8"));

// Execute the checked-in workflow shell with real Node and local command
// doubles. No token, git remote, GitHub call, release, or user data is touched.
function runStep(step, scenario = {}) {
  const dir = mkdtempSync(join(tmpdir(), "murage-release-guard-"));
  mkdirSync(join(dir, "bin"));
  if (!scenario.download) mkdirSync(join(dir, "assets"));
  mkdirSync(join(dir, "scripts"));
  copyFileSync(join(ROOT, "scripts/release-guard.mjs"), join(dir, "scripts/release-guard.mjs"));
  writeFileSync(join(dir, "scripts/signal-release-prerequisites.mjs"), scenario.bootstrap ? "throw new Error('dependencies not installed');\n" : "export function assertSignalReleaseReady() {}\n");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: scenario.current ?? "1.2.3" }));
  if (!scenario.download) writeFileSync(join(dir, "assets", "asset.zip"), "artifact");
  writeFileSync(join(dir, "release-notes.md"), "notes");
  writeFileSync(join(dir, "scenario.json"), JSON.stringify(scenario));
  writeFileSync(join(dir, "output"), "");
  writeFileSync(join(dir, "calls"), "");
  const stub = `#!${process.execPath}
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const s = JSON.parse(readFileSync(process.env.SCENARIO, 'utf8'));
const tool = process.argv[1].split('/').at(-1);
appendFileSync(process.env.CALLS, JSON.stringify([tool, ...args]) + '\\n');
if (tool === 'npm') process.exit(0);
if (args[0] === 'run' && args[1] === 'download') {writeFileSync('assets/asset.zip','artifact');process.exit(0);}
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
  if (method === 'POST' && endpoint.endsWith('/releases')) {
    if (s.probeDenied) process.exit(1);
    console.log(JSON.stringify({id:71,tag_name:'release-preflight-123-2',draft:true})); process.exit(0);
  }
  if (method === 'GET') {
    const status = s.apiError || (s.missing && endpoint.includes('/releases/tags/') ? 404 : 200);
    console.log('HTTP/2.0 ' + status + ' Status\\nContent-Type: application/json\\n\\n' + JSON.stringify(
      status === 200 ? (endpoint.endsWith('/releases/71') ? {id:71,tag_name:'release-preflight-123-2',draft:true}
        : endpoint.includes('/contents/')
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
  for (const command of ["gh", "git", "npm"]) writeFileSync(join(dir, "bin", command), stub, { mode: 0o755 });
  try {
    const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", step.run], {
      cwd: dir,
      env: {
        PATH: `${join(dir, "bin")}:${dirname(process.execPath)}:/usr/bin:/bin`,
        GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "2", GITHUB_EVENT_NAME: "push", BEFORE: "b".repeat(40), VERSION: scenario.current ?? "1.2.3",
        GITHUB_REPOSITORY: "FerroxLabs/murage", GITHUB_OUTPUT: join(dir, "output"),
        GITHUB_STEP_SUMMARY: join(dir, "summary"), RUNNER_TEMP: dir,
        SCENARIO: join(dir, "scenario.json"), CALLS: join(dir, "calls"),
      },
      encoding: "utf8", timeout: 10_000,
    });
    return { ...result, output: readFileSync(join(dir, "output"), "utf8"),
      calls: readFileSync(join(dir, "calls"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) };
  } finally {
    removeTempDirSync(dir);
  }
}

// The guarded jobs run on Ubuntu and use Bash/POSIX executable stubs. Keep the
// platform-independent helper cases below enabled on the Windows test matrix.
describe.skipIf(process.platform === "win32")("executable release workflow boundaries", () => {
  const release = workflow("release.yml");
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
  it("bootstraps a clean checkout before importing any dependency", () => {
    const step=release.jobs.assemble.steps.find(s=>s.run==='node scripts/release-guard.mjs bootstrap');
    const result=runStep(step,{bootstrap:true});
    expect(result.status,result.stderr).toBe(0);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].slice(0,5)).toEqual(['npm','exec','--yes','--ignore-scripts','--package=pnpm@10.33.0']);
  });
  it("downloads only the staged artifact from this run into a fresh data directory", () => {
    const step=release.jobs.assemble.steps.find(s=>s.run==='node scripts/release-guard.mjs download');
    const result=runStep(step,{download:true});
    expect(result.status,result.stderr).toBe(0);
    expect(result.calls).toEqual([['gh','run','download','123','--repo','FerroxLabs/murage','--name','release-staged-assets-2','--dir','assets'],['gh','run','download','123','--repo','FerroxLabs/murage','--name','release-ci-review-2','--dir','release-review']]);
    const existing=runStep(step);
    expect(existing.status).not.toBe(0);
    expect(existing.calls).toEqual([]);
  });
  it("runs the early probe through the checked-in workflow command before checking availability", () => {
    const step=release.jobs.assemble.steps.find(s=>s.run==='node scripts/release-guard.mjs probe-prepared');
    const result=runStep(step,{missing:true});
    expect(result.status,result.stderr).toBe(0);
    expect(result.calls[0]).toContain('POST');
    expect(result.calls[1]).toContain('repos/FerroxLabs/murage-releases/releases/71');
    expect(result.calls[2]).toContain('DELETE');
    expect(result.calls.at(-1).at(-1)).toContain('/releases?per_page=100&page=1');
  });
  it("an early write failure stops the probe command without any subsequent operation", () => {
    const step=release.jobs.assemble.steps.find(s=>s.run==='node scripts/release-guard.mjs probe-prepared');
    const result=runStep(step,{probeDenied:true});
    expect(result.status).not.toBe(0);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toContain('POST');
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
    } finally { removeTempDirSync(dir); }
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
    finally { removeTempDirSync(dir); }
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
    finally { removeTempDirSync(dir); }
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
    finally { removeTempDirSync(dir); }
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

describe("the updater feed a release build may carry (L18 qualification feed)", () => {
  // What electron-builder writes into app-update.yml for electron-builder.yml.
  const mac = "owner: FerroxLabs\nrepo: murage-releases\nprovider: github\nupdaterCacheDirName: murage-updater\n";
  const win = "owner: FerroxLabs\nrepo: murage-releases\nprovider: github\npublisherName:\n  - Ferrox Labs, LLC\nupdaterCacheDirName: murage-updater\n";
  it("accepts the public GitHub releases feed, signed Windows publisher list included", () => {
    expect(assertReleaseUpdateFeed(mac)).toBe(true);
    expect(assertReleaseUpdateFeed(win.replace(/\n/g, "\r\n"))).toBe(true);
  });
  it("refuses a qualification build's feed, and any other feed", () => {
    const qualification = parse(readFileSync(join(ROOT, "electron-builder.qualification.yml"), "utf8"));
    expect(qualification.extends).toBe("./electron-builder.yml");
    expect(qualification.publish).toBeNull();
    expect(qualification.extraMetadata.murageQualification).toBe(true);
    const baked = "provider: generic\nurl: https://feed.example.invalid/murage\nchannel: latest\nupdaterCacheDirName: murage-qualification-updater\n";
    expect(() => assertReleaseUpdateFeed(baked)).toThrow("qualification");
    expect(() => assertReleaseUpdateFeed(baked.replace("murage-qualification-updater", "murage-updater"))).toThrow("not the GitHub releases feed");
    for (const bad of [
      mac.replace("FerroxLabs", "SomeoneElse"),
      mac.replace("repo: murage-releases", "repo: murage-releases-fork"),
      `${mac}updaterCacheDirName: again\n`,
      `${mac}url: https://feed.example.invalid\n`,
      `${mac}private: true\n`,
      mac.replace("provider: github", "provider: s3"),
    ]) expect(() => assertReleaseUpdateFeed(bad)).toThrow(/app-update\.yml/);
  });
  it("every platform's release job runs the feed guard on its packaged app", () => {
    const text = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8");
    for (const file of ["release/mac-arm64/Murage.app/Contents/Resources/app-update.yml", "release/mac/Murage.app/Contents/Resources/app-update.yml", "release/win-unpacked/resources/app-update.yml", "release/linux-unpacked/resources/app-update.yml"]) {
      expect(text.split("\n").some(line => line.includes("node scripts/release-guard.mjs update-feed ") && line.includes(` ${file}`)), file).toBe(true);
    }
  });
});

describe("a release body edit restores the tag at once", () => {
  const TAG_SHA = "c".repeat(40);
  const notes = () => { const dir = mkdtempBody(joinBody(tmpBody(), "rel-body-")); const file = joinBody(dir, "notes.md"); writeBody(file, "notes"); return file; };
  // A fake GitHub where a body PATCH clears the tag, exactly as the real one does.
  const fakeGitHub = ({ draft = false, bodyFails = false, latestTag = "v1.2.3", remoteTag = true } = {}) => {
    const state = { tag_name: "v1.2.3", name: "Murage 1.2.3", calls: [] };
    const run = (command, args) => {
      state.calls.push([command, ...args].join(" "));
      if (command === "git") return { status: 0, stdout: remoteTag ? `${TAG_SHA}\trefs/tags/v1.2.3\n` : "" };
      const method = args[args.indexOf("--method") + 1];
      if (method === "PATCH") {
        const fields = Object.fromEntries(args.filter(a => /^[a-z_]+=/.test(a)).map(a => [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]));
        if ("body" in fields) { state.tag_name = "untagged-ed938328"; if (bodyFails) return { status: 1, stderr: "HTTP 502", stdout: "" }; }
        for (const key of ["tag_name", "name"]) if (key in fields) state[key] = fields[key];
        if ("target_commitish" in fields) state.target = fields.target_commitish;
        return { status: 0, stdout: "{}" };
      }
      const endpoint = args.at(-1);
      return http(200, endpoint.endsWith("/latest") ? { id: 7, tag_name: latestTag } : { id: 7, tag_name: state.tag_name, name: state.name, draft, assets: [] });
    };
    return { run, state };
  };
  it("re-PATCHes tag_name, target_commitish and name right after the body, then checks ls-remote and releases/latest", () => {
    const { run, state } = fakeGitHub();
    setReleaseBody("1.2.3", 7, notes(), "main", run);
    expect(state).toMatchObject({ tag_name: "v1.2.3", name: "Murage 1.2.3", target: "main" });
    const patches = state.calls.filter(c => c.includes("PATCH"));
    expect(patches[0]).toContain("body=@");
    expect(patches[1]).toMatch(/tag_name=v1\.2\.3 .*target_commitish=main .*name=Murage 1\.2\.3/);
    expect(state.calls.some(c => c.startsWith("git ls-remote --tags https://github.com/FerroxLabs/murage-releases.git refs/tags/v1.2.3"))).toBe(true);
    expect(state.calls.some(c => c.includes("releases/latest"))).toBe(true);
  });
  it("restores the tag even when the body PATCH itself failed", () => {
    const { run, state } = fakeGitHub({ bodyFails: true });
    expect(() => setReleaseBody("1.2.3", 7, notes(), "main", run)).toThrow(/refusing/);
    expect(state.tag_name).toBe("v1.2.3");
  });
  it("refuses when the tag is missing on the remote or another release is latest", () => {
    expect(() => verifyReleaseTag("1.2.3", 7, fakeGitHub({ remoteTag: false }).run)).toThrow(/not on/);
    expect(() => verifyReleaseTag("1.2.3", 7, fakeGitHub({ latestTag: "v1.2.2" }).run)).toThrow(/releases\/latest/);
  });
  it("a draft has no remote tag yet: the record and title are what is checked", () => {
    const { run, state } = fakeGitHub({ draft: true, remoteTag: false });
    setReleaseBody("1.2.3", 7, notes(), "main", run);
    expect(state.calls.some(c => c.startsWith("git "))).toBe(false);
  });
});


describe("guarded probe and notes commands", () => {
  it("creates, rechecks and deletes only the probe draft", () => {
    const calls = [], probe = 'release-preflight-123-1';
    const run = (command, args) => {
      calls.push([command, ...args]);
      const data = JSON.stringify({ id: 71, tag_name: probe, draft: true });
      return { status: 0, stdout: args.includes('GET') ? `HTTP/2.0 200 OK\n\n${data}` : data };
    };
    expect(probeReleaseToken(probe, run)).toBe(71);
    expect(calls.map(call => call[call.indexOf('--method') + 1])).toEqual(['POST', 'GET', 'DELETE']);
  });
  it.each([{id:71,tag_name:'changed',draft:true}, {id:71,tag_name:'release-preflight-123-1',draft:false}])("refuses to delete a changed probe %j", current => {
    const calls=[];
    const run=(command,args)=>{calls.push(args);return {status:0,stdout:args.includes('GET') ? `HTTP/2.0 200 OK\n\n${JSON.stringify(current)}` : JSON.stringify({id:71,tag_name:'release-preflight-123-1',draft:true})};};
    expect(()=>probeReleaseToken('release-preflight-123-1',run)).toThrow('refusing deletion');
    expect(calls.some(args=>args.includes('DELETE'))).toBe(false);
  });
  it("generates notes at the guarded API boundary", () => {
    const calls=[];
    expect(generateReleaseNotes('1.0.19','FerroxLabs/murage','a'.repeat(40),(command,args)=>{calls.push(args);return {status:0,stdout:'notes'};})).toBe('notes');
    expect(calls[0]).toContain('repos/FerroxLabs/murage/releases/generate-notes');
    expect(calls[0]).toContain('POST');
  });
});


describe("privileged workflow guard entrypoints", () => {
  it("bootstraps a pinned package manager with frozen dependencies and no lifecycle scripts", () => {
    const calls=[];
    bootstrapDependencies((...args)=>{calls.push(args);return {status:0};});
    expect(calls[0][0]).toBe('npm');
    expect(calls[0][1]).toEqual(['exec','--yes','--ignore-scripts','--package=pnpm@10.33.0','--','pnpm','install','--frozen-lockfile','--ignore-scripts']);
    expect(()=>bootstrapDependencies(()=>({status:1}))).toThrow('bootstrap failed');
  });
  it("creates notes and records the approved waiver, falling back on API failure", () => {
    const dir=mkdtempSync(join(tmpdir(),'release-notes-'));
    try {
      const env={VERSION:'1.2.3',RUNNER_TEMP:dir,GITHUB_REPOSITORY:'o/r',SHA:'a'.repeat(40),WAIVER_PATH:'ci/waiver.json',WAIVER_SHA256:'b'.repeat(64),WAIVER_RUN:'12',WAIVER_RUN_URL:'https://example.invalid/12',WAIVER_APPROVAL:'reviewed'};
      const file=prepareReleaseNotes(env,()=>({status:1}));
      expect(readFileSync(file,'utf8')).toContain('Built by the release workflow from o/r@');
      expect(readFileSync(file,'utf8')).toContain('CI review record');
      prepareReleaseNotes(env,()=>({status:0,stdout:'generated notes'}));
      expect(readFileSync(file,'utf8')).toContain('generated notes');
    } finally {removeTempDirSync(dir);}
  });
  it("imports the CI review artifact only when it matches the pinned source commit", () => {
    const dir=mkdtempSync(join(tmpdir(),'release-review-'));
    try {
      const env={VERSION:'1.2.3',RUNNER_TEMP:dir,GITHUB_REPOSITORY:'o/r',SHA:'a'.repeat(40),REVIEW_FILE:join(dir,'review.json')};
      const review={SHA:env.SHA,WAIVER_PATH:'ci/waiver.md',WAIVER_SHA256:'b'.repeat(64),WAIVER_RUN:'12',WAIVER_RUN_URL:'https://example.invalid/12',WAIVER_APPROVAL:'reviewed'};
      writeFileSync(env.REVIEW_FILE,JSON.stringify(review));
      const file=prepareReleaseNotes(env,()=>({status:0,stdout:'generated notes'}));
      expect(readFileSync(file,'utf8')).toContain('ci/waiver.md');
      writeFileSync(env.REVIEW_FILE,JSON.stringify({...review,SHA:'c'.repeat(40)}));
      expect(()=>prepareReleaseNotes(env,()=>({status:1}))).toThrow('invalid CI review record');
    } finally {removeTempDirSync(dir);}
  });
  it("rejects an artifact source that is not a numeric run in a repository", () => {
    const calls=[];
    expect(()=>downloadPreparedAssets({GITHUB_RUN_ID:'../other',GITHUB_REPOSITORY:'o/r'},(...args)=>{calls.push(args);})).toThrow('invalid artifact source');
    expect(calls).toEqual([]);
  });
});
