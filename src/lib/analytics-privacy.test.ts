import { afterEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ init: vi.fn(), capture: vi.fn(), opt_in_capturing: vi.fn(), opt_out_capturing: vi.fn(), has_opted_out_capturing: () => false }));
vi.mock("posthog-js", () => ({ default: fake }));
vi.mock("./analytics-active", () => ({ watchActiveDays: vi.fn() }));
vi.mock("./native-shell", () => ({ inNativeShell: () => false }));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("A9: filters SDK-enriched events at the outgoing boundary, including URLs and free text", async () => {
  vi.resetModules();
  vi.stubEnv("VITE_POSTHOG_KEY", "fixture-public-project");
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  vi.stubGlobal("navigator", { userAgent: "Electron fixture" });
  const analytics = await import("./analytics");
  expect(analytics.analyticsEnabled()).toBe(true); // the 1.0.18 default
  analytics.initAnalytics();
  await vi.waitFor(() => expect(fake.init).toHaveBeenCalledOnce());
  analytics.track("message_sent", { queued: true, text: "PRIVATE_MESSAGE", path: "/home/ada/private", distinct_id: "PRIVATE_MESSAGE", driver: "PRIVATE_MESSAGE" });
  expect(fake.capture).toHaveBeenLastCalledWith("message_sent", { queued: true });
  const sentCount = fake.capture.mock.calls.length;
  analytics.track("PRIVATE_MESSAGE", { text: "PRIVATE_MESSAGE" });
  expect(fake.capture).toHaveBeenCalledTimes(sentCount);
  const options = fake.init.mock.calls[0][1];
  expect(options.advanced_disable_flags).toBe(true);
  expect(options.save_campaign_params).toBe(false);
  expect(options.save_referrer).toBe(false);
  expect(options.disable_surveys).toBe(true);
  expect(options.disable_external_dependency_loading).toBe(true);
  expect(options.autocapture).toBe(false);
  expect(options.capture_pageview).toBe(false);
  expect(options.disable_session_recording).toBe(true);
  expect(options.capture_exceptions).toBe(false);
  expect(options.before_send).toBeTypeOf("function");
  const event = { event: "message_sent", uuid: "fixture-event", $set: { email: "PRIVATE_MESSAGE" }, $set_once: { path: "/Users/ada/private" }, properties: {
    token: "fixture-public-project", distinct_id: "fixture-anonymous-id",
    $device_id: "fixture-device", $current_url: "file:///Users/ada/Private Project/chat",
    $referrer: "/home/ada/notes", $set: { email: "fixture@example.invalid" },
    message: "PRIVATE_MESSAGE", path: "/home/ada/private.md", driver: "/Users/ada/custom-engine",
    queued: true, engineCommand: false,
  } };
  const sent = options.before_send(event);
  expect(sent).toEqual({ event: "message_sent", uuid: "fixture-event", properties: {
    token: "fixture-public-project", distinct_id: "fixture-anonymous-id", queued: true, engineCommand: false,
  } });
  expect(options.before_send({ ...event, event: "PRIVATE_MESSAGE" })).toBeNull();
  expect(options.before_send({ ...event, event: "$autocapture" })).toBeNull();
  const counts = options.before_send({ ...event, event: "room_members_changed", properties: { members: 3, added: 1, removed: "PRIVATE_MESSAGE", path: "/Users/ada/secret" } });
  expect(counts.properties).toEqual({ members: 3, added: 1 });
  const malformed = options.before_send({ ...event, event: "team_imported", properties: { source: "/home/ada/private", members: NaN, mode: "PRIVATE_MESSAGE" } });
  expect(malformed.properties).toEqual({});
});

it("A9: Settings discloses the stored anonymous identifier and IP address", async () => {
  const { readFileSync } = await import("node:fs");
  const copy = readFileSync(new URL("../components/settings/rows/GeneralRows.tsx", import.meta.url), "utf8");
  expect(copy).toContain("stored anonymous identifier");
  expect(copy).toContain("IP address");
  expect(copy).toContain("file paths");
});
