// Build the capability database: one master record of what Murage can do.
//
// Source: shared/capabilities/*.yaml (CAPABILITY-DB-1010 rev 2). Each entry
// says whether Murage can do a thing, how, where on screen, on which platforms
// and engines, and what to ask the bot when the answer is no. The concierge
// (murage_help and the facts block for turns without the agents server), the
// in-app help, the release export and the site KB all read these records, so
// they cannot drift apart.
//
// Modes:
//   (none)                write shared/capability-db.ts
//   --check               validate the YAML and fail when the generated file is stale
//   --check --touched <sha>  also list entries whose file: anchors changed since <sha>
//                         while `verified` is older than package.json (a warning in 1.0.10)
//   --export <file>       write the public JSON export (no `internal` fields)
//   --diff <previous.json> [--diff-out <file>]  compare with a previous export
//   --diff <previous.json> --current <export.json>  the same with no sources (release assembly)
//   --docs-report         print the in-app docs paths outside the slice that the app does not render
//   --src <dir> --out <file>  test hooks: read another YAML folder, compare another file
//
// Everything is recomputed from the sources on every run: the anchors resolve
// against buildInventory() from build-capabilities.mjs, never against the
// committed help-capabilities.ts.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildInventory } from "./build-capabilities.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n");

export const STATUSES = ["can", "partial", "via-engine", "coming", "cannot"];
export const PLATFORMS = ["mac", "windows", "linux", "android", "ios", "cloud"];
const PHONES = ["android", "ios"];
/** Fuigo first: the order every engine list follows (copy rule). */
export const ENGINES = ["fuigo", "claude", "codex", "grok", "cursor", "kimi", "droid", "antigravity", "opencode", "qwen", "hermes", "pi", "openclaw", "openai-compatible"];
const ENGINE_NAMES = {
  fuigo: "Fuigo", claude: "Claude", codex: "Codex", grok: "Grok", cursor: "Cursor", kimi: "Kimi", droid: "Droid", antigravity: "Antigravity",
  opencode: "OpenCode", qwen: "Qwen", hermes: "Hermes", pi: "Pi", openclaw: "OpenClaw", "openai-compatible": "OpenAI-compatible engines",
};
const PLATFORM_NAMES = { mac: "Mac", windows: "Windows", linux: "Linux", android: "the Android app", ios: "the iPhone app", cloud: "Murage Cloud" };
const STATUS_SENTENCES = {
  can: "Murage can do this",
  partial: "Murage can do part of this",
  "via-engine": "This works through the bot's engine",
  coming: "This is coming soon",
  cannot: "Murage cannot do this today",
};
/** Backend and vendor names customer text never carries. Seeded with the one
 * src/copy-rules.test.ts refuses (the connection service) and the services
 * behind Murage that a person never picks. */
const BANNED_NAMES = ["Composio", "AgentMail", "Cua", "Help Scout", "build host", "Vercel", "Supabase", "Cloudflare", "Requesty"];
const ROOTS = { settings: "Settings", bot: "Bot settings" };
const ARROW = " → ";
const ENTRY_KEYS = new Set(["id", "name", "status", "questions", "answer", "limits", "ask_your_bot", "settings_path", "platforms", "engines",
  "anchors", "verified", "since", "removed_in", "doc", "internal"]);

/** Child controls a Settings path may name below a card or a page, each bound
 * to its owner and proved by a literal in the file that renders it. A path
 * segment that is not a page, the Advanced region, a card label or one of
 * these does not exist on screen. Kept to what the slice entries need; the
 * remaining docs paths are a printed report (CAPABILITY-DB-1010 Astra r2 M6). */
const PATH_CONTROLS = [
  // Learn about me renders on the workspace Memory page with no card of its own (MemorySettings.tsx `workspacePage &&`).
  { id: "memory/learn-about-me", root: "settings", page: "memory", card: null, advanced: false, labelKey: "learnAboutMe.title",
    proof: [["src/components/MemorySettings.tsx", "{workspacePage && <LearnAboutMe"], ["src/components/LearnAboutMe.tsx", "learnAboutMe.title"]] },
  // The plan sign-in block on Models & engines, above the Model connections card (ModelsSettings.tsx).
  { id: "models/plan-sign-in", root: "settings", page: "models", card: null, advanced: false, labelKey: "modelSignIn.heading",
    proof: [["src/components/ModelsSettings.tsx", "<SubscriptionSignIn"], ["src/components/SubscriptionSignIn.tsx", "modelSignIn.heading"]] },
  // The Approvals block (the level new conversations start at) in a bot's Permissions section.
  { id: "permissions/approvals", root: "bot", section: "permissions", label: "Approvals",
    proof: [["src/components/BotPermissionDefault.tsx", 'text-ink">Approvals</div>'], ["src/components/SettingsPanel.tsx", "<BotPermissionDefault"]] },
  // The Name field in a bot's Identity & instructions section.
  { id: "identity/name", root: "bot", section: "identity", labelKey: "settings.bot.identity.name",
    proof: [["src/components/SettingsPanel.tsx", 't("settings.bot.identity.name")']] },
];

