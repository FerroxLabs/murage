import { afterEach, beforeEach, expect, it } from "vitest";
import { MINIMAL_ARGV, launcherRig, type Rig } from "./engine-launch-fixture.ts";
let rig: Rig;
beforeEach(() => { rig = launcherRig(".safety-agy-mode-"); });
afterEach(() => rig.dispose());
const relay = { profile: "relay", socket: "/data/broker/agyr-0123456789ab.sock", token: "a".repeat(48) };
it.each([undefined, "bound", "open"])("Cloud native relay renders the admitted fixed-frame mode %s", mode => {
  const result = rig.plan(rig.request("antigravity", { args: [...MINIMAL_ARGV.antigravity, "--dangerously-skip-permissions"],
    render: { hooks: { ...relay, ...(mode === undefined ? {} : { mode }) } } }));
  expect(result.error).toBeUndefined();
  const plan = result.ok!;
  const home = rig.home("antigravity");
  expect(plan.files[`${home}/.gemini/config/murage-agy-relay.env`]).toBe(`SOCKET=${relay.socket}\nTOKEN=${relay.token}\nMODE=${mode ?? "bound"}\n`);
});
it.each(["", "Open", "bound ", null, 1])("Cloud native relay rejects malformed fixed-frame mode %s", mode => {
  const result = rig.plan(rig.request("antigravity", { args: MINIMAL_ARGV.antigravity, render: { hooks: { ...relay, mode } } }));
  expect(result.error).toBe("Cloud turn render hooks is not allowed");
});
