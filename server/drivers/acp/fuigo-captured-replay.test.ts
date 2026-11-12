import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FuigoAgentDriver } from "./fuigo.ts";
import { useOutsideStoreFixture } from "../../testing/outside-store-fixture.ts";
import { fixtureBotFolder } from "../../testing/bot-folder-fixture.ts";
import { recordEvents } from "../../testing/events.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { LimitTurns, gatewayBusy } from "../../limit-continuation.ts";
import { maskKey } from "../../../shared/key-extract.ts";
import * as fluxRefusal from "../../flux-refusal.ts";
import { assertPublishedFuigoCapture, assertTypedCapTurn } from "../../testing/fuigo-capture-proof.ts";
import type { ProviderInstance } from "../../contracts.ts";

useOutsideStoreFixture();
const fixtures = fileURLToPath(new URL("./__fixtures__/", import.meta.url));
const cli = fileURLToPath(new URL("../../testing/fuigo-captured-cli.mjs", import.meta.url));
const provenance = JSON.parse(readFileSync(join(fixtures, "PROVENANCE.json"), "utf8"));
// The published drop is read in place (read-only bind mount in container runs).
const publishedCaptures = process.env.FUIGO_1043_CAPTURE_DIR ?? "/work/build/fuigo-1043-captures";
const paths: string[] = [];
let instance: ProviderInstance | undefined;
beforeEach(() => { vi.stubEnv("FLUX_API_KEY", "sk-flux-Ffffffffffffffffffffffffffffffffffffffffff"); });
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await instance?.dispose(); instance = undefined; for (const path of paths.splice(0)) await removeTempDir(path); });
async function replay(file: string, reason: string | null, status: number, typedOnly = false, captureDir = fixtures) {
  // Preserve every captured byte. Disable only the legacy classifier, so a
  // surviving message cannot conceal removal of B1 from the real driver.
  if (typedOnly) vi.spyOn(fluxRefusal, "fluxRefusalCode").mockReturnValue(undefined);
  const home = mkdtempSync(join(tmpdir(), "fuigo-capture-replay-")); paths.push(home);
  instance = await FuigoAgentDriver.create({ instanceId: "captured", displayName: "Fuigo", enabled: true,
    environment: { HOME: home }, config: { fullAuto: false, cli: `"${process.execPath}" "${cli}" "${join(captureDir, file)}"` } });
  const recorder = recordEvents(instance.adapter);
  const turns = new LimitTurns();
  turns.begin({ botId: "b", threadId: "captured", selection: { instanceId: "captured", model: "flux-auto" }, engineName: "Fuigo", driverKind: "fuigoAgent", viaGateway: false, sendIds: [], sourceMessageId: "m", sourceText: "hi", ownerDirect: true, routine: false, onFailover: false, activity: false });
  try {
    await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "captured", text: "hi", model: "flux-auto" });
    await recorder.until(e => e.type === "turn.completed");
    for (const event of recorder.events) turns.observe(event);
    const turn = turns.get("captured")!;
    expect(turn.httpStatus, JSON.stringify(recorder.events)).toBe(status);
    expect(gatewayBusy(turn, { resetsAt: null })).toBe(reason);
    if (typedOnly) assertTypedCapTurn(turn);
    if (status === 402) expect(recorder.events.find(e => e.type === "runtime.error")).toMatchObject({ providerError: { kind: "credits" } });
  } finally { recorder.stop(); }
}
describe("captured Fuigo refusals", () => {
  for (const repeat of [1, 2]) {
    it(`R1: 1.0.41 S1 run ${repeat} → freeCap/429`, () => replay(`fuigo-1.0.41-free-cap-S1-${repeat}.jsonl`, "freeCap", 429));
    it(`R2: 1.0.41 S2 run ${repeat} preserves cap signal`, () => replay(`fuigo-1.0.41-free-cap-S2-${repeat}.jsonl`, "freeCap", 429));
    it(`R5: 1.0.41 S3 run ${repeat} → busy/429`, () => replay(`fuigo-1.0.41-free-cap-S3-${repeat}.jsonl`, "busy", 429));
    it(`R6: 1.0.41 S4 run ${repeat} → credit/402`, () => replay(`fuigo-1.0.41-free-cap-S4-${repeat}.jsonl`, "credit", 402));
  }
  it("R3 proof control: legacy-only real capture cannot prove typed state", async () => {
    await expect(replay("fuigo-1.0.41-free-cap-S1-1.jsonl", "freeCap", 429, true)).rejects.toThrow("R3 requires typed state");
  });
  // MAIN 2026-11-11 11:16Z: error.data.upstream is new in Fuigo 1.0.43;
  // 1.0.42 captures cannot prove R3. Require published captures, never synthetic.
  for (const scenario of ["S1", "S2"]) {
    it(`R3: 1.0.43 captured ${scenario} typed state (published release pin; never synthetic)`, async () => {
      // Published frames-S1/S2-1 are the requested free-cap S1/S2-1 runs.
      const file = `frames-${scenario}-1.jsonl`;
      expect(existsSync(join(publishedCaptures, file)), `OPEN R3: published 1.0.43 capture missing: ${join(publishedCaptures, file)}`).toBe(true);
      const pinPath = join(publishedCaptures, "PROVENANCE-1.0.43.json");
      expect(existsSync(pinPath), "OPEN R3: 1.0.43 binary pin and capture provenance missing").toBe(true);
      const pin = JSON.parse(readFileSync(pinPath, "utf8"));
      // This receipt is supplied by the release/bundle lane, never by the
      // capture itself. A self-declared, well-formed digest is not a pin.
      const releasePath = join(publishedCaptures, "scripts/fuigo-1.0.43-provenance.json");
      expect(existsSync(releasePath), "OPEN R3: scripts/fuigo-1.0.43-provenance.json release receipt missing").toBe(true);
      const bytes = readFileSync(join(publishedCaptures, file));
      assertPublishedFuigoCapture(pin, JSON.parse(readFileSync(releasePath, "utf8")), file, bytes);
      const frames = bytes.toString().trim().split("\n").map(line => JSON.parse(line));
      expect(frames.some(frame => frame.direction === "stdout" && JSON.parse(frame.line).error?.data?.upstream?.state === "free_cap_reached"), "R3 must include the real typed terminal field").toBe(true);
      await replay(file, "freeCap", 429, true, publishedCaptures);
    });
  }
  it("R7: capture hashes, released binary pin, and unchanged masked frames", () => {
    expect(provenance.binary.sha256).toBe("12c9b952ee9c9561e4ef36ed18973f3af2a443817f5dc928e89bee38dddddc07");
    expect(Object.keys(provenance.files).filter(file => file.startsWith("fuigo-1.0.41-"))).toHaveLength(8);
    for (const [file, hash] of Object.entries({ ...provenance.scripts, ...provenance.bodies })) {
      expect(createHash("sha256").update(readFileSync(join(fixtures, "capture", file))).digest("hex"), file).toBe(hash);
    }
    for (const runs of Object.values(provenance.repeats) as Array<Array<{ terminal_sha256: string; post_count: number; retry_notices: string[] }>>) {
      expect(runs[0]).toEqual(runs[1]);
    }
    for (const [file, hash] of Object.entries(provenance.files)) {
      const bytes = readFileSync(join(fixtures, file));
      expect(createHash("sha256").update(bytes).digest("hex"), file).toBe(hash);
      expect(bytes.toString().replaceAll("fuigo-capture-dummy-0000", maskKey("fuigo-capture-dummy-0000")), file).toBe(bytes.toString());
      expect(bytes.toString()).not.toContain("fuigo-capture-dummy-0000");
    }
  });
});
