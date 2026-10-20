// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";
const program = fileURLToPath(new URL("../../deploy/cloud-home/murage-enroll", import.meta.url));
// Protocol: imports the actual helper/boot CLI. Fake CP is already exercised by
// enroll.test.ts; here unwrap returns the same synthetic shape. Only block-device
// discovery, stat and privileged command transport are modeled. The actual
// zero sampling (edges + seeded random blocks) reads a disposable file. Commands retain args/stdin separately.
const wrapper = `import importlib.machinery,importlib.util,json,os,sys,stat,types
loader=importlib.machinery.SourceFileLoader("q04",sys.argv[1]);spec=importlib.util.spec_from_loader(loader.name,loader);m=importlib.util.module_from_spec(spec);loader.exec_module(m)
root,scenario=sys.argv[2:4];config=root;disk=root+"/disk";device="/dev/disk/by-id/scsi-0HC_Volume_201";mapper="/dev/mapper/murage-data";commands=[]
v={"provider":"hetzner","id":"201","device":device,"new":scenario!="existing-blank","homeId":"home-test","generation":1}
if scenario=="vultr":
 device="/dev/disk/by-id/virtio-mount201";v.update(provider="vultr",id="resource201",device=device)
if scenario=="generation":v["generation"]=2
if scenario=="identity":v["device"]="/dev/sda"
if scenario=="home":v["homeId"]="other"
with open(root+"/volume.json","w") as f:json.dump(v,f)
os.chmod(root+"/volume.json",0o600)
with open(disk,"wb") as f:f.write(b"X" if scenario=="nonempty" else b"\\0"*8192)
realpath,exists,stat_fn=m.os.path.realpath,m.os.path.exists,m.os.stat
m.os.path.realpath=lambda p:disk if p==device else "/dev/dm-0" if p==mapper and scenario=="restart-alias" else realpath(p)
device_checks=[];ticks=[0]
def device_exists(p):
 if p==device:
  device_checks.append(p)
  return ticks[0]>=3 if scenario=="delayed-device" else scenario!="missing-device"
 return (scenario in ("restart","restart-alias","restart-wrong-label","wrong-mapping")) if p==mapper else exists(p)
m.os.path.exists=device_exists
wait=m.wait_exact_device
m.wait_exact_device=lambda p:wait(p,sleep=lambda _:ticks.__setitem__(0,ticks[0]+1),monotonic=lambda:ticks[0])
m.os.stat=lambda p:types.SimpleNamespace(st_mode=stat.S_IFBLK) if p==disk and scenario!="not-block" else stat_fn(p)
m.enroll=lambda *a:None
m.unwrap=lambda *a:({"volumeKey":"AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM="},"home-test",1)
def command(args,key=None):
 commands.append({"args":args,"keyStdin":key.hex() if key else None})
 if "lsblk" in args[0]:
  assert "--tree" in args
  block={"path":disk,"type":"disk","serial":"wrong" if scenario=="serial" else "mount201" if scenario=="vultr" else "201","mountpoints":[]}
  if scenario=="partition":block["children"]=[{"type":"part","path":"/dev/sdb1"}]
  if scenario in ("restart","restart-wrong-label"):block["children"]=[{"type":"crypt","path":mapper,"mountpoints":["/data"]}]
  if scenario=="restart-alias":block["children"]=[{"type":"crypt","path":"/dev/dm-0","mountpoints":["/data"]}]
  return json.dumps({"blockdevices":[block]})
 luks=lambda off,u="b7c5":{"type":"crypto_LUKS","offset":off,"uuid":u,"label":"murage-data-luks"}
 # Real LUKS2 (seen on a rebooted CX23 home) reports the primary and secondary header.
 sigs={"foreign":[{"type":"ext4","offset":"0x438"}],"existing":[luks("0x0"),luks("0x4000")],"existing-one-header":[luks("0x0")],
  "wrong-label":[luks("0x0"),luks("0x4000")],"bad-header":[luks("0x0"),luks("0x4000")],"two-luks":[luks("0x0"),luks("0x4000","other")],
  "luks-and-fs":[luks("0x0"),{"type":"ext4","offset":"0x438"}],"luks-not-at-start":[luks("0x4000")]}
 if "wipefs" in args[0]:return json.dumps({"signatures":sigs.get(scenario,[])})
 if "luksDump" in args:return json.dumps({} if scenario=="bad-header" else {"keyslots":{}})
 if "status" in args:return "device: "+("/dev/sda" if scenario=="wrong-mapping" else disk)+"\\ntype: LUKS2"
 if "blkid" in args[0]:
  if args[-1]==device:return "foreign" if scenario in ("wrong-label","restart-wrong-label") else "murage-data-luks"
  if "TYPE" in args:return "xfs" if scenario=="filesystem" else "ext4"
  return "other" if scenario=="filesystem-label" else "murage-data"
 if scenario=="command-error":raise ValueError("synthetic-private-output")
 return ""
m.command=command
boot=m.boot;m.boot=lambda:boot(config=config,expected_uid=os.getuid());m.os.geteuid=lambda:0
sys.argv=[sys.argv[1],"--boot"]
try:m.main();code=0
except m.DeviceReadinessExpired:code=78
except Exception:code=1
print(json.dumps({"code":code,"commands":commands,"deviceChecks":device_checks,"ticks":ticks[0]}));sys.exit(code)
`;
function run(scenario: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "q04-volume-")));
  try {
    const result = spawnSync("python3", ["-I", "-c", wrapper, program, root, scenario], { encoding: "utf8" });
    expect(result.stderr.split("\n").filter(l => l && !l.startsWith("murage-enroll: volume sample "))).toEqual([]); return {status:result.status,...JSON.parse(result.stdout)};
  } finally { removeTempDirSync(root); }
}
it("actual boot formats only a proven zero new intended block device and keys only on stdin", () => {
  const result = run("new"); expect(result.status).toBe(0);
  const commands = result.commands as Array<{args:string[];keyStdin:string|null}>;
  expect(commands.filter(row => row.args.includes("luksFormat"))).toHaveLength(1);
  expect(commands.filter(row => row.args[0].endsWith("mkfs.ext4"))).toHaveLength(1);
  for (const row of commands.filter(row => row.args.includes("luksFormat") || row.args.includes("open"))) {
    expect(row.keyStdin).toBe("03".repeat(32)); expect(row.args).toContain("-"); expect(JSON.stringify(row.args)).not.toContain("AwMD");
  }
  expect(commands.findIndex(row => row.args.includes("luksFormat"))).toBeLessThan(commands.findIndex(row => row.args.includes("open")));
});
it.each(["existing", "existing-one-header", "restart", "restart-alias"])("%s verifies identity and filesystem without formatting", scenario => {
  const result = run(scenario); expect(result.status).toBe(0);
  expect(result.commands.some((row:{args:string[]}) => row.args.includes("luksFormat") || row.args[0].endsWith("mkfs.ext4"))).toBe(false);
  if (scenario.startsWith("restart")) expect(result.commands.some((row:{args:string[]}) => row.args.includes("--test-passphrase"))).toBe(true);
});
it("Vultr binds trusted mount_id device serial separately from API resource id", () => expect(run("vultr").status).toBe(0));
it("waits for only the exact intended device before existing identity and format checks", () => {
  const result = run("delayed-device"); expect(result.status).toBe(0); expect(result.ticks).toBe(3);
  expect(new Set(result.deviceChecks)).toEqual(new Set(["/dev/disk/by-id/scsi-0HC_Volume_201"]));
  expect(result.commands[0].args[0]).toBe("/usr/bin/lsblk");
});
it("exact-device timeout exits 78 without discovery, alternate disk or formatting", () => {
  const result = run("missing-device"); expect(result.status).toBe(78); expect(result.ticks).toBe(120);
  expect(result.commands).toEqual([]); expect(new Set(result.deviceChecks)).toEqual(new Set(["/dev/disk/by-id/scsi-0HC_Volume_201"]));
});
it.each(["generation", "identity", "home", "serial", "partition", "not-block", "existing-blank", "nonempty", "foreign", "wrong-label", "bad-header", "wrong-mapping", "two-luks", "luks-and-fs", "luks-not-at-start"])("refuses %s before any destructive operation", scenario => {
  const result = run(scenario); expect(result.status).toBe(1);
  expect(result.commands.some((row:{args:string[]}) => row.args.includes("luksFormat") || row.args[0].endsWith("mkfs.ext4"))).toBe(false);
});
it("refuses restart-wrong-label before any destructive operation", () => {
  const result = run("restart-wrong-label");
  // Check non-formatting even in the expected RED run before asserting refusal.
  expect(result.commands.some((row:{args:string[]}) => row.args.includes("luksFormat") || row.args[0].endsWith("mkfs.ext4"))).toBe(false);
  expect(result.commands.some((row:{args:string[]}) => row.args.includes("status"))).toBe(true);
  expect(result.status).toBe(1);
});
it.each(["filesystem", "filesystem-label", "command-error"])("refuses %s without boot success", scenario => expect(run(scenario).status).toBe(1));
it("unit graph unlocks before mount without cloud-final/startup cycles, preserving failed required mount propagation", () => {
  const read = (name:string) => readFileSync(new URL(`../../deploy/cloud-home/${name}`, import.meta.url), "utf8");
  const mount=read("data.mount"),volume=read("murage-volume.service");
  expect(mount).toContain("What=/dev/mapper/murage-data"); expect(mount).toContain("Requires=murage-volume.service"); expect(mount).toContain("After=murage-volume.service");
  expect(volume).toContain("Before=data.mount"); expect(volume).toContain("DefaultDependencies=no"); expect(mount).toContain("DefaultDependencies=no");
  expect(volume).toContain("After=network-online.target cloud-config.service"); expect(volume).not.toMatch(/After=.*(?:cloud-final|data.mount|murage-home|murage-proxy)/);
  expect(volume).toContain("ExecStart=/usr/local/libexec/murage-enroll --boot");
  for (const name of ["murage-home.service","murage-proxy.service"]) expect(read(name)).toMatch(/^Requires=.*data.mount/m);
  // A rebooted home must come back unattended: the image enables the whole chain.
  const image = readFileSync(fileURLToPath(new URL("../../deploy/cloud-home/build-image.sh", import.meta.url)), "utf8");
  expect(image).toMatch(/^systemctl enable murage-home\.service murage-proxy\.service murage-egress-proxy\.service$/m);
  for (const name of ["murage-home.service","murage-proxy.service","murage-egress-proxy.service"]) expect(read(name)).toMatch(/^WantedBy=multi-user\.target$/m);
  expect(read("start-home.sh")).not.toContain("--boot");
});
// Sampling check: sparse 300 MiB file. Clean passes; a non-zero byte in the last
// byte, the first byte, or inside a seeded random block each fail closed. The
// middle case recomputes the pick the same way the program seeds it.
const sampleScript = `import importlib.machinery,importlib.util,hashlib,random,sys,os
loader=importlib.machinery.SourceFileLoader("q04s",sys.argv[1]);spec=importlib.util.spec_from_loader(loader.name,loader);m=importlib.util.module_from_spec(spec);loader.exec_module(m)
path,where=sys.argv[2:4];size=300*1024*1024
with open(path,"wb") as f:f.truncate(size)
seed=int.from_bytes(hashlib.sha256(b"home-test").digest()[:8],"big");pick=sorted(random.Random(seed).randrange(size//4096) for _ in range(1000))[500]
off={"clean":None,"first":0,"last":size-1,"random":pick*4096+17}[where]
if off is not None:
 with open(path,"r+b") as f:f.seek(off);f.write(b"X")
try:m.volume_sample_zero(path,"home-test");print("ok")
except ValueError as e:print("refused",e)
`;
it.each([["clean", "ok"], ["first", "refused"], ["last", "refused"], ["random", "refused"]])("zero sample on a 300 MiB device: %s", (where, expected) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "q04-sample-")));
  try {
    const result = spawnSync("python3", ["-I", "-c", sampleScript, program, join(root, "disk"), where], { encoding: "utf8" });
    expect(result.stdout.startsWith(expected)).toBe(true);
    expect(result.stderr).toContain(where === "clean" ? "volume sample zero ok" : "non-zero at offset");
  } finally { removeTempDirSync(root); }
});
