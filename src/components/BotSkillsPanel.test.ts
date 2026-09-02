import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  applySkillEnabled,
  createSkillsStore,
  filterSkills,
  skillDescriptionLine,
  SkillsBody,
  SKILL_PAGE_SIZE,
  toggleSkillEnabled,
  type BotSkill,
  type SkillsBodyProps,
} from "./BotSkillsPanel";

const skill = (over: Partial<BotSkill> = {}): BotSkill => ({
  name: "chart-analysis",
  description: "Read a price chart and name the setup.",
  enabled: true,
  editable: false,
  source: "library:chart-analysis@1.0.0",
  sha256: "a".repeat(64),
  importedAt: "2026-08-01T00:00:00.000Z",
  warnings: [],
  skippedFiles: [],
  ...over,
});

const render = (over: Partial<SkillsBodyProps> = {}) =>
  renderToStaticMarkup(
    createElement(SkillsBody, {
      botName: "Ember",
      phase: "ready",
      skills: [],
      staged: 0,
      loadFailure: "",
      authoringEnabled: false,
      query: "",
      onQuery: vi.fn(),
      visible: SKILL_PAGE_SIZE,
      onShowMore: vi.fn(),
      busy: new Set<string>(),
      rowErrors: new Map<string, string>(),
      viewing: null,
      onOpen: vi.fn(),
      onBack: vi.fn(),
      onRetry: vi.fn(),
      onToggle: vi.fn(),
      onRemove: vi.fn(),
      ...over,
    }),
  );

/** The shape createSkillsStore() calls, so a mock's recorded calls stay typed. */
type SkillsRequest = (path: string, init?: RequestInit) => Promise<unknown>;

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // an unhandled rejection here would fail the run before the store sees it
  promise.catch(() => {});
  return { promise, resolve, reject };
};

