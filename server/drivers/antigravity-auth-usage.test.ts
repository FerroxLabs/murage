import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { AntigravityDriver } from "./antigravity.ts";
import { fixtureBotFolder } from "../testing/bot-folder-fixture.ts";
import { useOutsideStoreFixture } from "../testing/outside-store-fixture.ts";
import { recordEvents } from "../testing/events.ts";

useOutsideStoreFixture();
it("an Antigravity authentication result retains the usage already charged and emits one structured error", async () => {
  const driver = await AntigravityDriver.create({ instanceId: "auth-usage", displayName: undefined, enabled: true, environment: { FAKE_AGY_RESULT_FAILED: JSON.stringify({ error: { code: "UNAUTHENTICATED" }, usage: { input_tokens: 3, cache_read_tokens: 2, output_tokens: 4 } }) }, config: { cli: fileURLToPath(new URL("../testing/fake-agy-cli.ts", import.meta.url)), fullAuto: true } });
  const seen = recordEvents(driver.adapter);
  try {
    await driver.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "auth-usage-thread", text: "go" });
    const done = await seen.until(event => event.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, stopReason: "signin_required", usage: { input: 5, output: 4 } });
    expect(seen.events.filter(event => event.type === "runtime.error")).toHaveLength(1);
    expect(seen.events.find(event => event.type === "runtime.error")).toMatchObject({ authRequired: true, providerError: { httpStatus: 401 } });
  } finally { await driver.dispose(); }
});
