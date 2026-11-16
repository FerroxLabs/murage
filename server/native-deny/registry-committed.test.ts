import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { launchProfile, DEFAULT_NATIVE_SKIP_FLAGS } from "./profile.ts";
it("the committed probe registry is empty and every engine defaults off", () => {
  expect(JSON.parse(readFileSync(new URL("../../shared/native-deny-probes.json", import.meta.url), "utf8"))).toEqual([]);
  expect(Object.values(DEFAULT_NATIVE_SKIP_FLAGS).every(flag => flag === false)).toBe(true);
  expect(launchProfile(undefined as never).profile).toBe("today");
  // No caller-supplied rows can replace the reviewed JSON.
  for (const engine of Object.keys(DEFAULT_NATIVE_SKIP_FLAGS)) {
    expect(launchProfile({
      engine, build: { version: "1.2.3", binarySha256: "a".repeat(64) }, platform: "linux", arch: "x64",
      osRelease: "6.8.0", launchMode: { transport: "stream-json", shellMode: "murage-exec" }, uid: 2001,
      level: "no-limits", initiator: "owner", pairedDmAuthenticated: false, proposalOnly: false, draftOnly: false,
      mounts: [], conversationProfile: null, emitter: "ok",
    }, { flags: { [engine]: true }, revisions: {
      emitterRev: "b".repeat(40), backstopRev: "c".repeat(40), probeSetRev: "native-deny-r2",
      readerRev: "d".repeat(40), adapterRev: "e".repeat(40), clientRev: "f".repeat(40),
      protocolRev: "1".repeat(40), integrityRev: "2".repeat(40), configRev: "3".repeat(64),
    } }).profile).toBe("today");
  }
});
