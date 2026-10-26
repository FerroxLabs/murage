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
    expect(doc.engines.antigravity).toEqual(["cloudcode-pa.googleapis.com", "oauth2.googleapis.com"]); expect(doc.engines.antigravity).not.toContain("www.googleapis.com");
    expect(Object.keys(doc.engines).sort()).toEqual(["antigravity", "claudeAgent", "codex", "cursorAgent", "fuigoAgent", "geminiAgent", "grokAgent", "kimiAgent", "opencodeGo"]);
    // agy 1.4.4: its updater, flag service and telemetry hosts stay refused.
    expect(py(`a = M["load_allowlist"](sys.argv[2]); print(a.allows("antigravity","oauth2.googleapis.com"), a.allows("antigravity","antigravity-unleash.goog"), a.allows("antigravity","play.googleapis.com"), a.allows("antigravity","antigravity-cli-auto-updater-974169037036.us-central1.run.app"))`, [deploy("egress-allow.json")])).toBe("True False False False");
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
    for (const line of accepts) expect(line).toMatch(/ip daddr 127\.(0\.0\.0\/8|0\.0\.1)|ip6 daddr ::1/);
    for (const line of accepts) expect(line.replace(" ct original ip daddr 127.0.0.53", "")).not.toContain("127.0.0.53");
    for (const line of accepts) expect(line).not.toMatch(/daddr !=/);
    expect(accepts.filter(line => line.includes("tcp dport 443") && !line.includes("127.0.0.1"))).toEqual([]);
  });
  it("redirects only murage-turn tcp 443 in a nat output chain keyed by gid", () => {
    expect(nft).toMatch(/chain turn_nat \{\n\s+type nat hook output priority -100;/);
    const nat = nft.slice(nft.indexOf("chain turn_nat {"), nft.indexOf("chain output {")).split("\n").filter(line => line.includes("redirect"));
    expect(nat).toHaveLength(28);
    for (const line of nat) expect(line.trim()).toMatch(/^meta skuid "murage-turn" meta skgid "murage-eng-\w+" (ip daddr != 127\.0\.0\.0\/8 tcp dport 443 counter redirect to :88\d\d|ip daddr 127\.0\.0\.53 udp dport 53 counter redirect to :53\d\d)$/);
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

// ---- A2 DNS forwarder (synthetic answers, no upstream) ----
describe("A2 DNS forwarder", () => {
  const dnsPrelude = `
SHIPPED = sys.argv[2]
def qname(name):
    out = b""
    for label in name.rstrip(".").split("."):
        out += bytes([len(label)]) + label.encode()
    return out + b"\\0"
def query(name, qtype=1, qclass=1, ident=0x1234, flags=0x0100, opt=None, raw_name=None, extra=b"", qd=1, an=0, ns=0):
    ar = 0 if opt is None else 1
    head = struct.pack(">HHHHHH", ident, flags, qd, an, ns, ar)
    q = (raw_name if raw_name is not None else qname(name)) + struct.pack(">HH", qtype, qclass)
    return head + q + (opt or b"") + extra
OPT = b"\\x00" + struct.pack(">HHIH", 41, 1232, 0, 0)
def parse(reply):
    ident, flags, qd, an, ns, ar = struct.unpack(">HHHHHH", reply[:12])
    return {"id": ident, "qr": flags >> 15, "opcode": (flags >> 11) & 15, "rcode": flags & 15, "ra": (flags >> 7) & 1, "rd": (flags >> 8) & 1, "aa": (flags >> 10) & 1, "qd": qd, "an": an, "ns": ns, "ar": ar}
allow = M["load_allowlist"](SHIPPED)
dns = lambda engine, pkt: M["dns_respond"](engine, allow, pkt)
`;
  const run = (code: string) => JSON.parse(execFileSync("python3", ["-I", "-c", prelude + dnsPrelude + code, proxy, deploy("egress-allow.json")], { encoding: "utf8", timeout: 60000 }).trim());

  it("answers an allowed A query with exactly one synthetic record, echoing id, question case and RD", () => {
    const out = run(`
pkt = query("API.Anthropic.com", ident=0xBEEF)
r = dns("claudeAgent", pkt); p = parse(r)
qlen = len(qname("API.Anthropic.com")) + 4
tail = r[12 + qlen:]
print(json.dumps({"p": p, "question": r[12:12 + qlen] == pkt[12:12 + qlen], "owner": tail[:2].hex(), "rr": struct.unpack(">HHIH", tail[2:12]), "addr": ".".join(map(str, tail[12:16])), "len": len(tail)}))`);
    expect(out.p).toEqual({ id: 0xbeef, qr: 1, opcode: 0, rcode: 0, ra: 1, rd: 1, aa: 0, qd: 1, an: 1, ns: 0, ar: 0 });
    expect(out.question).toBe(true); expect(out.owner).toBe("c00c"); expect(out.rr).toEqual([1, 1, 30, 4]); expect(out.addr).toBe("5.255.0.1"); expect(out.len).toBe(16);
  });
  it("gives NODATA for other types on an allowed name and NXDOMAIN for every type on a refused one", () => {
    const out = run(`
types = [1, 28, 16, 65, 64, 15, 255, 33, 257, 12, 6, 252]
nodata = {t: (lambda p: [p["rcode"], p["an"]])(parse(dns("claudeAgent", query("api.anthropic.com", qtype=t)))) for t in types if t != 1}
nx = {t: parse(dns("claudeAgent", query("data.attacker.example", qtype=t)))["rcode"] for t in types}
print(json.dumps({"nodata": nodata, "nx": nx}))`);
    for (const v of Object.values(out.nodata)) expect(v).toEqual([0, 0]);
    for (const v of Object.values(out.nx)) expect(v).toBe(3);
  });
  it("refuses exfil-shaped, lookalike, reverse, cross-engine and engine-without-list names", () => {
    const out = run(`
names = ["aGVsbG8.attacker.example", "evil.api.anthropic.com.attacker.net", "api.anthropic.com.attacker.net", "xapi.anthropic.com", "1.0.0.127.in-addr.arpa", "x.ip6.arpa", "x.local", "x.onion", "oaiusercontent.com", "evil-oaiusercontent.com"]
res = {n: parse(dns("codex", query(n)))["rcode"] for n in names}
res["claudeHostOnCodex"] = parse(dns("codex", query("api.anthropic.com")))["rcode"]
res["piAny"] = parse(dns("pi", query("api.anthropic.com")))["rcode"]
res["wildSub"] = (lambda p: [p["rcode"], p["an"]])(parse(dns("codex", query("abc.oaiusercontent.com"))))
res["wildDeep"] = (lambda p: [p["rcode"], p["an"]])(parse(dns("codex", query("a.b.c.oaiusercontent.com"))))
res["wildOnClaude"] = parse(dns("claudeAgent", query("abc.oaiusercontent.com")))["rcode"]
res["dot"] = parse(dns("claudeAgent", query("api.anthropic.com.")))["an"]
res["case"] = parse(dns("claudeAgent", query("ApI.AnThRoPiC.cOm")))["an"]
print(json.dumps(res))`);
    const { claudeHostOnCodex, piAny, wildSub, wildDeep, wildOnClaude, dot, case: caseRes, ...names } = out;
    for (const v of Object.values(names)) expect(v).toBe(3);
    expect(claudeHostOnCodex).toBe(3); expect(piAny).toBe(3); expect(wildOnClaude).toBe(3);
    expect(wildSub).toEqual([0, 1]); expect(wildDeep).toEqual([0, 1]); expect(dot).toBe(1); expect(caseRes).toBe(1);
  });
  it("handles EDNS OPT strictly: one OPT echoed, none echoes none, bad shapes are FORMERR", () => {
    const out = run(`
ok = dns("claudeAgent", query("api.anthropic.com", opt=OPT)); okp = parse(ok)
none = parse(dns("claudeAgent", query("api.anthropic.com")))
two = parse(dns("claudeAgent", query("api.anthropic.com", opt=OPT + OPT)))
twoCount = struct.pack(">HHHHHH", 1, 0x0100, 1, 0, 0, 2) + qname("api.anthropic.com") + struct.pack(">HH", 1, 1) + OPT + OPT
badOwner = parse(dns("claudeAgent", query("api.anthropic.com", opt=b"\\x01a\\x00" + struct.pack(">HHIH", 41, 1232, 0, 0))))
ver1 = parse(dns("claudeAgent", query("api.anthropic.com", opt=b"\\x00" + struct.pack(">HHIH", 41, 1232, 0x00010000, 0))))
noRr = parse(dns("claudeAgent", struct.pack(">HHHHHH", 1, 0x0100, 1, 0, 0, 1) + qname("api.anthropic.com") + struct.pack(">HH", 1, 1)))
doBit = parse(dns("claudeAgent", query("api.anthropic.com", opt=b"\\x00" + struct.pack(">HHIH", 41, 4096, 0x00008000, 0))))
nonOpt = parse(dns("claudeAgent", query("api.anthropic.com", opt=b"\\x00" + struct.pack(">HHIH", 16, 1, 0, 0))))
print(json.dumps({"okAr": okp["ar"], "okEnd": ok[-11:].hex(), "noneAr": none["ar"], "two": two["rcode"], "twoCount": parse(dns("claudeAgent", twoCount))["rcode"], "badOwner": badOwner["rcode"], "ver1": ver1["rcode"], "noRr": noRr["rcode"], "doBit": [doBit["rcode"], doBit["an"], doBit["ar"]], "nonOpt": nonOpt["rcode"]}))`);
    expect(out.okAr).toBe(1); expect(out.okEnd).toBe("00" + "0029" + "04d0" + "00000000" + "0000"); expect(out.noneAr).toBe(0);
    expect(out).toMatchObject({ two: 1, twoCount: 1, badOwner: 1, ver1: 1, noRr: 1, doBit: [0, 1, 1], nonOpt: 1 });
  });
  it("answers FORMERR/NOTIMP or drops malformed packets without processing the name", () => {
    const out = run(`
r = lambda b: (lambda x: None if x is None else parse(x)["rcode"])(dns("claudeAgent", b))
base = query("api.anthropic.com")
print(json.dumps({
 "qd0": r(query("api.anthropic.com", qd=0)), "qd2": r(query("api.anthropic.com", qd=2)),
 "qr": r(query("api.anthropic.com", flags=0x8100)), "op": r(query("api.anthropic.com", flags=0x2800)),
 "trunc": r(base[:8]), "short": r(b"\\x00"), "empty": r(b""),
 "garbage": r(base + b"x"), "pointer": r(query("", raw_name=b"\\xc0\\x0c")), "label64": r(query("", raw_name=b"\\x40" + b"a" * 64 + b"\\0")),
 "an": r(query("api.anthropic.com", an=1)), "ns": r(query("api.anthropic.com", ns=1)),
 "chaos": r(query("api.anthropic.com", qclass=3)), "badchar": r(query("", raw_name=b"\\x03a.b\\x00")),
 "emptyMid": r(query("", raw_name=b"\\x03api\\x00\\x09anthropic\\x03com\\x00")), "nameTooLong": r(query("", raw_name=(b"\\x3f" + b"a" * 63) * 5 + b"\\0")),
}))`);
    expect(out).toMatchObject({ qd0: 1, qd2: 1, qr: null, op: 4, trunc: null, short: null, empty: null, garbage: 1, pointer: 1, label64: 1, an: 1, ns: 1, chaos: 4, badchar: 1, emptyMid: 1, nameTooLong: 1 });
  });
  it("survives seeded random fuzz: never raises, never answers a refused name, never exceeds 512 bytes", () => {
    const out = run(`
import random
rng = random.Random(20261023)
bad = 0; long_ = 0; answered = 0; seeds = [query("api.anthropic.com"), query("data.attacker.example"), query("a.oaiusercontent.com", opt=OPT)]
for i in range(6000):
    base = bytearray(rng.choice(seeds))
    for _ in range(rng.randint(0, 6)):
        k = rng.random()
        if k < 0.5 and base: base[rng.randrange(len(base))] = rng.randrange(256)
        elif k < 0.7 and base: del base[rng.randrange(len(base)):]
        else: base += bytes(rng.randrange(256) for _ in range(rng.randint(1, 20)))
    pkt = bytes(base) if rng.random() < 0.8 else bytes(rng.randrange(256) for _ in range(rng.randint(0, 80)))
    try: r = dns("claudeAgent", pkt)
    except Exception: bad += 1; continue
    if r is None: continue
    if len(r) > 512: long_ += 1
    p = parse(r)
    if p["an"]:
        answered += 1
        # an answered name must be allowlisted: re-derive it from the echoed question
        pos = 12; labels = []
        while r[pos]: labels.append(r[pos + 1:pos + 1 + r[pos]].decode("ascii")); pos += 1 + r[pos]
        if not allow.allows("claudeAgent", ".".join(labels).lower()): bad += 1
print(json.dumps({"bad": bad, "long": long_, "answered_some": answered > 0}))`);
    expect(out).toEqual({ bad: 0, long: 0, answered_some: true });
  });
  it("makes no upstream call: resolver and socket sends are poisoned while the corpus runs", () => {
    const out = run(`
import socket as S
calls = []
def boom(*a, **k): calls.append("call"); raise RuntimeError("upstream")
S.getaddrinfo = boom; S.socket.connect = boom; S.socket.sendto = boom; S.socket.send = boom; S.gethostbyname = boom
loop = asyncio.new_event_loop(); loop.getaddrinfo = boom; loop.create_connection = boom
M["dns_respond"].__globals__["socket"].getaddrinfo = boom
for n in ["api.anthropic.com", "data.attacker.example", "x.oaiusercontent.com", "1.0.0.127.in-addr.arpa"]:
    for t in (1, 28, 16):
        dns("claudeAgent", query(n, qtype=t)); dns("codex", query(n, qtype=t))
print(json.dumps({"calls": len(calls)}))`);
    expect(out.calls).toBe(0);
  });
  it("uses a dummy address that is global, in no special range, and passes the proxy's is_global", () => {
    const out = run(`
import ipaddress
a = ipaddress.ip_address(M["DUMMY_ADDRESS"])
special = ["0.0.0.0/8","100.64.0.0/10","127.0.0.0/8","169.254.0.0/16","192.0.0.0/24","192.0.2.0/24","198.18.0.0/15","198.51.100.0/24","203.0.113.0/24","224.0.0.0/4","240.0.0.0/4","10.0.0.0/8","172.16.0.0/12","192.168.0.0/16"]
print(json.dumps({"addr": M["DUMMY_ADDRESS"], "global": M["is_global"](M["DUMMY_ADDRESS"]), "special": any(a in ipaddress.ip_network(n) for n in special), "in5": a in ipaddress.ip_network("5.0.0.0/8"), "edge": int(a) & 255 in (0, 255), "not53": M["DUMMY_ADDRESS"] != "192.0.2.53"}))`);
    expect(out).toEqual({ addr: "5.255.0.1", global: true, special: false, in5: true, edge: false, not53: true });
  });
  it("agrees with the SNI path: DNS verdict == serve_connection verdict == Allowlist.allows over a corpus", () => {
    const out = run(`
sample = M["parse_allowlist"](json.dumps({"engines": {"claudeAgent": ["api.anthropic.com", "*.claude.ai"], "codex": ["api.openai.com", "*.oaiusercontent.com"]}, "extra": ["docs.example.org"]}))
lists = {"shipped": allow, "sample": sample}
corpus = ["api.anthropic.com", "API.Anthropic.COM", "api.anthropic.com.", "claude.ai", "login.claude.ai", "a.b.claude.ai", "evilclaude.ai", "evil-claude.ai", "claude.ai.attacker.net", "api.openai.com", "auth.openai.com", "chatgpt.com", "x.oaiusercontent.com", "a.b.oaiusercontent.com", "oaiusercontent.com", "evil-oaiusercontent.com", "oaiusercontent.com.attacker.net", "docs.example.org", "x.docs.example.org", "cli-chat-proxy.grok.com", "auth.x.ai", "api.fluxrouter.ai", "api2.cursor.sh", "cloudcode-pa.googleapis.com", "auth.kimi.com", "models.opencode.ai", "example.com", "data.attacker.example", "1.2.3.4", "localhost", "a_b.example.com", "xn--80ak6aa92e.com", "-bad.example.com", "x" * 64 + ".com", "0x7f.1", "2130706433"]
async def sni_verdict(al, engine, name):
    # SNI-allowed means ONLY that the allowlist check passed: serve_connection calls resolve
    # exactly once, after allows() succeeded. ech / no-sni / not-tls / bad-host / not-allowed
    # never reach it, and a later resolve or connect failure does not make a name "not allowed".
    reached = []
    async def resolve(h): reached.append(h); return ["93.184.216.34"]
    async def connect(a, p): raise OSError("no")
    class W:
        def __init__(s): s.b = b""
        def write(s, d): pass
        def close(s): pass
    r = asyncio.StreamReader(); r.feed_data(hello(name)); r.feed_eof()
    await M["serve_connection"](engine, al, r, W(), resolve, connect)
    return len(reached) == 1
async def main():
    mism = []
    for lname, al in lists.items():
        for engine in M["ENGINES"]:
            for name in corpus:
                try: dp = parse(M["dns_respond"](engine, al, query(name)))
                except Exception: dp = None
                d = dp is not None and dp["rcode"] == 0 and dp["an"] == 1
                try:
                    h = M["normalize_host"](name); direct = al.allows(engine, h)
                except Refused: direct = False
                s = await sni_verdict(al, engine, name)
                if not (d == s == direct): mism.append([lname, engine, name, d, direct, s])
    print(json.dumps({"mism": mism, "n": len(lists) * len(M["ENGINES"]) * len(corpus)}))
asyncio.run(main())`);
    expect(out.mism).toEqual([]); expect(out.n).toBeGreaterThan(1000);
  });
  it("dns mode takes its list from load_allowlist(ALLOWLIST_PATH) and defines no matching of its own", () => {
    const src = read("murage-egress-proxy.py");
    const dnsPart = src.slice(src.indexOf("# DNS mode (A2). A turn"), src.indexOf("def main("));
    expect(dnsPart).not.toMatch(/endswith\(|startswith\(|fnmatch|\.suffix|"\*\."/);
    expect(dnsPart).toContain("allowlist.allows(engine, host)");
    expect(dnsPart).toContain("normalize_host(");
    const main = src.slice(src.indexOf("def main("));
    expect(main.match(/load_allowlist\(path\)/g)).toHaveLength(1);
    expect(main).toContain("path = argv[0] if argv else ALLOWLIST_PATH");
    expect(dnsPart).not.toMatch(/getaddrinfo|create_connection|open_connection|\.connect\(/);
  });
  it("binds the listeners to loopback only", () => {
    const src = read("murage-egress-proxy.py");
    expect(src).toContain('LISTEN_HOST = "127.0.0.1"');
    expect(src).toMatch(/async def start_dns\(allowlist, log=None, host=LISTEN_HOST/);
    expect(src).not.toMatch(/0\.0\.0\.0/);
  });
  it.each([
    ["missing file", null], ["not JSON", "{nope"], ["unknown engine", '{"engines":{"nope":["a.com"]},"extra":[]}'], ["IP entry", '{"engines":{"codex":["1.2.3.4"]},"extra":[]}'], ["TLD wildcard", '{"engines":{"codex":["*.com"]},"extra":[]}'], ["infix wildcard", '{"engines":{"codex":["a.*.com"]},"extra":[]}'],
  ])("dns mode refuses to start: %s", (_name, text) => {
    const dir = mkdtempSync(join(tmpdir(), "egress-dns-"));
    try {
      const path = join(dir, "allow.json");
      if (text !== null) writeFileSync(path, text as string);
      const result = spawnSync("python3", ["-I", proxy, "dns", path], { encoding: "utf8", timeout: 10000 });
      expect(result.status).toBe(78); expect(result.stderr).toContain("refuses to start");
    } finally { removeTempDirSync(dir); }
  });
  it("serves over real loopback UDP sockets (ephemeral ports) with per-engine views and rate limiting", () => {
    const out = run(`
async def main():
    ports = {"claudeAgent": 0, "codex": 0}
    transports = await M["start_dns"](allow, M["RefusalLog"](emit=lambda l: None, prefix="dns"), ports=ports)
    bound = {t.get_extra_info("sockname")[1]: i for i, t in enumerate(transports)}
    names = list(ports)
    async def ask(port, pkt):
        loop = asyncio.get_running_loop(); fut = loop.create_future()
        class P(asyncio.DatagramProtocol):
            def datagram_received(s, d, a): fut.done() or fut.set_result(d)
        t, _ = await loop.create_datagram_endpoint(P, remote_addr=("127.0.0.1", port))
        t.sendto(pkt)
        try: return await asyncio.wait_for(fut, 2)
        except asyncio.TimeoutError: return None
        finally: t.close()
    p_claude, p_codex = [t.get_extra_info("sockname")[1] for t in transports]
    a = await ask(p_claude, query("api.anthropic.com")); b = await ask(p_codex, query("api.anthropic.com"))
    host = transports[0].get_extra_info("sockname")[0]
    for t in transports: t.close()
    bucket = M["TokenBucket"](100.0, 200.0, clock=lambda: 0.0)
    allowed = sum(1 for _ in range(500) if bucket.take())
    print(json.dumps({"a": parse(a)["an"], "b": parse(b)["rcode"], "host": host, "burst": allowed}))
asyncio.run(main())`);
    expect(out).toEqual({ a: 1, b: 3, host: "127.0.0.1", burst: 200 });
  });
  it("keeps DNS ports consecutive from 5310 and equal to the nft redirect and accept rules", () => {
    const nft = read("murage-egress.nft");
    const t = pyJson(`print(json.dumps({"dns": M["DNS_PORTS"], "base": M["DNS_BASE_PORT"], "engines": list(M["ENGINES"])}))`);
    expect(t.base).toBe(5310);
    expect(Object.fromEntries(t.engines.map((e: string, i: number) => [e, 5310 + i]))).toEqual(t.dns);
    const redirects = Object.fromEntries([...nft.matchAll(/meta skuid "murage-turn" meta skgid "murage-eng-(\w+)" ip daddr 127\.0\.0\.53 udp dport 53 counter redirect to :(\d+)$/gm)].map(m => [m[1], Number(m[2])]));
    const accepts = Object.fromEntries([...nft.matchAll(/meta skuid "murage-turn" meta skgid "murage-eng-(\w+)" ip daddr 127\.0\.0\.1 udp dport (\d+) ct status dnat ct original ip daddr 127\.0\.0\.53 counter accept$/gm)].map(m => [m[1], Number(m[2])]));
    expect(redirects).toEqual(t.dns); expect(accepts).toEqual(t.dns);
    expect(Object.keys(t.dns)).toHaveLength(14);
  });
  it("nft: no turn stub accept or tcp/53 accept, forwarder ports guarded early, murage-dns block closed", () => {
    const nft = read("murage-egress.nft");
    const out = nft.slice(nft.indexOf("chain output {"), nft.indexOf("chain input {"));
    const lines = out.split("\n").map(l => l.trim());
    expect(lines.map(l => l.replace(" ct original ip daddr 127.0.0.53", "")).filter(l => l.startsWith('meta skuid "murage-turn"') && /127\.0\.0\.53|dport 53 /.test(l) && l.endsWith("accept"))).toEqual([]);
    expect(lines.filter(l => /meta skuid "murage-turn".*tcp dport 53\b/.test(l))).toEqual([]);
    const udpGuard = lines.indexOf('meta skuid != "murage-turn" ip daddr 127.0.0.1 udp dport 5310-5323 counter drop');
    const tcpGuard = lines.indexOf('meta skuid != "murage-turn" ip daddr 127.0.0.1 tcp dport 5310-5323 counter drop');
    expect(udpGuard).toBeGreaterThan(-1); expect(tcpGuard).toBeGreaterThan(-1);
    const firstAccept = lines.findIndex(l => l.endsWith("accept"));
    expect(udpGuard).toBeLessThan(firstAccept); expect(tcpGuard).toBeLessThan(firstAccept);
    const meter = lines.findIndex(l => l.includes("update @engine_connections"));
    const dnsAccepts = lines.map((l, i) => [l, i] as const).filter(([l]) => /udp dport 53\d\d ct status dnat ct original ip daddr 127\.0\.0\.53 counter accept$/.test(l));
    expect(dnsAccepts).toHaveLength(14);
    // Provenance: every forwarder accept needs the nat redirect's conntrack state, so a packet sent
    // straight to 127.0.0.1:53NN (no dnat, original daddr 127.0.0.1) matches no accept and drops.
    for (const [l] of dnsAccepts) expect(l).toMatch(/^meta skuid "murage-turn" meta skgid "murage-eng-\w+" ip daddr 127\.0\.0\.1 udp dport 53\d\d ct status dnat ct original ip daddr 127\.0\.0\.53 counter accept$/);
    for (const [, i] of dnsAccepts) expect(i).toBeLessThan(meter);
    const dnsRules = lines.filter(l => l.startsWith('meta skuid "murage-dns"'));
    expect(dnsRules).toEqual(['meta skuid "murage-dns" oifname "lo" ct state established,related counter accept', 'meta skuid "murage-dns" counter drop']);
    expect(lines.indexOf('meta skuid "murage-turn" counter drop')).toBeGreaterThan(Math.max(...dnsAccepts.map(([, i]) => i)));
  });
  it("packages the DNS unit with the lifecycle binding and hardening, user, install and enable", () => {
    const unit = read("murage-egress-dns.service");
    for (const line of ["User=murage-dns", "BindsTo=murage-egress-proxy.service", "PartOf=murage-home.service", "Before=murage-home.service", "IPAddressDeny=any", "IPAddressAllow=localhost", "RestrictAddressFamilies=AF_INET", "RestartPreventExitStatus=78", "NoNewPrivileges=yes", "ProtectSystem=strict", "PrivateTmp=yes", "Restart=always", "WantedBy=murage-home.service", "ExecStart=/usr/bin/python3 -I /usr/local/libexec/murage-egress-proxy dns"]) expect(unit).toContain(line);
    expect(unit).toMatch(/^After=.*\bmurage-egress-proxy\.service\b/m);
    expect(unit).toMatch(/MemoryMax=\d+M/);
    expect(read("murage-home.service")).toMatch(/^Wants=.*\bmurage-egress-dns\.service\b/m);
    const build = read("build-image.sh");
    expect(build).toContain("useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin murage-dns");
    expect(build).toContain("install -m 0644 deploy/cloud-home/murage-egress-dns.service /etc/systemd/system/murage-egress-dns.service");
    expect(build).toMatch(/systemctl enable [^\n]*murage-egress-dns\.service/);
  });
  it("launcher keeps one nameserver line and the pasta dns-forward without -D", () => {
    const launcher = read("murage-turn-launch.py");
    expect(launcher).toContain('blobs["resolv"] = "nameserver " + PASTA_DNS + "\\n"');
    expect(launcher).toContain('PASTA_DNS = "192.0.2.53"');
    expect(launcher).toMatch(/"--dns-forward", PASTA_DNS,/);
    expect(launcher).not.toMatch(/^\s*"-D",/m);
    expect(launcher).not.toMatch(/"search |\bsearch \S+\\n/);
  });
});
