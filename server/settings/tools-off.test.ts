import { describe, expect, it } from "vitest";
import { admitTool, claudeSearchDeny, hiddenToolNames, setToolOff, toolForName, toolSwitchesFor } from "./tools-off.ts";
import { gateWebRead, gateWebSearch, webSearchSwitch } from "./web-read.ts";

const bot = (toolsOff?: string[]) => ({ id: "bot-a", ...(toolsOff ? { toolsOff } : {}) });

describe("T1 Read web pages switch", () => {
  it("is on by default and absent config changes nothing", () => {
    expect(gateWebRead({}, { url: "https://example.com/" }).ok).toBe(true);
  });
  it("global off refuses a new page for every bot with a settingRef", () => {
    for (const id of ["bot-a", "bot-b"]) {
      const r = gateWebRead({ webRead: { enabled: false } }, { url: "https://example.com/" }, id);
      expect(r).toMatchObject({ ok: false, code: "web-read-off", settingRef: { id: "tools.web-read", bot: id, code: "web-read-off" } });
    }
  });
  it("range 2 of a page already fetched is a continuation; a new URL or a handle plus URL is not", () => {
    const off = { webRead: { enabled: false } };
    expect(gateWebRead(off, { handle: "w-1" }).ok).toBe(true);
    expect(gateWebRead(off, { handle: "w-1", url: "https://example.com/other" }).ok).toBe(false);
    expect(gateWebRead(off, { handle: "" }).ok).toBe(false);
  });
  // dev/1022 settings-truth ruling (server/web-read-api.test.ts, internal-response-fence.test.ts): Web search Off also turns new page reads off.
  it("Search off turns new page reads off too, and names Web search as the setting to change", () => {
    expect(gateWebRead({ webSearch: { provider: "off" } }, { url: "https://example.com/" })).toMatchObject({ ok: false, code: "web-search-off", settingRef: { id: "tools.web-search" } });
    expect(gateWebRead({ webSearch: { provider: "off" }, webRead: { enabled: false } }, { url: "https://example.com/" })).toMatchObject({ ok: false });
    expect(gateWebRead({ webSearch: { provider: "engine" } }, { url: "https://example.com/" }).ok).toBe(true);
  });
});

describe("Web search row switch", () => {
  it("Off remembers the provider, On restores it and asks first when it costs money", () => {
    const off = webSearchSwitch({ provider: "tavily" }, false);
    expect(off).toEqual({ provider: "off", lastProvider: "tavily" });
    expect(webSearchSwitch({ provider: "off", lastProvider: "tavily" }, true)).toEqual({ provider: "tavily", needsAsk: true });
    expect(webSearchSwitch({ provider: "off", lastProvider: "engine" }, true)).toEqual({ provider: "engine" });
    expect(webSearchSwitch({ provider: "off" }, true)).toEqual({ provider: "engine" });
  });
  it("Off twice keeps the remembered provider", () => {
    expect(webSearchSwitch({ provider: "off", lastProvider: "exa" }, false)).toEqual({ provider: "off", lastProvider: "exa" });
  });
  it("gate refuses with its own setting id", () => {
    expect(gateWebSearch({ webSearch: { provider: "off" } }, "bot-a")).toMatchObject({ ok: false, settingRef: { id: "tools.web-search" } });
  });
});

describe("T2 per-bot toolsOff", () => {
  it("one bot off, a second unchanged", () => {
    expect(admitTool({}, bot(["web_search"]), "web_search").ok).toBe(false);
    expect(admitTool({}, bot(), "web_search").ok).toBe(true);
    expect(admitTool({}, bot(["web_search"]), "web_read", { url: "https://example.com/" }).ok).toBe(true);
  });
  it("two quick toggles both stick, applied in order to the stored list", () => {
    const a = setToolOff(undefined, "web_search", true);
    const b = setToolOff(a, "images", true);
    expect(b).toEqual(["web_search", "images"]);
    expect(setToolOff(b, "web_search", false)).toEqual(["images"]);
    expect(setToolOff(["bogus", "images"], "routines", true)).toEqual(["images", "routines"]);
  });
  it("each of the six tools maps and refuses with a bot-scoped settingRef", () => {
    for (const [tool, name] of [["web_search", "web_search"], ["web_read", "web_read"], ["images", "generate_image"], ["voice_notes", "send_voice_note"], ["routines", "propose_routine"]] as const) {
      expect(toolForName(name)).toBe(tool);
      expect(admitTool({}, bot([tool]), name, { url: "https://example.com/" })).toMatchObject({ ok: false, code: "tool-off-for-bot", settingRef: { bot: "bot-a" } });
    }
  });
  it("a page already being read finishes for a bot with Read web pages off, a new page does not", () => {
    expect(admitTool({}, bot(["web_read"]), "web_read", { handle: "w-1" }).ok).toBe(true);
    expect(admitTool({}, bot(["web_read"]), "web_read", { url: "https://example.com/" }).ok).toBe(false);
  });
  it("list build hides exactly the refused tools", () => {
    const hidden = hiddenToolNames({ webSearch: { provider: "off" } }, bot(["images"]));
    expect(hidden.has("web_search")).toBe(true);
    expect(hidden.has("generate_image")).toBe(true);
    // Web search Off also turns page reading off (one reading predicate), so the list does not offer web_read
    expect(hidden.has("web_read")).toBe(true);
    expect(hiddenToolNames({ webRead: { enabled: false } }, bot()).has("web_read")).toBe(true);
    expect(hiddenToolNames({ webRead: { enabled: false } }, bot()).has("web_search")).toBe(false);
    expect(hiddenToolNames({}, bot()).has("web_read")).toBe(false);
  });
  it("Claude's native deny list gains WebSearch when search is off app-wide or for the bot", () => {
    expect(claudeSearchDeny({ webSearch: { provider: "off" } }, bot())).toEqual(["WebSearch"]);
    expect(claudeSearchDeny({}, bot(["web_search"]))).toEqual(["WebSearch"]);
    expect(claudeSearchDeny({}, bot())).toEqual([]);
  });
  it("the route body carries what the proxy reads", () => {
    expect(toolSwitchesFor({ webRead: { enabled: false } }, bot(["images"]))).toEqual({ webRead: { enabled: false }, webSearch: { provider: "engine" }, toolsOff: ["images"] });
  });
});
