// N7 (fprod3 r3b section 8): an archived bot places no call; the check sits right before the durable row and the vendor start.
import { afterEach, describe, expect, it } from "vitest";
import { PHONE_SECRETS_ENV, _resetPhoneSecretsForTest, loadPhoneSecretsFromEnv } from "./phone-secrets.ts";
import { PhoneCallService } from "./service.ts";
import { RevisionStore, defaultSettings } from "./settings.ts";
import { ALL_SETTINGS, type PhoneAdapter } from "./vapi-adapter.ts";

afterEach(() => _resetPhoneSecretsForTest());

function adapter(starts: string[]): PhoneAdapter {
  let n = 0;
  return {
    vendor: "vapi", supportedLanguages: ["en"], capabilities: Object.fromEntries(ALL_SETTINGS.map(k => [k, true])),
    setup: async () => ({ numbers: [] }), applySettings: async () => `asst-${++n}`, deleteAssistant: async () => {},
    start: async (call: { operationId: string }) => { starts.push(call.operationId); return { vendorId: "v-1", status: "queued" }; },
    status: async () => ({ vendorId: "v-1", status: "queued" }), result: async () => ({ vendorId: "v-1", status: "queued" }), cancel: async () => {},
  } as unknown as PhoneAdapter;
}

describe("N7: PhoneCallService.place refuses a fenced bot", () => {
  const args = { to: "+15550123456", goal: "Book a table" };
  async function world(fenced: Set<string>) {
    loadPhoneSecretsFromEnv({ [PHONE_SECRETS_ENV]: JSON.stringify({ key: "fixture-key", origin: "https://api.vapi.ai" }) });
    const starts: string[] = [];
    const service = new PhoneCallService(adapter(starts), new RevisionStore(), () => "en");
    service.setBotFence(id => fenced.has(id));
    await service.saveSettings(defaultSettings("pn-1", "Sam"));
    return { service, starts };
  }
  it("an archived bot: refused, the vendor is never asked", async () => {
    const { service, starts } = await world(new Set(["a"]));
    expect(await service.place(args, "a")).toEqual({ ok: false, error: "not_set_up" });
    expect(starts).toHaveLength(0);
  });
  it("control: another bot's call goes to the vendor", async () => {
    const { service, starts } = await world(new Set(["a"]));
    expect((await service.place(args, "b")).ok).toBe(true);
    expect(starts).toHaveLength(1);
  });
});
