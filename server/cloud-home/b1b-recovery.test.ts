// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { createHomeRecoveryCleanup } from "./b1b-recovery.ts";
describe("recovery cleanup", () => {
  it("waits for every required cleanup and rotation acknowledgement", async () => {
    const seen:string[]=[];
    let acknowledge!: () => void;
    const pending=new Promise<void>(resolve => { acknowledge=resolve; });
    const cleanup=createHomeRecoveryCleanup({stopWork:async()=>{seen.push("stop");},pauseChannels:async()=>{seen.push("channels");},wipeEngineSignIns:async()=>{seen.push("wipe");await pending;},rotateConnectedAppsAndFlux:async()=>{seen.push("rotate");}});
    const first=cleanup(); expect(cleanup()).toBe(first);
    await Promise.resolve();await Promise.resolve();await Promise.resolve();
    expect(seen).toEqual(["stop","channels","wipe"]);
    acknowledge();await first;expect(seen).toEqual(["stop","channels","wipe","rotate"]);
  });
  it("cannot report completion when credential removal fails", async () => {
    let rotated=false;
    const cleanup=createHomeRecoveryCleanup({stopWork:async()=>{},pauseChannels:async()=>{},wipeEngineSignIns:async()=>{throw new Error("fixture removal failed");},rotateConnectedAppsAndFlux:async()=>{rotated=true;}});
    await expect(cleanup()).rejects.toThrow("fixture removal failed");expect(rotated).toBe(false);
  });
});