describe("what skills a bot has", () => {
  it("lists every skill with its description and its on/off state", () => {
    const markup = render({
      skills: [
        skill(),
        skill({ name: "morning-prep", description: "Assemble the pre-open brief.", enabled: false }),
      ],
    });

    expect(markup).toContain("chart-analysis");
    expect(markup).toContain("Read a price chart and name the setup.");
    expect(markup).toContain("morning-prep");
    expect(markup).toContain("Assemble the pre-open brief.");
    // the switch state is the readable answer to "is this one on?"
    expect(markup).toContain('aria-label="Disable chart-analysis"');
    expect(markup).toContain("1 of 2 on");
  });

  it("says a bot has none and where skills come from, never a blank box", () => {
    const markup = render({ skills: [] });

    expect(markup).toContain("Ember has no skills yet.");
    // This used to read "the + at the top of the sidebar, then Teams" —
    // directions to a menu three levels away, written because the panel had no
    // add control at all. It has one now, so the copy names the outcome and
    // the control does the navigating.
    expect(markup).not.toContain("the + at the top of the sidebar, then Teams");
    // the panel has no import field, so the copy must not send anyone looking
    // for one
    expect(markup).not.toContain("GitHub import");
    expect(markup).not.toContain('aria-label="Search');
  });

  it("offers a visible way to add one, in both the empty and the full state", () => {
    // A VISIBLE control, not a right-click and not a sentence pointing
    // elsewhere: `Sidebar.tsx` shipped its bot menu behind `onContextMenu`
    // alone and a touch device fires no `contextmenu` event at all.
    const onBrowse = vi.fn();
    for (const skills of [[], [skill()]]) {
      const markup = render({ skills, onBrowse });
      expect(markup).toContain('aria-label="Add a skill to Ember"');
      // the label a person actually reads, not just the accessible name
      expect(markup).toContain("Add a skill</button>");
    }
    // and it is optional, so the body still renders without a store behind it
    expect(render({ skills: [] })).not.toContain("Add a skill</button>");
  });

  it("says installed skills arrive switched ON, which is what the import does", () => {
    const markup = render({ skills: [] });

    expect(markup).toContain("arrives switched on");
    // the exact sentence that was false from 0.1.44 until this test existed
    expect(markup).not.toContain("land switched off");
    expect(markup).not.toContain("switched off until you");

    // Pin the behaviour, not just the words: the string above is only true
    // because the team import enables every library skill it installs. If that
    // loop stops enabling them, this fails here rather than going stale on
    // screen for another forty releases.
    const server = readFileSync(new URL("../../server/index.ts", import.meta.url), "utf8").replace(/\s+/g, " ");
    const start = server.indexOf("for (const skillId of source.skillIds)");
    expect(start).toBeGreaterThan(-1);
    const installLoop = server.slice(start, start + 1200);
    expect(installLoop).toContain("installSkillFromLibrary(created.id, skillId, SKILL_LIBRARY_ROOT)");
    expect(installLoop).toContain("setSkillEnabled(created.id, installed.name, true)");

    // and the other route the copy names: a learned skill is enabled when its
    // proposal is confirmed, not left off for a second visit to this panel
    const skills = readFileSync(new URL("../../server/skills.ts", import.meta.url), "utf8").replace(/\s+/g, " ");
    expect(skills).toContain('staged.action === "create" ? installPreparedSkill(botId, staged.source, prepared, { enabled: true,');
  });

  it("describes /learn only where /learn exists", () => {
    expect(render({ skills: [], authoringEnabled: true })).toContain("/learn in chat");
    expect(render({ skills: [], authoringEnabled: false })).not.toContain("/learn");
  });

  it("names the bot while its skills are loading", () => {
    expect(render({ phase: "loading" })).toContain("Loading Ember&#x27;s skills…");
  });

  it("shows the SKILL.md text once a skill is opened", () => {
    const markup = render({
      skills: [skill()],
      viewing: { name: "chart-analysis", text: "## When to use\n\nWhen a chart is attached.", error: "" },
    });

    expect(markup).toContain("When to use");
    expect(markup).toContain("When a chart is attached.");
    expect(markup).toContain("All skills");
  });

  it("says what failed when SKILL.md will not open, and offers the read again", () => {
    const markup = render({
      skills: [skill()],
      viewing: { name: "chart-analysis", text: null, error: "Could not read “chart-analysis”. no such skill" },
    });

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("no such skill");
    // without a retry a transient read failure strands the skill forever
    expect(markup).toContain("Try again");
  });

  it("pages a hired bot's hundreds of skills instead of laying them all out", () => {
    const many = Array.from({ length: 120 }, (_, index) =>
      skill({ name: `skill-${index}`, description: `does ${index}` }),
    );
    const markup = render({ skills: many });

    expect(markup).toContain("skill-39");
    expect(markup).not.toContain("skill-40<");
    expect(markup).toContain(`Show ${SKILL_PAGE_SIZE} more · 80 left`);
  });

  it("filters on name and description together", () => {
    const skills = [
      skill(),
      skill({ name: "morning-prep", description: "Assemble the pre-open brief." }),
    ];
    expect(filterSkills(skills, "chart").map((entry) => entry.name)).toEqual(["chart-analysis"]);
    expect(filterSkills(skills, "pre-open").map((entry) => entry.name)).toEqual(["morning-prep"]);
    expect(filterSkills(skills, "  ").map((entry) => entry.name)).toEqual(["chart-analysis", "morning-prep"]);
  });
});

describe("a list that will not load", () => {
  it("says the load failed instead of claiming the bot has no skills", () => {
    const markup = render({ phase: "failed", skills: [], loadFailure: "500 Internal Server Error" });

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Could not load Ember&#x27;s skills. 500 Internal Server Error");
    // the lie: a bot with 200 skills must never read as a bot with none
    expect(markup).not.toContain("has no skills yet");
  });

  it("offers a retry rather than making the user close and reopen the panel", () => {
    expect(render({ phase: "failed", skills: [], loadFailure: "500" })).toContain("Try again");
  });

  it("keeps the list it already had when a refresh fails, and still says so", () => {
    const markup = render({ phase: "failed", skills: [skill()], loadFailure: "network down" });

    expect(markup).toContain("chart-analysis");
    expect(markup).toContain("Could not load Ember&#x27;s skills. network down");
  });
});

