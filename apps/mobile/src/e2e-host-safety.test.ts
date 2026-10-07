// Behaviour, not strings: serve.sh and stop-host.sh run against a fake
// Tailscale CLI and harmless stand-in processes in a temp copy of e2e/host,
// so every refusal that protects Sean's live Serve config and processes is
// exercised. Nothing here touches the real Tailscale or the 28xxx ports.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SOURCE = fileURLToPath(new URL("../e2e/host/", import.meta.url));
const SCRIPTS = ["serve.sh", "stop-host.sh", "door.sh", "tailscale-cli.sh", "own-pid.sh", "run-host.sh"];
// run-host.sh, door.sh and stop-host.sh source scripts/safe-wipe.sh from the
// repository root (4 levels above e2e/host), so the fake tree below stages a
// copy of it at the same relative place.
const SAFE_WIPE = fileURLToPath(new URL("../../../scripts/safe-wipe.sh", import.meta.url));

// Records every argv; applies only the two writes serve.sh may make, so a
// normal up -> down really round-trips the state file.
const FAKE_CLI = `#!/bin/bash
here=$(cd "$(dirname "$0")" && pwd)
case "$*" in
  version) echo 1.0; exit 0 ;;
  "serve status --json") cat "$here/state.json"; exit 0 ;;
esac
echo "$*" >> "$here/mutations.log"
python3 - "$here/state.json" "$@" <<'PY'
import json, sys
path, args = sys.argv[1], sys.argv[2:]
state = json.load(open(path))
if args[:3] == ["serve", "--bg", "--https=8444"]:
    state.setdefault("TCP", {})["8444"] = {"HTTPS": True}
    state.setdefault("Web", {})["h.ts.net:8444"] = {"Handlers": {"/": {"Proxy": args[3]}}}
elif args == ["serve", "--https=8444", "off"]:
    state.get("TCP", {}).pop("8444", None)
    state.get("Web", {}).pop("h.ts.net:8444", None)
else:
    sys.exit("unexpected tailscale call: " + " ".join(args))
json.dump(state, open(path, "w"), indent=2)
PY
`;

const LIVE = { TCP: { "443": { HTTPS: true } }, Web: { "h.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8813" } } } } };
const FOREIGN = {
  TCP: { "443": { HTTPS: true }, "8444": { HTTPS: true } },
  Web: { ...LIVE.Web, "h.ts.net:8444": { Handlers: { "/": { Proxy: "http://127.0.0.1:9000" } } } },
};

let root: string;
let host: string;
let cli: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mm-e2e-host-"));
  host = join(root, "app/apps/mobile/e2e/host");
  mkdirSync(host, { recursive: true });
  for (const name of SCRIPTS) if (existsSync(join(SOURCE, name))) cpSync(join(SOURCE, name), join(host, name));
  mkdirSync(join(root, "app/scripts"), { recursive: true });
  cpSync(SAFE_WIPE, join(root, "app/scripts/safe-wipe.sh"));
  cli = join(root, "fake-cli");
  mkdirSync(cli);
  writeFileSync(join(cli, "tailscale"), FAKE_CLI, { mode: 0o755 });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const state = (value?: unknown) => {
  if (value !== undefined) writeFileSync(join(cli, "state.json"), JSON.stringify(value, null, 2));
  return readFileSync(join(cli, "state.json"), "utf8");
};
const mutations = () => (existsSync(join(cli, "mutations.log")) ? readFileSync(join(cli, "mutations.log"), "utf8").trim().split("\n") : []);
const run = (script: string, ...args: string[]) =>
  spawnSync("bash", [join(host, script), ...args], { encoding: "utf8", env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: root, TAILSCALE: join(cli, "tailscale") } });
const file = (name: string) => join(host, name);

