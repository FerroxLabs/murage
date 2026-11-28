// M9 witnesses: IDENTITY on the real fromIni/STSClient with an in-process fake STS (no AWS call, no network): W3 W6 W7 W15 W16 W22 W23, R7 FENCE,
// and the launch helper's ADMIT/AWAIT/IDENTITY/R7 order.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BedrockBindings } from "./bedrock-bindings.ts";
import { bedrockFence, bedrockLaunch, setBedrockRuntime } from "./bedrock-launch.ts";
import { IdentityCache, identityNetwork, resolveBedrockAccount } from "./bedrock-identity.ts";

const sts = (account: string) => `<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Arn>arn:aws:iam::${account}:user/fixture</Arn><UserId>AIDFIXTURE</UserId><Account>${account}</Account></GetCallerIdentityResult><ResponseMetadata><RequestId>r</RequestId></ResponseMetadata></GetCallerIdentityResponse>`;
/** An SDK request handler that answers by credential source: the account whose key signed the request. */
function fakeHandler(accounts: Record<string, string>, seen: Array<{ host: string; path: string; key?: string }> = []) {
  return {
    seen,
    handle: async (req: any) => {
      const auth = String(req.headers?.authorization ?? req.headers?.Authorization ?? "");
      const key = /Credential=([A-Z0-9]+)\//.exec(auth)?.[1];
      seen.push({ host: req.hostname, path: req.path, key });
      const reply = (status: number, body: string, type = "text/xml") => ({ response: { statusCode: status, reason: "", headers: { "content-type": type }, body: Readable.from([Buffer.from(body)]) } });
      if (req.hostname.startsWith("portal.sso.")) return reply(200, JSON.stringify({ roleCredentials: { accessKeyId: "AKIASSOFIXTURE", secretAccessKey: "x", sessionToken: "t", expiration: Date.now() + 3_600_000 } }), "application/json");
      const account = key ? accounts[key] : undefined;
      return account ? reply(200, sts(account)) : reply(403, "<ErrorResponse><Error><Code>InvalidClientTokenId</Code><Message>The security token included in the request is invalid.</Message></Error></ErrorResponse>");
    },
    destroy() {},
  };
}

