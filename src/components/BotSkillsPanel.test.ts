import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  applySkillEnabled,
  filterSkills,
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
      loading: false,
      skills: [],
      staged: 0,
      authoringEnabled: false,
      query: "",
      onQuery: vi.fn(),
      visible: SKILL_PAGE_SIZE,
      onShowMore: vi.fn(),
      busy: "",
      error: "",
      viewing: null,
      onOpen: vi.fn(),
      onBack: vi.fn(),
      onToggle: vi.fn(),
      onRemove: vi.fn(),
      ...over,
    }),
  );

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
    expect(markup).toContain('aria-label="Enable morning-prep"');
    expect(markup).toContain("1 of 2 on");
  });

  it("says a bot has none and where skills come from, never a blank box", () => {
    const markup = render({ skills: [] });

    expect(markup).toContain("Ember has no skills yet.");
    expect(markup).toContain("team library");
    expect(markup).toContain("GitHub import");
    expect(markup).not.toContain("aria-label=\"Search");
  });

  it("names the bot while its skills are loading", () => {
    expect(render({ loading: true })).toContain("Loading Ember&#x27;s skills…");
  });

  it("says what failed when the list will not load", () => {
    const markup = render({ error: "Could not load Ember's skills. 500 Internal Server Error" });

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Could not load Ember&#x27;s skills. 500 Internal Server Error");
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

  it("says what failed when SKILL.md will not open", () => {
    const markup = render({
      skills: [skill()],
      viewing: { name: "chart-analysis", text: null, error: "Could not read “chart-analysis”. no such skill" },
    });

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("no such skill");
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
    const request = vi.fn(async () => ({ skill: skill({ enabled: true, warnings: ["network access"] }) }));

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
    let release: (value: { skill: BotSkill }) => void = () => {};
    const pending = new Promise<{ skill: BotSkill }>((resolve) => {
      release = resolve;
    });

    const settled = toggleSkillEnabled({
      botId: "bot-1",
      name: "chart-analysis",
      enabled: true,
      apply: list.apply,
      request: () => pending,
    });

    expect(list.current[0]!.enabled).toBe(true);
    release({ skill: skill({ enabled: true }) });
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