function sha256(text) { return createHash("sha256").update(text).digest("hex"); }
/** Whitespace runs fold to one space, so re-wrapping folded YAML never changes a fact. */
function norm(value) { return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : value; }

/** rev: a content hash over exactly the answer-relevant fields, canonically
 * serialized (fixed key order, normalized whitespace, platforms and engines in
 * their canonical order). A rebuild, a version bump, a `verified` or `since`
 * change, or a reformat never changes it; a changed fact always does. */
export function entryRev(entry) {
  const order = (list, canon) => [...(list ?? [])].sort((a, b) => canon.indexOf(a) - canon.indexOf(b));
  return sha256(JSON.stringify([
    ["status", norm(entry.status)],
    ["answer", norm(entry.answer ?? "")],
    ["limits", norm(entry.limits ?? "")],
    ["ask_your_bot", norm(entry.ask_your_bot ?? "")],
    ["settings_path", norm(entry.settings_path ?? "")],
    ["platforms", order(entry.platforms, ["all", ...PLATFORMS])],
    ["engines", order(entry.engines, ["all", ...ENGINES])],
  ]));
}
export function dbRev(entries) {
  return sha256(entries.map((entry) => `${entry.id}:${entry.rev}`).sort().join("\n"));
}

function loadHelpIndex() {
  const source = read("shared/help-index.ts");
  const prefix = "export const HELP_INDEX: readonly HelpEntry[] = ";
  const start = source.indexOf(prefix);
  if (start < 0) throw new Error("shared/help-index.ts: cannot find HELP_INDEX");
  const json = source.slice(start + prefix.length, source.lastIndexOf("];") + 1);
  return JSON.parse(json);
}

async function loadSources(srcDir) {
  // Loaded here, not at the top: the release assembly job diffs two exports with no node_modules installed.
  const { parse: parseYaml } = await import("yaml");
  const files = readdirSync(srcDir).filter((name) => name.endsWith(".yaml")).sort();
  const entries = [];
  const retired = [];
  const errors = [];
  for (const file of files) {
    const doc = parseYaml(readFileSync(join(srcDir, file), "utf8"));
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) { errors.push(`${file}: the file must be a mapping {schema, entries, retired}`); continue; }
    if (doc.schema !== 1) errors.push(`${file}: schema must be 1`);
    for (const key of Object.keys(doc)) if (!["schema", "entries", "retired"].includes(key)) errors.push(`${file}: unknown top-level key ${key}`);
    if (!Array.isArray(doc.entries)) { errors.push(`${file}: entries must be a list`); continue; }
    const area = file.replace(/\.yaml$/, "");
    for (const entry of doc.entries) entries.push({ ...entry, _file: file, _area: area });
    for (const item of doc.retired ?? []) retired.push({ ...item, _file: file });
  }
  return { entries, retired, errors };
}

/** The navigation tree the product renders, from the code: SECTION_PAGES with
 * settings.page.* labels, the card registry (page, Advanced, settings.l1.card.*
 * label), the bot settings sections, the places, and the bound child controls.
 * Each valid path records its owner, so an entry's path must match the thing
 * its anchor names, not just a label that exists somewhere. */
