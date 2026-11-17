// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The capability database (CAPABILITY-DB-1010): the YAML under
// shared/capabilities is valid, the generated shared/capability-db.ts is fresh,
// every settings path is one the app renders and belongs to the thing the
// entry's anchor names, and `rev` moves only when a fact moves.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { CAPABILITY_DB_REV, CAPABILITY_ENTRIES } from "./capability-db.ts";
import { removeTempDirSync } from "../server/testing/cleanup.ts";
import { SECTION_PAGES } from "../src/lib/settings-pages";
import { SETTINGS_CARDS, cardLabel } from "../src/lib/settings-card-registry";
import en from "../src/locales/en.json";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = join(root, "scripts", "build-capability-db.mjs");
const SOURCE = join(root, "shared", "capabilities");
const scratch = mkdtempSync(join(tmpdir(), "capdb-"));
afterAll(() => removeTempDirSync(scratch));

function run(args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execFileSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8", stdio: "pipe" }) };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return { ok: false, out: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

let fixtureCount = 0;
/** A copy of the real YAML with one change, checked against a fresh generated file of its own. */
function checkFixture(mutate: (files: Map<string, { schema: number; entries: Record<string, unknown>[]; retired?: unknown[] }>) => void) {
  const dir = join(scratch, `src-${fixtureCount += 1}`);
  cpSync(SOURCE, dir, { recursive: true });
  const files = new Map(readdirSync(dir).filter((name) => name.endsWith(".yaml")).map((name) => [name, parse(readFileSync(join(dir, name), "utf8"))]));
  mutate(files);
  for (const [name, doc] of files) writeFileSync(join(dir, name), stringify(doc));
  const out = join(scratch, `db-${fixtureCount}.ts`);
  const written = run(["--src", dir, "--out", out]);
  if (!written.ok) return written;
  return run(["--check", "--src", dir, "--out", out]);
}
const entry = (files: Map<string, { entries: Record<string, unknown>[] }>, id: string) => {
  for (const doc of files.values()) {
    const found = doc.entries.find((candidate) => candidate.id === id);
    if (found) return found;
  }
  throw new Error(`no entry ${id}`);
};

const SLICE = [
  "apps.bot-email", "apps.chat-approval-buttons", "apps.own-browser", "apps.web-read", "apps.webhook-routines", "bots.channel-turns", "bots.rename-chief",
  "engines.continue-with-chatgpt-grok", "engines.default-models", "engines.grok-images", "engines.muse-code", "engines.openai-compatible-tools", "engines.set-up-claude-code", "engines.set-up-from-the-app", "engines.use-my-subscription",
  "install-account.policy-lock", "install-account.ubuntu-computer-control", "limits.plan-usage", "limits.spending-per-bot",
  "memory.learn-about-me", "memory.pin",
  "settings.notification-chooser", "settings.review-and-approve-all", "settings.search-chief-fallback",
  "skills.library",
];

// Every bullet under "## New" in release-notes/1.0.19.md, by its bold title, and the capability entries that answer it.
const NEW_IN_1019: Record<string, string[]> = {
  "The whole library, within reach.": ["skills.library"],
  "Read before you add.": ["skills.library"],
  "Settings, all in one place.": ["settings.search-chief-fallback"],
  "Pick how Murage reaches you.": ["settings.notification-chooser"],
  "Read beyond the search result.": ["apps.web-read"],
  "Review the whole change.": ["settings.review-and-approve-all"],
};

describe("capability database", () => {
  it("reads localized, shared and literal card names from the rendered registry", async () => {
    const { buildNavigation } = await import("../scripts/build-capability-db.mjs");
    const { cards } = buildNavigation();
    expect(cards.get("memory/browser")?.label).toBe("Open memory");
    expect(cards.get("general/send-key")?.label).toBe("Sending messages");
    expect(cards.get("connections/bot-email")?.label).toBe("Bot email");
    expect(cards.get("connections/phone-calls")?.label).toBe("Phone calls");
    expect(cards.get("about/health")?.label).toBe("Health");
    expect(cards.get("usage/spend-limit")?.label).toBe("Monthly spending notice");
  });

  it("reads every current Settings page and preserves each card's stable identity and actual page", async () => {
    const { buildNavigation } = await import("../scripts/build-capability-db.mjs");
    const navigation = buildNavigation();
    expect([...navigation.pages.values()]).toEqual(SECTION_PAGES.map((page) => ({
      id: page.id, label: en[`settings.page.${page.id}`], desktopOnly: Boolean(page.desktopOnly),
    })));
    expect([...navigation.cards.keys()].sort()).toEqual(SETTINGS_CARDS.map((card) => card.id.replace(".", "/")).sort());
    for (const card of SETTINGS_CARDS) {
      expect(navigation.cards.get(card.id.replace(".", "/")), card.id).toEqual({
        id: card.id, page: card.section, anchor: card.anchor, advanced: card.advanced, surface: card.surface,
        label: cardLabel(card),
      });
    }
    expect(navigation.paths.get("Settings → Computer & browser → Built-in browser")).toEqual({
      owner: "card:companion/browser", page: "computer", desktopOnly: true,
    });
    expect(navigation.paths.has("Settings → Phone and other devices → Built-in browser")).toBe(false);
  });

  it("is valid and the generated file is fresh (recomputed from the sources, never the committed inventory)", () => {
    const result = run(["--check"]);
    expect(result.out).toContain("capability db up to date");
    expect(result.ok).toBe(true);
  });

  it("holds exactly the reviewed entries", () => {
    expect(CAPABILITY_ENTRIES.map((record) => record.capability).sort()).toEqual(SLICE);
    for (const record of CAPABILITY_ENTRIES) expect(record.id).toBe(`cap:${record.capability}`);
    expect(CAPABILITY_DB_REV).toMatch(/^[0-9a-f]{64}$/);
  });

  it("has a since-1.0.19 entry for every feature marked New in the 1.0.19 release notes", () => {
    const notes = readFileSync(join(root, "release-notes", "1.0.19.md"), "utf8");
    const section = notes.split(/^## New\s*$/m)[1]?.split(/^## /m)[0] ?? "";
    const titles = [...section.matchAll(/^- \*\*(.+?)\*\*/gm)].map((match) => match[1]);
    expect(titles.length).toBeGreaterThan(0);
    // A new New bullet with no mapping here fails: add the entry, then name it.
    expect(titles.sort()).toEqual(Object.keys(NEW_IN_1019).sort());
    const yamlEntries = readdirSync(join(root, "shared", "capabilities")).filter((file) => file.endsWith(".yaml"))
      .flatMap((file) => parse(readFileSync(join(root, "shared", "capabilities", file), "utf8")).entries as { id: string; since?: string; verified?: string }[]);
    for (const id of new Set(Object.values(NEW_IN_1019).flat())) {
      expect(CAPABILITY_ENTRIES.some((candidate) => candidate.capability === id), id).toBe(true);
      const source = yamlEntries.find((candidate) => candidate.id === id);
      expect(String(source?.since), id).toBe("1.0.19");
      expect(String(source?.verified), id).toBe("1.0.19");
    }
  });

  const row = (id: string) => {
    const found = CAPABILITY_ENTRIES.find((candidate) => candidate.capability === id);
    expect(found, id).toBeDefined();
    return found!;
  };

  it("pins the answer and applicability for skills.library", () => {
    const skills = row("skills.library");
    expect(skills.status).toBe("can");
    expect(skills.answer).toContain("2,247 skills across 141 topics");
    expect(skills.answer).toContain("Save as my copy");
    expect(skills.answer).toContain("Go back to the original");
    expect(skills.limits).toContain("Skill Guard checks a skill before a bot can use it");
    expect(skills.limits).toContain("desktop app only");
    expect(skills.platforms).toEqual(["mac", "windows", "linux"]);
    expect(skills.engines).toEqual(["all"]);
  });

  it("pins the answer and applicability for apps.web-read", () => {
    const web = row("apps.web-read");
    expect(web.status).toBe("can");
    expect(web.answer).toContain("read it with Murage");
    expect(web.limits).toContain("16,000 characters");
    expect(web.limits).toContain("untrusted text");
    expect(web.limits).toMatch(/OpenClaw and Box Agent read pages with their own tools/);
    expect(web.engines).not.toContain("openclaw");
    expect(web.engines).not.toContain("all");
    for (const engine of ["fuigo", "claude", "codex", "gemini"]) expect(web.engines).toContain(engine);
    expect(web.applies).not.toMatch(/OpenClaw|Box Agent|every engine/);
    expect(web.limits).toContain("so may some agent engines");
  });

  it("pins the answer and applicability for engines.default-models", () => {
    const models = row("engines.default-models");
    expect(models.answer).toContain("Claude Sonnet 5.5");
    expect(models.answer).toContain("Claude Fable 5.2 (whether your Claude Code version accepts it is separate)");
    expect(models.answer).toContain("GPT-6.1 Sol");
    expect(models.limits).toContain("Fuigo 1.0.43");
    expect(models.platforms).toEqual(["mac", "windows", "linux", "cloud"]);
    expect(models.engines).toEqual(["claude", "codex"]);
    const modelSource = parse(readFileSync(join(SOURCE, "engines.yaml"), "utf8")).entries
      .find((candidate: { id: string }) => candidate.id === "engines.default-models");
    expect(String(modelSource?.verified)).toBe("1.0.19");
  });

  it("pins the answer and applicability for settings.search-chief-fallback", () => {
    const search = row("settings.search-chief-fallback");
    expect(search.status).toBe("can");
    expect(search.answer).toContain("ask your Chief of Staff");
    expect(search.limits).toContain("only once you have a bot to ask");
    expect(search.engines).toEqual(["all"]);
  });

  it("pins the answer and applicability for settings.notification-chooser", () => {
    const chooser = row("settings.notification-chooser");
    expect(chooser.status).toBe("can");
    expect(chooser.answer).toContain("It lists what your computer supports");
    expect(chooser.limits).toContain("The chooser is in the desktop app");
    expect(chooser.platforms).toEqual(["mac", "windows", "linux"]);
  });

  it("pins the answer and applicability for settings.review-and-approve-all", () => {
    const review = row("settings.review-and-approve-all");
    expect(review.status).toBe("can");
    expect(review.answer).toMatch(/Approve all/);
    expect(review.limits).toContain("desktop app and the owner's phone app, never a browser");
  });

  it("qualifies the notification chooser: the pill is Mac only, not every unsupported option is listed (review 1019-n2 Low)", () => {
    const record = CAPABILITY_ENTRIES.find((candidate) => candidate.capability === "settings.notification-chooser");
    expect(record?.limits).toMatch(/menu bar pill/i);
    expect(record?.limits).toMatch(/Mac only/);
    expect(record?.limits).not.toMatch(/^An option your computer cannot do is shown with the reason, and/);
  });

  it("says webhook routines exist and that the desktop link is local only (WEBHOOK-SELF-KNOWLEDGE-1015)", () => {
    const record = CAPABILITY_ENTRIES.find((candidate) => candidate.capability === "apps.webhook-routines");
    expect(record?.status).toBe("partial");
    expect(record?.answer).toContain("webhook routine gives a bot a link");
    expect(record?.limits).toContain("listens on this computer only, so outside services such as Stripe cannot reach it yet");
    expect(record?.platforms).toEqual(["mac", "windows", "linux"]);
    // The bot reads the same fact where it makes one: the propose_routine description.
    expect(readFileSync(join(root, "server", "drivers", "agents-proxy.ts"), "utf8")).toContain("On the desktop app that link listens on this computer only");
  });

  it("rejects a Settings path under the wrong parent", () => {
    const result = checkFixture((files) => { entry(files, "bots.channel-turns").settings_path = "Settings → Memory → Advanced → Channel turn timeout"; });
    expect(result.ok).toBe(false);
    expect(result.out).toContain("is not a path the app renders");
  });

  it("rejects a real label borrowed by an entry whose anchor is another card on the same page", () => {
    const result = checkFixture((files) => {
      const record = entry(files, "bots.channel-turns");
      record.anchors = ["settings-card:botDefaults/new-bot-effort"];
    });
    expect(result.ok).toBe(false);
    expect(result.out).toContain("belongs to card:botDefaults/channel-turns");
  });

  it("accepts a moved card's current page with its stable anchor", () => {
    const result = checkFixture((files) => {
      entry(files, "apps.own-browser").settings_path = "Settings → Computer & browser";
    });
    expect(result.out).toContain("capability db up to date");
    expect(result.ok).toBe(true);
  });

  it("rejects a moved card's former page even though the page and stable anchor still exist", () => {
    const result = checkFixture((files) => {
      entry(files, "apps.own-browser").settings_path = "Settings → Phone and other devices";
    });
    expect(result.ok).toBe(false);
    expect(result.out).toContain("is on page companion, but the card anchor is on computer");
  });

  it("keeps a moved desktop card unavailable to phone platforms", () => {
    const result = checkFixture((files) => {
      entry(files, "apps.own-browser").platforms = ["all"];
    });
    expect(result.ok).toBe(false);
    expect(result.out).toContain("is desktop only");
  });

  it("rejects a reused id", () => {
    const result = checkFixture((files) => {
      const doc = [...files.values()].find((candidate) => candidate.entries.some((record) => record.id === "memory.pin"))!;
      doc.entries.push({ ...entry(files, "memory.pin") });
    });
    expect(result.ok).toBe(false);
    expect(result.out).toContain("is used again");
  });

  it("rejects a cannot entry with no ask_your_bot step (House Rule 4)", () => {
    const result = checkFixture((files) => { entry(files, "install-account.policy-lock").ask_your_bot = ""; });
    expect(result.ok).toBe(false);
    expect(result.out).toContain("needs ask_your_bot");
  });

  it("rejects a phone platform on a desktop-only Settings path", () => {
    const result = checkFixture((files) => { entry(files, "memory.learn-about-me").platforms = ["all"]; });
    expect(result.ok).toBe(false);
    expect(result.out).toContain("is desktop only");
  });

  it("rejects copy that breaks the rules", () => {
    const result = checkFixture((files) => { entry(files, "memory.pin").answer = "It is safe and free — always."; });
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/dash/);
    expect(result.out).toMatch(/"safe"/);
    expect(result.out).toMatch(/"free"/);
  });

  it("rejects a stale generated file", () => {
    const out = join(scratch, "stale.ts");
    expect(run(["--out", out]).ok).toBe(true);
    writeFileSync(out, readFileSync(out, "utf8").replace(/"rev": "[0-9a-f]{64}"/, `"rev": "${"0".repeat(64)}"`));
    const result = run(["--check", "--out", out]);
    expect(result.ok).toBe(false);
    expect(result.out).toContain("is stale");
  });
});

describe("rev moves only when an answer-relevant fact moves", () => {
  it("is identical across rebuilds, version and verified bumps, and reformatting", async () => {
    const { buildDatabase, entryRev } = await import("../scripts/build-capability-db.mjs");
    const first = await buildDatabase();
    const second = await buildDatabase();
    expect(second.entries.map((record: { rev: string }) => record.rev)).toEqual(first.entries.map((record: { rev: string }) => record.rev));
    const base = first.entries.find((record: { id: string }) => record.id === "memory.learn-about-me");
    expect(entryRev({ ...base, verified: "9.9.9", since: "0.0.1", doc: "other", questions: ["a", "b", "c"], internal: "note" })).toBe(base.rev);
    expect(entryRev({ ...base, answer: `  ${base.answer.replace(/ /g, "\n ")}  ` })).toBe(base.rev);
    expect(entryRev({ ...base, platforms: [...base.platforms].reverse() })).toBe(base.rev);
  });

  it("changes when status, answer, limits, ask_your_bot, settings_path, platforms or engines change", async () => {
    const { buildDatabase, entryRev } = await import("../scripts/build-capability-db.mjs");
    const base = (await buildDatabase()).entries.find((record: { id: string }) => record.id === "limits.spending-per-bot");
    const changes = [
      { status: "cannot" }, { answer: `${base.answer} More.` }, { limits: `${base.limits} Also this.` },
      { ask_your_bot: `${base.ask_your_bot} Again.` }, { settings_path: "Settings → Bots" }, { platforms: ["mac"] }, { engines: ["fuigo"] },
    ];
    for (const change of changes) expect(entryRev({ ...base, ...change }), JSON.stringify(change)).not.toBe(base.rev);
  });
});

describe("export and diff", () => {
  it("exports without internal fields and with the app's valid paths, and a bootstrap diff reports every entry as added", () => {
    const file = join(scratch, "export.json");
    expect(run(["--export", file, "--sha", "abc123"]).ok).toBe(true);
    const exported = JSON.parse(readFileSync(file, "utf8"));
    expect(exported.db_rev).toBe(CAPABILITY_DB_REV);
    expect(exported.sha).toBe("abc123");
    expect(exported.entries).toHaveLength(SLICE.length);
    expect(JSON.stringify(exported)).not.toContain("\"internal\"");
    for (const record of exported.entries) expect(record.applies).toMatch(/^Applies to /);
    expect(exported.valid_paths).toEqual(expect.arrayContaining([
      "Settings → How every bot behaves → Advanced → Time limit for bot activity in channels", "Settings → Memory → Learn about me", "Team map", "Routines", "Connected apps", "Tools",
    ]));
    const diff = run(["--diff", join(scratch, "no-previous.json"), "--current", file]);
    expect(diff.ok).toBe(true);
    expect(diff.out).toContain(`+${SLICE.length} added`);
  });

  it("fails when an id from the previous export is neither an entry nor retired", () => {
    const file = join(scratch, "export2.json");
    expect(run(["--export", file]).ok).toBe(true);
    const previous = JSON.parse(readFileSync(file, "utf8"));
    previous.entries.push({ ...previous.entries[0], id: "memory.gone" });
    previous.entries[1] = { ...previous.entries[1], rev: "0".repeat(64) };
    const previousFile = join(scratch, "previous.json");
    writeFileSync(previousFile, JSON.stringify(previous));
    const diff = run(["--diff", previousFile, "--current", file]);
    expect(diff.ok).toBe(false);
    expect(diff.out).toContain("memory.gone");
    expect(diff.out).toContain("Facts changed");
  });

  it("keeps retired ids retired: a dropped tombstone or a reused retired id fails", () => {
    const file = join(scratch, "export3.json");
    expect(run(["--export", file]).ok).toBe(true);
    const previous = JSON.parse(readFileSync(file, "utf8"));
    previous.retired = [{ id: "memory.old-thing", version: "1.0.9", why: "replaced" }, { id: "memory.pin", version: "1.0.9", why: "test" }];
    const previousFile = join(scratch, "previous-retired.json");
    writeFileSync(previousFile, JSON.stringify(previous));
    const diff = run(["--diff", previousFile, "--current", file]);
    expect(diff.ok).toBe(false);
    expect(diff.out).toContain("memory.old-thing");
    expect(diff.out).toContain("retired id(s) reused as entries: memory.pin");
  });

  it("ships the export as a named release asset that the installed updater's checksum file never lists", () => {
    const workflow = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8");
    expect(workflow).toContain('node scripts/build-capability-db.mjs --export "release/capability-db-$v.json" --sha "$CANDIDATE_SHA"');
    expect(workflow).not.toMatch(/releases\/latest[^\n]*\|\| true/);
    expect(workflow).toContain("release/capability-db-*.json");
    expect(workflow).toMatch(/required=\([\s\S]*"capability-db-\$VERSION\.json"[\s\S]*?\)/);
    expect(workflow).toContain("sha256sum Murage-$v-amd64.deb Murage-$v-x86_64.AppImage > SHA256SUMS-ubuntu-x64.txt");
    expect(workflow).toContain("--diff \"$previous\" --current \"assets/capability-db-$VERSION.json\"");
    const verifier = readFileSync(join(root, "scripts", "verify-linux-package.mjs"), "utf8");
    for (const where of ["resources", "debResources", "appImageResources"]) expect(verifier).toContain(`verifyCapabilityDb(${where})`);
  });
});
