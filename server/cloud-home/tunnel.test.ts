// SPDX-License-Identifier: AGPL-3.0-or-later
// Cloud homes are reached only through an outbound Cloudflare Tunnel. Text
// assertions over the deploy files plus one behavioural run of murage-enroll --tunnel.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";

const read = (name: string) => readFileSync(new URL(`../../deploy/cloud-home/${name}`, import.meta.url), "utf8");
const nft = read("murage-egress.nft");
const output = nft.slice(nft.indexOf("chain output {"), nft.indexOf("chain input {"));
const outLines = output.split("\n").map(line => line.trim());
const input = nft.slice(nft.indexOf("chain input {"), nft.indexOf("chain browser_input {"));

describe("no inbound service port", () => {
  it("accepts nothing on tcp 80, tcp 443 or udp 443 at the host input", () => {
    expect(input).not.toMatch(/dport\s*(\{[^}]*\b(80|443)\b[^}]*\}|80\b|443\b)/);
    expect(input).toContain("policy drop");
    expect(input).toContain('iifname "lo" counter accept');
  });
  it("opens no 80/443 in the build host firewall of a managed-endpoint home", () => {
    const driver = read("qualify/hz-live.py");
    expect(driver).toContain("rules = [] if managed_endpoint else [");
    expect(driver).toContain('--managed-endpoint');
  });
});