export function buildNavigation() {
  const en = JSON.parse(read("src/locales/en.json"));
  const pagesSource = read("src/lib/settings-pages.ts");
  const pages = new Map();
  const pagesStart = pagesSource.indexOf("export const SECTION_PAGES");
  const pagesEnd = pagesSource.indexOf("];", pagesStart);
  for (const match of pagesSource.slice(pagesStart, pagesEnd).matchAll(/\{ id: "([A-Za-z]+)", group: "[a-z]+"(, desktopOnly: true)? \}/g)) {
    const label = en[`settings.page.${match[1]}`];
    if (!label) throw new Error(`settings page ${match[1]} has no settings.page.${match[1]} label`);
    pages.set(match[1], { id: match[1], label, desktopOnly: Boolean(match[2]) });
  }
  const cards = new Map();
  const registry = read("src/lib/settings-card-registry.ts");
  for (const match of registry.matchAll(/^ {2}card\("([a-z0-9-]+)", "([A-Za-z]+)", "([a-z0-9-]+)", \{([^\n]*)\}\),$/gm)) {
    const [, slug, page, anchor, spec] = match;
    const id = `${page}.${slug}`;
    const label = en[`settings.l1.card.${id}`];
    if (!label) throw new Error(`settings card ${id} has no settings.l1.card.${id} label`);
    cards.set(`${page}/${slug}`, { id, page, anchor, label, advanced: /advanced: true/.test(spec), surface: /surface: "any"/.test(spec) ? "any" : "desktop" });
  }
  const botSource = read("src/components/bot-settings-sections.ts");
  const gated = new Set([.../export const GATED_BOT_SETTINGS[^=]*= new Set\(\[([^\]]*)\]\)/.exec(botSource)[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]));
  const desktopBot = new Set([.../export const DESKTOP_ONLY_BOT_SETTINGS[^=]*= new Set\(\[([^\]]*)\]\)/.exec(botSource)[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]));
  const botSections = new Map();
  for (const match of botSource.matchAll(/\{ id: "([a-z]+)", label: "([^"]+)"/g)) {
    if (!gated.has(match[1])) botSections.set(match[1], { id: match[1], label: match[2], desktopOnly: desktopBot.has(match[1]) });
  }

  const paths = new Map(); // path -> { owner, page?, desktopOnly }
  const addPath = (path, info) => { if (!paths.has(path)) paths.set(path, info); };
  for (const page of pages.values()) addPath([ROOTS.settings, page.label].join(ARROW), { owner: `page:${page.id}`, page: page.id, desktopOnly: page.desktopOnly });
  for (const page of pages.values()) {
    if ([...cards.values()].some((card) => card.page === page.id && card.advanced)) {
      addPath([ROOTS.settings, page.label, "Advanced"].join(ARROW), { owner: `page:${page.id}`, page: page.id, desktopOnly: page.desktopOnly });
    }
  }
  for (const [key, card] of cards) {
    const page = pages.get(card.page);
    if (!page) throw new Error(`settings card ${card.id} names page ${card.page}, which is not in SECTION_PAGES`);
    addPath([ROOTS.settings, page.label, ...(card.advanced ? ["Advanced"] : []), card.label].join(ARROW),
      { owner: `card:${key}`, page: page.id, desktopOnly: page.desktopOnly || card.surface === "desktop" });
  }
  addPath(ROOTS.bot, { owner: "bot" });
  for (const section of botSections.values()) addPath([ROOTS.bot, section.label].join(ARROW), { owner: `bot:${section.id}`, desktopOnly: section.desktopOnly });
  const controlErrors = [];
  for (const control of PATH_CONTROLS) {
    for (const [file, token] of control.proof) {
      if (!existsSync(join(root, file)) || !read(file).includes(token)) controlErrors.push(`path control ${control.id}: ${file} no longer contains ${JSON.stringify(token)}`);
    }
    const label = control.label ?? en[control.labelKey];
    if (!label) { controlErrors.push(`path control ${control.id}: no label`); continue; }
    if (control.root === "settings") {
      const page = pages.get(control.page);
      const card = control.card ? cards.get(`${control.page}/${control.card}`) : null;
      if (!page || (control.card && !card)) { controlErrors.push(`path control ${control.id}: unknown page or card`); continue; }
      const parent = [ROOTS.settings, page.label, ...((card?.advanced ?? control.advanced) ? ["Advanced"] : []), ...(card ? [card.label] : [])];
      addPath([...parent, label].join(ARROW), { owner: `control:${control.id}`, page: page.id, desktopOnly: page.desktopOnly || card?.surface === "desktop" });
    } else {
      const section = botSections.get(control.section);
      if (!section) { controlErrors.push(`path control ${control.id}: unknown bot settings section`); continue; }
      addPath([ROOTS.bot, section.label, label].join(ARROW), { owner: `control:${control.id}`, desktopOnly: section.desktopOnly });
    }
  }
  // Places a person reaches outside Settings (agreement with MurageSite item 3).
  for (const key of ["nav.routines", "nav.mapName"]) if (en[key]) addPath(en[key], { owner: `place:${key}` });
  addPath("Connected apps", { owner: "place:connected-apps" });
  addPath("Tools", { owner: "place:tools" });
  addPath("your menu", { owner: "place:menu" });
  return { pages, cards, botSections, paths, controlErrors };
}

