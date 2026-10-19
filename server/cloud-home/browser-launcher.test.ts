// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { agentBrowserIntegration, browserSessionId } from "../browser-engine.ts";
import { cloudBrowserRequest, CLOUD_BROWSER_BOT } from "./browser-process.ts";

const launcher = fileURLToPath(new URL("../../deploy/cloud-home/murage-turn-launch.py", import.meta.url));
const validate = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("browser_fixture",sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
plan=module.validate_browser_request(json.loads(sys.argv[2]))
plan["mountArgs"]=module.browser_mount_args([("/fixture/anchor",plan["home"])],plan["home"],plan["args"],sockets="/fixture/sockets")
print(json.dumps(plan))`;
function request() { return { mode: "browser", bot: "bot-1", args: ["mcp", "--tools", "core", "--no-webmcp"], settings: {
  AGENT_BROWSER_SESSION: "fixture", AGENT_BROWSER_ENCRYPTION_KEY: "a".repeat(64), AGENT_BROWSER_RESTORE_SAVE: "never" } }; }
function check(input: unknown) { return JSON.parse(execFileSync("python3", ["-I", "-c", validate, launcher, JSON.stringify(input)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })); }
afterEach(() => vi.unstubAllEnvs());
it("validates browser UID and grants only the selected private profile writable", () => {
  const result = check(request());
  expect(result.user).toBe("murage-browser"); expect(result.home).toBe("/data/browser/bot-1");
  expect(result.writable).toEqual([result.home]); expect(result.env.HOME).toBe(result.home);
  expect(result.env.AGENT_BROWSER_PROFILE).toBe(`${result.home}/profile`);
  const binds = result.mountArgs.flatMap((arg: string, index: number) => arg === "--bind" ? [result.mountArgs.slice(index + 1, index + 3)] : []);
  expect(binds).toEqual([["/fixture/anchor", result.home]]);
  // Only the session host may bring the daemon up: every command sees the socket directory read-only (connect works, bind does not).
  const readonly = result.mountArgs.flatMap((arg: string, index: number) => arg === "--ro-bind" ? [result.mountArgs.slice(index + 1, index + 3)] : []);
  expect(readonly).toContainEqual(["/fixture/sockets", `${result.home}/sockets`]);
  expect(result.mountArgs.indexOf("--ro-bind", result.mountArgs.indexOf("--bind"))).toBeGreaterThan(result.mountArgs.indexOf("--bind"));
  expect(result.mountArgs).toContain("/usr/bin/python3"); expect(result.mountArgs).toContain("-I"); expect(result.mountArgs).toContain("--browser-child");
  expect(result.mountArgs).toContain("--unshare-pid"); expect(result.mountArgs).toContain("--die-with-parent");
  // Chromium builds its own userns/seccomp sandbox, so the browser argv must not carry the turn hardening.
  expect(result.mountArgs).not.toContain("--disable-userns"); expect(result.mountArgs).not.toContain("--seccomp");
  expect(result.env).not.toHaveProperty("CI"); expect(result.env).not.toHaveProperty("LD_AUDIT");
});
it("refuses traversal in browser and cleanup requests and caller-selected launch overrides", () => {
  for (const mode of ["browser", "browser-cleanup"]) for (const bot of ["../x", "a/b", "x\n", "é"]) expect(() => check({ ...request(), mode, bot })).toThrow();
  for (const args of [["--no-sandbox"], ["--profile=/data/home"], ["--executable-path", "/tmp/rogue"], ["--config", "/tmp/settings"]]) expect(() => check({ ...request(), args })).toThrow();
  expect(() => check({ ...request(), settings: { ...request().settings, CI: "1" } })).toThrow();
  expect(check({ mode: "browser-cleanup", bot: "bot-1" }).user).toBe("murage-browser");
});
it("accepts only the exact agent-browser argv shapes the server builds and refuses Chrome flag pass-through", () => {
  for (const args of [["mcp", "--tools", "core", "--no-webmcp"], ["--version"], ["--session", "fixture", "close"], ["--json", "stream", "status"], ["--json", "get", "cdp-url"], ["--json", "open", "about:blank"], ["--json", "open", "https://example.com/a?b=1"], ["relay", "cdp"], ["relay", "stream"]]) expect(check({ ...request(), args }).args).toEqual(args);
  const flags = ["--remote-debugging-port", "--remote-debugging-address", "--remote-debugging-pipe", "--gpu-launcher", "--renderer-cmd-prefix", "--utility-cmd-prefix", "--browser-subprocess-path", "--load-extension", "--user-data-dir", "--proxy-server", "--host-resolver-rules", "--no-sandbox", "--disable-web-security"];
  for (const flag of flags) for (const args of [[flag], [`${flag}=x`], [flag, "x"], ["mcp", "--tools", "core", "--no-webmcp", `${flag}=x`], ["--json", "open", "about:blank", flag, "x"], ["--args", `${flag}=x`], ["--json", "open", `${flag}=x`]]) expect(() => check({ ...request(), args })).toThrow();
  for (const args of [[], ["--session", "a b", "close"], ["--json", "open", "javascript:1"], ["--json", "open", "https://a b"], ["--json", "eval", "1"], ["install", "--with-deps"], ["relay"], ["relay", "x"], ["relay", "cdp", "extra"], ["relay", "stream", "9222"], ["relay", "ws://127.0.0.1:9222/devtools/browser/x"], ["relay", "127.0.0.1:9222"], ["--json", "relay", "cdp"], ["cdp", "relay"]]) expect(() => check({ ...request(), args })).toThrow();
});
it("carries validated session settings over the private request and separates home bot identities", () => {
  vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
  expect(browserSessionId("a", "shared", "realm")).not.toBe(browserSessionId("b", "shared", "realm"));
  const input = { binaryPath: "/fixture/browser", botId: "bot-1", session: "fixture", encryptionKey: "a".repeat(64), dataDir: "/fixture", realmId: "fixture" };
  // Exercise environment construction without pretending this container can
  // run Chromium. Separate host tests retain all Linux container refusals.
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    const spec = agentBrowserIntegration(input);
    expect(spec.env.HOME).toBe("/data/browser/bot-1"); expect(spec.env[CLOUD_BROWSER_BOT]).toBe("bot-1");
    const wire = cloudBrowserRequest(spec.args, { ...spec.env, CI: "1", LD_AUDIT: "fixture", MURAGE_CLOUD_SECRET: "fixture" });
    const result = check(wire); expect(result.env.AGENT_BROWSER_SESSION).toBe("fixture");
    expect(result.env.AGENT_BROWSER_ENCRYPTION_KEY).toBe(input.encryptionKey);
    expect(wire.settings).not.toHaveProperty("CI"); expect(wire.settings).not.toHaveProperty("MURAGE_CLOUD_SECRET");
  } finally { Object.defineProperty(process, "platform", platform); }
});

// The relay runs inside the bot's namespace as the browser user. These drive its
// internals (endpoint derivation and the byte pipe) with an injected fake CLI.
const relayHarness = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("relay_fixture",sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
exec(sys.argv[2])`;
function relayPython(code: string) { return execFileSync("python3", ["-I", "-c", relayHarness, launcher, code], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
it("the relay accepts only a loopback endpoint from the CLI and refuses anything else", () => {
  const out = relayPython(`
good=['{"success":true,"data":{"cdpUrl":"ws://127.0.0.1:41909/devtools/browser/abc"}}','{"data":"ws://127.0.0.1:41909/devtools/browser/abc"}','{"cdp_url":"ws://127.0.0.1:41909/devtools/page/1"}']
print([module.relay_endpoint("cdp",g) for g in good])
print(module.relay_endpoint("stream",'{"success":true,"data":{"port":4100}}'), module.relay_endpoint("stream",'{"data":{"streamPort":4101}}'))
bad=['{"success":false}','not json','[]','{"data":null}','{"data":"ws://10.0.0.5:9222/devtools/browser/a"}','{"data":"ws://localhost:9222/devtools/browser/a"}','{"data":"ws://[::1]:9222/devtools/browser/a"}','{"data":"wss://127.0.0.1:9222/devtools/browser/a"}','{"data":"http://127.0.0.1:9222/devtools/browser/a"}','{"data":"ws://127.0.0.1:0/devtools/browser/a"}','{"data":"ws://127.0.0.1:70000/devtools/browser/a"}','{"data":"ws://127.0.0.1/devtools/browser/a"}','{"data":"ws://127.0.0.1:9222/json/version"}','{"data":"ws://127.0.0.1@evil.example:9222/devtools/browser/a"}','{"data":"ws://evil@127.0.0.1:9222/devtools/browser/a"}','{"data":"ws://127.0.0.1:9222/devtools/a b"}']
for b in bad:
    try: module.relay_endpoint("cdp",b); print("ACCEPTED",b)
    except Exception: pass
for b in ['{"data":{"port":0}}','{"data":{"port":65536}}','{"data":{"port":"4100"}}','{"data":{"port":true}}','{"data":{}}','{"data":"4100"}','{"success":false,"data":{"port":4100}}']:
    try: module.relay_endpoint("stream",b); print("ACCEPTED",b)
    except Exception: pass
print("done")`);
  expect(out.trim().split("\n")).toEqual(["[41909, 41909, 41909]", "4100 4101", "done"]);
});
it("the relay is a byte pipe between stdio and the endpoint it found itself, and refuses without writing to stdout", () => {
  const out = relayPython(`
import socket,threading,os
srv=socket.socket();srv.bind(("127.0.0.1",0));srv.listen(1);port=srv.getsockname()[1]
def echo():
    c,_=srv.accept()
    while True:
        d=c.recv(65536)
        if not d: break
        c.sendall(d[::-1])
threading.Thread(target=echo,daemon=True).start()
asked=[]
def discover(kind): asked.append(kind); return port
ir,iw=os.pipe();outr,outw=os.pipe()
result=[]
t=threading.Thread(target=lambda:result.append(module.run_relay("stream",discover=discover,infd=ir,outfd=outw)));t.start()
payload=bytes(range(256))*2000
threading.Thread(target=lambda:os.write(iw,payload) and None).start()
got=b""
while len(got)<len(payload): got+=os.read(outr,65536)
os.close(iw);t.join(10)
print(asked,result,len(got))
def refuse(kind): raise ValueError("nope")
a,b=os.pipe()
print(module.run_relay("cdp",discover=refuse,infd=a,outfd=b), os.read(a,1) if False else "")
os.set_blocking(a,False)
try: print("stdout bytes",len(os.read(a,10)))
except BlockingIOError: print("stdout bytes 0")
`);
  const lines = out.trim().split("\n");
  expect(lines[0]).toMatch(/^\['stream'\] \[0\] \d+$/);
  expect(lines[1]).toBe("1 ");
  expect(lines[2]).toBe("stdout bytes 0");
});
it("the relay finds the endpoint by running the bundled CLI with the fixed argv only", () => {
  const out = relayPython(`
calls=[]
def fake(argv): calls.append(argv); return b'{"success":true,"data":{"cdpUrl":"ws://127.0.0.1:5555/devtools/browser/x"}}' if argv[1:]==["--json","get","cdp-url"] else b'{"success":true,"data":{"port":6666}}'
print(module.relay_discover("cdp",fake), module.relay_discover("stream",fake))
print(json.dumps(calls))`);
  const lines = out.trim().split("\n");
  expect(lines[0]).toBe("5555 6666");
  expect(JSON.parse(lines[1])).toEqual([["/opt/murage/resources/browser-engine/agent-browser", "--json", "get", "cdp-url"], ["/opt/murage/resources/browser-engine/agent-browser", "--json", "stream", "status"]]);
});

it("T19 the root launcher's identity check accepts the UI canary's reserved id", () => {
  const result = check({ ...request(), bot: "__murage-ui-canary" });
  expect(result.home).toBe("/data/browser/__murage-ui-canary"); expect(result.writable).toEqual([result.home]);
  expect(check({ mode: "browser-cleanup", bot: "__murage-ui-canary" }).home).toBe("/data/browser/__murage-ui-canary");
  expect(() => check({ ...request(), bot: "_".repeat(65) })).toThrow();
});
