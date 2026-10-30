#!/usr/bin/env node
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Builds src/lib/screens-index.ts: every screen the help panel can be opened
// on (House rule 7, UX-OVERHAUL-PHASE2-SPEC 1.3), with the copy keys for its
// title, intro, tips (at most three) and one line of why, plus the controls
// the screen envelope may name.
//
// The screen list is read from the code, so a new Settings page, bot settings
// section or first-run step cannot ship without help: its keys are missing
// from src/locales/en-ux/l4a.json and this script fails. The words live in
// that fragment file (one copy catalogue, lane prefix ux.l4a.*).
//
//   node scripts/help/gen-screens-index.mjs           write the file
//   node scripts/help/gen-screens-index.mjs --check   fail when it is stale or a rule is broken
//   node scripts/help/gen-screens-index.mjs --stdout  print it instead of writing
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (file) => readFileSync(join(root, file), "utf8").replace(/\r\n/g, "\n");
const OUT = join(root, "src/lib/screens-index.ts");
const COPY_FILE = "src/locales/en-ux/l4a.json";
const MAX_TIPS = 3;
const MAX_TIP_CHARS = 80;

function block(source, start, file) {
  const at = source.indexOf(start);
  if (at < 0) throw new Error(`${file}: cannot find ${start}`);
  return source.slice(at, source.indexOf("];", at));
}
function ids(text) {
  return [...text.matchAll(/\{\s*id:\s*"([A-Za-z0-9-]+)"/g)].map((m) => m[1]);
}

const settingsPages = ids(block(read("src/lib/settings-pages.ts"), "export const SECTION_PAGES", "settings-pages.ts"));
const botSections = ids(block(read("src/components/bot-settings-sections.ts"), "export const BOT_SETTINGS_SECTIONS", "bot-settings-sections.ts"));
const setupMatch = /SETUP_STEPS = \[([^\]]+)\]/.exec(read("shared/setup.ts"));
if (!setupMatch) throw new Error("shared/setup.ts: cannot find SETUP_STEPS");
const setupSteps = [...setupMatch[1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
if (settingsPages.length < 10 || botSections.length < 10 || setupSteps.length < 3) {
  throw new Error(`screen sources look wrong: ${settingsPages.length} pages, ${botSections.length} bot sections, ${setupSteps.length} steps`);
}

// key -> the screen id pattern the envelope carries. `<...>` parts are filled
// at run time (src/lib/screen-envelope.ts resolveHelpScreen).
const screens = [
  ["today", "today"],
  ["chats", "chats"],
  ["chat", "chat:<botId>"],
  ["group", "group:<id>"],
  ["needs-you", "needs-you:<tab>"],
  ["routines", "routines"],
  ["routine", "routine:<id>"],
  ["bot", "bot:<id>"],
  ...botSections.map((section) => [`bot:${section}`, `bot:<id>:${section}`]),
  ["new", "new"],
  ["new-bot", "new-bot"],
  ["connect-app", "connect-app:<slug>"],
  ...settingsPages.map((page) => [`settings:${page}`, `settings:${page}`]),
  ["help", "help"],
  ...setupSteps.map((step) => [`first-run:${step}`, `first-run:${step}`]),
  // FIRSTRUN boards (UX-FIRSTRUN-SCALE-1012 rule 7)
  ["first-run:strip", "first-run:strip"],
  ["rail-fold", "rail-fold"],
  ["client-header", "client-header"],
  ["clients-card", "clients-card"],
  ["other-workspaces", "other-workspaces"],
  ["add-client", "add-client"],
  ["phone-setup", "phone-setup"],
  ["cloud", "cloud"],
  ["files", "files"],
  ["map", "map"],
  ["apps", "apps"],
  ["skill-recorder", "skill-recorder"],
  ["computer", "computer"],
  ["inspector", "inspector"],
  ["no-engines", "no-engines"],
];

// The controls a screen may name in its envelope: an id, a label key and an
// address. Static on purpose: a label read off the page could carry what the
// owner typed.
const SETTINGS_SEARCH = { id: "settings-search", label: "ux.l4a.control.settingsSearch", address: "murage://settings/search" };
const controls = {
  chat: [
    { id: "level", label: "ux.l4a.control.level", address: "murage://bots/<botId>/settings/permissions" },
    { id: "bot-settings", label: "ux.l4a.control.botSettings", address: "murage://bots/<botId>/settings" },
  ],
  chats: [{ id: "new-bot", label: "ux.l4a.control.newBot", address: "murage://new/bot" }],
  apps: [{ id: "connect-app", label: "ux.l4a.control.connectApp", address: "murage://settings/connections" }],
  "no-engines": [{ id: "engines", label: "ux.l4a.control.engines", address: "murage://settings/engines" }],
};
for (const page of settingsPages) controls[`settings:${page}`] = [SETTINGS_SEARCH];

const copy = JSON.parse(read(COPY_FILE));
const problems = [];
// Plain-language rules (COMMON block; UX-PLAIN-LANGUAGE-INVENTORY section 1).
const BANNED = [/[–—]/, /\bsafe(ly|ty)?\b/i, /\b(MCP|ACP|API|CLI|JSON|YAML|OAuth|SSH|PATH)\b/, /\b(token|provider|endpoint|schema|payload|webhook|stdout|stderr|sandbox|daemon|runtime|config|localhost|regex|repo|commit)s?\b/i, /\benv\b/i, /\bport\b/i, /\bmodel id\b/i, /\bexit code\b/i, /\benvironment variable\b/i];
for (const [key, value] of Object.entries(copy)) {
  if (!key.startsWith("ux.l4a.")) problems.push(`${key}: every key in ${COPY_FILE} starts with ux.l4a.`);
  if (typeof value !== "string" || !value.trim()) { problems.push(`${key}: empty`); continue; }
  for (const rule of BANNED) if (rule.test(value)) problems.push(`${key}: "${value}" breaks the plain-language rule ${rule}`);
}
const fill = (text) => text.replaceAll("{mod}", "Ctrl").replaceAll("{name}", "Assistant1");

const entries = screens.map(([key, pattern]) => {
  const base = `ux.l4a.screen.${key.replaceAll(":", ".")}`;
  for (const field of ["title", "intro", "why"]) if (!copy[`${base}.${field}`]) problems.push(`${key}: missing ${base}.${field} in ${COPY_FILE}`);
  const tips = [];
  for (let n = 1; copy[`${base}.tip${n}`] !== undefined; n += 1) tips.push(`${base}.tip${n}`);
  if (tips.length === 0) problems.push(`${key}: needs at least one tip`);
  if (tips.length > MAX_TIPS) problems.push(`${key}: ${tips.length} tips, at most ${MAX_TIPS}`);
  for (const tip of tips) if (fill(copy[tip]).length > MAX_TIP_CHARS) problems.push(`${tip}: over ${MAX_TIP_CHARS} characters`);
  return { key, pattern, title: `${base}.title`, intro: `${base}.intro`, tips, why: `${base}.why`, controls: controls[key] ?? [] };
});
const declared = new Set(entries.flatMap((entry) => [entry.title, entry.intro, entry.why, ...entry.tips]));
for (const key of Object.keys(copy)) {
  if (key.startsWith("ux.l4a.screen.") && !declared.has(key)) problems.push(`${key}: belongs to no screen (or a tip number is skipped)`);
}
for (const list of Object.values(controls)) for (const control of list) if (!copy[control.label]) problems.push(`control ${control.id}: missing ${control.label}`);
if (problems.length) {
  console.error(`screens index: ${problems.length} problem(s)\n  ${problems.join("\n  ")}`);
  process.exit(1);
}

const generated = `// GENERATED by scripts/help/gen-screens-index.mjs. Do not edit by hand.
// Sources: the Settings pages (src/lib/settings-pages.ts), the bot settings
// sections (src/components/bot-settings-sections.ts), the first-run steps
// (shared/setup.ts) and the words in ${COPY_FILE}. Run
// \`node scripts/help/gen-screens-index.mjs\` after changing any of them;
// \`--check\` in the test suite fails when this file is stale.

/** A control a screen may name in its envelope. \`label\` is a copy key; \`address\` may hold \`<botId>\`. */
export interface ScreenControlEntry {
  readonly id: string;
  readonly label: string;
  readonly address: string;
}

/** One screen the help panel knows. Every text field is a copy key (ux.l4a.*). */
export interface ScreenIndexEntry {
  readonly key: string;
  /** The screen id the envelope carries; \`<...>\` parts are filled at run time. */
  readonly pattern: string;
  readonly title: string;
  readonly intro: string;
  readonly tips: readonly string[];
  readonly why: string;
  readonly controls: readonly ScreenControlEntry[];
}

export const SCREENS: readonly ScreenIndexEntry[] = ${JSON.stringify(entries, null, 2)};

const BY_KEY: ReadonlyMap<string, ScreenIndexEntry> = new Map(SCREENS.map((entry) => [entry.key, entry]));

/** The entry for an index key ("chat", "settings:usage"), or undefined. */
export function screenEntry(key: string): ScreenIndexEntry | undefined {
  return BY_KEY.get(key);
}
`;

if (process.argv.includes("--stdout")) {
  process.stdout.write(generated);
} else if (process.argv.includes("--check")) {
  let current = "";
  try { current = readFileSync(OUT, "utf8").replace(/\r\n/g, "\n"); } catch { /* missing reads as stale */ }
  if (current !== generated) {
    console.error("src/lib/screens-index.ts is stale. Run `node scripts/help/gen-screens-index.mjs`");
    process.exit(1);
  }
  console.log(`screens index up to date (${entries.length} screens)`);
} else {
  writeFileSync(OUT, generated);
  console.log(`wrote ${relative(root, OUT)} (${entries.length} screens)`);
}