/** How an anchor names the owner of a path: settings-card:<page>/<card>,
 * bot-settings:<id>, settings-control:<id>. */
function anchorOwners(anchors) {
  const owners = new Set();
  for (const anchor of anchors) {
    const [kind, value] = splitAnchor(anchor);
    if (kind === "settings-card") { owners.add(`card:${value}`); owners.add(`page:${value.split("/")[0]}`); }
    if (kind === "bot-settings") owners.add(`bot:${value}`);
    if (kind === "settings-control") owners.add(`control:${value}`);
  }
  return owners;
}
function splitAnchor(anchor) {
  const at = String(anchor).indexOf(":");
  return at < 0 ? [String(anchor), ""] : [String(anchor).slice(0, at), String(anchor).slice(at + 1)];
}

function copyErrors(field, text, status) {
  const errors = [];
  if (!text) return errors;
  if (/[—–]/.test(text)) errors.push(`${field} has a dash Murage copy never uses (em or en dash)`);
  if (/\bsaf(?:e|ely|ety)\b|\bunsafe\b/i.test(text)) errors.push(`${field} says "safe"`);
  if (/\bfree\b/i.test(text)) errors.push(`${field} says "free"`);
  for (const name of BANNED_NAMES) if (new RegExp(`\\b${name}\\b`).test(text)) errors.push(`${field} names ${name}, a backend or vendor`);
  if (status === "coming" && /\b(20\d\d|Q[1-4]|January|February|March|April|May|June|July|August|September|October|November|December|next (week|month|year)|this (week|month|year))\b/.test(text)) {
    errors.push(`${field} gives a date; "coming soon" carries none`);
  }
  return errors;
}

