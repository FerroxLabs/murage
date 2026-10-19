import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase } from "../database.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { reconcileMemoryRoster } from "./policy.ts";

import { removeTempDirSync } from "../testing/cleanup.ts";
const state = vi.hoisted(() => ({ value: "absent" as "verified" | "checking" | "absent" }));
vi.mock("./model-location.ts", async (original) => ({ ...(await original<typeof import("./model-location.ts")>()), bundledModelState: () => state.value }));
const { memoryOwnerRoute, memoryOwnerStatus } = await import("./settings.ts");

const roster = { bots: [{ id: "bundled-owner", threadId: "bundled-thread" }], groups: [] };
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); reconcileMemoryRoster(roster); state.value = "absent"; });
afterEach(() => { vi.unstubAllGlobals(); closeDatabase(); });

it("reports a ready, bundled model with nothing to download", async () => {
  state.value = "verified";
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const owner = ownerMemoryTicket();
  const model = memoryOwnerStatus(owner, roster).model;
  expect(model).toMatchObject({ state: "ready", bundled: true });
  expect(model.bytesDownloaded).toBe(model.totalBytes);
  await expect(memoryOwnerRoute("/api/memory/action", { action: "model-download", confirm: true }, owner, roster)).resolves.toMatchObject({ model: { state: "ready", bundled: true } });
  expect(fetch).not.toHaveBeenCalled();
});

it("reports a bundled model as being checked until it verifies", () => {
  state.value = "checking";
  expect(memoryOwnerStatus(ownerMemoryTicket(), roster).model).toMatchObject({ state: "unverified", bundled: true });
});

it("keeps the optional download for builds without a bundled model", () => {
  const model = memoryOwnerStatus(ownerMemoryTicket(), roster).model;
  expect(model.state).toBe("missing");
  expect(model.bundled).toBeUndefined();
});
