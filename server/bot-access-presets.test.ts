// B43: preset-built grants go through the unchanged configure path; `*` is refused, allowWrites
// is whatever the owner set, and an empty expansion never reaches the saved record as tools: [].
import { mkdirSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase } from "./database.ts";
import { Store } from "./store.ts";
import { reviewBotAccess } from "./bot-access.ts";
import { botAccessPolicy } from "./bot-access-role.ts";
import { presetTools, withAccountTools } from "../shared/bot-access.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
const gmail = { toolkit: "gmail", accountId: "ca_fixture_gmail" };
const slack = { toolkit: "slack", accountId: "ca_fixture_slack" };
function setup() { const store = new Store(() => ({ instanceId: "fixture", model: "fixture" })); const bot = store.createBot({ name: "Specialist", section: "Studio" }); return { store, bot }; }
const configure = (f: ReturnType<typeof setup>, allowWrites: boolean, grants: unknown) =>
  reviewBotAccess(f.store, f.bot.id, { action: "configure", revision: botAccessPolicy(f.bot).revision, mode: "restricted", allowWrites, grants }, [gmail, slack]);

it("configure refuses a wildcard tool", () => {
  const f = setup();
  expect(() => configure(f, false, [{ ...gmail, tools: ["*"] }])).toThrow("Invalid");
  expect(botAccessPolicy(f.bot).grants).toEqual([]);
});
it("a preset leaves allowWrites exactly as the owner set it", () => {
  for (const allowWrites of [false, true]) {
    const f = setup();
    configure(f, allowWrites, []);
    const grants = withAccountTools(botAccessPolicy(f.bot).grants, gmail, presetTools("gmail", "all"));
    configure(f, botAccessPolicy(f.bot).allowWrites, grants);
    expect(botAccessPolicy(f.bot).allowWrites).toBe(allowWrites);
    expect(botAccessPolicy(f.bot).grants).toEqual([{ ...gmail, tools: ["GMAIL_FETCH_EMAILS", "GMAIL_GET_PROFILE", "GMAIL_SEND_EMAIL"] }]);
  }
});
it("an empty expansion removes the row, so the saved record holds no tools: []", () => {
  const f = setup();
  configure(f, false, [{ ...slack, tools: ["SLACK_SEND_MESSAGE"] }, { ...gmail, tools: ["GMAIL_FETCH_EMAILS"] }]);
  const grants = withAccountTools(botAccessPolicy(f.bot).grants, slack, presetTools("slack", "read"));
  configure(f, false, grants);
  const saved = new Store(() => ({ instanceId: "fixture", model: "fixture" })).bot(f.bot.id)!;
  expect(botAccessPolicy(saved).grants).toEqual([{ ...gmail, tools: ["GMAIL_FETCH_EMAILS"] }]);
  expect(JSON.stringify(saved.connectedAppAccess)).not.toContain('"tools":[]');
  expect(() => configure(f, false, [{ ...slack, tools: [] }])).toThrow("Invalid");
});