describe("serve.sh against a fake Tailscale CLI", () => {
  it("up then down adds :8444, removes it, proves the config identical, and closes the cycle", () => {
    const before = state(LIVE);
    const up = run("serve.sh", "up");
    expect(up.status, up.stderr).toBe(0);
    expect(mutations()).toEqual(["serve --bg --https=8444 http://127.0.0.1:28813"]);

    const down = run("serve.sh", "down");
    expect(down.status, down.stderr).toBe(0);
    expect(down.stdout).toContain("tailscale serve restored exactly");
    expect(JSON.parse(state())).toEqual(JSON.parse(before));
    expect(mutations()).toHaveLength(2);
    // A closed cycle leaves no snapshot a later down could trust.
    expect(existsSync(file("serve-before.json"))).toBe(false);
    expect(readFileSync(file("serve-restored.json"), "utf8")).toBe(readFileSync(file("serve-after.json"), "utf8"));
  });

  it("refuses a second up, keeps the first snapshot, and down still restores", () => {
    state(LIVE);
    expect(run("serve.sh", "up").status).toBe(0);
    const snapshot = readFileSync(file("serve-before.json"), "utf8");

    const again = run("serve.sh", "up");
    expect(again.status).not.toBe(0);
    expect(again.stderr).toMatch(/already up|run serve\.sh down/);
    expect(readFileSync(file("serve-before.json"), "utf8")).toBe(snapshot);
    expect(mutations()).toHaveLength(1);

    const down = run("serve.sh", "down");
    expect(down.status, down.stderr).toBe(0);
    expect(down.stdout).toContain("tailscale serve restored exactly");
  });

  it("refuses up when something else already serves :8444, and keeps no snapshot", () => {
    const before = state(FOREIGN);
    const up = run("serve.sh", "up");
    expect(up.status).not.toBe(0);
    expect(mutations()).toEqual([]);
    expect(state()).toBe(before);
    expect(existsSync(file("serve-before.json"))).toBe(false);
  });

  it("down with no snapshot next to a foreign :8444 changes nothing and fails loudly", () => {
    const before = state(FOREIGN);
    const down = run("serve.sh", "down");
    expect(down.status).not.toBe(0);
    expect(down.stderr).toMatch(/nothing was changed/i);
    expect(mutations()).toEqual([]);
    expect(state()).toBe(before);
  });

  it("down with a stale snapshot next to a foreign :8444 changes nothing and fails loudly", () => {
    writeFileSync(file("serve-before.json"), JSON.stringify(LIVE));
    const before = state(FOREIGN);
    const down = run("serve.sh", "down");
    expect(down.status).not.toBe(0);
    expect(down.stderr).toMatch(/not the isolated door/);
    expect(mutations()).toEqual([]);
    expect(state()).toBe(before);
    expect(existsSync(file("serve-before.json"))).toBe(true);
  });

  it("a second down after a closed cycle refuses without touching anything", () => {
    state(LIVE);
    run("serve.sh", "up");
    run("serve.sh", "down");
    const before = state();
    const again = run("serve.sh", "down");
    expect(again.status).not.toBe(0);
    expect(mutations()).toHaveLength(2);
    expect(state()).toBe(before);
  });
});

describe("stop-host.sh kills only the isolated host's own processes", () => {
  const children: ChildProcess[] = [];
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const idle = (args: string[], cwd: string) => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", ...args], { cwd, stdio: "ignore" });
    children.push(child);
    return child.pid!;
  };
  const hostEnv = (serverPid: number, doorPid: number) => {
    const data = mkdtempSync("/tmp/murage-e2e-data-test-");
    writeFileSync(file("host.env"), `DATA=${data}\nTS_HOST=h.ts.net\nCOMPANION_TOKEN=${"0".repeat(64)}\nSERVER_PID=${serverPid}\n`, { mode: 0o600 });
    writeFileSync(file("door.pid"), `${doorPid}\n`);
    return data;
  };
  const settle = async (pid: number) => {
    for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
  };

  afterEach(() => {
    for (const child of children.splice(0)) child.kill("SIGKILL");
  });

  it("refuses to kill PIDs from host.env and door.pid that are not the isolated server or door", async () => {
    const stranger = idle(["server/index.ts"], tmpdir()); // right script, wrong checkout
    const other = idle([], root); // right checkout, not the door
    const data = hostEnv(stranger, other);
    const stop = run("stop-host.sh");
    expect(stop.stderr).toMatch(new RegExp(`refusing to kill ${stranger}`));
    expect(stop.stderr).toMatch(new RegExp(`refusing to kill ${other}`));
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(stranger)).toBe(true);
    expect(alive(other)).toBe(true);
    rmSync(data, { recursive: true, force: true });
  });

  it("kills the isolated server and door it can identify, then cleans up", async () => {
    const app = join(root, "app");
    const server = idle(["--", "server/index.ts"], app);
    const door = idle(["--", "--require", join(host, "fake-serve-preload.cjs"), "companion/src/index.ts"], app);
    const data = hostEnv(server, door);
    const stop = run("stop-host.sh");
    await settle(server);
    await settle(door);
    expect(stop.status, stop.stderr).toBe(0);
    expect(alive(server)).toBe(false);
    expect(alive(door)).toBe(false);
    expect(existsSync(data)).toBe(false);
    expect(existsSync(file("host.env"))).toBe(false);
  });

  it("refuses to delete a DATA path that climbs out with ..", () => {
    const outside = mkdtempSync(join(tmpdir(), "mm-keep-"));
    writeFileSync(file("host.env"), `DATA=/tmp/murage-e2e-data-x/../../${outside}\nSERVER_PID=\n`, { mode: 0o600 });
    const stop = run("stop-host.sh");
    expect(stop.stderr).toMatch(/refusing to delete/);
    expect(existsSync(outside)).toBe(true);
    rmSync(outside, { recursive: true, force: true });
  });
});

