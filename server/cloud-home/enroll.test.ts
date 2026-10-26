// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeCloudBootEnvelope } from "./secrets.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const program = fileURLToPath(new URL("../../deploy/cloud-home/murage-enroll", import.meta.url));
const shapes = JSON.parse(readFileSync(new URL("../../cloudflare/control-plane/test/fixtures/cp0-shapes.json", import.meta.url), "utf8"));
// Production CLI has fixed root paths and HTTPS. This fixture replaces only
// those filesystem/transport boundaries and the modeled root UID; it calls
// the actual enroll, envelope, main and stale-generation handling.
const wrapper = `import importlib.machinery,importlib.util,os,sys
loader=importlib.machinery.SourceFileLoader("enroll_fixture",sys.argv[1]);spec=importlib.util.spec_from_loader(loader.name,loader)
module=importlib.util.module_from_spec(spec);loader.exec_module(module)
enroll_fn,envelope_fn=module.enroll,module.envelope
state,config,user_data=sys.argv[2:5];mode=sys.argv[5]
def pending_stop(_):raise SystemExit(3)
ticks=[0]
fast={"monotonic":lambda:ticks[0],"sleep":lambda d:ticks.__setitem__(0,ticks[0]+d)}
if mode=="refused-once":
    real_post,calls=module.post,[0]
    def flaky(admin,*a,**k):
        calls[0]+=1
        return real_post("http://127.0.0.1:1" if calls[0]==1 else admin,*a,**k)
    module.post=flaky
module.enroll=lambda:enroll_fn(state,config,user_data,expected_uid=os.getuid(),allow_http=True,**({"sleep":pending_stop} if mode=="pending-stop" else fast if mode in("pending-fast","refused-once") else {}))
module.envelope=lambda:envelope_fn(state,config,expected_uid=os.getuid(),allow_http=True)
sys.argv=[sys.argv[1]]+(["--envelope"] if mode=="envelope" else [])
module.os.geteuid=lambda:0
try:module.main()
except module.StaleGeneration:sys.exit(78)
except Exception:print("Cloud enrollment refused",file=sys.stderr);sys.exit(1)`;
let root: string, state: string, config: string, userData: string, server: Server, admin: string;
let credential: string;
let requests: Array<{ path: string; body: unknown; authorization?: string }>, stale: boolean, hostile: boolean;
let unwrapOverride: Record<string, unknown>, enrollExtra: Record<string, unknown>;
let pendingCount: number, enrolled: boolean, enrollFailure: "401" | "403" | "unknown409" | "lost" | "duplicate409" | undefined;
let transient: { status: number; count: number } | undefined;
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "murage-enroll-"))); state = join(root, "state"); config = join(root, "config"); userData = join(root, "user-data.txt");
  credential = randomBytes(32).toString("base64");
  mkdirSync(config, { mode: 0o700 }); requests = []; stale = false; hostile = false; unwrapOverride = {}; enrollExtra = {};
  pendingCount = 0; enrolled = false; enrollFailure = undefined; transient = undefined;
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push({ path: req.url!, body, authorization: req.headers.authorization });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v1/machines/home-test/enroll") {
      if (transient && transient.count > 0) { transient.count--; res.statusCode = transient.status; res.end("{}"); return; }
      if (enrollFailure === "lost") { req.socket.destroy(); return; }
      if (enrollFailure) { res.statusCode = enrollFailure === "401" ? 401 : enrollFailure === "403" ? 403 : 409; res.end(enrollFailure === "duplicate409" ? '{"error":"enrollment_pending","error":"enrollment_pending"}' : '{"error":"unknown"}'); return; }
      if (JSON.stringify(body) !== JSON.stringify(shapes.enrollRequest) || enrolled) { res.statusCode = 401; res.end("{}"); return; }
      // Models the published definite-nonconsumption protocol. Actual D1
      // pending predicate and consumption races are CP-owned tests.
      if (pendingCount > 0) { pendingCount--; res.statusCode = 409; res.end('{"error":"enrollment_pending"}'); return; }
      enrolled = true;
      res.end(JSON.stringify({ ...shapes.enrollResponse, machineCredential: credential, adminUrl: admin, ...enrollExtra })); return;
    }
    if (req.url === "/v1/machines/home-test/unwrap") {
      if (req.headers.authorization !== `Bearer ${credential}` || JSON.stringify(body) !== JSON.stringify(shapes.unwrapRequest)) { res.statusCode = 401; res.end("{}"); return; }
      if (stale) { res.statusCode = 409; res.end(JSON.stringify(shapes.staleResponse)); return; }
      res.end(JSON.stringify({ ...shapes.unwrapResponse, ...unwrapOverride, ...(hostile ? { keyEncryptionKey: "fixture-prohibited-key" } : {}) })); return;
    }
    res.statusCode = 404; res.end("{}");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  admin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  writeFileSync(userData, `#cloud-config\nmurage_home_id: ${shapes.createResponse.homeId}\nmurage_enrollment_token: ${shapes.createResponse.enrollmentToken}\nmurage_admin_url: ${admin}\n`, { mode: 0o600 });
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); removeTempDirSync(root); });
// start-home.sh runs under the image's bash 5 and waits on its process substitution, which bash
// before 4.4 cannot do (`wait` answers 127, "not a child"). macOS ships bash 3.2 as /bin/bash, so
// the boot run uses a bash 4.4+ from the host (Homebrew's on the macOS runners) and is skipped when there is none.
const modernBash = ["bash", "/opt/homebrew/bin/bash", "/usr/local/bin/bash"].find(candidate => {
  const probe = spawnSync(candidate, ["-c", 'echo "${BASH_VERSINFO[0]} ${BASH_VERSINFO[1]}"'], { encoding: "utf8" });
  const [major, minor] = (probe.stdout ?? "").trim().split(" ").map(Number);
  return probe.status === 0 && (major > 4 || (major === 4 && minor >= 4));
});
function run(mode: "enroll" | "envelope" | "boot" | "pending-stop" | "pending-fast" | "refused-once") {
  const helper = join(root, "helper"), node = join(root, "node");
  if (mode === "boot") {
    writeFileSync(helper, `#!/usr/bin/python3
import sys
sys.argv=[sys.argv[0],${JSON.stringify(program)},${JSON.stringify(state)},${JSON.stringify(config)},${JSON.stringify(userData)},"envelope" if len(sys.argv)>1 else "enroll"]
${wrapper}
`, { mode: 0o700 });
    writeFileSync(node, "#!/bin/bash\necho supervisor-entered\n", { mode: 0o700 });
  }
  const script = readFileSync(new URL("../../deploy/cloud-home/start-home.sh", import.meta.url), "utf8").replaceAll("/usr/local/libexec/murage-enroll", helper).replaceAll("/etc/murage-home/home.env", join(config, "home.env")).replaceAll("/usr/bin/python3 -I /usr/local/libexec/murage-home-launch", node);

  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = mode === "boot" ? spawn(modernBash!, ["-c", script], { stdio: ["ignore", "pipe", "pipe"] }) : spawn("python3", ["-I", "-c", wrapper, program, state, config, userData, mode], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", data => stdout += data); child.stderr.on("data", data => stderr += data);
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
it("enrolls once with shared CP0 shapes, private credential/metadata and stdout-only v2 unwrap", async () => {
  expect(await run("enroll")).toEqual({ code: 0, stdout: "", stderr: "" });
  expect(await run("enroll")).toEqual({ code: 0, stdout: "", stderr: "" });
  expect(requests).toHaveLength(1); expect(requests[0].body).toEqual(shapes.enrollRequest);
  expect(statSync(state).mode & 0o777).toBe(0o700);
  for (const file of [join(state, "credential"), join(state, "generation"), join(config, "home.env")]) expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(state, "credential"), "utf8").trim()).toBe(credential);
  const homeEnv = readFileSync(join(config, "home.env"), "utf8");
  expect(homeEnv).toContain("MURAGE_CLOUD_ROLE=home"); expect(homeEnv).toContain("MURAGE_CLOUD_MACHINE_ID=home-test");
  expect(homeEnv).toContain("MURAGE_PUBLIC_ORIGIN=https://home.murage.test");
  expect(homeEnv).not.toContain(credential);
  const output = await run("envelope"); expect(output.code).toBe(0); expect(output.stderr).toBe("");
  const envelope = JSON.parse(output.stdout);
  expect(envelope).toEqual({ version: 2, machineId: "home-test", dataKey: shapes.unwrapResponse.dataKey, bootstrapSecret: shapes.unwrapResponse.bootstrapSecret });
  expect(decodeCloudBootEnvelope(output.stdout, "home-test").dataKey).toEqual(Buffer.from(shapes.unwrapResponse.dataKey, "base64"));
  expect(requests[1]).toEqual({ path: "/v1/machines/home-test/unwrap", body: shapes.unwrapRequest, authorization: `Bearer ${credential}` });
  for (const file of [join(state, "credential"), join(state, "generation"), join(config, "home.env")]) {
    const text = readFileSync(file, "utf8"); expect(text).not.toContain(shapes.unwrapResponse.dataKey); expect(text).not.toContain(shapes.unwrapResponse.bootstrapSecret);
  }
});
it("stale generation exits 78 with no envelope output", async () => {
  expect((await run("enroll")).code).toBe(0); stale = true;
  expect(await run("envelope")).toEqual({ code: 78, stdout: "", stderr: "" });
});
it("rejects prohibited KEK response fields without printing any response bytes", async () => {
  expect((await run("enroll")).code).toBe(0); hostile = true;
  const result = await run("envelope"); expect(result.code).toBe(1); expect(result.stdout).toBe("");
  expect(result.stderr).toBe("Cloud enrollment refused\n");
});

