// M9 (BEDROCK-ENGINE-1023 r2): the Bedrock launch env rules. Pure functions only; no AWS call is made here.
// Owner of this file: M9 builder lane. The Claude Code CLI (external) reads the env names set here.
import { readFileSync } from "node:fs";

export const BEDROCK_PROFILE_RE = /^[A-Za-z0-9_.+=,@-]{1,64}$/;
export const BEDROCK_REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/;

export interface BedrockBinding { profile: string; region: string; accountId: string; epoch: number }

/** A saved block that is missing accountId/epoch or fails the schema loads as UNBOUND (never "skip the check"). */
/** M9 W25 (Fable M7): the binding never leaves the desktop. A copy of config.json made for anything other than the local config.json
 * (the encrypted backup's raw copy) passes through this first: each Bedrock account keeps its entry, but its block becomes {}, which
 * decodes UNBOUND, so a restored copy is still a Bedrock account that refuses turns until the owner sets it up again (never the default
 * Claude sign-in). No profile, region or account id survives. Mutates `config` in place; true when a block was emptied. */
export function omitBedrockBindings(config: unknown): boolean {
  const record = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);
  let changed = false;
  for (const entry of Object.values(record(record(config)?.instances) ?? {})) {
    const inner = record(record(entry)?.config);
    if (!inner || inner.bedrock === undefined) continue;
    inner.bedrock = {};
    changed = true;
  }
  return changed;
}
export function decodeBedrockBinding(raw: unknown): BedrockBinding | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.profile !== "string" || !BEDROCK_PROFILE_RE.test(o.profile)) return null;
  if (typeof o.region !== "string" || !BEDROCK_REGION_RE.test(o.region)) return null;
  if (typeof o.accountId !== "string" || !/^\d{12}$/.test(o.accountId)) return null;
  if (typeof o.epoch !== "number" || !Number.isInteger(o.epoch) || o.epoch < 1) return null;
  return { profile: o.profile, region: o.region, accountId: o.accountId, epoch: o.epoch };
}

/** Last four digits, as shown to the owner everywhere except the Save line. */
export const maskAccount = (accountId: string): string => `…${accountId.slice(-4)}`;

/** Every `arn:aws…` token becomes `arn:…`; every run of exactly 12 digits (not part of a longer run) becomes `…` + its last 4. */
export function bedrockRedact(text: string): string {
  return text
    .replace(/arn:aws[A-Za-z0-9:_\-./@+=,*]*/g, (token) => { const id = /(?<!\d)\d{8}(\d{4})(?!\d)/.exec(token); return id ? `arn:…${id[1]}` : "arn:…"; })
    .replace(/(?<!\d)(\d{8})(\d{4})(?!\d)/g, "…$2");
}

// ---- name classes -------------------------------------------------------------------------------------------------------------