let home = ""; let files = { configFile: "", credentialsFile: "" };
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bedrock-id-"));
  mkdirSync(join(home, ".aws"), { recursive: true });
  files = { configFile: join(home, ".aws", "config"), credentialsFile: join(home, ".aws", "credentials") };
  writeFileSync(files.configFile, "[profile personal]\nregion = us-east-1\n");
  writeFileSync(files.credentialsFile, "[personal]\naws_access_key_id = AKIAPERSONALFIXTURE\naws_secret_access_key = fixturesecretvalue\n");
});
afterEach(() => { setBedrockRuntime(null); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

const network = {};
describe("IDENTITY on the real SDK path", () => {
  it("W16 employer keys in the process env and the captured shell never bind: the profile's own files decide", async () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIAEMPLOYERFIXTURE"); vi.stubEnv("AWS_SECRET_ACCESS_KEY", "employersecret"); vi.stubEnv("AWS_ENDPOINT_URL", "http://localstack.test:4566");
    const handler = fakeHandler({ AKIAEMPLOYERFIXTURE: "222222222222", AKIAPERSONALFIXTURE: "111111111111" });
    const account = await resolveBedrockAccount({ profile: "personal", region: "us-east-1", files, network, requestHandler: handler });
    expect(account, "W16 personal account").toBe("111111111111"); // W16
    expect(handler.seen.every((s) => s.host === "sts.us-east-1.amazonaws.com"), "W16 explicit STS endpoint").toBe(true); // W16-endpoint
  });
  it("W22 a role-less SSO profile reaches its own sso_region (us-east-1) while GetCallerIdentity goes to the Bedrock region (us-west-2)", async () => {
    writeFileSync(files.configFile, "[profile p]\nsso_session = s\nsso_account_id = 123456789012\nsso_role_name = Dev\nregion = us-west-2\n[sso-session s]\nsso_region = us-east-1\nsso_start_url = https://example.test/start\n");
    mkdirSync(join(home, ".aws", "sso", "cache"), { recursive: true });
    writeFileSync(join(home, ".aws", "sso", "cache", createHash("sha1").update("s").digest("hex") + ".json"), JSON.stringify({ accessToken: "fixturetoken", expiresAt: "2099-01-01T00:00:00Z" }));
    vi.stubEnv("HOME", home); vi.stubEnv("USERPROFILE", home);
    const handler = fakeHandler({ AKIASSOFIXTURE: "123456789012" });
    const account = await resolveBedrockAccount({ profile: "p", region: "us-west-2", files, network, requestHandler: handler });
    expect(account).toBe("123456789012");
    expect(handler.seen.find((s) => s.host.startsWith("portal.sso."))?.host, "W22 sso host").toBe("portal.sso.us-east-1.amazonaws.com"); // W22-sso
    expect(handler.seen.find((s) => s.host.startsWith("sts."))?.host, "W22 sts host").toBe("sts.us-west-2.amazonaws.com"); // W22-sts
  });
  it("W7 a timeout is one R3-class error and a credential_process that cannot run says so plainly (M5)", async () => {
    const hang = { handle: () => new Promise(() => {}), destroy() {} };
    await expect(resolveBedrockAccount({ profile: "personal", region: "us-east-1", files, network, requestHandler: hang, timeoutMs: 60 })).rejects.toMatchObject({ kind: "timeout" }); // W7-timeout
    writeFileSync(files.configFile, "[profile cp]\nregion = us-east-1\ncredential_process = bedrock-fixture-no-such-helper --x\n");
    await expect(resolveBedrockAccount({ profile: "cp", region: "us-east-1", files, network, requestHandler: fakeHandler({}) })).rejects.toThrow(/credential_process command\. Use its full path in ~\/\.aws\/config/); // M5
  });
  describe("W23 proxy", () => {
    let server: Server; const connects: string[] = []; let port = 0;
    beforeEach(async () => {
      connects.length = 0;
      server = createServer((sock) => { sock.once("data", (d) => { connects.push(String(d).split("\r\n")[0]!); sock.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n"); }); sock.on("error", () => {}); });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r)); port = (server.address() as any).port;
    });
    afterEach(() => new Promise<void>((r) => server.close(() => r())));
    it("W23 the hand's HTTPS_PROXY (not Murage's own env) carries the STS call: exactly one CONNECT, answered 403, R3", async () => {
      const hand = { HTTPS_PROXY: `http://127.0.0.1:${port}` };
      await expect(resolveBedrockAccount({ profile: "personal", region: "us-east-1", files, network: identityNetwork(hand), timeoutMs: 3000 })).rejects.toBeDefined();
      expect(connects, "W23 one CONNECT").toEqual(["CONNECT sts.us-east-1.amazonaws.com:443 HTTP/1.1"]); // W23-direct
    });
    it("W23 (managed settings only) a proxy that only managed settings env names still carries the call", async () => {
      const managed = join(home, "managed-settings.json");
      writeFileSync(managed, JSON.stringify({ env: { HTTPS_PROXY: `http://127.0.0.1:${port}` } }));
      const bindings = new BedrockBindings({ readBlock: () => ({ profile: "personal", region: "us-east-1", accountId: "111111111111", epoch: 1 }), writeBlock: async () => {}, busy: { get: () => false, set: () => {} }, check: async () => "111111111111" });
      setBedrockRuntime({ bindings, cache: new IdentityCache(), home: () => home });
      const out = await bedrockLaunch({ instanceId: "i", hand: { AWS_CONFIG_FILE: files.configFile, AWS_SHARED_CREDENTIALS_FILE: files.credentialsFile }, settingsFiles: [join(home, "user.json")], managedFiles: [managed] });
      expect(out.ok, "refused (403 from the proxy)").toBe(false);
      expect(connects.length, "W23 managed proxy CONNECT").toBe(1); // W23-managed
      expect(out.ok === false && out.cause).toContain("Murage could not confirm your AWS sign-in");
    });
  });
});

describe("the launch helper", () => {
  const record = (accountId = "111111111111") => ({ profile: "personal", region: "us-east-1", accountId, epoch: 1 });
  function runtime(opts: { block?: unknown; resolve?: (a: any) => Promise<string>; calls?: { n: number } } = {}) {
    const state = { block: opts.block ?? record() as unknown };
    const calls = opts.calls ?? { n: 0 };
    const bindings = new BedrockBindings({ readBlock: () => state.block, writeBlock: async (_i, b) => { state.block = b; }, busy: { get: () => false, set: () => {} }, check: async () => "111111111111" });
    setBedrockRuntime({ bindings, cache: new IdentityCache(), home: () => home, resolve: async (a) => { calls.n++; return (opts.resolve ?? (async () => "111111111111"))(a); } });
    return { state, calls, bindings };
  }
  const hand = () => ({ AWS_CONFIG_FILE: files.configFile, AWS_SHARED_CREDENTIALS_FILE: files.credentialsFile });
  it("W3 a different account is one R2 row showing both masked ids", async () => {
    runtime({ resolve: async () => "222222222222" });
    const out = await bedrockLaunch({ instanceId: "i", hand: hand() });
    expect(out.ok, "W3 a different account refuses").toBe(false); // W3
    expect(out.ok === false && out.cause, "W3 R2 row").toBe("Profile `personal` now signs in to AWS account …2222, but this engine is bound to …1111. Nothing was sent. Check again in Settings to bind the new account.");
  });
  it("W6 the identity is cached by file stats: a changed credentials file calls STS again (2 calls in total)", async () => {
    const r = runtime();
    expect((await bedrockLaunch({ instanceId: "i", hand: hand() })).ok).toBe(true);
    expect((await bedrockLaunch({ instanceId: "i", hand: hand() })).ok).toBe(true);
    expect(r.calls.n, "cache hit").toBe(1);
    writeFileSync(files.credentialsFile, "[personal]\naws_access_key_id = AKIAPERSONALFIXTURE2\naws_secret_access_key = other\n");
    utimesSync(files.credentialsFile, new Date(), new Date(Date.now() + 5000));
    expect((await bedrockLaunch({ instanceId: "i", hand: hand() })).ok).toBe(true);
    expect(r.calls.n, "W6 second STS call").toBe(2); // W6
  });
  it("W5 a launch admitted during a re-bind waits for the check and resolves the NEW binding, never the old one", async () => {
    const gate = { release: () => {} }; let rebinding: Promise<unknown> | null = null;
    const state = { block: record() as unknown };
    const bindings = new BedrockBindings({ readBlock: () => state.block, writeBlock: async (_i, b) => { state.block = b; }, busy: { get: () => false, set: () => {} }, check: () => new Promise<string>((r) => { gate.release = () => r("444444444444"); }) });
    const profilesSeen: string[] = [];
    setBedrockRuntime({ bindings, cache: new IdentityCache(), home: () => home, resolve: async (a) => { profilesSeen.push(a.profile); return "444444444444"; } });
    rebinding = bindings.save("i", { profile: "other", region: "us-east-1" });
    const launching = bedrockLaunch({ instanceId: "i", hand: hand() });
    await new Promise((r) => setTimeout(r, 20));
    gate.release();
    await rebinding;
    const out = await launching;
    expect(profilesSeen, "W5 the launch used the new profile").toEqual(["other"]); // W5-launch
    expect(out.ok).toBe(true);
  });
  it("W7 an STS failure is R3 with no launch (redacted: W27)", async () => {
    runtime({ resolve: async () => { throw new Error("User: arn:aws:sts::123456789012:assumed-role/Dev/owner@example.test is not authorized"); } });
    const out = await bedrockLaunch({ instanceId: "i", hand: hand() });
    expect(out.ok, "W7 an STS failure refuses").toBe(false); // W7
    const cause = out.ok === false ? out.cause : "";
    expect(cause).toContain("Murage could not confirm your AWS sign-in for profile `personal`");
    expect(cause, "W27 R3 arn").not.toContain("arn:aws"); // W27-r3
    expect(cause, "W27 keeps the account suffix").toContain("…9012");
  });
  it("W8 Stop during IDENTITY: the launch reports aborted and does not resolve an account", async () => {
    const ctl = new AbortController();
    runtime({ resolve: (a) => new Promise((_, reject) => { a.signal.addEventListener("abort", () => reject(new Error("stopped"))); ctl.abort(); }) });
    const out = await bedrockLaunch({ instanceId: "i", hand: hand(), signal: ctl.signal });
    expect(out.ok === false && out.aborted, "W8 aborted").toBe(true); // W8
  });
  it("R1 an UNBOUND instance and R5 a Cloud home refuse before any STS call (W9)", async () => {
    const r = runtime({ block: { profile: "personal", region: "us-east-1" } });
    expect((await bedrockLaunch({ instanceId: "i", hand: hand() })).ok === false).toBe(true);
    expect(r.calls.n).toBe(0);
    runtime();
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    const home5 = await bedrockLaunch({ instanceId: "i", hand: hand() });
    expect(home5.ok === false && home5.cause, "W9 R5").toBe("Claude on Bedrock runs only on your own computer, where your AWS sign-in is."); // W9
    expect(r.calls.n).toBe(0);
  });
  it("W15 FENCE: an epoch bump (a re-bind) after IDENTITY is R4", async () => {
    const r = runtime();
    const out = await bedrockLaunch({ instanceId: "i", hand: hand() });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(bedrockFence("i", out), "no change: no refusal").toBeNull();
    r.state.block = record("111111111111");
    (r.state.block as any).epoch = 2;
    expect(bedrockFence("i", out), "W15 R4").toContain("changed while your message was starting"); // W15
  });
  it("FENCE also catches a change of an AWS file since IDENTITY (the identity is taken under the current file stats)", async () => {
    runtime();
    const out = await bedrockLaunch({ instanceId: "i", hand: hand() });
    if (!out.ok) throw new Error("setup");
    writeFileSync(files.credentialsFile, "[personal]\naws_access_key_id = AKIAOTHER\naws_secret_access_key = other2\n");
    expect(bedrockFence("i", out), "M1 file stat change").toContain("changed while your message was starting"); // M1-files
  });
  it("R7 runs in the launch helper before any caller hold: a repo AWS_PROFILE is refused even though no noLimits value exists", async () => {
    runtime();
    const repo = join(home, "repo-settings.json");
    writeFileSync(repo, JSON.stringify({ env: { AWS_PROFILE: "other" } }));
    const out = await bedrockLaunch({ instanceId: "i", hand: hand(), settingsFiles: [repo] });
    expect(out.ok === false && out.cause, "W2 R7").toContain("sets AWS_PROFILE"); // W2-launch
  });
});