function compareVersions(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Validate and shape. Returns { entries, retired, errors, navigation }. */
export async function buildDatabase({ srcDir = join(root, "shared", "capabilities") } = {}) {
  const { entries: raw, retired: rawRetired, errors } = await loadSources(srcDir);
  const inventory = buildInventory();
  const has = (kind, name) => inventory.some((item) => item.kind === kind && item.name === name);
  const navigation = buildNavigation();
  errors.push(...navigation.controlErrors);
  const help = new Map(loadHelpIndex().map((entry) => [entry.id, entry]));
  const version = JSON.parse(read("package.json")).version;
  const ids = new Map();
  const seenId = (id, where) => {
    if (ids.has(id)) errors.push(`${where}: id ${id} is used again (first in ${ids.get(id)}); ids are never reused`);
    else ids.set(id, where);
  };
  for (const item of rawRetired) {
    if (!item.id || !item.version || !item.why) errors.push(`${item._file}: a retired item needs id, version and why`);
    seenId(item.id, item._file);
  }
  const entries = [];
  for (const entry of raw) {
    const where = `${entry._file}: ${entry.id ?? "(no id)"}`;
    const fail = (message) => errors.push(`${where}: ${message}`);
    for (const key of Object.keys(entry)) if (!key.startsWith("_") && !ENTRY_KEYS.has(key)) fail(`unknown field ${key}`);
    if (typeof entry.id !== "string" || !new RegExp(`^${entry._area}\\.[a-z0-9-]+$`).test(entry.id)) fail(`id must be ${entry._area}.<slug>`);
    seenId(entry.id, entry._file);
    if (typeof entry.name !== "string" || !entry.name.trim()) fail("needs a name");
    if (!STATUSES.includes(entry.status)) fail(`status must be one of ${STATUSES.join(", ")}`);
    if (!Array.isArray(entry.questions) || entry.questions.length < 3 || entry.questions.length > 6) fail("needs 3 to 6 questions");
    if (typeof entry.answer !== "string" || !entry.answer.trim()) fail("needs an answer");
    const limits = norm(entry.limits ?? "");
    const ask = norm(entry.ask_your_bot ?? "");
    if (entry.status !== "can" && !limits) fail(`status ${entry.status} needs limits (the workaround)`);
    if ((entry.status === "cannot" || entry.status === "partial") && !ask) fail(`status ${entry.status} needs ask_your_bot (House Rule 4: no dead ends)`);
    const platforms = entry.platforms;
    if (!Array.isArray(platforms) || !platforms.length || !(platforms.join() === "all" || platforms.every((p) => PLATFORMS.includes(p)))) {
      fail(`platforms must be [all] or a list of ${PLATFORMS.join(", ")}`);
    }
    const engines = entry.engines;
    if (!Array.isArray(engines) || !engines.length || !(engines.join() === "all" || engines.every((e) => ENGINES.includes(e)))) {
      fail(`engines must be [all] or a list of ${ENGINES.join(", ")}`);
    } else if (engines.join() !== "all") {
      const sorted = [...engines].sort((a, b) => ENGINES.indexOf(a) - ENGINES.indexOf(b));
      if (sorted.join() !== engines.join()) fail(`engines must follow the canonical order, Fuigo first: ${sorted.join(", ")}`);
    }
    const removed = norm(entry.removed_in ?? "");
    if (removed && entry.status !== "cannot") fail("an entry with removed_in must have status cannot");
    if (!entry.verified) fail("needs verified: the version a person last checked the claim against the code");
    const anchors = Array.isArray(entry.anchors) ? entry.anchors : [];
    if (!removed && !anchors.length) fail("needs at least one anchor");
    for (const anchor of anchors) {
      const [kind, value] = splitAnchor(anchor);
      if (kind === "tool") { if (!has("tool", value)) fail(`anchor ${anchor}: no such bot tool`); }
      else if (kind === "bot-settings") { if (!navigation.botSections.has(value)) fail(`anchor ${anchor}: no such bot settings section`); }
      else if (kind === "place") { if (!has("place", value)) fail(`anchor ${anchor}: no such place`); }
      else if (kind === "route") { if (!has("route", value.startsWith("/api/") ? value : `/api/${value}`)) fail(`anchor ${anchor}: no such route family`); }
      else if (kind === "settings-card") { if (!navigation.cards.has(value)) fail(`anchor ${anchor}: no such Settings card in settings-card-registry.ts`); }
      else if (kind === "settings-control") { if (!PATH_CONTROLS.some((control) => control.id === value)) fail(`anchor ${anchor}: no such path control`); }
      else if (kind === "file") {
        const hash = value.indexOf("#");
        const path = hash < 0 ? value : value.slice(0, hash);
        const token = hash < 0 ? "" : value.slice(hash + 1);
        if (!token) fail(`anchor ${anchor}: a file anchor needs #<token>`);
        else if (!existsSync(join(root, path))) fail(`anchor ${anchor}: ${path} does not exist`);
        else if (!read(path).includes(token)) fail(`anchor ${anchor}: ${path} no longer contains ${token}`);
      } else fail(`anchor ${anchor}: unknown kind ${kind}`);
    }
    const path = norm(entry.settings_path ?? "");
    let pathInfo;
    if (path) {
      pathInfo = navigation.paths.get(path);
      if (!pathInfo) fail(`settings_path "${path}" is not a path the app renders`);
      else if (/^(card|control|bot):/.test(pathInfo.owner) && !anchorOwners(anchors).has(pathInfo.owner)) {
        fail(`settings_path "${path}" belongs to ${pathInfo.owner}, which none of this entry's anchors names`);
      } else if (pathInfo.page) {
        const cardPages = anchors.map(splitAnchor).filter(([kind]) => kind === "settings-card").map(([, value]) => value.split("/")[0]);
        if (cardPages.length && !cardPages.includes(pathInfo.page)) fail(`settings_path "${path}" is on page ${pathInfo.page}, but the card anchor is on ${cardPages.join(", ")}`);
      }
      if (pathInfo?.desktopOnly && Array.isArray(platforms) && (platforms.join() === "all" || platforms.some((p) => PHONES.includes(p)))) {
        fail(`settings_path "${path}" is desktop only, so platforms must not include a phone (or all)`);
      }
    }
    if (entry.doc && !help.has(entry.doc)) fail(`doc ${entry.doc} is not a help-index id`);
    for (const [field, text] of [["name", entry.name], ["answer", entry.answer], ["limits", limits], ["ask_your_bot", ask], ...((entry.questions ?? []).map((q, i) => [`questions[${i}]`, q]))]) {
      for (const message of copyErrors(field, norm(text), entry.status)) fail(message);
    }
    if (removed && compareVersions(removed, version) < 0) {
      const [major, minor, patch] = version.split(".").map(Number);
      const previousTrain = `${major}.${minor}.${Math.max(patch - 1, 0)}`;
      if (compareVersions(removed, previousTrain) < 0) fail(`removed in ${removed}, more than one train ago: move it to retired`);
    }
    // The facts block keeps these whole inside its 600-character line (shared/capability-facts.ts).
    const essentials = `${entry.name ?? ""} ${limits} ${ask} ${path}`.length + 120;
    if (essentials > 450) fail(`name, limits, ask_your_bot and settings_path come to ${essentials} characters with the status and applicability; keep them under 450 so no qualification is clipped`);
    const doc = entry.doc ? help.get(entry.doc) : undefined;
    entries.push({
      id: entry.id, name: norm(entry.name), status: entry.status, questions: (entry.questions ?? []).map(norm), answer: norm(entry.answer),
      limits, ask_your_bot: ask, settings_path: path, platforms, engines, anchors, verified: String(entry.verified), since: String(entry.since ?? ""),
      removed_in: removed, doc: entry.doc ?? "", doc_url: doc?.url ?? "https://murage.ai/docs", doc_where: doc?.where ?? "", internal: norm(entry.internal ?? ""),
      _file: entry._file,
    });
  }
  for (const entry of entries) entry.rev = entryRev(entry);
  const retired = rawRetired.map(({ id, version: v, why }) => ({ id, version: String(v), why: norm(why) }));
  return { entries, retired, errors, navigation, version };
}

export function applicability(entry) {
  const platforms = entry.platforms.join() === "all" ? "every platform" : entry.platforms.map((p) => PLATFORM_NAMES[p]).join(", ");
  const engines = entry.engines.join() === "all" ? "every engine" : entry.engines.map((e) => ENGINE_NAMES[e]).join(", ");
  return `Applies to ${platforms}; ${engines}.`;
}
export function statusSentence(entry) {
  return entry.removed_in ? `Removed in ${entry.removed_in}` : STATUS_SENTENCES[entry.status];
}

function generate(db) {
  const records = db.entries.map((entry) => ({
    id: `cap:${entry.id}`,
    title: entry.name,
    description: `${statusSentence(entry)}.`,
    heading: entry.questions.join(" / "),
    breadcrumb: "Murage capabilities",
    where: entry.settings_path || entry.doc_where || "Murage capabilities",
    url: entry.doc_url,
    text: [entry.answer, entry.limits, entry.ask_your_bot ? `Ask your bot: ${entry.ask_your_bot}` : ""].filter(Boolean).join(" "),
    capability: entry.id,
    status: entry.status,
    answer: entry.answer,
    limits: entry.limits,
    askYourBot: entry.ask_your_bot,
    platforms: entry.platforms,
    engines: entry.engines,
    applies: applicability(entry),
    rev: entry.rev,
  }));
  return `// GENERATED by scripts/build-capability-db.mjs from shared/capabilities/*.yaml. Do not edit by hand.
// Run \`node scripts/build-capability-db.mjs\` after changing the YAML; \`--check\`
// in shared/capability-db.test.ts (a GATE test) fails when this file is stale.
import type { HelpEntry } from "./help-index.ts";

export type CapabilityStatus = "can" | "partial" | "via-engine" | "coming" | "cannot";

/** One capability, already shaped as a help entry (id "cap:<id>") so the
 * help search ranks it beside the docs with no mapping at load. */
export interface CapabilityEntry extends HelpEntry {
  readonly capability: string;
  readonly status: CapabilityStatus;
  readonly answer: string;
  readonly limits: string;
  readonly askYourBot: string;
  readonly platforms: readonly string[];
  readonly engines: readonly string[];
  /** "Applies to <platforms>; <engines>." Never clipped off an answer. */
  readonly applies: string;
  /** sha256 over the answer-relevant fields; the site invalidates on a change. */
  readonly rev: string;
}

/** sha256 over every entry's id and rev. The release asserts the packaged server carries this value. */
export const CAPABILITY_DB_REV = ${JSON.stringify(dbRev(db.entries))};

export const CAPABILITY_ENTRIES: readonly CapabilityEntry[] = ${JSON.stringify(records, null, 2)};
`;
}

function exportJson(db, sha) {
  return {
    schema: 1,
    version: db.version,
    sha,
    exported_at: new Date().toISOString(),
    db_rev: dbRev(db.entries),
    valid_paths: [...db.navigation.paths.keys()].sort(),
    entries: db.entries.map((entry) => ({
      id: entry.id, name: entry.name, status: entry.status, status_sentence: statusSentence(entry), questions: entry.questions,
      answer: entry.answer, limits: entry.limits, ask_your_bot: entry.ask_your_bot, settings_path: entry.settings_path,
      platforms: entry.platforms, engines: entry.engines, applies: applicability(entry), since: entry.since, verified: entry.verified,
      removed_in: entry.removed_in, doc: entry.doc, doc_url: entry.doc_url, rev: entry.rev,
    })),
    retired: db.retired,
  };
}

/** Compare two exports. Fails when an id in the previous export is in neither
 * entries nor retired of the current one. */
export function diffExports(previous, current) {
  const before = new Map((previous?.entries ?? []).map((entry) => [entry.id, entry]));
  const after = new Map(current.entries.map((entry) => [entry.id, entry]));
  const retiredNow = new Set(current.retired.map((item) => item.id));
  const retiredBefore = new Set((previous?.retired ?? []).map((item) => item.id));
  const added = [...after.keys()].filter((id) => !before.has(id));
  const retired = [...retiredNow].filter((id) => !retiredBefore.has(id));
  const statusChanged = [...after.values()].filter((entry) => before.has(entry.id) && before.get(entry.id).status !== entry.status)
    .map((entry) => `${entry.id}: ${before.get(entry.id).status} -> ${entry.status}`);
  const revChanged = [...after.values()].filter((entry) => before.has(entry.id) && before.get(entry.id).rev !== entry.rev).map((entry) => entry.id);
  const vanished = [...before.keys()].filter((id) => !after.has(id) && !retiredNow.has(id));
  const lines = [
    `# Capability database diff: ${previous ? previous.version : "(no previous export)"} -> ${current.version}`,
    "",
    `+${added.length} added, ${retired.length} retired, ~${revChanged.length} changed (${statusChanged.length} status changes)`,
    "",
    ...(added.length ? ["## Added", ...added.map((id) => `- ${id}`), ""] : []),
    ...(retired.length ? ["## Retired", ...retired.map((id) => `- ${id}`), ""] : []),
    ...(statusChanged.length ? ["## Status changed", ...statusChanged.map((line) => `- ${line}`), ""] : []),
    ...(revChanged.length ? ["## Facts changed (site rows to re-read)", ...revChanged.map((id) => `- ${id}`), ""] : []),
    ...(vanished.length ? ["## Missing (neither an entry nor retired): this fails the release", ...vanished.map((id) => `- ${id}`), ""] : []),
  ];
  return { added, retired, statusChanged, revChanged, vanished, markdown: lines.join("\n") };
}

/** Bold Settings and Bot settings paths in the in-app docs, checked against the
 * paths the app renders. A path inside a section an entry names as its `doc`
 * fails the check; every other unknown path is printed as debt (1.0.10 bounds
 * enforcement to the slice: Astra r2 M6). */
export function docsPathReport(db) {
  const docsRoot = join(root, "apps", "docs", "content", "docs");
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((item) => item.isDirectory()
    ? walk(join(dir, item.name)) : item.name.endsWith(".mdx") ? [join(dir, item.name)] : []);
  const slugOf = (heading) => heading.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const docIds = new Set(db.entries.map((entry) => entry.doc).filter(Boolean));
  const failures = [];
  const debt = [];
  for (const file of walk(docsRoot)) {
    const rel = relative(docsRoot, file).split("\\").join("/").replace(/\.mdx$/, "");
    if (rel.split("/")[0] === "contributing" || rel.split("/")[0] === "changelog") continue;
    const slug = rel.replace(/(^|\/)index$/, "") || "index";
    const raw = readFileSync(file, "utf8").replace(/\r\n/g, "\n").replace(/^---\n[\s\S]*?\n---\n?/, "").replace(/```[\s\S]*?```/g, "");
    const parts = raw.split(/^##+ +(.+)$/m);
    const sections = [{ id: `${slug}#overview`, text: parts[0] }];
    for (let i = 1; i < parts.length; i += 2) sections.push({ id: `${slug}#${slugOf(parts[i].trim())}`, text: parts[i + 1] ?? "" });
    for (const section of sections) {
      for (const match of section.text.matchAll(/\*\*((?:Settings|Bot settings) → [^*\n]+)\*\*/g)) {
        const path = norm(match[1]);
        if (db.navigation.paths.has(path)) continue;
        (docIds.has(section.id) ? failures : debt).push(`${section.id}: "${path}"`);
      }
    }
  }
  return { failures, debt };
}

function touchedReport(db, base) {
  let changed;
  try {
    changed = new Set(execFileSync("git", ["diff", "--name-only", `${base}..HEAD`], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean));
  } catch (error) {
    return [`--touched ${base}: git diff failed (${error instanceof Error ? error.message.split("\n")[0] : error})`];
  }
  const out = [];
  for (const entry of db.entries) {
    const files = entry.anchors.map(splitAnchor).filter(([kind]) => kind === "file").map(([, value]) => value.split("#")[0]);
    const hit = files.filter((file) => changed.has(file));
    if (hit.length && compareVersions(entry.verified, db.version) < 0) out.push(`${entry.id}: ${hit.join(", ")} changed since ${base}; verified ${entry.verified} < ${db.version}, re-read the claim`);
  }
  return out;
}

function argValue(name) {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
}

function runDiff(previousPath, current) {
  const previous = existsSync(resolve(previousPath)) ? JSON.parse(readFileSync(resolve(previousPath), "utf8")) : null;
  const diff = diffExports(previous, current);
  const diffOut = argValue("--diff-out");
  if (diffOut) writeFileSync(resolve(diffOut), `${diff.markdown}\n`);
  console.log(diff.markdown);
  if (diff.vanished.length) {
    console.error(`capability db: ${diff.vanished.length} id(s) from the previous export are neither entries nor retired: ${diff.vanished.join(", ")}`);
    process.exit(1);
  }
}

async function main() {
  // `--diff <previous.json> --current <export.json>`: two exports, no sources, no dependencies (the release assembly job).
  const currentPath = argValue("--current");
  if (currentPath) {
    const diffPath = argValue("--diff");
    if (!diffPath) { console.error("--current needs --diff <previous.json>"); process.exit(1); }
    runDiff(diffPath, JSON.parse(readFileSync(resolve(currentPath), "utf8")));
    return;
  }
  const srcDir = resolve(argValue("--src") ?? join(root, "shared", "capabilities"));
  const out = resolve(argValue("--out") ?? join(root, "shared", "capability-db.ts"));
  let db;
  try {
    db = await buildDatabase({ srcDir });
  } catch (error) {
    console.error(`capability db: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
  const docsPaths = docsPathReport(db);
  for (const line of docsPaths.failures) db.errors.push(`in-app docs path in an entry's doc section is not one the app renders: ${line}`);
  if (process.argv.includes("--docs-report")) {
    console.log(`in-app docs paths the app does not render (outside the slice, debt for 1.0.11): ${docsPaths.debt.length}`);
    for (const line of docsPaths.debt) console.log(`- ${line}`);
  }
  if (db.errors.length) {
    console.error(`capability db: ${db.errors.length} problem(s)\n${db.errors.map((line) => `- ${line}`).join("\n")}`);
    process.exit(1);
  }
  const generated = generate(db);
  if (process.argv.includes("--check")) {
    const current = existsSync(out) ? readFileSync(out, "utf8").replace(/\r\n/g, "\n") : "";
    if (current !== generated) {
      console.error(`${relative(root, out) || out} is stale: run \`node scripts/build-capability-db.mjs\``);
      process.exit(1);
    }
    const base = argValue("--touched");
    if (base) {
      // A warning in 1.0.10 (a CI annotation), a failure from 1.0.11.
      for (const line of touchedReport(db, base)) console.log(`::warning title=capability db::${line}`);
    }
    console.log(`capability db up to date (${db.entries.length} entries, db_rev ${dbRev(db.entries).slice(0, 12)})`);
  }
  const exportPath = argValue("--export");
  const diffPath = argValue("--diff");
  if (exportPath || diffPath) {
    const sha = argValue("--sha") ?? process.env.GITHUB_SHA ?? (() => {
      try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(); } catch { return ""; }
    })();
    const current = exportJson(db, sha);
    if (exportPath) {
      writeFileSync(resolve(exportPath), `${JSON.stringify(current, null, 2)}\n`);
      console.log(`wrote ${exportPath} (${current.entries.length} entries, db_rev ${current.db_rev.slice(0, 12)})`);
    }
    if (diffPath) runDiff(diffPath, current);
  }
  if (!process.argv.includes("--check") && !exportPath && !diffPath) {
    writeFileSync(out, generated);
    console.log(`wrote ${relative(root, out)} (${db.entries.length} entries)`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
