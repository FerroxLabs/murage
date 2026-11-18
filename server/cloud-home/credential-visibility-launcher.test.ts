import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, it } from "vitest";

// Call the real launcher planner. These are inert path names, never host files read by this test.
const script = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("visibility",sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
out=[]
for engine in ["claudeAgent","codex","grokAgent","kimiAgent","opencodeGo","fuigoAgent"]:
 h="/data/engine-homes/"+engine
 argv,blobs=m.turn_mount_args(engine,[],h,h,"/fixture/cli",[],turn_home="/fixture/turn-home")
 mounts=[(a,argv[i+1],argv[i+2]) for i,a in enumerate(argv) if a in ["--bind","--ro-bind","--ro-bind-data"]]
 out.append({"engine":engine,"mounts":mounts})
print(json.dumps(out))`;
it("does not expose Class D machine stores in any engine's launcher mount plan", () => {
  const plans = JSON.parse(execFileSync("python3", ["-I", "-c", script, resolve("deploy/cloud-home/murage-turn-launch.py")], { encoding: "utf8" })) as { engine: string; mounts: string[][] }[];
  expect(plans).toHaveLength(6);
  for (const plan of plans) for (const hidden of ["/var/tmp/murage-authorize.fixture/pw", "/var/lib/murage-home/credential", "/etc/murage-home/credential", "/run/murage-turn/request.json", "/run/murage-turn/home/auth.json", "/run/murage-tunnel/token", "/run/murage-tunnel/.token-fixture", "/run/murage-turn-requests/r-" + "a".repeat(32)]) {
    for (const [kind, source, target] of plan.mounts) {
      expect(target === "/" || hidden === target || hidden.startsWith(target + "/"), `${plan.engine}: ${hidden} at ${target}`).toBe(false);
      if (kind !== "--ro-bind-data") expect(source === "/" || hidden === source || hidden.startsWith(source + "/"), `${plan.engine}: ${hidden} from ${source}`).toBe(false);
    }
  }
});
