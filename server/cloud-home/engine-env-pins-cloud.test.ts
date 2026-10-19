// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Rule 74c on a Cloud home (MURAGE_CLOUD_ROLE=home): the handed pins are written on top of the driver's
// cloudTurnEnvironment map (never the server account's captured environment), ride the launcher request,
// and the launcher pins the same values itself, so they reach the engine and are never dropped.

import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ABSENT_PINS, sshPinCommand, valuePins } from "../../shared/arg-vocabulary.ts";
import { handedEngineEnv } from "../engine-env.ts";
import { CLOUD_TURN_ENGINES, launcher } from "./engine-launch-fixture.ts";
import { TURN_BOT, TURN_MARKER, cloudTurnBot, cloudTurnEnvironment, cloudTurnLaunch } from "./turn-process.ts";

const PLAIN_SSH = sshPinCommand("ssh", []);
/** Every value pin of ENV_PINS on POSIX, the ssh transport in its plain resolved form. */
function posixPins(): Map<string, string> {
  const pins = new Map(valuePins("linux"));
  pins.set("GIT_SSH_COMMAND", PLAIN_SSH);
  pins.set("RSYNC_RSH", PLAIN_SSH);
  return pins;
}

const pinsScript = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("launcher_fixture",sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
proposal=json.loads(sys.argv[2])
out={"table":module.HANDED_ENV_PIN,"envs":{}}
for engine in json.loads(sys.argv[3]):
    out["envs"][engine]=module.engine_environment(engine,"/fixture/engine-homes/"+engine,proposal)[0]
print(json.dumps(out))`;

afterEach(() => vi.unstubAllEnvs());

describe("a Cloud-home spawn carries the Rule 74 pins", () => {
  it("hands the pins on top of the cloudTurnEnvironment map, keeps its markers and PATH, and the launcher request carries them", async () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    vi.stubEnv("FIXTURE_SERVER_ONLY_SECRET", "server-value");
    const base = cloudTurnEnvironment("codex", { ...process.env, LANG: "C.UTF-8", TERM: "xterm-256color", GIT_ASKPASS: "/fixture/askpass", BASH_ENV: "/fixture/bashenv" });
    cloudTurnBot(base, "bot-atlas");
    const handed = await handedEngineEnv({ extra: { FIXTURE_DRIVER_NAME: "1" } }, base);
    // the ssh transport: no probe runs on a home, so plain ssh unless an earlier hand in this process identified one
    const SSH = /^'(?:\/[^']*\/)?ssh' '-o' 'BatchMode=yes'$/;
    for (const [name, value] of posixPins()) {
      if (name === "GIT_SSH_COMMAND" || name === "RSYNC_RSH") expect(handed.env[name], name).toMatch(SSH);
      else expect(handed.env[name], name).toBe(value);
    }
    for (const name of ABSENT_PINS) expect(handed.env, name).not.toHaveProperty(name);
    expect(handed.env.PATH).toBe("/opt/murage/bin:/usr/local/bin:/usr/bin:/bin");
    expect(handed.env.HOME).toBe("/data/engine-homes/codex");
    expect(handed.env[TURN_MARKER]).toBe("codex");
    expect(handed.env[TURN_BOT]).toBe("bot-atlas");
    expect(handed.env.FIXTURE_DRIVER_NAME).toBe("1");
    // the server account's own environment never becomes the base
    expect(handed.env).not.toHaveProperty("FIXTURE_SERVER_ONLY_SECRET");

    const request = JSON.parse(cloudTurnLaunch("/usr/local/bin/codex", ["app-server"], handed.env, "/data/home/workspaces/w")!.request);
    expect(request.engine).toBe("codex");
    expect(request.bot).toBe("bot-atlas");
    for (const name of posixPins().keys()) expect(request.env[name], name).toBe(handed.env[name]);
    for (const name of ABSENT_PINS) expect(request.env, name).not.toHaveProperty(name);
  });

  it("refuses a Cloud-home hand without the Cloud turn environment", async () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    await expect(handedEngineEnv({})).rejects.toThrow(/Cloud turn environment/);
  });

  it("the launcher pins the same values for every engine, over any request value", () => {
    const hostile: Record<string, string> = {};
    for (const name of posixPins().keys()) hostile[name] = "/fixture/evil";
    for (const name of ABSENT_PINS) hostile[name] = "/fixture/evil";
    const out = JSON.parse(execFileSync("python3", ["-I", "-c", pinsScript, launcher, JSON.stringify(hostile), JSON.stringify(CLOUD_TURN_ENGINES)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    // one table with ENV_PINS: every POSIX value pin but TERM (a COMMON_ENV name the hand sends as "dumb")
    const expected = Object.fromEntries([...posixPins()].filter(([name]) => name !== "TERM"));
    expect(out.table).toEqual(expected);
    for (const engine of CLOUD_TURN_ENGINES) {
      const env = out.envs[engine] as Record<string, string>;
      expect(env, engine).toMatchObject(expected);
      for (const name of ABSENT_PINS) expect(env, `${engine} ${name}`).not.toHaveProperty(name);
    }
  });
});