it.each(["short", "A".repeat(43), "_".repeat(43) + "=", "A".repeat(42) + "B="])("rejects malformed credential %s before publication", async value => {
  credential = value;
  expect((await run("enroll")).code).toBe(1);
});
it.each(["UNKNOWN=value\n", "MURAGE_CLOUD_ROLE=home\n", "malformed\n", "MURAGE_PUBLIC_ORIGIN='unterminated\n"])("refuses malformed trusted metadata %s", async extra => {
  expect((await run("enroll")).code).toBe(0);
  const file = join(config, "home.env"); writeFileSync(file, readFileSync(file, "utf8") + extra);
  expect((await run("envelope")).code).toBe(1);
  expect(requests).toHaveLength(1);
});
it("accepts quoted trusted metadata values without replacement inside values", async () => {
  expect((await run("enroll")).code).toBe(0);
  const file = join(config, "home.env");
  writeFileSync(file, `MURAGE_CLOUD_ROLE='home'\nMURAGE_CLOUD_MACHINE_ID="home-test"\nMURAGE_CLOUD_ADMIN_URL='${admin}'\nMURAGE_PUBLIC_ORIGIN='https://home.murage.test'\n`);
  expect((await run("envelope")).code).toBe(0);
});

it.skipIf(!modernBash)("actual CP unwrap409 survives the shell and stops before supervisor exec", async () => {
  expect((await run("enroll")).code).toBe(0); stale = true;
  const result = await run("boot"); expect(result.code).toBe(78); expect(result.stdout).toBe("");
  expect(result.stderr).toBe("Cloud home stopped: stale generation; operator recovery required\n");
  expect(requests.filter(item => item.path.endsWith("/enroll"))).toHaveLength(1);
  expect(requests.filter(item => item.path.endsWith("/unwrap"))).toHaveLength(1);
});
it("shared canonical synthetic credential includes plus slash and padding", async () => {
  credential = shapes.enrollResponse.machineCredential;
  expect(credential).toContain("+"); expect(credential).toContain("/"); expect(credential).toMatch(/=$/);
  expect((await run("enroll")).code).toBe(0); expect((await run("envelope")).code).toBe(0);
});

