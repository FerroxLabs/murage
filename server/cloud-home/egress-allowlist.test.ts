// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";
const deploy = (name: string) => fileURLToPath(new URL(`../../deploy/cloud-home/${name}`, import.meta.url));
const read = (name: string) => readFileSync(deploy(name), "utf8");
const proxy = deploy("murage-egress-proxy.py");

// The proxy file is loaded with run_path (no network, no listening); resolver and
// connect are injected, so nothing here touches the network.
const prelude = `
import runpy, sys, json, asyncio, ssl, struct
M = runpy.run_path(sys.argv[1])
Refused = M["Refused"]; ConfigError = M["ConfigError"]
def hello(sni=None, ext=b""):
    exts = b""
    if sni is not None:
        n = sni.encode(); entry = b"\\0" + struct.pack(">H", len(n)) + n; lst = struct.pack(">H", len(entry)) + entry
        exts += struct.pack(">HH", 0, len(lst)) + lst
    exts += ext
    body = b"\\x03\\x03" + b"\\0" * 32 + b"\\0" + struct.pack(">H", 2) + b"\\x13\\x01" + b"\\x01\\x00"
    if exts: body += struct.pack(">H", len(exts)) + exts
    hs = b"\\x01" + len(body).to_bytes(3, "big") + body
    return b"\\x16\\x03\\x01" + struct.pack(">H", len(hs)) + hs
def real_hello(name):
    ctx = ssl.create_default_context(); inc = ssl.MemoryBIO(); out = ssl.MemoryBIO()
    o = ctx.wrap_bio(inc, out, server_hostname=name)
    try: o.do_handshake()
    except ssl.SSLWantReadError: pass
    return out.read()
def reason(fn, *a):
    try: return "ok:" + str(fn(*a))
    except Refused as e: return e.reason
    except ConfigError as e: return "config:" + str(e)
`;
const py = (code: string, args: string[] = []) => execFileSync("python3", ["-I", "-c", prelude + code, proxy, ...args], { encoding: "utf8", timeout: 20000 }).trim();
const pyJson = (code: string) => JSON.parse(py(code));

describe("SNI parser", () => {
  it("accepts a real ClientHello and lowercases the name", () => {
    expect(py(`print(M["parse_sni"](real_hello("API.Anthropic.com")))`)).toBe("api.anthropic.com");
    expect(py(`print(M["parse_sni"](hello("Claude.AI.")))`)).toBe("claude.ai");
  });
  it("rejects no-SNI, IP literal, ECH, oversized, truncated and malformed hellos", () => {
    const out = pyJson(`
real = real_hello("api.anthropic.com")
print(json.dumps({
 "none": reason(M["parse_sni"], hello(None)),
 "otherExt": reason(M["parse_sni"], hello(None, b"\\x00\\x17\\x00\\x00")),
 "v4": reason(M["parse_sni"], hello("93.184.216.34")),
 "v6": reason(M["parse_sni"], hello("2606:4700::1111")),
 "decimal": reason(M["parse_sni"], hello("2130706433")),
 "hex": reason(M["parse_sni"], hello("0x7f.1")),
 "ech": reason(M["parse_sni"], hello("api.anthropic.com", b"\\xfe\\x0d\\x00\\x02\\x00\\x00")),
 "oversized": reason(M["parse_sni"], b"\\x16\\x03\\x01" + struct.pack(">H", 20000) + b"\\0" * 20000),
 "oversizedHeaderOnly": reason(M["parse_sni"], b"\\x16\\x03\\x01" + struct.pack(">H", 16380) + b"\\0" * 10),
 "truncated": reason(M["parse_sni"], real[:-10]),
 "tiny": reason(M["parse_sni"], real[:3]),
 "notTls": reason(M["parse_sni"], b"GET / HTTP/1.1\\r\\n\\r\\n"),
 "badChars": reason(M["parse_sni"], hello("a b.example.com")),
 "garbage": reason(M["parse_sni"], b"\\x16\\x03\\x01\\x00\\x08\\x01\\x00\\x00\\x04\\x03\\x03\\x00\\x00"),
}))`);
    expect(out).toEqual({ none: "no-sni", otherExt: "no-sni", v4: "ip-literal", v6: expect.stringMatching(/^(ip-literal|bad-host)$/), decimal: "ip-literal", hex: "ip-literal", ech: "ech", oversized: "oversized", oversizedHeaderOnly: "oversized", truncated: "truncated", tiny: "not-tls", notTls: "not-tls", badChars: "bad-host", garbage: expect.stringMatching(/^(malformed|truncated)$/) });
  });
});