describe("the control on a skill that is switched off", () => {
  it("is an honest button, not a switch that does nothing when activated", () => {
    const markup = render({ skills: [skill({ name: "morning-prep", enabled: false })] });

    // enabling requires reading SKILL.md first, so this control opens that
    // view; announcing it as a switch promises a state change that never comes
    expect(markup).toContain('aria-label="Review morning-prep to enable it"');
    expect(markup).toContain("Review to enable");
    expect(markup).not.toContain('aria-label="Enable morning-prep"');
  });

  it("hands focus to the view that replaced it", () => {
    const markup = render({
      skills: [skill({ enabled: false })],
      viewing: { name: "chart-analysis", text: "# read me", error: "" },
    });

    // the effect focuses this container on open; it has to be focusable at all
    expect(markup).toContain('tabindex="-1"');
  });

  it("still lets an already-on skill be switched off when its SKILL.md will not load", () => {
    const stranded = {
      skills: [skill({ enabled: true })],
      viewing: { name: "chart-analysis", text: null, error: "boom" } as const,
    };

    // a failed read must not strand a skill in the on position
    expect(render(stranded)).toContain('aria-label="Disable chart-analysis" type=');
    // and the control still greys out while its own PATCH is in flight
    expect(render({ ...stranded, busy: new Set(["chart-analysis"]) })).toContain(
      'aria-label="Disable chart-analysis" disabled=""',
    );
  });

  it("will not let a skill be switched on before its SKILL.md has been read", () => {
    const markup = render({
      skills: [skill({ enabled: false })],
      viewing: { name: "chart-analysis", text: null, error: "boom" },
    });

    expect(markup).toContain('aria-label="Enable chart-analysis" disabled=""');
  });
});

describe("a skill with no description of its own", () => {
  it("falls back to where it came from rather than an empty line", () => {
    expect(skillDescriptionLine(skill({ description: "" }))).toBe("Library · chart-analysis@1.0.0");
    expect(skillDescriptionLine(skill({ description: "   " }))).toBe("Library · chart-analysis@1.0.0");
    expect(skillDescriptionLine(skill({ description: "", source: "" }))).toBe("No description");
    expect(skillDescriptionLine(skill())).toBe("Read a price chart and name the setup.");
  });

  it("renders that fallback in the row", () => {
    const markup = render({ skills: [skill({ description: "", source: "learn:2026-08-01" })] });

    expect(markup).toContain("Learned in chat");
  });
});

describe("an empty SKILL.md", () => {
  it("reads as empty, not as a file that must be removed and re-imported", () => {
    const markup = render({
      skills: [skill()],
      viewing: { name: "chart-analysis", text: "", error: "" },
    });

    expect(markup).toContain("This skill&#x27;s SKILL.md is empty.");
    expect(markup).not.toContain("remove and import");
    expect(markup).not.toContain('role="alert"');
  });
});

describe("switching a skill on and off", () => {
  const track = (initial: BotSkill[]) => {
    let skills = initial;
    return {
      apply: (update: (current: BotSkill[]) => BotSkill[]) => {
        skills = update(skills);
      },
      get current() {
        return skills;
      },
    };
  };

  it("PATCHes { enabled } for that skill and keeps the server's answer", async () => {
    const list = track([skill({ enabled: false })]);
    const request = vi.fn<SkillsRequest>(async () => ({ skill: skill({ enabled: true, warnings: ["network access"] }) }));

    const result = await toggleSkillEnabled({
      botId: "bot-1",
      name: "chart-analysis",
      enabled: true,
      apply: list.apply,
      request,
    });

    expect(result).toEqual({ ok: true });
    expect(request).toHaveBeenCalledWith("/api/bots/bot-1/skills/chart-analysis", {
      method: "PATCH",
      body: JSON.stringify({ enabled: true }),
    });
    expect(list.current[0]!.enabled).toBe(true);
    expect(list.current[0]!.warnings).toEqual(["network access"]);
  });

  it("flips the row before the request answers", async () => {
    const list = track([skill({ enabled: false })]);
    const pending = deferred<{ skill: BotSkill }>();

    const settled = toggleSkillEnabled({
      botId: "bot-1",
      name: "chart-analysis",
      enabled: true,
      apply: list.apply,
      request: () => pending.promise,
    });

    expect(list.current[0]!.enabled).toBe(true);
    pending.resolve({ skill: skill({ enabled: true }) });
    await settled;
  });

  it("rolls the row back and says what failed when the PATCH is refused", async () => {
    const list = track([skill({ enabled: false }), skill({ name: "morning-prep", enabled: false })]);

    const result = await toggleSkillEnabled({
      botId: "bot-1",
      name: "chart-analysis",
      enabled: true,
      apply: list.apply,
      request: async () => {
        throw new Error("stored SKILL.md changed after review");
      },
    });

    expect(result).toEqual({
      ok: false,
      error: "Could not enable “chart-analysis”. stored SKILL.md changed after review",
    });
    expect(list.current[0]!.enabled).toBe(false);
  });

  it("rolls back by the inverse edit, so a concurrent toggle survives the failure", async () => {
    const list = track([skill({ enabled: false }), skill({ name: "morning-prep", enabled: false })]);

    const failing = toggleSkillEnabled({
      botId: "bot-1",
      name: "chart-analysis",
      enabled: true,
      apply: list.apply,
      request: async () => {
        throw new Error("nope");
      },
    });
    // a second row is switched on while the first request is still in flight
    list.apply((current) => applySkillEnabled(current, "morning-prep", true));
    await failing;

    expect(list.current.map((entry) => entry.enabled)).toEqual([false, true]);
  });
});

