// Live channel qualification inputs: one dedicated test identity per platform.
//
// The manifest names identities and the files holding credentials; it never
// holds a credential itself. Validation checks the files without returning or
// printing their contents, and loadSecrets reads them only when a qualification
// server is about to launch. Nothing here touches the network.
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync, type Stats } from "node:fs";
import { hostname as osHostname } from "node:os";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { z } from "zod";

export type Platform = "telegram" | "slack" | "discord";

const text = z.string().trim().min(1).max(500);
const telegramId = z.string().regex(/^[1-9][0-9]{0,15}$/, "must be a decimal Telegram ID");
const slackId = z.string().regex(/^[A-Z][A-Z0-9]{1,79}$/, "must be an upper-case Slack ID");
const snowflake = z.string().regex(/^[1-9][0-9]{0,19}$/, "must be a decimal-string Discord snowflake");
const secretPath = z.string().min(1).max(4096).refine(isAbsolute, "must be an absolute path");
const limits = z.object({
  maxOperatorMessages: z.number().int().min(1).max(10),
  maxOutboundMessages: z.number().int().min(1).max(10),
  maxMinutes: z.number().int().min(1).max(45),
}).strict();
const common = {
  version: z.literal(1),
  authorityReference: text,
  dedicated: z.literal(true),
  testHostname: text,
  limits,
  denylistIdentityIds: z.array(z.string().min(1).max(100)).max(50).optional(),
};

const manifestSchema = z.discriminatedUnion("platform", [
  z.object({ ...common, platform: z.literal("telegram"), telegram: z.object({
    botId: telegramId, botUsername: z.string().regex(/^[A-Za-z0-9_]{5,32}$/), ownerUserId: telegramId, tokenFile: secretPath,
  }).strict() }).strict(),
  z.object({ ...common, platform: z.literal("slack"), slack: z.object({
    teamId: slackId, appId: slackId, botUserId: slackId, botId: slackId, ownerUserId: slackId, appTokenFile: secretPath, botTokenFile: secretPath,
  }).strict() }).strict(),
  z.object({ ...common, platform: z.literal("discord"), discord: z.object({
    applicationId: snowflake, botUserId: snowflake, ownerUserId: snowflake, tokenFile: secretPath,
  }).strict() }).strict(),
]);
export type Manifest = z.infer<typeof manifestSchema>;

/** Operator messages and bot replies the live run needs, per platform. */
export const LIVE_BUDGET: Record<Platform, { operator: number; outbound: number }> = {
  // pair code, request one, request two after restart, request after Chief change
  telegram: { operator: 4, outbound: 3 },
  // the same plus a "yes" that must come back as a review reply, not an approval
  slack: { operator: 5, outbound: 4 },
  discord: { operator: 5, outbound: 4 },
};

const TOKEN_SHAPES = {
  telegram: /^\d{1,20}:[A-Za-z0-9_-]{20,200}$/,
  slackApp: /^xapp-[A-Za-z0-9-]{10,400}$/,
  slackBot: /^xoxb-[A-Za-z0-9-]{10,400}$/,
  discord: /^[A-Za-z0-9_-]{10,100}\.[A-Za-z0-9_-]{3,40}\.[A-Za-z0-9_-]{20,200}$/,
} as const;
type Shape = keyof typeof TOKEN_SHAPES;

export interface InputContext {
  /** Repository checkout; credential files inside it are refused. */
  repoRoot: string;
  hostname?: string;
  uid?: number | null;
  /** Test seam only: runs after the path checks and before the file is opened. */
  afterPathCheck?: (path: string) => void;
}