describe("run-host.sh takes host.lock, so two E2E runs never both start a host", () => {
  beforeEach(() => {
    mkdirSync(file("web-dist"));
    writeFileSync(file("web-dist/index.html"), "<!doctype html>");
    state(LIVE);
  });

  const lockedBy = (pid: number | string) => {
    mkdirSync(file("host.lock"));
    writeFileSync(file("host.lock/pid"), `${pid}\n`);
  };
  // A pid that certainly exited: a child that has already been reaped.
  const deadPid = () => spawnSync("/usr/bin/true").pid!;

  it("refuses with \"is busy\" while another run holds the lock, and leaves the lock alone", () => {
    lockedBy(process.pid); // alive
    const start = run("run-host.sh");
    expect(start.status).toBe(1);
    expect(start.stderr).toMatch(/is busy/);
    expect(existsSync(file("host.lock"))).toBe(true);
    expect(existsSync(file("host.env"))).toBe(false);
  });

  it("releases the lock when its own start fails before host.env is written", () => {
    // The fake CLI has no `status --json` for the MagicDNS name, so the start fails there.
    const start = run("run-host.sh");
    expect(start.status).not.toBe(0);
    expect(existsSync(file("host.env"))).toBe(false);
    expect(existsSync(file("host.lock"))).toBe(false);
  });

  it("takes over a stale lock (owner gone, no isolated port listening), then releases it on its own failed start", () => {
    lockedBy(deadPid());
    const start = run("run-host.sh");
    expect(start.stderr).toMatch(/took over a stale host.lock/);
    expect(start.status).not.toBe(0); // the fake CLI has no MagicDNS name
    expect(existsSync(file("host.lock"))).toBe(false);
  });

  it("stop-host.sh without host.env releases only a lock its caller owns", () => {
    lockedBy(process.pid + 1_000_000); // someone else
    expect(run("stop-host.sh").status).toBe(0);
    expect(existsSync(file("host.lock"))).toBe(true);
    rmSync(file("host.lock"), { recursive: true });
    lockedBy(process.pid); // spawnSync's bash has this test as its parent
    expect(run("stop-host.sh").status).toBe(0);
    expect(existsSync(file("host.lock"))).toBe(false);
  });

  it("both E2E scripts refuse up front while host.lock exists", () => {
    for (const script of ["android-e2e.sh", "ios-e2e.sh"]) {
      const text = readFileSync(fileURLToPath(new URL(`../e2e/${script}`, import.meta.url)), "utf8");
      expect(text, script).toMatch(/if \[\[ -e "\$HERE\/host\/host\.lock" \|\| -f "\$HERE\/host\/host\.env" \|\| -f "\$HERE\/host\/serve-before\.json" \]\]; then\n\s+echo "the isolated host or Serve :8444 is in use by another run; nothing was changed" >&2\n\s+exit 1/);
    }
  });

  it("stop-host.sh releases the lock with the host", () => {
    lockedBy(process.pid);
    const data = mkdtempSync("/tmp/murage-e2e-data-test-");
    writeFileSync(file("host.env"), `DATA=${data}\nTS_HOST=h.ts.net\nCOMPANION_TOKEN=${"0".repeat(64)}\nSERVER_PID=\n`, { mode: 0o600 });
    const stop = run("stop-host.sh");
    expect(stop.status, stop.stderr).toBe(0);
    expect(existsSync(file("host.lock"))).toBe(false);
    expect(existsSync(data)).toBe(false);
  });
});

describe("the approver fixture (SEC-006 P7)", () => {
  const read = (path: string) => readFileSync(join(SOURCE, "..", path), "utf8");
  it("keeps the stop-line command in its fixture file, never in a shell script or the freshauth runner", () => {
    const fixture = JSON.parse(read("host/fixtures/approver-instance.json"));
    expect(fixture.approver.environment.FAKE_ACP_MODE).toBe("permission");
    const command = fixture.approver.environment.FAKE_ACP_PERMISSION_COMMAND as string;
    expect(command.length).toBeGreaterThan(0);
    for (const file of ["host/run-host.sh", "host/seed.sh", "host/merge-config.mjs", "ios-e2e.sh", "android-e2e.sh", "freshauth/run.mjs", "freshauth/native-double.js"]) {
      expect(read(file), file).not.toContain(command);
    }
  });
  it("merges the fixture as data, with no shell", () => {
    const merge = read("host/merge-config.mjs");
    expect(merge).not.toMatch(/child_process|exec|spawn/);
  });
});