describe("the panel's data layer", () => {
  const listing = (skills: BotSkill[], staged: { id: string; name: string; gist: string }[] = []) => ({
    skills,
    staged,
  });

  it("stores exactly the skills the GET returned", async () => {
    const skills = [skill(), skill({ name: "morning-prep", enabled: false })];
    const request = vi.fn<SkillsRequest>(async () => listing(skills, [{ id: "s1", name: "new-thing", gist: "does a thing" }]));
    const store = createSkillsStore({ botId: "bot-1", request });

    await store.load();

    expect(request).toHaveBeenCalledWith("/api/bots/bot-1/skills");
    expect(store.getSnapshot().phase).toBe("ready");
    expect(store.getSnapshot().skills.map((entry) => entry.name)).toEqual(["chart-analysis", "morning-prep"]);
    expect(store.getSnapshot().skills[1]!.enabled).toBe(false);
    expect(store.getSnapshot().staged.map((entry) => entry.name)).toEqual(["new-thing"]);
  });

  it("does not turn a failed GET into an empty list", async () => {
    const request = vi.fn<SkillsRequest>(async () => {
      throw new Error("500 Internal Server Error");
    });
    const store = createSkillsStore({ botId: "bot-1", request });

    await store.load();

    expect(store.getSnapshot().phase).toBe("failed");
    expect(store.getSnapshot().phase).not.toBe("ready");
    expect(store.getSnapshot().loadFailure).toBe("500 Internal Server Error");
  });

  it("keeps the skills it already had when a refresh fails", async () => {
    let broken = false;
    const request = vi.fn<SkillsRequest>(async () => {
      if (broken) throw new Error("network down");
      return listing([skill()]);
    });
    const store = createSkillsStore({ botId: "bot-1", request });

    await store.load();
    broken = true;
    await store.load();

    expect(store.getSnapshot().phase).toBe("failed");
    expect(store.getSnapshot().skills.map((entry) => entry.name)).toEqual(["chart-analysis"]);
  });

  it("recovers on a retry after a failed load", async () => {
    let broken = true;
    const request = vi.fn<SkillsRequest>(async () => {
      if (broken) throw new Error("500");
      return listing([skill()]);
    });
    const store = createSkillsStore({ botId: "bot-1", request });

    await store.load();
    expect(store.getSnapshot().phase).toBe("failed");

    broken = false;
    await store.load();

    expect(store.getSnapshot().phase).toBe("ready");
    expect(store.getSnapshot().loadFailure).toBe("");
    expect(store.getSnapshot().skills).toHaveLength(1);
  });

  it("throws away the answer to a load a newer one superseded", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    let call = 0;
    const request = vi.fn<SkillsRequest>(async () => (++call === 1 ? first.promise : second.promise));
    const store = createSkillsStore({ botId: "bot-1", request });

    const stale = store.load();
    const fresh = store.load();
    second.resolve(listing([skill({ name: "morning-prep" })]));
    await fresh;
    first.resolve(listing([skill({ name: "chart-analysis" })]));
    await stale;

    expect(store.getSnapshot().skills.map((entry) => entry.name)).toEqual(["morning-prep"]);
  });

  it("asks for the bot it was built for, so switching bots reloads", async () => {
    const request = vi.fn<SkillsRequest>(async () => listing([skill()]));

    await createSkillsStore({ botId: "bot-1", request }).load();
    await createSkillsStore({ botId: "bot-2", request }).load();

    expect(request.mock.calls.map((call) => call[0])).toEqual([
      "/api/bots/bot-1/skills",
      "/api/bots/bot-2/skills",
    ]);
  });

  it("is rebuilt for each bot id, which is what makes the panel refire", () => {
    // The three lines that bind the store to bot.id cannot execute in this
    // repo's node-environment vitest (no DOM, so no hooks), and a wrong
    // dependency there silently shows one bot's skills under another's name.
    const source = readFileSync(new URL("./BotSkillsPanel.tsx", import.meta.url), "utf8").replace(/\s+/g, " ");
    const start = source.indexOf("const store = useMemo(");
    const wiring = source.slice(start, source.indexOf("return (", start));

    expect(start).toBeGreaterThan(-1);

    expect(wiring).toContain("createSkillsStore({ botId: bot.id, request: api })");
    expect(wiring).toMatch(/useMemo\(.*\[bot\.id\]\)/);
    expect(wiring).toContain("void store.load();");
    expect(wiring).toMatch(/useEffect\(.*\[store\]\)/);
  });

  it("GETs the named skill when one is opened and keeps its text", async () => {
    const request = vi.fn<SkillsRequest>(async (path) =>
      path.endsWith("/skills") ? listing([skill()]) : { text: "# Chart analysis\n\nRead the chart." },
    );
    const store = createSkillsStore({ botId: "bot-1", request });
    await store.load();

    await store.open(skill());

    expect(request).toHaveBeenCalledWith("/api/bots/bot-1/skills/chart-analysis");
    expect(store.getSnapshot().viewing).toEqual({
      name: "chart-analysis",
      text: "# Chart analysis\n\nRead the chart.",
      error: "",
    });
  });

  it("keeps an empty SKILL.md as empty text rather than calling it unavailable", async () => {
    const request = vi.fn<SkillsRequest>(async (path) => (path.endsWith("/skills") ? listing([skill()]) : { text: "" }));
    const store = createSkillsStore({ botId: "bot-1", request });
    await store.load();

    await store.open(skill());

    expect(store.getSnapshot().viewing).toEqual({ name: "chart-analysis", text: "", error: "" });
  });

  it("says the stored file is unavailable only when the response carries no text at all", async () => {
    const request = vi.fn<SkillsRequest>(async (path) => (path.endsWith("/skills") ? listing([skill()]) : {}));
    const store = createSkillsStore({ botId: "bot-1", request });
    await store.load();

    await store.open(skill());

    expect(store.getSnapshot().viewing?.error).toContain("The stored SKILL.md is unavailable");
  });

  it("DELETEs the named skill and reloads the list", async () => {
    let removed = false;
    const request = vi.fn<SkillsRequest>(async (_path, init) => {
      if (init?.method === "DELETE") {
        removed = true;
        return { ok: true };
      }
      return listing(removed ? [] : [skill()]);
    });
    const store = createSkillsStore({ botId: "bot-1", request });
    await store.load();

    await store.remove(skill());

    expect(request).toHaveBeenCalledWith("/api/bots/bot-1/skills/chart-analysis", { method: "DELETE" });
    expect(store.getSnapshot().skills).toEqual([]);
    expect(store.getSnapshot().phase).toBe("ready");
  });

  it("says which skill would not be removed and leaves the list alone", async () => {
    const request = vi.fn<SkillsRequest>(async (_path, init) => {
      if (init?.method === "DELETE") throw new Error("no such skill");
      return listing([skill()]);
    });
    const store = createSkillsStore({ botId: "bot-1", request });
    await store.load();

    await store.remove(skill());

    expect(store.getSnapshot().rowErrors.get("chart-analysis")).toBe(
      "Could not remove “chart-analysis”. no such skill",
    );
    expect(store.getSnapshot().skills).toHaveLength(1);
  });

  it("opens the SKILL.md instead of PATCHing when a switched-off skill is toggled", async () => {
    const request = vi.fn<SkillsRequest>(async (path) => (path.endsWith("/skills") ? listing([skill({ enabled: false })]) : { text: "read me" }));
    const store = createSkillsStore({ botId: "bot-1", request });
    await store.load();

    await store.toggle(skill({ enabled: false }));

    expect(request.mock.calls.every((call) => call[1]?.method !== "PATCH")).toBe(true);
    expect(store.getSnapshot().viewing?.name).toBe("chart-analysis");
  });
});

