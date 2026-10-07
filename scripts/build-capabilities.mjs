// Build the capabilities list that keeps murage_help honest.
//
// The help index answers from prose, and prose goes stale the day a feature
// ships without a page. This script reads the CODE and writes down, in
// shared/help-capabilities.ts, every thing a bot or a person can reach:
//
//   - every tool a bot has (the TOOLS and PROJECT_TOOLS in the agents proxy),
//   - every Settings page, every bot-settings section and their names,
//   - the main places in the sidebar,
//   - the labels of the permission controls,
//   - every family of harness routes, each named in the words a person uses.
//
// shared/help-capabilities.test.ts then fails when any of them is missing
// from the help index, so a new tool, setting or route cannot ship without the
// docs saying something about it.
//
// Run `node scripts/build-capabilities.mjs` after changing any of those.
// `--check` fails when the committed file is stale; the test suite runs it.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "shared", "help-capabilities.ts");
const read = (path) => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n");
const en = JSON.parse(read("src/locales/en.json"));

const items = [];
const add = (kind, name, term, source) => items.push({ kind, name, term, source });

// 1. Bot tools. Top-level entries of TOOLS look like `{ name: "x", ...` or
// `{\n    name: "x",`; the project tools live in their own schema file.
const proxy = read("server/drivers/agents-proxy.ts");
const toolsStart = proxy.indexOf("const TOOLS = [");
const toolsEnd = proxy.indexOf("\n];", toolsStart);
if (toolsStart < 0 || toolsEnd < 0) throw new Error("agents-proxy.ts: cannot find the TOOLS array");
const toolSlice = proxy.slice(toolsStart, toolsEnd);
for (const match of toolSlice.matchAll(/^ {2}\{\s*name: "([a-z_]+)"/gm)) add("tool", match[1], match[1], "server/drivers/agents-proxy.ts");
for (const match of proxy.matchAll(/const PROJECT_PROPOSE_TOOL = \{\s*name: "([a-z_]+)"/g)) add("tool", match[1], match[1], "server/drivers/agents-proxy.ts");
for (const match of read("server/drivers/project-tool-schemas.ts").matchAll(/^ {2}\{\s*name: "([a-z_]+)"/gm)) add("tool", match[1], match[1], "server/drivers/project-tool-schemas.ts");

// 2. App settings pages: the id is a contract, the label is what people read.
for (const match of read("src/lib/settings-sections.ts").matchAll(/^ {2}\{ id: "([A-Za-z]+)", group:/gm)) {
  const label = en[`settings.section.${match[1]}`];
  if (!label) throw new Error(`settings section ${match[1]} has no settings.section.${match[1]} label`);
  add("settings-page", match[1], label, "src/lib/settings-sections.ts");
}

// 3. Bot settings sections.
for (const match of read("src/components/bot-settings-sections.ts").matchAll(/\{ id: "([a-z]+)", label: "([^"]+)"/g)) {
  add("bot-settings", match[1], match[2], "src/components/bot-settings-sections.ts");
}

// 4. The places in the sidebar.
for (const key of ["nav.routines", "nav.files", "nav.apps", "nav.mapName"]) {
  if (!en[key]) throw new Error(`missing locale key ${key}`);
  add("place", key, en[key], "src/locales/en.json");
}

// 5. Labels of the permission controls, exported as plain constants.
for (const match of read("src/lib/permission-mode.ts").matchAll(/^export const ([A-Z_]+_LABEL) = "([^"]+)"/gm)) {
  add("label", match[1], match[2], "src/lib/permission-mode.ts");
}

// 6. Route families. Every `/api/<family>` the harness serves must be either
// named in the words a person uses (ROUTE_TERMS) or listed as plumbing
// (ROUTE_PLUMBING). A new family is neither, which fails this script until
// someone decides which it is: that decision is the point.
const ROUTE_TERMS = {
  "about-me": "about me",
  publish: "publishing sites",
  artifacts: "files",
  attachments: "attachments",
  "backup-failure-notice": "backups",
  "backup-restart": "backups",
  "backup-waiting": "backups",
  bots: "bots",
  "browser-extension": "browser extension",
  "calendar-calls": "calls",
  "cli-candidates": "engines",
  "cli-test": "engines",
  connectors: "connected apps",
  decisions: "decisions",
  discord: "Discord",
  "engine-setup-command": "engines",
  files: "files",
  "flux-connection": "Flux",
  "folder-trust": "working folder",
  groups: "channels",
  "house-rules": "house rules",
  images: "image generation",
  inbox: "inbox",
  library: "templates",
  "local-computer": "local computer",
  mcp: "MCP servers",
  "mcp-grants": "script access",
  memory: "memory",
  mobile: "phone",
  packages: "templates",
  projects: "projects",
  "provider-connections": "engines",
  "routine-runs": "routines",
  routines: "routines",
  search: "search",
  "section-context": "team instructions",
  "sidebar-sections": "teams",
  skills: "skills",
  slack: "Slack",
  "starter-profiles": "templates",
  "team-library": "templates",
  "team-map": "team map",
  "team-sections": "teams",
  teams: "teams",
  telegram: "Telegram",
  "thread-snoozes": "snooze",
  tts: "voice",
  voice: "voice",
  "whats-new": "what's new",
  webhooks: "webhooks",
  whatsapp: "WhatsApp",
};
const ROUTE_PLUMBING = new Set([
  "announcements", "automation-admission", "config", "desktop", "desktop-secret", "deletion-preview", "diagnostics",
  "events", "health", "hermes", "instances", "internal", "presence", "setup", "subscribe",
]);
const seenFamilies = new Set();
for (const match of read("server/index.ts").matchAll(/"\/api\/([a-z][a-z-]*)/g)) seenFamilies.add(match[1]);
const unmapped = [...seenFamilies].filter((family) => !(family in ROUTE_TERMS) && !ROUTE_PLUMBING.has(family)).sort();
if (unmapped.length) {
  console.error(`New route families need a place in scripts/build-capabilities.mjs (ROUTE_TERMS if a person can reach it, ROUTE_PLUMBING if not): ${unmapped.join(", ")}`);
  process.exit(1);
}
for (const family of [...seenFamilies].filter((name) => name in ROUTE_TERMS).sort()) add("route", `/api/${family}`, ROUTE_TERMS[family], "server/index.ts");

const key = (item) => `${item.kind}\u0000${item.name}`;
const unique = [...new Map(items.map((item) => [key(item), item])).values()];

const generated = `// GENERATED by scripts/build-capabilities.mjs — do not edit by hand.
// Source: the tool lists, settings sections, locale labels and route families
// named in each entry. Run \`node scripts/build-capabilities.mjs\` after changing
// them; \`--check\` in the test suite fails when this file is stale.
export type CapabilityKind = "tool" | "settings-page" | "bot-settings" | "place" | "label" | "route";

/** One thing the product can do, and the word the help must use for it. */
export interface Capability {
  readonly kind: CapabilityKind;
  /** The code-side name (a tool name, a section id, a locale key or a route). */
  readonly name: string;
  /** The words the help index has to contain, as a person would say them. */
  readonly term: string;
  /** Where the code says so. */
  readonly source: string;
}

export const HELP_CAPABILITIES: readonly Capability[] = ${JSON.stringify(unique, null, 2)};
`;

if (process.argv.includes("--check")) {
  const current = readFileSync(OUT, "utf8").replace(/\r\n/g, "\n");
  if (current !== generated) {
    console.error("shared/help-capabilities.ts is stale — run `node scripts/build-capabilities.mjs`");
    process.exit(1);
  }
  console.log(`capabilities up to date (${unique.length} entries)`);
} else {
  writeFileSync(OUT, generated);
  console.log(`wrote ${relative(root, OUT)} (${unique.length} entries)`);
}
