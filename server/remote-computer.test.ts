import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import {
  ensureRemoteCuaCommand,
  REMOTE_CUA_EXECUTABLE,
  REMOTE_CUA_SOCKET,
  REMOTE_CUA_VERSION,
  remoteComputerBootstrapCommand,
  semanticBrowserCommand,
} from "./remote-computer.ts";

describe("remote Cua computer setup", () => {
  it("installs one exact checksummed 0.20.0 driver and disables telemetry", () => {
    const command = remoteComputerBootstrapCommand("Test Bot");
    expect(REMOTE_CUA_VERSION).toBe("0.20.0");
    expect(command).toContain("cua_driver-0.20.0-py3-none-manylinux_2_31_x86_64.whl");
    expect(command).toContain("cua_driver-0.20.0-py3-none-manylinux_2_31_aarch64.whl");
    expect(command).toContain("f60c35696a37f37ac954935e478ae4754f220856d022036625c9400d72185961");
    expect(command).toContain("48833bc5e4c60e701fc9eefb57dbac36ec77ef3990f816fbbe85b4e954af2c77");
    expect(command).toContain(`test "$(${REMOTE_CUA_EXECUTABLE} --version)" = "cua-driver 0.20.0"`);
    expect(command).toContain("sha256sum -c -");
    expect(command).toContain("CUA_DRIVER_RS_TELEMETRY_ENABLED=0");
    expect(command).not.toContain("uv pip install");
    expect(command).not.toContain("cua-computer-server");
    expect(command).not.toContain("--port 8000");
    if (process.platform !== "win32") {
      expect(spawnSync("/bin/bash", ["-n"], { input: command }).status).toBe(0);
    }
  });

  // A display name is whatever the user typed. It used to be scrubbed with
  // `replace(/["'\\]/g, "")` and interpolated into the tmux command inside
  // DOUBLE quotes, where `$(…)` and backticks still expand — so naming a bot
  // `Bruce $(id -un)` ran `id` on the provisioned box.
  it("cannot be made to run a command by naming a bot", () => {
    const hostile = 'Bruce $(id -un) `whoami` "; touch /tmp/pwned; #';
    const command = remoteComputerBootstrapCommand(hostile);

    // The name reaches the box as base64, so no fragment of it survives as
    // shell text anywhere in the script.
    expect(command).not.toContain("$(id -un)");
    expect(command).not.toContain("`whoami`");
    expect(command).not.toContain("touch /tmp/pwned");

    // ...and it is genuinely carried, not silently dropped: the encoded
    // banner decodes back to the exact name.
    const encoded = /printf %s ([A-Za-z0-9+/=]+) \| base64 -d/.exec(command);
    expect(encoded, "the banner is no longer sent as base64").toBeTruthy();
    expect(Buffer.from(encoded![1]!, "base64").toString("utf8")).toContain(hostile);

    if (process.platform !== "win32") {
      // Still a syntactically valid script with a hostile name in it...
      expect(spawnSync("/bin/bash", ["-n"], { input: command }).status).toBe(0);
      // ...and the substitution does not happen. Running the real bootstrap
      // would need a box, so this executes only the tmux line's payload, which
      // is the part the name is interpolated into.
      const payload = /tmux new-session -d -s work (.+)$/m.exec(command);
      expect(payload).toBeTruthy();
      const ran = spawnSync("/bin/bash", ["-c", `eval ${payload![1]!.replace(/; exec bash -i/, "")}`], {
        encoding: "utf8",
      });
      expect(ran.stdout).toContain("$(id -un)");
      expect(ran.stdout).not.toContain(process.env.USER ?? "\u0000never");
    }
  });

  it("reattaches the private daemon after resume without opening a port", () => {
    const command = ensureRemoteCuaCommand();
    expect(command).toContain(`status --socket ${REMOTE_CUA_SOCKET}`);
    expect(command).toContain(`serve --socket ${REMOTE_CUA_SOCKET} --permission-mode standard`);
    expect(command).toContain("CUA_DRIVER_RS_TELEMETRY_ENABLED=0");
    expect(command).not.toMatch(/--host|--port/);
  });

  it("encodes semantic browser input instead of interpolating it into shell", () => {
    const command = semanticBrowserCommand("fill", { ref: "b7", text: "don't expand $HOME" });
    expect(command).toContain("murage-cdp.mjs fill");
    expect(command).not.toContain("don't expand");
    expect(command).not.toContain("$HOME");
  });
});