describe("two rows toggled at once", () => {
  const alpha = skill({ name: "alpha", enabled: true });
  const beta = skill({ name: "beta", enabled: true });

  const harness = () => {
    const a = deferred<unknown>();
    const b = deferred<unknown>();
    const request = vi.fn<SkillsRequest>(async (path) => {
      if (path.endsWith("/alpha")) return a.promise;
      if (path.endsWith("/beta")) return b.promise;
      return { skills: [alpha, beta], staged: [] };
    });
    return { a, b, store: createSkillsStore({ botId: "bot-1", request }), request };
  };

  it("holds both rows busy, and one finishing does not free the other", async () => {
    const { a, b, store } = harness();
    await store.load();

    const toggleA = store.toggle(alpha);
    const toggleB = store.toggle(beta);
    expect([...store.getSnapshot().busy].sort()).toEqual(["alpha", "beta"]);

    a.resolve({ skill: { ...alpha, enabled: false } });
    await toggleA;

    // beta's PATCH is still in flight: re-enabling its control here is what
    // let a second click compute the opposite request from the flipped row
    expect(store.getSnapshot().busy.has("beta")).toBe(true);
    expect(store.getSnapshot().busy.has("alpha")).toBe(false);

    b.resolve({ skill: { ...beta, enabled: false } });
    await toggleB;
    expect(store.getSnapshot().busy.size).toBe(0);
  });

  it("ignores a second toggle of a row whose request is still running", async () => {
    const { a, b, store, request } = harness();
    await store.load();

    const toggleA = store.toggle(alpha);
    await store.toggle(alpha);

    expect(request.mock.calls.filter((call) => call[1]?.method === "PATCH")).toHaveLength(1);
    a.resolve({ skill: { ...alpha, enabled: false } });
    await toggleA;
    b.resolve({});
  });

  it("does not let one row's success wipe another row's failure", async () => {
    const { a, b, store } = harness();
    await store.load();

    const toggleA = store.toggle(alpha);
    const toggleB = store.toggle(beta);

    a.reject(new Error("stored SKILL.md changed after review"));
    await toggleA;
    expect(store.getSnapshot().rowErrors.get("alpha")).toBe(
      "Could not disable “alpha”. stored SKILL.md changed after review",
    );

    b.resolve({ skill: { ...beta, enabled: false } });
    await toggleB;

    expect(store.getSnapshot().rowErrors.get("alpha")).toBe(
      "Could not disable “alpha”. stored SKILL.md changed after review",
    );
    expect(store.getSnapshot().rowErrors.has("beta")).toBe(false);
  });

  it("shows each row's failure on that row", () => {
    const markup = render({
      skills: [alpha, beta],
      rowErrors: new Map([["alpha", "Could not disable “alpha”. nope"]]),
    });

    expect(markup).toContain("Could not disable “alpha”. nope");
    expect(markup).toContain('role="alert"');
  });
});

describe("proposals waiting in chat", () => {
  it("is still visible on a bot that has no installed skills yet", () => {
    const markup = render({ skills: [], staged: 1 });

    expect(markup).toContain("1 proposal is waiting for a decision in chat.");
  });

  it("counts alongside an existing list", () => {
    const markup = render({ skills: [skill()], staged: 2 });

    expect(markup).toContain("2 proposals are waiting in chat");
  });
});