describe("allowlist matching", () => {
  const sample = JSON.stringify({ engines: { claudeAgent: ["api.anthropic.com", "*.claude.ai"], codex: ["api.openai.com"] }, extra: ["docs.example.org"] });
  it("matches exact, wildcard suffix, case and trailing dot but never substrings", () => {
    const out = pyJson(`
a = M["parse_allowlist"](${JSON.stringify(sample)})
n = lambda h: M["normalize_host"](h)
t = lambda e, h: a.allows(e, n(h))
print(json.dumps({
 "exact": t("claudeAgent", "api.anthropic.com"),
 "case": t("claudeAgent", "API.Anthropic.COM"),
 "dot": t("claudeAgent", "api.anthropic.com."),
 "wild": t("claudeAgent", "login.claude.ai"),
 "wildDeep": t("claudeAgent", "a.b.claude.ai"),
 "wildBare": t("claudeAgent", "claude.ai"),
 "wildSub": t("claudeAgent", "evilclaude.ai"),
 "substr": t("claudeAgent", "evilapi.anthropic.com.attacker.net"),
 "prefix": t("claudeAgent", "api.anthropic.com.attacker.net"),
 "lead": t("claudeAgent", "xapi.anthropic.com"),
 "otherEngine": t("codex", "api.anthropic.com"),
 "noEntry": t("pi", "api.anthropic.com"),
 "extraAll": t("pi", "docs.example.org"),
 "extraOther": t("pi", "x.docs.example.org"),
}))`);
    expect(out).toEqual({ exact: true, case: true, dot: true, wild: true, wildDeep: true, wildBare: false, wildSub: false, substr: false, prefix: false, lead: false, otherEngine: false, noEntry: false, extraAll: true, extraOther: false });
  });
  it("refuses a non-global resolved address (and replays nothing)", () => {
    const out = pyJson(`
g = M["is_global"]
print(json.dumps({a: g(a) for a in ["10.0.0.5","127.0.0.1","169.254.169.254","100.64.0.1","192.168.1.1","172.16.0.1","0.0.0.0","224.0.0.1","::1","fe80::1","fc00::1","::ffff:8.8.8.8","93.184.216.34","2606:4700::1111"]}))`);
    expect(out).toEqual({ "10.0.0.5": false, "127.0.0.1": false, "169.254.169.254": false, "100.64.0.1": false, "192.168.1.1": false, "172.16.0.1": false, "0.0.0.0": false, "224.0.0.1": false, "::1": false, "fe80::1": false, "fc00::1": false, "::ffff:8.8.8.8": false, "93.184.216.34": true, "2606:4700::1111": true });
  });
});