it("consumed enrollment plus lost local credential refuses redemption replay pending admin rotation", async () => {
  expect((await run("enroll")).code).toBe(0);
  rmSync(join(state, "credential"));
  expect((await run("enroll")).code).toBe(1);
  expect(requests.filter(item => item.path.endsWith("/enroll"))).toHaveLength(1);
});
it.each([{generation:true}, {volumeKey:"short"}, {volumeKey:"A".repeat(42)+"B="}])("rejects invalid unwrap generation/key without an envelope", async value => {
  expect((await run("enroll")).code).toBe(0); unwrapOverride=value;
  const result=await run("envelope"); expect(result.code).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).toBe("Cloud enrollment refused\n");
});

it("retries only exact pending nonconsumption and commits the credential once", async () => {
  pendingCount = 1;
  expect((await run("enroll")).code).toBe(0);
  expect(requests.filter(item => item.path.endsWith("/enroll"))).toHaveLength(2);
  expect(existsSync(join(state, "enrollment-pending"))).toBe(false);
  expect(existsSync(join(state, "enrollment-attempt"))).toBe(true);
  expect((await run("enroll")).code).toBe(0);
  expect(requests).toHaveLength(2);
});
it("pending restart keeps no persisted budget and each boot retries with a fresh one", async () => {
  pendingCount = 2;
  expect((await run("pending-stop")).code).toBe(3);
  expect(existsSync(join(state, "enrollment-pending"))).toBe(false); expect(existsSync(join(state, "enrollment-attempt"))).toBe(false);
  expect((await run("pending-stop")).code).toBe(3);
  expect((await run("enroll")).code).toBe(0); expect(requests).toHaveLength(3);
});
it("transient connection refusal before any request is sent retries and enrolls", async () => {
  expect((await run("refused-once")).code).toBe(0);
  expect(requests).toHaveLength(1); expect(existsSync(join(state, "credential"))).toBe(true);
  expect((await run("enroll")).code).toBe(0); expect(requests).toHaveLength(1);
});
it.each([503, 500, 429])("HTTP %i then success enrolls", async status => {
  transient = { status, count: 2 };
  expect((await run("pending-fast")).code).toBe(0);
  expect(requests.filter(item => item.path.endsWith("/enroll"))).toHaveLength(3);
  expect(existsSync(join(state, "credential"))).toBe(true);
});
it("budget exhaustion fails without a permanent marker and the next boot retries", async () => {
  transient = { status: 503, count: 1000 };
  expect((await run("pending-fast")).code).toBe(1);
  const sent = requests.length;
  // exponential backoff 1,2,4..60 inside 30 minutes: bounded, not a hot loop
  expect(sent).toBeGreaterThan(10); expect(sent).toBeLessThan(60);
  expect(existsSync(join(state, "enrollment-attempt"))).toBe(false); expect(existsSync(join(state, "credential"))).toBe(false);
  transient = undefined;
  expect((await run("pending-fast")).code).toBe(0);
  expect(requests).toHaveLength(sent + 1);
});
it("legacy persisted pending budget is ignored", async () => {
  mkdirSync(state, { mode: 0o700 });
  writeFileSync(join(state, "enrollment-pending"), JSON.stringify({ stale: true }), { mode: 0o600 });
  expect((await run("enroll")).code).toBe(0);
  expect(existsSync(join(state, "enrollment-pending"))).toBe(false);
});
it.each(["401", "403", "unknown409", "lost", "duplicate409"] as const)("%s retains ambiguous marker and never retries on restart", async failure => {
  enrollFailure = failure;
  expect((await run("enroll")).code).toBe(1); expect(requests).toHaveLength(1);
  expect(existsSync(join(state, "enrollment-attempt"))).toBe(true);
  enrollFailure = undefined;
  expect((await run("enroll")).code).toBe(1); expect(requests).toHaveLength(1);
});