export class ManifestError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Qualification inputs refused: ${issues.join("; ")}`);
    this.name = "ManifestError";
    this.issues = issues;
  }
}

interface SecretSpec { label: string; path: string; shape: Shape; env: string; identity?: { label: string; value: string } }

function secretSpecs(manifest: Manifest): SecretSpec[] {
  if (manifest.platform === "telegram") return [{ label: "telegram.tokenFile", path: manifest.telegram.tokenFile, shape: "telegram", env: "MURAGE_TELEGRAM_BOT_TOKEN",
    identity: { label: "telegram.botId", value: manifest.telegram.botId } }];
  if (manifest.platform === "slack") return [
    { label: "slack.appTokenFile", path: manifest.slack.appTokenFile, shape: "slackApp", env: "MURAGE_SLACK_APP_TOKEN", identity: { label: "slack.appId", value: manifest.slack.appId } },
    { label: "slack.botTokenFile", path: manifest.slack.botTokenFile, shape: "slackBot", env: "MURAGE_SLACK_BOT_TOKEN" },
  ];
  return [{ label: "discord.tokenFile", path: manifest.discord.tokenFile, shape: "discord", env: "MURAGE_DISCORD_BOT_TOKEN",
    identity: { label: "discord.botUserId", value: manifest.discord.botUserId } }];
}

export function identityIds(manifest: Manifest): string[] {
  if (manifest.platform === "telegram") return [manifest.telegram.botId, manifest.telegram.ownerUserId, manifest.telegram.botUsername];
  if (manifest.platform === "slack") return [manifest.slack.teamId, manifest.slack.appId, manifest.slack.botUserId, manifest.slack.botId, manifest.slack.ownerUserId];
  return [manifest.discord.applicationId, manifest.discord.botUserId, manifest.discord.ownerUserId];
}

/** The identity a credential carries in its own bytes, where the provider encodes one. */
function derivedIdentity(shape: Shape, value: string): string | undefined {
  if (shape === "telegram") return value.slice(0, value.indexOf(":"));
  if (shape === "slackApp") return /^xapp-\d+-(A[A-Z0-9]+)-/.exec(value)?.[1];
  if (shape === "discord") {
    const decoded = Buffer.from(value.slice(0, value.indexOf(".")), "base64url").toString("utf8");
    return /^[1-9][0-9]{0,19}$/.test(decoded) ? decoded : undefined;
  }
  return undefined;
}

/** Path check plus inode ancestry, so case variants and aliased paths cannot slip outside. */
function insideRepository(repoRoot: string, file: string): boolean {
  let root: string, real: string, rootStat: Stats;
  try { root = realpathSync.native(repoRoot); real = realpathSync.native(file); rootStat = statSync(root); } catch { return true; }
  const rel = relative(root, real);
  if (!(rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))) return true;
  for (let dir = dirname(real); ; dir = dirname(dir)) {
    try { const stat = statSync(dir); if (stat.dev === rootStat.dev && stat.ino === rootStat.ino) return true; } catch { return true; }
    if (dirname(dir) === dir) return false;
  }
}

/** Checks one credential file and returns its trimmed value. Errors never contain the value. */
function readSecret(spec: SecretSpec, context: InputContext, issues: string[]): string | undefined {
  const start = issues.length;
  let before: Stats;
  try { before = lstatSync(spec.path); } catch { issues.push(`${spec.label} is not readable`); return undefined; }
  if (before.isSymbolicLink()) { issues.push(`${spec.label} must not be a symbolic link`); return undefined; }
  if (!before.isFile()) { issues.push(`${spec.label} must be a regular file`); return undefined; }
  const uid = context.uid === undefined ? (process.getuid?.() ?? null) : context.uid;
  if (uid !== null && before.uid !== uid) issues.push(`${spec.label} must be owned by the current user`);
  if (process.platform !== "win32" && (before.mode & 0o777) !== 0o600) issues.push(`${spec.label} must have mode 0600`);
  if (before.nlink !== 1) issues.push(`${spec.label} must not have other hard links`);
  if (before.size === 0 || before.size > 512) issues.push(`${spec.label} must hold one credential of at most 512 bytes`);
  if (insideRepository(context.repoRoot, spec.path)) issues.push(`${spec.label} must be outside the repository checkout`);
  if (issues.length > start) return undefined;
  context.afterPathCheck?.(spec.path);
  let fd: number;
  try { fd = openSync(spec.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch { issues.push(`${spec.label} changed while it was being checked`); return undefined; }
  try {
    const now = fstatSync(fd);
    if (!now.isFile() || now.dev !== before.dev || now.ino !== before.ino || now.mode !== before.mode || now.uid !== before.uid || now.size !== before.size || now.nlink !== 1) {
      issues.push(`${spec.label} changed while it was being checked`); return undefined;
    }
    const buffer = Buffer.alloc(now.size);
    let offset = 0;
    while (offset < buffer.length) { const read = readSync(fd, buffer, offset, buffer.length - offset, offset); if (read === 0) break; offset += read; }
    const value = buffer.subarray(0, offset).toString("utf8").trim();
    if (!TOKEN_SHAPES[spec.shape].test(value)) { issues.push(`${spec.label} does not look like a ${shapeName(spec.shape)}`); return undefined; }
    return value;
  } finally { closeSync(fd); }
}
const shapeName = (shape: Shape) => ({ telegram: "Telegram bot token", slackApp: "Slack app-level token", slackBot: "Slack bot token", discord: "Discord bot token" })[shape];

/** Reads every credential, matches the identity it carries and applies the denylist. */
function checkSecrets(manifest: Manifest, context: InputContext, issues: string[]): Record<string, string> {
  const env: Record<string, string> = {}, derived: string[] = [];
  for (const spec of secretSpecs(manifest)) {
    const value = readSecret(spec, context, issues);
    if (value === undefined) continue;
    env[spec.env] = value;
    if (!spec.identity) continue;
    const carried = derivedIdentity(spec.shape, value);
    if (carried === undefined) issues.push(`${spec.label} does not carry a readable identity`);
    else {
      derived.push(carried);
      if (carried !== spec.identity.value) issues.push(`${spec.label} belongs to a different identity than ${spec.identity.label}`);
    }
  }
  const denied = new Set(manifest.denylistIdentityIds ?? []);
  if ([...identityIds(manifest), ...derived].some(id => denied.has(id))) issues.push("a configured or credential-derived identity is on denylistIdentityIds (production identity refused)");
  return env;
}

export interface RedactedPlan {
  platform: Platform;
  authorityReference: string;
  testHostname: string;
  identities: Record<string, string>;
  credentialFiles: Record<string, "validated">;
  budget: { operatorMessages: number; outboundMessages: number; maxMinutes: number; plannedOperator: number; plannedOutbound: number };
}

const mask = (value: string) => value.length <= 4 ? "*".repeat(value.length) : `${value.slice(0, 2)}${"*".repeat(Math.max(1, value.length - 4))}${value.slice(-2)}`;

/** Validate a parsed manifest and its credential files; returns a plan with no secret bytes. */
export function validateManifest(raw: unknown, context: InputContext): { manifest: Manifest; plan: RedactedPlan } {
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) throw new ManifestError(parsed.error.issues.map(issue => `${issue.path.join(".") || "manifest"}: ${issue.message}`));
  const manifest = parsed.data;
  const issues: string[] = [];
  const host = context.hostname ?? osHostname();
  if (manifest.testHostname !== host) issues.push("testHostname does not match this computer");
  const planned = LIVE_BUDGET[manifest.platform];
  if (manifest.limits.maxOperatorMessages < planned.operator) issues.push(`limits.maxOperatorMessages must allow the ${planned.operator} planned operator messages`);
  if (manifest.limits.maxOutboundMessages < planned.outbound) issues.push(`limits.maxOutboundMessages must allow the ${planned.outbound} planned bot replies`);
  checkSecrets(manifest, context, issues);
  if (issues.length) throw new ManifestError(issues);
  const section = manifest.platform === "telegram" ? manifest.telegram : manifest.platform === "slack" ? manifest.slack : manifest.discord;
  const identities: Record<string, string> = {};
  for (const [key, value] of Object.entries(section)) if (!key.endsWith("File")) identities[key] = mask(value);
  return { manifest, plan: {
    platform: manifest.platform, authorityReference: manifest.authorityReference, testHostname: manifest.testHostname, identities,
    credentialFiles: Object.fromEntries(secretSpecs(manifest).map(spec => [spec.label, "validated" as const])),
    budget: { operatorMessages: manifest.limits.maxOperatorMessages, outboundMessages: manifest.limits.maxOutboundMessages, maxMinutes: manifest.limits.maxMinutes,
      plannedOperator: planned.operator, plannedOutbound: planned.outbound },
  } };
}

export function loadManifestFile(path: string, context: InputContext): { manifest: Manifest; plan: RedactedPlan } {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { throw new ManifestError(["inputs file is not readable JSON"]); }
  return validateManifest(raw, context);
}

/** Re-check and read credentials at child-launch time. Returns the child env entries only. */
export function loadSecrets(manifest: Manifest, context: InputContext): Record<string, string> {
  const issues: string[] = [];
  const env = checkSecrets(manifest, context, issues);
  if (issues.length) throw new ManifestError(issues);
  return env;
}