describe("connection handling with injected resolver and connect", () => {
  const harness = `
allow = M["parse_allowlist"](json.dumps({"engines": {"claudeAgent": ["api.anthropic.com"]}, "extra": []}))
async def echo(r, w):
    w.write(await r.read(-1)); await w.drain(); w.close()
async def session(engine, data, resolve, calls, lines):
    up = await asyncio.start_server(echo, "127.0.0.1", 0)
    uport = up.sockets[0].getsockname()[1]
    async def connect(address, port):
        calls.append((address, port))
        return await asyncio.open_connection("127.0.0.1", uport)
    log = M["RefusalLog"](emit=lines.append)
    result = []
    async def handler(r, w):
        result.append(await M["serve_connection"](engine, allow, r, w, resolve, connect, log))
    srv = await asyncio.start_server(handler, "127.0.0.1", 0)
    port = srv.sockets[0].getsockname()[1]
    r, w = await asyncio.open_connection("127.0.0.1", port)
    w.write(data); await w.drain(); w.write_eof()
    back = await asyncio.wait_for(r.read(-1), 10)
    await asyncio.sleep(0.05)
    srv.close(); up.close()
    return back, result[0]
`;
  it("replays the ClientHello to the resolved global address on 443 only", () => {
    const out = pyJson(`${harness}
async def main():
    seen = []; calls = []; lines = []
    async def resolve(host): seen.append(host); return ["93.184.216.34"]
    data = real_hello("api.anthropic.com")
    back, res = await session("claudeAgent", data, resolve, calls, lines)
    print(json.dumps({"echo": back == data, "res": res, "seen": seen, "calls": calls, "lines": lines}))
asyncio.run(main())`);
    expect(out).toEqual({ echo: true, res: null, seen: ["api.anthropic.com"], calls: [["93.184.216.34", 443]], lines: [] });
  });
  it("never connects when every resolved address is non-global", () => {
    const out = pyJson(`${harness}
async def main():
    calls = []; lines = []
    async def resolve(host): return ["10.0.0.5", "169.254.169.254", "::1"]
    back, res = await session("claudeAgent", real_hello("api.anthropic.com"), resolve, calls, lines)
    print(json.dumps({"back": len(back), "res": res, "calls": calls, "lines": lines}))
asyncio.run(main())`);
    expect(out).toEqual({ back: 0, res: "non-global", calls: [], lines: ["egress refused engine=claudeAgent host=api.anthropic.com reason=non-global"] });
  });
  it("refuses a host outside the engine's list before resolving, and rate-limits the log", () => {
    const out = pyJson(`${harness}
async def main():
    calls = []; lines = []; resolved = []
    async def resolve(host): resolved.append(host); return ["93.184.216.34"]
    r1 = await session("claudeAgent", real_hello("evil.example.net"), resolve, calls, lines)
    r2 = await session("codex", real_hello("api.anthropic.com"), resolve, calls, lines)
    log = M["RefusalLog"](emit=lines.append, clock=lambda: 5.0)
    first = log.refuse("pi", "x.example.com", "not-allowed"); again = log.refuse("pi", "x.example.com", "not-allowed")
    bad = log.refuse("pi", "bad host\\n127.0.0.1", "not-allowed")
    print(json.dumps({"res": [r1[1], r2[1]], "resolved": resolved, "calls": calls, "first": first, "again": again, "lines": lines[-2:], "bad": bad}))
asyncio.run(main())`);
    expect(out.res).toEqual(["not-allowed", "not-allowed"]);
    expect(out.resolved).toEqual([]); expect(out.calls).toEqual([]);
    expect(out.first).toBe(true); expect(out.again).toBe(false);
    expect(out.lines).toEqual(["egress refused engine=pi host=x.example.com reason=not-allowed", "egress refused engine=pi host=- reason=not-allowed"]);
  });
});