/** Names the Bedrock launch sets (the hand decides them; no settings file may). */
export const BEDROCK_SET_NAMES = ["CLAUDE_CODE_USE_BEDROCK", "AWS_PROFILE", "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_EC2_METADATA_DISABLED", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE"] as const;

const KEEP_EXACT = new Set([
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "ALL_PROXY", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED",
  "CLAUDE_CODE_ENABLE_PROXY_AUTH_HELPER", "CLAUDE_CODE_CERT_STORE", "CLAUDE_CODE_CLIENT_CERT", "CLAUDE_CODE_CLIENT_KEY",
  "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE", "BUN_TLS_REFUSE_DISTRUSTED_KEYS", "CLAUDE_CODE_PROXY_RESOLVES_HOSTS", "CLAUDE_CODE_PROXY_AUTH_HELPER_TTL_MS",
  "ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION", "ANTHROPIC_BEDROCK_REGION_PREFIX",
  "ANTHROPIC_BEDROCK_SERVICE_TIER", "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL_FORCE", "CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL",
  "CLAUDE_CODE_AUTO_MODE_MODEL", "CLAUDE_CODE_BG_CLASSIFIER_MODEL", "CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP",
]);
const KEEP_PREFIX = ["ANTHROPIC_DEFAULT_", "ANTHROPIC_CUSTOM_MODEL_OPTION", "NPM_CONFIG_", "CLAUDE_CODE_HTTP_PROXY", "CLAUDE_CODE_HTTPS_PROXY", "CLAUDE_CODE_PROXY_"];

/** Non-AWS provider names Claude Code ignores once CLAUDE_CODE_USE_BEDROCK=1 (Opus L2): dropped from the CLI env, never an R7 cause. */
const IGNORE_EXACT = new Set([
  "ANTHROPIC_VERTEX_PROJECT_ID", "ANTHROPIC_FOUNDRY_RESOURCE", "ANTHROPIC_GOOGLE_CLOUD_PROJECT", "ANTHROPIC_GOOGLE_CLOUD_LOCATION",
  "ANTHROPIC_GOOGLE_CLOUD_WORKSPACE_ID", "ANTHROPIC_AWS_WORKSPACE_ID", "CLOUD_ML_REGION", "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES", "CLOUDSDK_CONFIG", "GCE_METADATA_HOST", "GCE_METADATA_ROOT", "GCE_METADATA_IP",
  "GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT", "GOOGLE_CLOUD_QUOTA_PROJECT", "CLAUDE_CODE_SKIP_VERTEX_AUTH", "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
  "CLAUDE_CODE_API_KEY_HELPER_TTL_MS", "AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE",
]);
const IGNORE_PREFIX = ["VERTEX_REGION_CLAUDE_"];

const DELETE_EXACT = new Set([
  "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CODE_USE_GATEWAY", "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", "ANTHROPIC_UNIX_SOCKET", "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH", "AWS_BEARER_TOKEN_BEDROCK", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_ROLE_ARN",
  "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_EC2_METADATA_SERVICE_ENDPOINT", "AWS_ENDPOINT_URL", "ANTHROPIC_PROFILE", "ANTHROPIC_CONFIG_DIR",
  "CLAUDE_CODE_API_BASE_URL", "ANTHROPIC_BASE_URL",
]);
const DELETE_PREFIX = ["AWS_CONTAINER_", "AWS_ENDPOINT_URL_"];
// Names matching *_API_KEY, *_AUTH_TOKEN, *_OAUTH_*, *_TOKEN_FILE, *_BASE_URL and host-auth names are Delete because they sit in the owner-routing
// table with no keep tag (routing=true below); an unrelated *_API_KEY in the hand is not a routing name and is left to stripCapturedCredentialNames.

export type BedrockNameClass = "set" | "keep" | "delete" | "ignore" | "free";

/** How one env name is treated on a Bedrock instance. `routing` says whether the name is in the versioned owner-routing table: a
 * routing name with no tag counts as Delete (fail closed; the driver owner tags it when the CLI pin moves). */
export function classifyBedrockName(name: string, routing = false): BedrockNameClass {
  const upper = name.toUpperCase();
  if ((BEDROCK_SET_NAMES as readonly string[]).includes(upper)) return "set";
  if (KEEP_EXACT.has(upper) || KEEP_PREFIX.some((p) => upper.startsWith(p))) return "keep";
  if (IGNORE_EXACT.has(upper) || IGNORE_PREFIX.some((p) => upper.startsWith(p))) return "ignore";
  if (DELETE_EXACT.has(upper) || DELETE_PREFIX.some((p) => upper.startsWith(p))) return "delete";
  return routing ? "delete" : "free";
}

export interface BedrockFiles { configFile: string; credentialsFile: string }

/** The two AWS file paths IDENTITY and the CLI both use: the hand's own if it has them, else `~/.aws/*`. */
export function bedrockAwsFiles(hand: Readonly<Record<string, string | undefined>>, home: string): BedrockFiles {
  const sep = home.includes("\\") && !home.includes("/") ? "\\" : "/";
  return {
    configFile: hand.AWS_CONFIG_FILE || `${home}${sep}.aws${sep}config`,
    credentialsFile: hand.AWS_SHARED_CREDENTIALS_FILE || `${home}${sep}.aws${sep}credentials`,
  };
}

/** The Delete step, applied to a CLI spawn env map (or any strip site): names of class delete or ignore leave. */
export function bedrockDeleteNames(map: Record<string, string | undefined>, routingNames: (name: string) => boolean = () => false): string[] {
  const gone: string[] = [];
  for (const name of Object.keys(map)) {
    const kind = classifyBedrockName(name, routingNames(name));
    if (kind === "delete" || kind === "ignore") { delete map[name]; gone.push(name); }
  }
  return gone;
}

/** The Set step. Runs AFTER stripClaudeOwnedEnv at every strip site, so CLAUDE_CODE_USE_BEDROCK survives. */
export function bedrockSet(map: Record<string, string | undefined>, b: Pick<BedrockBinding, "profile" | "region">, files: BedrockFiles): void {
  for (const name of Object.keys(map)) if ((BEDROCK_SET_NAMES as readonly string[]).includes(name.toUpperCase())) delete map[name];
  map.CLAUDE_CODE_USE_BEDROCK = "1";
  map.AWS_PROFILE = b.profile;
  map.AWS_REGION = b.region;
  map.AWS_DEFAULT_REGION = b.region;
  map.AWS_EC2_METADATA_DISABLED = "true";
  map.AWS_CONFIG_FILE = files.configFile;
  map.AWS_SHARED_CREDENTIALS_FILE = files.credentialsFile;
}

/** Delete then Set: the whole Bedrock env step for a CLI spawn env. */
export function applyBedrockEnv(map: Record<string, string | undefined>, b: Pick<BedrockBinding, "profile" | "region">, files: BedrockFiles, routingNames?: (name: string) => boolean): void {
  bedrockDeleteNames(map, routingNames);
  bedrockSet(map, b, files);
}

/** The value of a Set name the CLI will get, for the R7 compare. */
export function bedrockSetValues(b: Pick<BedrockBinding, "profile" | "region">, files: BedrockFiles): Record<string, string> {
  const m: Record<string, string | undefined> = {};
  bedrockSet(m, b, files);
  return m as Record<string, string>;
}

// ---- R7: settings files cannot redirect ------------------------------------------------------------------------------------------

export const BEDROCK_HELPER_KEYS = ["apiKeyHelper", "awsCredentialExport", "awsAuthRefresh"] as const;

export interface BedrockSettingsRead { path: string; env: Record<string, string>; helpers: string[]; cannot?: string }

/** One settings file: its `env` block (string-ified) and which of the three helper keys it sets. A missing file is empty; a file that
 * exists and cannot be read or parsed carries `cannot` (R7 refuses it, also under No limits). */
export function readBedrockSettings(path: string, read: (p: string) => string = (p) => readFileSync(p, "utf8")): BedrockSettingsRead {
  let text: string;
  try { text = read(path); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? { path, env: {}, helpers: [] } : { path, env: {}, helpers: [], cannot: `it could not be read (${code ?? "error"})` };
  }
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { return { path, env: {}, helpers: [], cannot: "it is not valid JSON" }; }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { path, env: {}, helpers: [], cannot: "it is not a settings object" };
  const d = doc as Record<string, unknown>;
  const env: Record<string, string> = {};
  if (d.env !== undefined && d.env !== null) {
    if (typeof d.env !== "object" || Array.isArray(d.env)) return { path, env: {}, helpers: [], cannot: "its env block is not an object" };
    for (const [k, v] of Object.entries(d.env as Record<string, unknown>)) if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") env[k] = String(v);
  }
  return { path, env, helpers: BEDROCK_HELPER_KEYS.filter((k) => d[k] !== undefined && d[k] !== null) };
}

export interface BedrockR7 { path: string; name: string; text: string }

/** R7. Refuse if any file sets a Delete or Set name to a value other than the hand's (a Delete name is absent from the hand, so any value
 * is a difference), sets one of the three helper keys, or exists but cannot be checked. Keep and ignore names never refuse. Takes no
 * noLimits argument: R1-R7 are identity refusals. */
export function bedrockSettingsRefusal(files: readonly BedrockSettingsRead[], hand: Readonly<Record<string, string | undefined>>, routingNames: (name: string) => boolean = () => false): BedrockR7 | null {
  const handLower = new Map(Object.entries(hand).map(([k, v]) => [k.toUpperCase(), v]));
  for (const f of files) {
    if (f.cannot) return { path: f.path, name: "env", text: `Claude's turn was not started: Murage cannot check the "env" block of ${f.path} because ${f.cannot}. Nothing was sent. Fix or remove that file and send the message again.` };
    for (const helper of f.helpers) return { path: f.path, name: helper, text: r7Text(f.path, helper) };
    for (const [name, value] of Object.entries(f.env)) {
      const kind = classifyBedrockName(name, routingNames(name));
      if (kind !== "set" && kind !== "delete") continue;
      if (kind === "set" && handLower.get(name.toUpperCase()) === value) continue;
      return { path: f.path, name, text: r7Text(f.path, name) };
    }
  }
  return null;
}
const r7Text = (path: string, name: string) =>
  `Your Claude settings file ${path} sets ${name}, which would send this engine's use to a different AWS account or endpoint. Nothing was sent. Remove it from that file, or use a separate Claude engine for it.`;

// ---- Section 4: errors from Bedrock during a turn ----------------------------------------------------------------------------------

export type BedrockErrorRow = "access-denied" | "validation" | "expired" | "throttled" | "other";

export interface BedrockFrame { text: string; isApiError: boolean; isErrorResult: boolean; subtype?: string; stopRequested?: boolean }

/** Whether a frame is a Bedrock/provider error this table may own. Never a confirmed Stop, never a runner-side result (error_max_turns and
 * similar: Opus H1). An `is_error` result counts only when it carries provider error text. */
export function bedrockFrameApplies(f: BedrockFrame): boolean {
  if (f.stopRequested) return false;
  if (f.isApiError) return true;
  if (!f.isErrorResult) return false;
  if (f.subtype && /^error_(max_turns|during_execution|max_budget|max_structured)/.test(f.subtype)) return false;
  return /Exception|AccessDenied|ThrottlingException|security token|credentials|\b(?:401|403|429)\b|Unauthorized|Forbidden|Bedrock|AWS/i.test(f.text);
}

/** The CLI relays a Bedrock error as `API Error: <status> <AWS message>`, with no exception name (the name travels in a response header), so
 * each row matches the AWS sentence as well as the name. The status alone decides nothing (a model that is not ready is a 429 too). */
export function classifyBedrockError(text: string): BedrockErrorRow {
  if (/ExpiredToken|UnrecognizedClientException|SSO (?:session|token)[^.\n]*expired|token (?:has )?expired|security token included in the request is expired/i.test(text)) return "expired";
  if (/ThrottlingException|ServiceQuotaExceededException|TooManyRequests/i.test(text) || /^(?:API Error:? ?\(?429 )?(?:\{"message":")?too many (?:requests|tokens)(?: per day)?, please wait before trying again\.?(?:"\})?\)?$/i.test(text.trim())) return "throttled";
  if (/ValidationException/i.test(text) && /model identifier|inference profile|model id/i.test(text)) return "validation";
  if ((/AccessDeniedException/i.test(text) && /model/i.test(text)) || /don't have access to the model/i.test(text)) return "access-denied";
  return "other";
}

/** Only throttling and quota errors count as a usage limit; every other row never starts the limit backup. */
export const bedrockIsLimit = (row: BedrockErrorRow): boolean => row === "throttled";

export interface BedrockRowContext { accountId: string; region: string; profile: string }

export function bedrockErrorRowText(row: BedrockErrorRow, ctx: BedrockRowContext, rawText: string): string {
  const acct = maskAccount(ctx.accountId);
  switch (row) {
    case "access-denied": return `Your AWS account ${acct} has no access to this model in ${ctx.region}. Turn it on under Model access in the Bedrock console, then send again.`;
    case "validation": return `Bedrock in ${ctx.region} does not offer this model id. Pick another model for this engine.`;
    case "expired": return `Your AWS sign-in for profile \`${ctx.profile}\` expired. Run \`aws sso login --profile ${ctx.profile}\` (or renew its keys), then send again.`;
    case "throttled": return `AWS throttled this account's Bedrock use (quota in ${ctx.region}). Wait or raise the quota in AWS, then send again.`;
    default: return `Bedrock refused this message for AWS account ${acct} (${bedrockRedact(rawText).replace(/\s+/g, " ").trim().slice(0, 200)}). Nothing switched. Fix it in AWS, or Check again in Settings, then send again.`;
  }
}

// ---- refusal rows before launch ------------------------------------------------------------------------------------------------

export const BEDROCK_R1 = "This Bedrock engine is not set up. Open Settings › Engines and check its AWS profile.";
export const BEDROCK_R4 = "This engine's AWS settings changed while your message was starting. Nothing was sent. Send again.";
export const BEDROCK_R5 = "Claude on Bedrock runs only on your own computer, where your AWS sign-in is.";
export const bedrockR2 = (profile: string, now: string, bound: string) =>
  `Profile \`${profile}\` now signs in to AWS account ${maskAccount(now)}, but this engine is bound to ${maskAccount(bound)}. Nothing was sent. Check again in Settings to bind the new account.`;
export const bedrockR3 = (profile: string, reason: string) =>
  `Murage could not confirm your AWS sign-in for profile \`${profile}\` (${bedrockRedact(reason).replace(/\s+/g, " ").trim().slice(0, 200)}). Nothing was sent.`;

/** The one sentence a Windows computer with no Git Bash adds (powershell-inherit: commands inherit the CLI env and cannot be separated). */
export const bedrockCommandsSentence = (profile: string, region: string): string =>
  `On this computer, commands the bot runs also use AWS profile \`${profile}\` in ${region}.`;

/** The Save line (full account id, shown once right after Save) plus the inherit-mode sentence when it applies. */
export function bedrockSaveLine(b: BedrockBinding, inherit: boolean): string {
  const base = `Signed in to AWS account ${b.accountId} with profile \`${b.profile}\` in ${b.region}. AWS bills this account for Bedrock use. Murage does not.`;
  return inherit ? `${base} ${bedrockCommandsSentence(b.profile, b.region)}` : base;
}
