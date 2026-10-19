// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
const source = (name: string) => readFileSync(new URL(`../../deploy/cloud-home/${name}`, import.meta.url), "utf8");
const helper = fileURLToPath(new URL("../../deploy/cloud-home/murage-browser-network.py", import.meta.url));
const policy = fileURLToPath(new URL("../../deploy/cloud-home/murage-egress.nft", import.meta.url));
// Actual pure adapter/loader; all ip/nft operations are captured fake argv. No
// host networking, namespace creation, nft kernel access or root needed.
it("validates routes and builds one atomic reload preserving stateful buckets", () => {
 const script = String.raw`
import contextlib, copy, importlib.util, json, sys
spec=importlib.util.spec_from_file_location("network",sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
policy=open(sys.argv[2]).read()
class Fake:
 def __init__(self):
  self.links=[{"ifname":"eth0","ifindex":2,"link_type":"ether"}]
  self.routes=[{"dst":"default","dev":"eth0"},{"dst":"203.0.113.0/24","dev":"eth0"}]
  self.addresses=[{"ifname":"eth0","addr_info":[{"family":"inet","local":"203.0.113.5","prefixlen":24}]}]
  self.calls=[]; self.inventory={"nftables":[]}
 def json(self,*args):
  assert args in (("-details","link","show"),("-4","route","show","table","all"),("-4","address","show"))
  return copy.deepcopy(self.links if "link" in args else self.routes if "route" in args else self.addresses)
 def run(self,argv,**kw):
  self.calls.append((argv,kw))
  if argv==["/usr/sbin/nft","-j","list","ruleset"]: return json.dumps(self.inventory).encode()
  assert argv==["/usr/sbin/nft","-f","-"]
  return b""
f=Fake(); context=m.network_context(f); assert context=={"dev":"eth0","index":2,"addresses":["203.0.113.5"]}
# Both iproute2 spellings of the default are excluded from pool overlap.
f.routes[0]["dst"]="0.0.0.0/0"
assert m.network_context(f)==context
f.routes[0]["dst"]="default"
# The default route is intentionally excluded from pool-overlap checks.
f.links.append({"ifname":"mbh1","ifindex":3,"ifalias":"murage-browser:bot:"+"a"*32})
f.routes.append({"dst":"10.253.0.4/30","dev":"mbh1"})
f.addresses.append({"ifname":"mbh1","addr_info":[{"family":"inet","local":"10.253.0.5","prefixlen":30}]})
assert m.network_context(f)==context
for change in (lambda x:x.routes.append({"dst":"default","dev":"eth0"}), lambda x:x.routes.append({"dst":"10.0.0.0/8","dev":"eth0"}), lambda x:x.addresses.append({"ifname":"eth1","addr_info":[{"family":"inet","local":"10.253.4.1","prefixlen":24}]}), lambda x:x.links[0].update(linkinfo={"info_kind":"bridge"}), lambda x:x.routes[0].update(nhid=5), lambda x:x.links[1].update(ifalias="unowned")):
 bad=copy.deepcopy(f); change(bad)
 try: m.network_context(bad); raise AssertionError("bad inventory accepted")
 except ValueError: pass
@contextlib.contextmanager
def registry(c):
 assert c==context
 yield [("mbh1","10.253.0.6"),("mbh2","10.253.0.10")]
m.load_firewall(f,policy,registry)
batch=f.calls[-1][1]["input"].decode()
assert len(f.calls)==2 and "flush ruleset" not in batch and "delete table" not in batch
assert batch.count("add limit inet murage_home smtp_new_home")==1
assert batch.count('limit name "smtp_new_home"')==2
assert '"mbh1" . 10.253.0.6' in batch and '"mbh2" . 10.253.0.10' in batch
assert batch.count("flush set inet murage_home browser_active")==1
assert batch.count("flush set ip murage_browser_nat browser_active")==1
# Follow the emitted OUTPUT/FORWARD references using one fake named object.
# This proves shared object wiring, not the kernel token-bucket implementation.
import re
references={}
for chain in ("output","browser_public"):
 line=next(line for line in batch.splitlines() if line.startswith("add rule inet murage_home "+chain+" ") and "tcp dport 587 limit name" in line)
 references[chain]=re.search(r'limit name "([^"]+)"',line).group(1)
assert references=={"output":"smtp_new_home","browser_public":"smtp_new_home"}
allowance={"smtp_new_home":30}
sequence=[("output",None),("browser_public","mbh1"),("browser_public","mbh2")]*11
accepted=[]
for chain,bot in sequence:
 name=references[chain]
 accepted.append(allowance[name]>0)
 if allowance[name]>0: allowance[name]-=1
assert sum(accepted)==30 and accepted[-3:]==[False,False,False]

# Represent every declared object as already installed on a second reload.
for kind,identity,body in m.blocks(policy):
 family,table=identity.split(); f.inventory["nftables"].append({"table":{"family":family,"name":table}})
 for kind,name,definition in m.blocks(body):
  f.inventory["nftables"].append({kind:{"family":family,"table":table,"name":name}})
m.load_firewall(f,policy,registry)
reload=f.calls[-1][1]["input"].decode()
assert "add limit " not in reload and "add set " not in reload
assert "flush chain inet murage_home output" in reload
assert not any("flush set" in line and any(n in line for n in ("browser_new_bot","browser_connections","uid_connections","cp_endpoints")) for line in reload.splitlines())
for pairs in ([("mbh1","10.253.0.10")],[("eth0","10.253.0.6")]):
 try: m.firewall_batch(policy,{},context,pairs); raise AssertionError("bad tuple accepted")
 except ValueError: pass
# An invalid/dead registry must fail before any mutation.
@contextlib.contextmanager
def dead(c):
 raise ValueError("dead task")
 yield []
before=len(f.calls)
try: m.load_firewall(f,policy,dead); raise AssertionError("dead registry accepted")
except ValueError: pass
assert len(f.calls)==before
print("network fake passed")
`;
 const result = spawnSync("python3", ["-c", script, helper, policy], { encoding: "utf8", timeout: 5000 });
 expect(result.stderr).toBe(""); expect(result.status).toBe(0); expect(result.stdout).toBe("network fake passed\n");
});
it("denies host, cross-bot, spoofed, private, IPv6 and nonresolver DNS before established", () => {
 const nft=source("murage-egress.nft");
 const forward=nft.slice(nft.indexOf("chain browser_forward"), nft.indexOf("chain browser_public"));
 for (const rule of ['type filter hook forward priority -10; policy drop;', 'iifname "mbh*" oifname "mbh*" counter drop', 'iifname . ip saddr != @browser_active counter drop', 'oifname . ip daddr != @browser_active counter drop', 'ip daddr @browser_non_global counter drop', 'ip daddr @browser_host_addresses counter drop', 'meta nfproto ipv6 counter drop', 'tcp dport { 25, 465 } counter drop', 'udp dport 53 ip daddr != @browser_resolvers counter drop', 'tcp dport 53 ip daddr != @browser_resolvers counter drop']) {
  expect(forward).toContain(rule); expect(forward.indexOf(rule)).toBeLessThan(forward.indexOf("ct state established,related"));
 }
 expect(nft).toContain('iifname "mbh*" counter drop');
 expect(nft).toContain('iifname . ip saddr @browser_active oifname @browser_outbound counter masquerade');
 expect(nft).toContain("600/minute burst 300 packets"); expect(nft).toContain("rate over 3000/minute burst 600 packets");
 expect(nft.match(/limit name "smtp_new_home"/g)).toHaveLength(2);
 expect(nft.match(/rate over 30\/hour/g)).toHaveLength(1);
 expect(nft).toContain("elements = { 1.1.1.1, 9.9.9.9 }");
 for (const range of ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4"]) expect(nft).toContain(range);
});
it("enables forwarding only after root atomic firewall installation", () => {
 const unit=source("murage-egress.service");
 expect(unit).toContain("ExecStart=/usr/bin/python3 -I /usr/local/libexec/murage-browser-network");
 expect(unit).toContain("ExecReload=/usr/bin/python3 -I /usr/local/libexec/murage-browser-network");
 expect(unit).toContain("ExecStartPost=/usr/sbin/sysctl -w net.ipv4.ip_forward=1");
 expect(unit.indexOf("ExecStartPost=")).toBeGreaterThan(unit.indexOf("ExecStart="));
 const loader=source("murage-browser-network.py");
 expect(loader).toContain('HELPER = "/usr/local/libexec/murage-browser-namespace"');
 expect(loader).toContain("module.firewall_registry"); expect(loader).not.toContain("sysctl");
});