describe("accepted-connection bounds", () => {
  const code = `
allow = M["parse_allowlist"](json.dumps({"engines": {"claudeAgent": ["api.anthropic.com"], "codex": ["api.anthropic.com"]}, "extra": []}))
async def echo(r, w):
    w.write(await r.read(-1)); await w.drain(); w.close()
async def closed_within(r, seconds):
    t = asyncio.get_running_loop().time()
    try: data = await asyncio.wait_for(r.read(-1), seconds)
    except asyncio.TimeoutError: return None
    return round(asyncio.get_running_loop().time() - t, 2) if data == b"" else "data"
async def main():
    up = await asyncio.start_server(echo, "127.0.0.1", 0); uport = up.sockets[0].getsockname()[1]
    async def resolve(host): return ["93.184.216.34"]
    async def connect(address, port): return await asyncio.open_connection("127.0.0.1", uport)
    log = M["RefusalLog"](emit=lambda line: None)
    admission = M["Admission"](per_engine=2, total=3)
    gate = asyncio.Semaphore(8)
    servers = {}; ports = {}
    for engine in ("claudeAgent", "codex"):
        h = M["make_handler"](engine, allow, admission, gate, resolve, connect, log, hello_timeout=0.4)
        servers[engine] = await asyncio.start_server(h, "127.0.0.1", 0); ports[engine] = servers[engine].sockets[0].getsockname()[1]
    dial = lambda e: asyncio.open_connection("127.0.0.1", ports[e])
    a1 = await dial("claudeAgent"); a2 = await dial("claudeAgent"); await asyncio.sleep(0.05)
    a3 = await dial("claudeAgent")
    over_cap = await closed_within(a3[0], 0.2)           # closed at once, well before the 0.4s hello timeout
    b = await dial("codex"); data = real_hello("api.anthropic.com"); b[1].write(data); b[1].write_eof()
    other_engine_ok = (await asyncio.wait_for(b[0].read(-1), 5)) == data
    idle = await closed_within(a1[0], 3)                  # idle socket dropped by the hello timeout
    idle2 = await closed_within(a2[0], 3)
    await asyncio.sleep(0.1)
    a4 = await dial("claudeAgent"); a4[1].write(data); a4[1].write_eof()
    freed = (await asyncio.wait_for(a4[0].read(-1), 5)) == data
    print(json.dumps({"over_cap": over_cap, "other_engine_ok": other_engine_ok, "idle": idle, "idle2": idle2, "freed": freed, "open": admission.open}))
    for s in servers.values(): s.close()
    up.close()
asyncio.run(main())`;
  it("closes an over-cap connection at once, keeps other engines connectable, and drops idle sockets after the hello timeout", () => {
    const out = pyJson(code);
    expect(out.over_cap).not.toBeNull(); expect(out.over_cap).toBeLessThan(0.2);
    expect(out.other_engine_ok).toBe(true);
    expect(out.idle).not.toBeNull(); expect(out.idle).toBeGreaterThan(0.1); expect(out.idle).toBeLessThan(2);
    expect(out.idle2).not.toBeNull();
    expect(out.freed).toBe(true); expect(out.open).toBe(0);
  });
});

describe("allowlist file", () => {
  const withFile = (text: string | null) => {
    const dir = mkdtempSync(join(tmpdir(), "egress-allow-"));
    try {
      const path = join(dir, "allow.json");
      if (text !== null) writeFileSync(path, text);
      const run = spawnSync("python3", ["-I", proxy, path], { encoding: "utf8", timeout: 10000 });
      return { status: run.status, stderr: run.stderr };
    } finally { removeTempDirSync(dir); }
  };
  it.each([
    ["missing file", null], ["not JSON", "{nope"], ["array", "[]"], ["unknown top-level key", '{"engines":{},"extra":[],"allow":["x.com"]}'],
    ["missing engines", '{"extra":[]}'], ["unknown engine", '{"engines":{"nope":["a.com"]},"extra":[]}'], ["host not a list", '{"engines":{"codex":"a.com"},"extra":[]}'],
    ["IP entry", '{"engines":{"codex":["1.2.3.4"]},"extra":[]}'], ["bare wildcard", '{"engines":{"codex":["*"]},"extra":[]}'], ["TLD wildcard", '{"engines":{"codex":["*.com"]},"extra":[]}'],
    ["infix wildcard", '{"engines":{"codex":["a.*.com"]},"extra":[]}'], ["extra not a list", '{"engines":{},"extra":"a.com"}'], ["non-string entry", '{"engines":{"codex":[1]},"extra":[]}'],
  ])("refuses to start: %s", (_name, text) => {
    const run = withFile(text as string | null);
    expect(run.status).toBe(78); expect(run.stderr).toContain("refuses to start");
  });
  it("the shipped file parses, is vendor-only and has no owner extras", () => {
    const doc = JSON.parse(read("egress-allow.json"));
    expect(Object.keys(doc).sort()).toEqual(["engines", "extra"]);
    expect(doc.extra).toEqual([]); expect(doc.engines.fuigoAgent).toEqual(["api.fluxrouter.ai"]);
    expect(Object.keys(doc.engines).sort()).toEqual(["claudeAgent", "codex", "cursorAgent", "fuigoAgent", "geminiAgent", "grokAgent", "kimiAgent", "opencodeGo"]);
    expect(py(`a = M["load_allowlist"](sys.argv[2]); print(a.allows("codex","sdmntprwestus.oaiusercontent.com"), a.allows("codex","oaiusercontent.com"), a.allows("codex","evil-oaiusercontent.com"), a.allows("claudeAgent","x.oaiusercontent.com"))`, [deploy("egress-allow.json")])).toBe("True False False False");
    expect(py(`a = M["load_allowlist"](sys.argv[2]); print(a.allows("claudeAgent","api.anthropic.com"), a.allows("claudeAgent","example.com"))`, [deploy("egress-allow.json")])).toBe("True False");
  });
});