describe("tunnel uid network rules", () => {
  const rules = outLines.filter(line => line.startsWith('meta skuid "murage-tunnel"'));
  it("allows only stub DNS, tcp/udp 7844, tcp 443 and 127.0.0.1:8830, then drops everything else", () => {
    expect(rules.at(-1)).toBe('meta skuid "murage-tunnel" counter drop');
    expect(rules.filter(line => line.endsWith("accept"))).toEqual([
      'meta skuid "murage-tunnel" ip daddr 127.0.0.53 udp dport 53 counter accept',
      'meta skuid "murage-tunnel" ip daddr 127.0.0.53 tcp dport 53 counter accept',
      'meta skuid "murage-tunnel" ip daddr 127.0.0.1 tcp dport 8830 counter accept',
      'meta skuid "murage-tunnel" tcp dport { 443, 7844 } counter accept',
      'meta skuid "murage-tunnel" udp dport 7844 counter accept',
    ]);
  });
  it("drops other loopback and the host's own addresses before the public accepts", () => {
    const index = (line: string) => outLines.indexOf(line);
    const publicAccept = index('meta skuid "murage-tunnel" tcp dport { 443, 7844 } counter accept');
    for (const drop of ['meta skuid "murage-tunnel" ip daddr 127.0.0.0/8 counter drop', 'meta skuid "murage-tunnel" ip6 daddr ::1 counter drop', 'meta skuid "murage-tunnel" fib daddr type local counter drop']) {
      expect(index(drop)).toBeGreaterThan(index('meta skuid "murage-tunnel" ip daddr 127.0.0.1 tcp dport 8830 counter accept'));
      expect(index(drop)).toBeLessThan(publicAccept);
    }
  });
  it("keeps private, CGNAT, link-local and metadata dropped for the tunnel uid ahead of its accepts", () => {
    const first = outLines.indexOf(rules[0]);
    expect(outLines.indexOf('meta skuid != 0 ip daddr 169.254.169.254 counter drop')).toBeLessThan(first);
    expect(outLines.findIndex(line => line.startsWith('meta skuid != { 0, "murage" } ip daddr { 10.0.0.0/8'))).toBeLessThan(first);
    expect(outLines.findIndex(line => line.startsWith('meta skuid != { 0, "murage" } ip6 daddr { fc00::/7'))).toBeLessThan(first);
  });
  it("is not exempt from, and not starved by, the generic per-uid new-connection meter", () => {
    const meter = outLines.find(line => line.includes("update @uid_connections"))!;
    expect(meter).toContain('oifname != "lo"');
    expect(meter).not.toContain("murage-tunnel");
    // Loopback hops to Caddy are outside the meter; external flows are few and long-lived.
    expect(outLines.indexOf(meter)).toBeLessThan(outLines.indexOf(rules[0]));
    const [, rate, burst] = meter.match(/over (\d+)\/minute burst (\d+) packets/)!;
    expect(Number(rate) + Number(burst)).toBeGreaterThanOrEqual(300);
  });
  it("lets only root and murage-tunnel connect to Caddy's port, ahead of every per-uid accept", () => {
    const rule = 'meta skuid != { 0, "murage-tunnel" } fib daddr type local tcp dport 8830 counter drop';
    expect(outLines).toContain(rule);
    const firstAccept = outLines.findIndex(line => line.endsWith("accept"));
    expect(outLines.indexOf(rule)).toBeLessThan(firstAccept);
    expect(nft.match(/dport 8830/g)!.length).toBe(2);
  });
  it("stays within the grammar murage-browser-network accepts (comment-free rules in the output chain)", () => {
    for (const line of rules) expect(line).toMatch(/^meta skuid "murage-tunnel" [A-Za-z0-9 ./:{},"_-]+$/);
    expect(nft).not.toContain("#!");
  });
});

describe("Caddy is a local plain-HTTP hop", () => {
  const caddy = read("Caddyfile");
  it("listens only on 127.0.0.1:8830 with automatic HTTPS off and no ACME", () => {
    expect(caddy).toMatch(/^\tauto_https off$/m);
    // No host in the site address (a host there matched only that literal Host and let
    // every other request fall through to an empty 200 on a real home); `bind` pins the listener.
    expect(caddy).toMatch(/^http:\/\/:8830 \{\n\tbind 127\.0\.0\.1$/m);
    expect(caddy).not.toMatch(/^http:\/\/127\.0\.0\.1:8830 \{$/m);
    expect(caddy).toMatch(/^\tbind 127\.0\.0\.1$/m);
    expect(caddy.replace(/^\s*#.*$/gm, "")).not.toMatch(/:(80|443)\b|https:\/\/|MURAGE_PUBLIC_ORIGIN|\bacme\b|\btls\b/);
  });
  it("trusts loopback and takes the visitor from Cf-Connecting-Ip, setting what the server reads", () => {
    expect(caddy).toContain("trusted_proxies static 127.0.0.0/8 ::1/128");
    expect(caddy).toContain("client_ip_headers Cf-Connecting-Ip");
    expect(caddy).toContain("header_up X-Forwarded-For {client_ip}");
    expect(caddy).toContain("header_up X-Forwarded-Host {$MURAGE_PUBLIC_HOST}");
    expect(caddy).toContain("header_up X-Forwarded-Proto https");
    const auth = readFileSync(fileURLToPath(new URL("../cloud-request-auth.ts", import.meta.url)), "utf8");
    expect(auth).toContain('req.headers["x-forwarded-host"]'); expect(auth).toContain('req.headers["x-forwarded-for"]');
  });
  it("routes /hooks/* and the unix socket, keeps the security headers, and 404s other hosts", () => {
    expect(caddy).toContain("@public host {$MURAGE_PUBLIC_HOST}");
    expect(caddy).toContain("reverse_proxy 127.0.0.1:{$WEBHOOK_PORT}");
    expect(caddy).toContain("reverse_proxy unix//data/proxy/murage.sock");
    for (const header of ['Strict-Transport-Security "max-age=31536000"', 'X-Content-Type-Options "nosniff"', 'X-Frame-Options "DENY"', 'Referrer-Policy "no-referrer"', "-Server", "-Via"]) expect(caddy).toContain(header);
    expect(caddy).toContain('respond "Not found" 404');
  });
  it("proxy unit needs no capability and derives the public host from the origin", () => {
    const unit = read("murage-proxy.service");
    expect(unit).not.toContain("CAP_NET_BIND_SERVICE");
    expect(unit).toMatch(/^CapabilityBoundingSet=$/m); expect(unit).toMatch(/^AmbientCapabilities=$/m);
    expect(unit).toContain("MURAGE_PUBLIC_HOST=");
    expect(unit).toContain("--config /etc/murage-home/Caddyfile --adapter caddyfile");
  });
});

describe("cloudflared in the image", () => {
  const build = read("build-image.sh");
  it("pins the version and digest of the desktop app and fails the build on a mismatch", () => {
    const prepare = readFileSync(fileURLToPath(new URL("../../scripts/prepare-cloudflared.mjs", import.meta.url)), "utf8");
    const readme = readFileSync(fileURLToPath(new URL("../../third_party/cloudflared/README.md", import.meta.url)), "utf8");
    const version = build.match(/^cloudflared_version=(\S+)$/m)![1], digest = build.match(/cloudflared_sha256_by_arch=\(\[x86_64\]=([0-9a-f]{64}) /)![1];
    const armDigest = build.match(/cloudflared_sha256_by_arch=\(\[x86_64\]=[0-9a-f]{64} \[aarch64\]=([0-9a-f]{64})\)/)![1];
    expect(build).toMatch(/^cloudflared_sha256=\$\{cloudflared_sha256_by_arch\[\$machine\]\}$/m);
    expect(prepare).toContain(armDigest); expect(readme).toContain(armDigest);
    expect(prepare).toContain(`CLOUDFLARED_VERSION = "${version}"`);
    expect(prepare).toContain(digest); expect(readme).toContain(digest);
    expect(build).toContain('cloudflared-linux-$cloudflared_arch" -o "$stage/cloudflared"');
    expect(build).toContain(`printf '%s  %s\\n' "$cloudflared_sha256" "$stage/cloudflared" | sha256sum -c -`);
    expect(build.indexOf("sha256sum -c -", build.indexOf("cloudflared_sha256"))).toBeLessThan(build.indexOf("murage-cloudflared"));
    expect(build).toContain('install -o root -g root -m 0755 "$stage/cloudflared" /usr/local/libexec/murage-cloudflared');
    expect(build).toContain("useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin murage-tunnel");
    expect(build).toContain("install -m 0644 deploy/cloud-home/murage-tunnel.service /etc/systemd/system/murage-tunnel.service");
    expect(build).toMatch(/^systemctl enable murage-tunnel-token\.service$/m);
    expect(build).not.toMatch(/systemctl enable [^\n]*murage-tunnel\.service/);
  });
});

describe("tunnel units", () => {
  const unit = read("murage-tunnel.service"), token = read("murage-tunnel-token.service");
  it("runs cloudflared as murage-tunnel, hardened, with the token only from a file on /run", () => {
    expect(unit).toContain("ExecStart=/usr/local/libexec/murage-cloudflared tunnel --no-autoupdate --loglevel info run --token-file /run/murage-tunnel/token");
    expect(unit).not.toMatch(/TUNNEL_TOKEN|--token\b(?!-file)|EnvironmentFile/);
    for (const line of ["User=murage-tunnel", "NoNewPrivileges=yes", "ProtectSystem=strict", "PrivateTmp=yes", "ProtectHome=yes", "Restart=always", "CapabilityBoundingSet=", "AmbientCapabilities=",
      "RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK", "After=network-online.target murage-egress.service murage-proxy.service", "ConditionPathExists=/run/murage-tunnel/token"]) expect(unit).toContain(line);
    expect(unit).toMatch(/^MemoryMax=\d+M$/m);
    expect(unit).not.toMatch(/^\[Install\]/m);
  });
  it("is started by a root oneshot that fetches the token through murage-enroll after enrollment", () => {
    expect(token).toContain("ExecStart=/usr/bin/python3 -I /usr/local/libexec/murage-enroll --tunnel");
    expect(token).toContain("Requires=murage-volume.service murage-egress.service");
    expect(token).toMatch(/^Type=oneshot$/m); expect(token).toMatch(/^Restart=on-failure$/m); expect(token).toMatch(/^WantedBy=multi-user\.target$/m);
    expect(token).not.toMatch(/token-file|TUNNEL_TOKEN/);
    const enroll = read("murage-enroll");
    expect(enroll).toContain('TUNNEL_RUNTIME = "/run/murage-tunnel"');
    expect(enroll).toContain("os.fchmod(stream.fileno(), 0o400)");
    expect(enroll).toContain('"/usr/bin/systemctl", "restart", "--no-block", "murage-tunnel.service"');
    expect(enroll).not.toMatch(/print\([^)]*token/i);
  });
});

describe("murage-enroll --tunnel", () => {
  const program = fileURLToPath(new URL("../../deploy/cloud-home/murage-enroll", import.meta.url));
  const driver = `import importlib.machinery,importlib.util,json,os,stat,sys
loader=importlib.machinery.SourceFileLoader("enroll_fixture",sys.argv[1]);spec=importlib.util.spec_from_loader(loader.name,loader)
m=importlib.util.module_from_spec(spec);loader.exec_module(m)
state,config,runtime,scenario=sys.argv[2:6]
calls=[];started=[];ticks=[0]
ready={"endpoint":{"url":"https://abc.homes.example.dev","hostname":"abc.homes.example.dev","status":"ready","generation":1},"connectorToken":"eyJhIjoiYWNjb3VudCIsInQiOiJ0dW5uZWwiLCJzIjoic2VjcmV0In0="}
def post(admin,home,op,body,credential=None,timeout=15):
    calls.append((admin,home,op,body,credential))
    n=len(calls)
    if scenario=="busy" and n<2: raise m.EndpointRefused(409,"endpoint_busy",2)
    if scenario=="limited" and n<2: raise m.EndpointRefused(429,"rate_limited",None)
    if scenario=="unavailable" and n<2: raise m.EndpointRefused(502,"endpoint_unavailable",None)
    if scenario.startswith("final"): raise m.EndpointRefused(int(scenario[5:8]),scenario[9:] or None,None)
    if scenario=="slow" and n<3: return {"endpoint":dict(ready["endpoint"],status="provisioning")}
    if scenario=="flaky" and n<2: raise ValueError("Enrollment response refused")
    if scenario=="never": return {"endpoint":dict(ready["endpoint"],status="provisioning")}
    if scenario=="wronghost": return {"endpoint":dict(ready["endpoint"],hostname="evil.example.dev"),"connectorToken":ready["connectorToken"]}
    if scenario=="badtoken": return {"endpoint":ready["endpoint"],"connectorToken":"not a token!"}
    return ready
try:
    m.tunnel(state,config,expected_uid=os.getuid(),allow_http=True,runtime=runtime,user=__import__("pwd").getpwuid(os.getuid()).pw_name,
             monotonic=lambda:ticks[0],sleep=lambda d:ticks.__setitem__(0,ticks[0]+d),post=post,start=lambda:started.append(1))
    ok=True
except Exception as e:
    ok=False
path=runtime+"/token"
info={"ok":ok,"calls":len(calls),"started":len(started),"op":calls[0][2] if calls else None,"auth":calls[0][4] if calls else None,"body":calls[0][3] if calls else None,"slept":ticks[0]}
if os.path.exists(path):
    st=os.stat(path);info.update(mode=stat.S_IMODE(st.st_mode),uid_ok=st.st_uid==os.getuid(),token=open(path).read().strip())
print(json.dumps(info))`;
  function run(scenario: string) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "murage-tunnel-"))); // enrollment walks with O_NOFOLLOW; macOS temp sits behind /var
    try {
      const state = join(root, "state"), config = join(root, "config"), runtime = join(root, "run");
      mkdirSync(state, { mode: 0o700 }); mkdirSync(config, { mode: 0o700 }); chmodSync(state, 0o700); chmodSync(config, 0o700);
      const credential = Buffer.alloc(32, 7).toString("base64");
      writeFileSync(join(state, "credential"), credential + "\n", { mode: 0o600 }); writeFileSync(join(state, "generation"), "1\n", { mode: 0o600 });
      writeFileSync(join(config, "home.env"), "MURAGE_CLOUD_ROLE=home\nMURAGE_CLOUD_MACHINE_ID=home-1\nMURAGE_CLOUD_ADMIN_URL=http://127.0.0.1:1\nMURAGE_PUBLIC_ORIGIN=https://abc.homes.example.dev\n", { mode: 0o600 });
      const result = spawnSync("python3", ["-I", "-c", driver, program, state, config, runtime, scenario], { encoding: "utf8", timeout: 20000 });
      expect(result.status).toBe(0);
      return { info: JSON.parse(result.stdout), credential, stdout: result.stdout + result.stderr, runtime };
    } finally { removeTempDirSync(root); }
  }
  it("authenticates with the machine credential, writes a 0400 token and starts the tunnel", () => {
    const r = run("ready");
    expect(r.info).toMatchObject({ ok: true, calls: 1, started: 1, op: "endpoint", auth: r.credential, body: { generation: 1 }, mode: 0o400, uid_ok: true });
    expect(r.info.token).toBe("eyJhIjoiYWNjb3VudCIsInQiOiJ0dW5uZWwiLCJzIjoic2VjcmV0In0=");
  });
  it("retries with backoff while provisioning or failing, then succeeds", () => {
    expect(run("slow").info).toMatchObject({ ok: true, calls: 3, started: 1, slept: 15 });
    expect(run("flaky").info).toMatchObject({ ok: true, calls: 2, started: 1 });
  });
  it("fails closed within a bounded budget: no token file, no tunnel start", () => {
    const r = run("never");
    expect(r.info).toMatchObject({ ok: false, started: 0 }); expect(r.info.token).toBeUndefined();
    expect(r.info.slept).toBeLessThanOrEqual(30 * 60); expect(r.info.calls).toBeGreaterThan(8); expect(r.info.calls).toBeLessThanOrEqual(16); // well under 20 reconciles/hour
  });
  it("retries 409 endpoint_busy (honouring retry-after), 502 and 429 (minutes, not seconds)", () => {
    expect(run("busy").info).toMatchObject({ ok: true, calls: 2, started: 1 });
    expect(run("unavailable").info).toMatchObject({ ok: true, calls: 2, started: 1, slept: 5 });
    expect(run("limited").info).toMatchObject({ ok: true, calls: 2, started: 1, slept: 600 });
  });
  it.each(["final409_stale_generation", "final409_home_inactive", "final401", "final403", "final404"])("stops without a token on %s", scenario => {
    const r = run(scenario);
    expect(r.info).toMatchObject({ ok: false, calls: 1, started: 0 }); expect(r.info.token).toBeUndefined();
  });
  it.each(["wronghost", "badtoken"])("refuses a %s response without writing the token", scenario => {
    const r = run(scenario);
    expect(r.info.ok).toBe(false); expect(r.info.started).toBe(0); expect(r.info.token).toBeUndefined();
    expect(r.stdout).not.toContain("not a token");
  });
});