it("writes an https siteOrigin from the enroll response into home.env, and the envelope step accepts it", async () => {
  enrollExtra = { siteOrigin: "https://murage.ai" };
  expect((await run("enroll")).code).toBe(0);
  expect(readFileSync(join(config, "home.env"), "utf8")).toContain("MURAGE_SITE_ORIGIN=https://murage.ai");
  expect((await run("envelope")).code).toBe(0);
});
it.each(["http://murage.ai", "https://murage.ai/path", "https://u:p@murage.ai", 7])("omits an invalid siteOrigin %s and still enrolls", async value => {
  enrollExtra = { siteOrigin: value };
  expect((await run("enroll")).code).toBe(0);
  expect(readFileSync(join(config, "home.env"), "utf8")).not.toContain("MURAGE_SITE_ORIGIN");
});

// Warm-pool claim: a pooled server's user-data.txt is only the #include line; the served cloud-config writes the
// identity to /etc/murage-home/claim-user-data (root 0600). The control plane serves that payload once.
describe("warm-pool claim identity", () => {
  const include = "#include\nhttps://cp.murage.test/v1/pool/claim/abc\n";
  const identity = (home = shapes.createResponse.homeId) =>
    `murage_home_id: ${home}\nmurage_enrollment_token: ${shapes.createResponse.enrollmentToken}\nmurage_admin_url: ${admin}\n`;
  const claim = () => join(config, "claim-user-data");
  it("enrolls from claim-user-data when user-data.txt holds only the #include line", async () => {
    writeFileSync(userData, include, { mode: 0o600 });
    writeFileSync(claim(), identity(), { mode: 0o600 });
    expect(await run("enroll")).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(requests).toHaveLength(1); expect(requests[0].path).toBe("/v1/machines/home-test/enroll");
    expect(readFileSync(join(state, "credential"), "utf8").trim()).toBe(credential);
  });
  it("user-data.txt identity wins over claim-user-data", async () => {
    writeFileSync(claim(), identity("home-other"), { mode: 0o600 }); // the fixture CP answers 404 for any other home
    expect((await run("enroll")).code).toBe(0);
    expect(requests.map(item => item.path)).toEqual(["/v1/machines/home-test/enroll"]);
  });
  it("a partial identity in user-data.txt fails closed, never mixed with the claim file", async () => {
    writeFileSync(userData, `#cloud-config\nmurage_home_id: ${shapes.createResponse.homeId}\n`, { mode: 0o600 });
    writeFileSync(claim(), identity(), { mode: 0o600 });
    expect(await run("enroll")).toEqual({ code: 1, stdout: "", stderr: "Cloud enrollment refused\n" });
    expect(requests).toHaveLength(0);
  });
  it.each(["murage_home_id:", "murage_enrollment_token:   ", "murage_admin_url:"])("a blank %s in user-data.txt fails validation and never falls back to the claim file", async line => {
    writeFileSync(userData, `#include\nhttps://cp.murage.test/x\n${line}\n`, { mode: 0o600 });
    writeFileSync(claim(), identity(), { mode: 0o600 });
    expect(await run("enroll")).toEqual({ code: 1, stdout: "", stderr: "Cloud enrollment refused\n" });
    expect(requests).toHaveLength(0);
  });
  it("enrolls from claim-user-data when user-data.txt is absent", async () => {
    rmSync(userData);
    writeFileSync(claim(), identity(), { mode: 0o600 });
    expect((await run("enroll")).code).toBe(0); expect(requests).toHaveLength(1);
  });
  it.each([0o640, 0o604, 0o400, 0o700])("refuses a claim file with mode %o", async mode => {
    writeFileSync(userData, include, { mode: 0o600 });
    writeFileSync(claim(), identity(), { mode: 0o600 }); chmodSync(claim(), mode);
    expect(await run("enroll")).toEqual({ code: 1, stdout: "", stderr: "Cloud enrollment refused\n" });
    expect(requests).toHaveLength(0); expect(existsSync(join(state, "enrollment-attempt"))).toBe(false);
  });
  it("refuses a claim file that is a symlink, even to a valid root 0600 file", async () => {
    writeFileSync(userData, include, { mode: 0o600 });
    const real = join(root, "elsewhere"); writeFileSync(real, identity(), { mode: 0o600 });
    symlinkSync(real, claim());
    expect((await run("enroll")).code).toBe(1); expect(requests).toHaveLength(0);
  });
  it("refuses an oversized claim file", async () => {
    writeFileSync(userData, include, { mode: 0o600 });
    writeFileSync(claim(), identity() + "#".repeat(65536), { mode: 0o600 });
    expect((await run("enroll")).code).toBe(1); expect(requests).toHaveLength(0);
  });
  it("refuses when neither source has an identity", async () => {
    writeFileSync(userData, include, { mode: 0o600 });
    expect((await run("enroll")).code).toBe(1); expect(requests).toHaveLength(0);
  });
  it("a later boot with the payload gone (bare #include, claim file shredded) keeps the enrolled state and succeeds", async () => {
    writeFileSync(userData, include, { mode: 0o600 });
    writeFileSync(claim(), identity(), { mode: 0o600 });
    expect((await run("enroll")).code).toBe(0);
    const before = [join(state, "credential"), join(state, "generation"), join(state, "enrollment-attempt"), join(config, "home.env")].map(f => readFileSync(f, "utf8"));
    rmSync(claim()); // murage-scrub-userdata shredded it; cloud-init re-fetched the #include and the CP no longer serves it
    expect(await run("enroll")).toEqual({ code: 0, stdout: "", stderr: "" });
    writeFileSync(claim(), "", { mode: 0o600 }); // or the re-fetch left an empty or stale file behind
    expect(await run("enroll")).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(requests).toHaveLength(1);
    const after = [join(state, "credential"), join(state, "generation"), join(state, "enrollment-attempt"), join(config, "home.env")].map(f => readFileSync(f, "utf8"));
    expect(after).toEqual(before);
    expect((await run("envelope")).code).toBe(0);
  });
});