describe("engine to port table", () => {
  const nft = read("murage-egress.nft");
  const table = pyJson(`print(json.dumps({"ports": M["PORTS"], "engines": list(M["ENGINES"]), "base": M["BASE_PORT"]}))`);
  it("is the sorted launcher engine set with consecutive ports", () => {
    const launcher = read("murage-turn-launch.py").match(/^ENGINES = \{(.*)\}$/m)![1].split(",").map(item => item.trim().replace(/"/g, "")).sort();
    expect(table.engines).toEqual(launcher);
    expect(table.engines).toEqual([...table.engines].sort());
    expect(Object.fromEntries(table.engines.map((engine: string, index: number) => [engine, table.base + index]))).toEqual(table.ports);
    const image = read("build-image.sh").match(/^engines=\((.*)\)$/m)![1].split(/\s+/).sort();
    expect(image).toEqual(launcher);
  });
  it("matches the nft redirect and accept rules exactly", () => {
    const redirects = Object.fromEntries([...nft.matchAll(/meta skuid "murage-turn" meta skgid "murage-eng-(\w+)" ip daddr != 127\.0\.0\.0\/8 tcp dport 443 counter redirect to :(\d+)$/gm)].map(m => [m[1], Number(m[2])]));
    const accepts = Object.fromEntries([...nft.matchAll(/meta skuid "murage-turn" meta skgid "murage-eng-(\w+)" ip daddr 127\.0\.0\.1 tcp dport (\d+) counter accept$/gm)].map(m => [m[1], Number(m[2])]));
    expect(redirects).toEqual(table.ports); expect(accepts).toEqual(table.ports);
  });
});

describe("nft policy", () => {
  const nft = read("murage-egress.nft");
  const output = nft.slice(nft.indexOf("chain output {"), nft.indexOf("chain input {"));
  const lines = output.split("\n").map(line => line.trim());
  const turn = lines.filter(line => line.startsWith('meta skuid "murage-turn"'));
  it("drops everything else from murage-turn, after every accept", () => {
    const drop = lines.indexOf('meta skuid "murage-turn" counter drop');
    expect(drop).toBeGreaterThan(-1);
    lines.forEach((line, index) => { if (line.startsWith('meta skuid "murage-turn"') && line.endsWith("accept")) expect(index).toBeLessThan(drop); });
    expect(lines.indexOf('meta skuid "murage-turn" fib daddr type local counter drop')).toBeLessThan(drop);
  });
  it("never accepts murage-turn to a non-loopback address", () => {
    const accepts = turn.filter(line => line.endsWith("accept"));
    expect(accepts.length).toBeGreaterThan(14);
    for (const line of accepts) expect(line).toMatch(/ip daddr 127\.(0\.0\.0\/8|0\.0\.1|0\.0\.53)|ip6 daddr ::1/);
    for (const line of accepts) expect(line).not.toMatch(/daddr !=/);
    expect(accepts.filter(line => line.includes("tcp dport 443") && !line.includes("127.0.0.1"))).toEqual([]);
  });
  it("redirects only murage-turn tcp 443 in a nat output chain keyed by gid", () => {
    expect(nft).toMatch(/chain turn_nat \{\n\s+type nat hook output priority -100;/);
    const nat = nft.slice(nft.indexOf("chain turn_nat {"), nft.indexOf("chain output {")).split("\n").filter(line => line.includes("redirect"));
    expect(nat).toHaveLength(14);
    for (const line of nat) expect(line.trim()).toMatch(/^meta skuid "murage-turn" meta skgid "murage-eng-\w+" ip daddr != 127\.0\.0\.0\/8 tcp dport 443 counter redirect to :88\d\d$/);
  });
  it("lets murage-egress reach only stub DNS, loopback replies and public tcp 443, after the private drops", () => {
    const rules = lines.filter(line => line.startsWith('meta skuid "murage-egress"'));
    expect(rules.at(-1)).toBe('meta skuid "murage-egress" counter drop');
    const accepts = rules.filter(line => line.endsWith("accept"));
    expect(accepts).toEqual([
      'meta skuid "murage-egress" ip daddr 127.0.0.53 udp dport 53 counter accept',
      'meta skuid "murage-egress" ip daddr 127.0.0.53 tcp dport 53 counter accept',
      'meta skuid "murage-egress" oifname "lo" ct state established,related counter accept',
      'meta skuid "murage-egress" tcp dport 443 counter accept',
    ]);
    const privateDrop = lines.findIndex(line => line.startsWith('meta skuid != { 0, "murage" } ip daddr { 10.0.0.0/8'));
    expect(privateDrop).toBeGreaterThan(-1); expect(privateDrop).toBeLessThan(lines.indexOf(rules[0]));
    expect(lines.indexOf('meta skuid != 0 ip daddr 169.254.169.254 counter drop')).toBeLessThan(lines.indexOf(rules[0]));
  });
  it("leaves the browser rules alone", () => {
    expect(output).toContain('meta skuid "murage-browser" ip daddr 127.0.0.0/8 counter drop');
    expect(output).toContain('meta skuid "murage-browser" ip6 daddr ::1 counter drop');
    expect(lines.filter(line => line.startsWith('meta skuid "murage-browser"'))).toHaveLength(2);
  });
});

describe("packaging", () => {
  it("image creates the user, installs proxy, allowlist and unit, and enables it", () => {
    const build = read("build-image.sh");
    expect(build).toContain("useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin murage-egress");
    expect(build).toContain("install -o root -g root -m 0755 deploy/cloud-home/murage-egress-proxy.py /usr/local/libexec/murage-egress-proxy");
    expect(build).toContain("install -o root -g root -m 0644 deploy/cloud-home/egress-allow.json /etc/murage/egress-allow.json");
    expect(build).toContain("install -m 0644 deploy/cloud-home/murage-egress-proxy.service /etc/systemd/system/murage-egress-proxy.service");
    expect(build).toMatch(/systemctl enable [^\n]*murage-egress-proxy\.service/);
  });
  it("unit is hardened and ordered between the egress rules and the home", () => {
    const unit = read("murage-egress-proxy.service");
    for (const line of ["User=murage-egress", "NoNewPrivileges=yes", "ProtectSystem=strict", "PrivateTmp=yes", "RestrictAddressFamilies=AF_INET AF_INET6", "Restart=always", "After=network-online.target murage-egress.service", "Before=murage-home.service"]) expect(unit).toContain(line);
    expect(unit).toMatch(/MemoryMax=\d+M/);
  });
  it("launcher makes the engine group the primary gid so nft can tell engines apart", () => {
    const launcher = read("murage-turn-launch.py");
    expect(launcher).toContain("os.setgid(engine_gid)");
    expect(launcher).toContain("os.setgroups([engine_gid, grp.getgrnam(SANDBOX_GROUP).gr_gid, account.pw_gid])");
  });
});
