#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// The ONLY supported deploy (Astra TRUSTCODE-1 P2-1):  pnpm run deploy:staging   (= node scripts/deploy.mjs staging)
// It (a) refuses every argument but the environment name, so no --name, --var, --config, --env override can reach wrangler; (b) validates
// wrangler.jsonc as RESOLVED for that environment (Worker name, account id, D1 ids, MAIL_SINK only on staging with the exact staging sink id,
// STAGING_MAIL_SINK / MAIL_SINK_ALLOWLIST only in env.staging.vars; scripts/check-deploy.mjs); (c) then runs exactly
//   npx --yes wrangler@4.149.0 deploy --config <the exact validated wrangler.jsonc path> --env <env>
// itself, with nothing else on the command line. The checked config file is the one wrangler reads (wrangler.jsonc in this directory), and
// an account or environment override in the process environment that disagrees with the validated one is refused.
// Production is env.production (account b8312..., Worker murage-control-plane): `node scripts/deploy.mjs production` runs `deploy --env production`
// only when check-deploy finds no PROD_TODO_ placeholder, no staging value, no test Stripe and no mail sink in that block. The top level is not deployed.
import { checkDeploy, checkFluxRollout, FLUX_ROLLOUT_SQL, fluxRolloutMarkSql, deployWarnings, stripJsonc, freezeMarkerSet, PRODUCTION_ACCOUNT, PRODUCTION_WORKER, STAGING_ACCOUNT, FREEZE_VAR, PROVISIONING_VAR, SALES_VAR } from "./check-deploy.mjs";
import { isDenialEnvelope } from "../src/env-policy.mjs";

export const WRANGLER_VERSION = "4.149.0";
const ENVIRONMENTS = ["staging", "production"];
export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const PROBE_TIMEOUT_MS = 10_000;
/** Settings that would change which account, endpoint or credential wrangler uses. */
const REFUSED_ENV_NAMES = ["CLOUDFLARE_API_KEY", "CLOUDFLARE_EMAIL", "CLOUDFLARE_API_BASE_URL", "WRANGLER_API_ENVIRONMENT", "CF_API_KEY", "CF_EMAIL", "CF_ACCOUNT_ID"];

/** The one flag besides the environment name: a freeze deploy (KMS-SIGNING-DESIGN 12.4, 12.5). It reaches check-deploy, never wrangler. */
export const FREEZE_FLAG = "--freeze";
/** The dark-prod flag: a normal production deploy that additionally enforces the dark-prod conditions (sales off, B3 off, no Stripe secret, no mail sink, home images empty or pinned). Production only. */
export const DARK_FLAG = "--dark";
/** Freeze provenance (12.5 H2): the tree must be clean and HEAD must equal the head of this branch on this remote, read fresh. */
export const FREEZE_REMOTE = "dev";
export const FREEZE_REF = "refs/heads/cloud-v2/release";
const FREEZE_REMOTE_URL = /^(?:https:\/\/github\.com\/|git@github\.com:)FerroxLabs\/murage-dev(?:\.git)?$/;
const SHA = /^[0-9a-f]{40}$/;

/** The wrangler invocation for these CLI arguments, or the reasons it is refused. */
/** @param {string[]} argv @param {Record<string, string | undefined>} [processEnv] @param {string} [configPath] absolute path of the validated wrangler.jsonc */
export function plan(argvIn, processEnv = {}, configPath = undefined) {
  const problems = [];
  const freezeFlags = argvIn.filter((a) => a === FREEZE_FLAG).length;
  const darkFlags = argvIn.filter((a) => a === DARK_FLAG).length;
  const argv = argvIn.filter((a) => a !== FREEZE_FLAG && a !== DARK_FLAG);
  const freeze = freezeFlags > 0;
  const dark = darkFlags > 0;
  if (darkFlags > 1) problems.push(`${DARK_FLAG} may be given once`);
  if (dark && freeze) problems.push(`${DARK_FLAG} and ${FREEZE_FLAG} are exclusive`);
  if (freezeFlags > 1) problems.push(`${FREEZE_FLAG} may be given once`);
  if (typeof configPath !== "string" || !configPath.startsWith("/") || !configPath.endsWith("/wrangler.jsonc")) problems.push("the validated config must be an absolute path to wrangler.jsonc");
  if (argv.length !== 1) problems.push(`exactly one argument is allowed (${ENVIRONMENTS.join(" | ")}); got ${argv.length}. No wrangler flag (--name, --var, --env, --config, ...) may be passed.`);
  const target = argv[0];
  if (argv.length >= 1 && !ENVIRONMENTS.includes(target)) problems.push(`unknown environment ${JSON.stringify(target)} (${ENVIRONMENTS.join(" | ")})`);
  if (freeze && argv.length >= 1 && target !== "production") problems.push(`${FREEZE_FLAG} applies to production only`);
  if (dark && argv.length >= 1 && target !== "production") problems.push(`${DARK_FLAG} applies to production only`);
  if (problems.length > 0) return { problems };
  const account = target === "staging" ? STAGING_ACCOUNT : PRODUCTION_ACCOUNT;
  if (processEnv.CLOUDFLARE_ACCOUNT_ID && processEnv.CLOUDFLARE_ACCOUNT_ID !== account) problems.push("CLOUDFLARE_ACCOUNT_ID in the environment is not this environment's account");
  if (processEnv.CLOUDFLARE_ENV && processEnv.CLOUDFLARE_ENV !== target) problems.push("CLOUDFLARE_ENV in the environment is not the requested environment");
  for (const name of REFUSED_ENV_NAMES) if (processEnv[name]) problems.push(`${name} is set in the environment; it can change the account, endpoint or credential`);
  if (problems.length > 0) return { problems };
  const args = ["--yes", `wrangler@${WRANGLER_VERSION}`, "deploy", "--config", configPath, "--env", target];
  return { target, freeze, dark, command: "npx", args, problems, account, otherAccount: target === "staging" ? PRODUCTION_ACCOUNT : STAGING_ACCOUNT };
}

/**
 * Validate and (unless refused) run. `io` = { configPath, exists(path), readConfig(): string, run(command, args): number, env, log, error, homeImages? }. Returns the exit code.
 * @param {string[]} argv
 * @param {{ env?: Record<string, string | undefined>, configPath?: string, exists?: (path: string) => boolean, homeImages?: { x86: string, arm: string, digest: string } | null, readConfig(): string, run(command: string, args: string[]): number, log(message: string): void, error(message: string): void }} io
 * Nothing runs unless every check passed.
 */
/**
 * Freeze provenance, FAIL CLOSED: refuses unless the working tree is clean and HEAD equals the head of FREEZE_REF on FREEZE_REMOTE, read fresh from the remote.
 * No network, an auth error, a missing or odd ref, a wrong remote url or any thrown error is a refusal. `git(args)` returns { status, stdout } (injected, so tests run offline).
 * Returns { problems, head, tree }.
 */
export function freezeProvenance(git) {
  const problems = []; let head = null; let tree = null;
  const out = (args) => {
    const r = git(args);
    if (!r || r.status !== 0 || typeof r.stdout !== "string") throw new Error(`git ${args[0]} failed`);
    return r.stdout;
  };
  try {
    if (out(["status", "--porcelain", "--untracked-files=all"]).trim() !== "") problems.push("freeze: the working tree is not clean (commit or remove every change)");
    head = out(["rev-parse", "HEAD"]).trim(); tree = out(["rev-parse", "HEAD^{tree}"]).trim();
    if (!SHA.test(head) || !SHA.test(tree)) { problems.push("freeze: HEAD or its tree is not a full sha"); head = SHA.test(head) ? head : null; tree = SHA.test(tree) ? tree : null; }
    const url = out(["remote", "get-url", FREEZE_REMOTE]).trim();
    if (!FREEZE_REMOTE_URL.test(url)) problems.push(`freeze: remote ${FREEZE_REMOTE} is not the dev repository`);
    const lines = out(["ls-remote", "--refs", FREEZE_REMOTE, FREEZE_REF]).split("\n").map((l) => l.trim()).filter(Boolean);
    const m = lines.length === 1 ? /^([0-9a-f]{40})\s+(\S+)$/.exec(lines[0]) : null;
    if (!m || m[2] !== FREEZE_REF) problems.push(`freeze: could not read ${FREEZE_REF} on ${FREEZE_REMOTE} (refused: the remote head must be verified fresh)`);
    else if (m[1] !== head) problems.push(`freeze: HEAD ${head} is not the ${FREEZE_REMOTE} ${FREEZE_REF} head ${m[1]}`);
  } catch (e) { problems.push(`freeze: provenance could not be verified, fails closed (${e instanceof Error ? e.message : "error"})`); }
  return { problems, head, tree };
}

function validate(argv, io) {
  const p = plan(argv, io.env ?? {}, io.configPath);
  let problems = p.problems;
  let text;
  if (problems.length === 0) {
    // Wrangler prefers a sibling wrangler.json / wrangler.toml and follows a .wrangler/deploy/config.json redirect when no --config is given. We pass --config,
    // but refuse to deploy at all while any of them exists beside the validated file (Astra LAUNCHCP4 P1-1).
    const dir = io.configPath.slice(0, io.configPath.lastIndexOf("/") + 1);
    for (const f of ["wrangler.json", "wrangler.toml", ".wrangler/deploy/config.json"]) {
      if (typeof io.exists !== "function") { problems = ["cannot check for competing wrangler config files"]; break; }
      if (io.exists(dir + f)) problems.push(`${dir}${f} exists beside the validated config; remove it`);
    }
  }
  if (problems.length === 0) {
    try { text = io.readConfig(); } catch (e) { problems = [`wrangler.jsonc cannot be read: ${e instanceof Error ? e.message : String(e)}`]; }
    if (text !== undefined) {
      // io.now is a number (the signature-check time, tests) or a clock function (the freeze path); the check gets a number either way, never a function.
      const nowMs = typeof io.now === "function" ? io.now() : io.now;
      const opts = { ...(io.homeImages === undefined ? {} : { homeImages: io.homeImages }), ...(io.imageTrust ? { trust: io.imageTrust } : {}), ...(nowMs !== undefined ? { now: nowMs } : {}), ...(p.freeze ? { freeze: true } : {}), ...(p.dark ? { dark: true } : {}) };
      problems = checkDeploy(text, p.target, opts);
      // While the freeze marker is set, a normal deploy is the way out of freeze: it gets the FULL check, and any failure refuses it with nothing waived.
      let marker = false;
      if (p.target === "production" && !p.freeze) { try { marker = freezeMarkerSet(JSON.parse(stripJsonc(text))?.env?.production); } catch { marker = false; } }
      if (marker && problems.length > 0) problems = [`the freeze marker (${FREEZE_VAR}) is set: leaving freeze is a normal deploy that must pass the FULL check-deploy, and nothing is waived`, ...problems];
      if (problems.length === 0) for (const w of deployWarnings(text, p.target, opts)) io.log(`deploy: warning: ${w}`);
    }
  }
  let provenance = null;
  if (problems.length === 0 && p.freeze) {
    if (typeof io.git !== "function") problems = ["freeze: no git runner, so provenance cannot be verified"];
    else { provenance = freezeProvenance(io.git); problems = provenance.problems; }
  }
  // Build stamp: the git sha goes into the Worker version (wrangler deploy --message <full sha> --tag <first 12 hex>; the tag stays short because the Workers API tag length limit is not known from the installed wrangler, which checks nothing client-side), so a version in the dashboard names its commit.
  // A dirty tree refuses (the sha would not describe what ships). A freeze deploy already proved a clean tree and reuses its HEAD. main() always supplies io.git.
  if (problems.length === 0 && p.args) {
    let sha = provenance?.head ?? null;
    if (sha === null && typeof io.git === "function") { const st = buildStamp(io.git); problems = st.problems; sha = st.sha; }
    if (problems.length === 0 && sha !== null) p.args = [...p.args, "--message", sha, "--tag", sha.slice(0, 12)];
  }
  return { p, problems, text, provenance };
}

/** The commit sha to stamp on the Worker version, FAIL CLOSED: the tree must be clean (tracked and untracked) and HEAD a full 40-hex sha. Returns { problems, sha }. */
export function buildStamp(git) {
  try {
    const st = git(["status", "--porcelain", "--untracked-files=all"]);
    if (!st || st.status !== 0 || typeof st.stdout !== "string") return { problems: ["build stamp: git status failed, so the commit cannot be stamped on the version (refused)"], sha: null };
    if (st.stdout.trim() !== "") return { problems: ["build stamp: the working tree is dirty; commit or remove every change so the version names the code that ships (refused)"], sha: null };
    const h = git(["rev-parse", "HEAD"]);
    const sha = h && h.status === 0 && typeof h.stdout === "string" ? h.stdout.trim() : "";
    if (!SHA.test(sha)) return { problems: ["build stamp: HEAD is not a full 40-hex sha (refused)"], sha: null };
    return { problems: [], sha };
  } catch { return { problems: ["build stamp: git could not be read (refused)"], sha: null }; }
}
/**
 * The dark-prod LIVE preflight (read-only): refuses when ANY Stripe secret is bound in the Worker (`wrangler secret list`: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
 * STRIPE_ALLOW_LIVE, or any other STRIPE_ name) or when STRIPE_ALLOW_LIVE is set in the deploy environment. FAILS CLOSED: no lister, a throw or a malformed answer refuses.
 * `io.secretList({ target, account })` returns the bound secret NAMES (strings, or objects with a name). Only names and presence are ever reported, never a value.
 */
export async function darkLivePreflight(io, p) {
  const problems = [];
  if ((io.env ?? {}).STRIPE_ALLOW_LIVE !== undefined) problems.push("dark: STRIPE_ALLOW_LIVE is set in the deploy environment (refused in any form)");
  if (typeof io.secretList !== "function") return [...problems, "dark: no wrangler secret list runner, so the bound secrets cannot be verified (fails closed)"];
  let names;
  try { names = await io.secretList({ target: p.target, account: p.account }); } catch { return [...problems, "dark: wrangler secret list failed, so the bound secrets cannot be verified (fails closed)"]; }
  if (!Array.isArray(names)) return [...problems, "dark: wrangler secret list returned something unreadable (fails closed)"];
  for (const n of names) {
    const name = typeof n === "string" ? n : n && typeof n === "object" ? n.name : undefined;
    if (typeof name !== "string") { problems.push("dark: wrangler secret list returned an entry without a name (fails closed)"); continue; }
    if (/^STRIPE_/i.test(name) || /(sk|rk)_live_|whsec_/i.test(name)) problems.push(`dark: a Stripe secret is bound in the Worker (${/(sk|rk)_live_|whsec_/i.test(name) ? "redacted" : name}); remove it with wrangler secret delete before a dark deploy`);
  }
  return problems;
}
export const DARK_LIVE_PREFLIGHT_OK = "live preflight: wrangler secret list shows no Stripe secret bound; STRIPE_ALLOW_LIVE not set";

export function deploy(argv, io) {
  const { p, problems } = validate(argv, io);
  if (problems.length === 0 && p.dark) { io.error(`deploy: REFUSED\n  - ${DARK_FLAG} needs the preflight path (live wrangler secret list); this entry point cannot do a dark deploy`); return 1; }
  if (problems.length === 0 && p.freeze) { io.error(`deploy: REFUSED\n  - ${FREEZE_FLAG} needs the preflight path (alert, record and live re-read); this entry point cannot do a freeze deploy`); return 1; }
  if (problems.length > 0) {
    io.error(`deploy: REFUSED\n${problems.map((x) => `  - ${x}`).join("\n")}`);
    return 1;
  }
  io.log(`deploy: ok, running: ${p.command} ${p.args.join(" ")}`);
  return io.run(p.command, p.args);
}

/** The environment wrangler runs with: everything but Cloudflare/Wrangler settings, plus the one token and the account from the plan. */
export function childEnvironment(processEnv, token, account) {
  const out = {};
  for (const [k, v] of Object.entries(processEnv)) {
    if (v === undefined || /^(CLOUDFLARE_|CF_|WRANGLER_)/.test(k)) continue;
    out[k] = v;
  }
  out.CLOUDFLARE_API_TOKEN = token;
  out.CLOUDFLARE_ACCOUNT_ID = account;
  return out;
}

/** One Workers listing probe: { status, body }; redirects are not followed; throws on a network error or timeout. */
async function probe(io, token, account) {
  const response = await io.fetch(`${CLOUDFLARE_API}/accounts/${account}/workers/scripts`, {
    method: "GET", headers: { authorization: `Bearer ${token}`, accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  return { status: response.status, body };
}

/**
 * Problems with the token's reach; empty when it can list Workers in its own account (200) and is denied in the other environment's account
 * (HTTP 403 with a Cloudflare error envelope carrying code 10000). FAILS CLOSED: any other status, redirect, body, timeout or exception is a problem.
 */
export async function accountPreflight(io, token, account, otherAccount) {
  const problems = [];
  if (!token) return ["CLOUDFLARE_API_TOKEN is not set; the deploy token is read from the environment and no login is used instead"];
  if (account === otherAccount) return ["the two accounts are the same; refusing"];
  try {
    const own = await probe(io, token, account);
    if (own.status !== 200 || !own.body || typeof own.body !== "object" || own.body.success !== true) problems.push("preflight: the token cannot list Workers in its own account (expected 200)");
  } catch { problems.push("preflight: the token's own account could not be checked"); }
  try {
    const other = await probe(io, token, otherAccount);
    if (!isDenialEnvelope(other.status, other.body)) problems.push("preflight: the token is not denied in the other environment's account (only 403 with code 10000 passes)");
  } catch { problems.push("preflight: the other account could not be checked"); }
  return problems;
}

/**
 * The deploy with the account preflight: validate, probe both accounts with the one token, read the config again (a change in between refuses),
 * then run wrangler with a scrubbed environment. `io` is deploy()'s io plus { fetch, run(command, args, env) }. Nothing runs unless every step passed.
 */
export async function deployWithPreflight(argv, io) {
  const { p, problems: first, text, provenance } = validate(argv, io);
  let problems = first;
  const processEnv = io.env ?? {};
  if (problems.length === 0) {
    try { problems = await accountPreflight(io, processEnv.CLOUDFLARE_API_TOKEN, p.account, p.otherAccount); } catch { problems = ["preflight: failed"]; }
  }
  if (problems.length === 0 && p.dark) {
    try { problems = await darkLivePreflight(io, p); } catch { problems = ["dark: live preflight failed (fails closed)"]; }
  }
  if (problems.length === 0) {
    let again;
    try { again = io.readConfig(); } catch { again = undefined; }
    if (again !== text) problems = ["wrangler.jsonc changed while the deploy was being checked"];
  }
  if (problems.length > 0) {
    io.error(`deploy: REFUSED\n${problems.map((x) => `  - ${x}`).join("\n")}`);
    return 1;
  }
  // FLUX-ENSURE-EMAIL-VERIFIED (M4): the ONE-TIME first-rollout check (check-deploy checkFluxRollout), read BEFORE the epoch write and the
  // upload, so a refusal changes nothing. Once the marker is written, later production deploys skip the count.
  const rollout = await fluxLinksPreflight(io, p.target, d1DatabaseName(text, p.target));
  if (rollout.problems.length > 0) {
    io.error(`deploy: REFUSED\n${rollout.problems.map((x) => `  - ${x}`).join("\n")}`);
    return 1;
  }
  // 10.4/12.3: the epoch goes into D1 BEFORE the upload; a failure here refuses with nothing deployed, and an interrupted upload leaves admission held.
  const epochProblems = await activateEpoch(io, p.target, d1DatabaseName(text, p.target));
  if (epochProblems.length > 0) {
    io.error(`deploy: REFUSED\n${epochProblems.map((x) => `  - ${x}`).join("\n")}`);
    return 1;
  }
  let code;
  if (p.freeze) code = await freezeDeploy(p, provenance, io);
  else {
    if (p.dark) io.log(`deploy: ${DARK_LIVE_PREFLIGHT_OK}`);
    io.log(`deploy: ok, running: ${p.command} ${p.args.join(" ")}`);
    code = await io.run(p.command, p.args, childEnvironment(processEnv, processEnv.CLOUDFLARE_API_TOKEN, p.account));
  }
  if (code === 0 && rollout.firstRollout) return markFluxRollout(io, p.target, d1DatabaseName(text, p.target));
  return code;
}

/** M4: after the FIRST production deploy that passed the zero-link check succeeded, the marker is written, so later deploys skip the count. A
 *  failed write is reported (exit 1): the Worker is deployed, and the next deploy judges the count again until the marker exists. */
async function markFluxRollout(io, target, database) {
  try {
    await io.d1(fluxRolloutMarkSql(typeof io.now === "function" ? io.now() : Date.now()), { target, database });
    return 0;
  } catch {
    io.error("deploy: the Worker deployed, but the email proof rollout marker could not be written; run the deploy again or write it by hand: "
      + "INSERT OR IGNORE INTO flux_email_proof_rollout (id,at) VALUES ('first',<now in ms>)");
    return 1;
  }
}

/** The bundle's policy epoch, read from the source constant the Worker ships (`export const IMAGE_POLICY_EPOCH = N;` in src/image-signature.ts). null when it is not exactly one such line. */
export function bundleEpochOf(source) {
  if (typeof source !== "string") return null;
  const found = [...source.matchAll(/^export const IMAGE_POLICY_EPOCH\s*=\s*(\d+)\s*;/gm)];
  if (found.length !== 1) return null;
  const n = Number(found[0][1]);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/**
 * KMS 9.6, 10.4, 12.3 (Astra G3-KMS H3): activate the bundle's policy epoch in D1 BEFORE `wrangler deploy`. The OLD bundle's fresh readiness row then carries a lower
 * epoch than the durable one, so sales and provisioning are held for as long as the deploy takes, and stay held if it stalls or is interrupted. FAILS CLOSED: no D1 runner,
 * an unreadable bundle epoch, a runner error, or a read-back below the bundle epoch refuses the deploy; a stored epoch ABOVE the bundle's (a rollback) refuses it too.
 * `io.d1(sql, { target, database })` runs one statement (or one `;`-separated batch, answered with its first statement's results) against the environment's D1 (wrangler d1 execute --remote) and returns { results }. Returns the problems.
 */
export async function activateEpoch(io, target, database) {
  if (typeof io.d1 !== "function") return ["epoch: no D1 runner, so the policy epoch cannot be activated before the upload (refused)"];
  let bundle = null;
  try { bundle = bundleEpochOf(typeof io.bundleEpoch === "function" ? io.bundleEpoch() : io.bundleEpoch); } catch { bundle = null; }
  if (bundle === null) return ["epoch: the bundle's IMAGE_POLICY_EPOCH could not be read (refused)"];
  if (typeof database !== "string" || !database) return ["epoch: the D1 database name for this environment is not in the validated config (refused)"];
  try {
    // One D1 batch (KMS 13 (a)): the epoch is raised and every still-open authorization of a LOWER epoch (written, POST not answered: it may have been
    // sent by the old bundle) is marked needs_review for the sweep. settled_* rows are not: an epoch is a config generation, not a revocation.
    await io.d1(`INSERT INTO image_policy (id,epoch) VALUES ('current',${bundle}) ON CONFLICT(id) DO UPDATE SET epoch=MAX(epoch,excluded.epoch); `
      + `UPDATE image_dispatch_auth SET state='needs_review',review_reason='epoch' WHERE epoch < ${bundle} AND state = 'open'`, { target, database });
    const read = await io.d1("SELECT epoch FROM image_policy WHERE id='current'", { target, database });
    const stored = Number(read?.results?.[0]?.epoch);
    if (!Number.isSafeInteger(stored)) return ["epoch: the policy epoch could not be read back from D1 (refused)"];
    if (stored < bundle) return [`epoch: the D1 policy epoch reads ${stored}, below this bundle's ${bundle} (refused)`];
    if (stored > bundle) return [`epoch: the D1 policy epoch ${stored} is above this bundle's ${bundle}: this is a rollback to an older bundle, which is prohibited (redeploy a fix forward)`];
  } catch { return ["epoch: activating the policy epoch in D1 failed (refused; nothing was deployed)"]; }
  return [];
}

/** M4: the email proof rollout marker and the production flux_links count, read-only in ONE statement, judged by check-deploy's
 *  checkFluxRollout. Production only; fails closed (no runner, a runner error, an unreadable row). The RAW values are judged, never converted
 *  first. Returns the problems and whether this is the first rollout. */
export async function fluxLinksPreflight(io, target, database) {
  if (target !== "production") return { problems: [], firstRollout: false };
  const refuse = (m) => ({ problems: [m], firstRollout: false });
  if (typeof io.d1 !== "function") return refuse("flux links: no D1 runner, so the production flux_links count cannot be read (refused)");
  if (typeof database !== "string" || !database) return refuse("flux links: the D1 database name for this environment is not in the validated config (refused)");
  let row;
  try { row = (await io.d1(FLUX_ROLLOUT_SQL, { target, database }))?.results?.[0]; }
  catch { return refuse("flux links: reading flux_links from production D1 failed (refused; nothing was deployed)"); }
  return checkFluxRollout(target, row);
}

/** The D1 database name of the validated env block's DB binding. */
function d1DatabaseName(text, target) {
  try {
    const blk = JSON.parse(stripJsonc(text))?.env?.[target];
    const db = (Array.isArray(blk?.d1_databases) ? blk.d1_databases : []).find((d) => d?.binding === "DB");
    return typeof db?.database_name === "string" ? db.database_name : null;
  } catch { return null; }
}

/** The plain-text vars of the LIVE Worker (Cloudflare settings API), or null when they cannot be read. */
export async function readLiveVars(io, token, account, worker) {
  try {
    const response = await io.fetch(`${CLOUDFLARE_API}/accounts/${account}/workers/scripts/${worker}/settings`, {
      method: "GET", headers: { authorization: `Bearer ${token}`, accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const body = await response.json();
    if (response.status !== 200 || !body || body.success !== true || !Array.isArray(body.result?.bindings)) return null;
    const vars = {};
    for (const b of body.result.bindings) if (b && b.type === "plain_text" && typeof b.name === "string") vars[b.name] = b.text;
    return vars;
  } catch { return null; }
}

/** Alert Sean through the operator alert path (a webhook post, the same body shape as the Worker's operator alerts). True only when delivered. */
async function notify(io, payload) {
  try { return (await io.alert(payload)) === true; } catch { return false; }
}

/**
 * The freeze deploy after every check and the preflight passed (KMS-SIGNING-DESIGN 12.4, 12.5): alert Sean (HEAD sha, tree sha, who, when) BEFORE anything
 * ships (an undelivered alert refuses), write the deploy record with the same shas, deploy, then re-read the LIVE config and alert (exit 1) if provisioning or
 * sales is not off or the re-read fails.
 */
async function freezeDeploy(p, provenance, io) {
  const processEnv = io.env ?? {};
  const at = typeof io.now === "function" ? io.now() : Date.now();
  let who = "unknown"; try { who = typeof io.who === "function" ? String(io.who()) : "unknown"; } catch { who = "unknown"; }
  const base = { target: p.target, head: provenance.head, tree: provenance.tree, who, at: new Date(at).toISOString() };
  const text = `FREEZE DEPLOY to ${p.target}: HEAD ${base.head}, tree ${base.tree}, run by ${who} at ${base.at}`;
  const refuse = (m) => { io.error(`deploy: REFUSED\n  - ${m}`); return 1; };
  if (typeof io.alert !== "function" || typeof io.record !== "function") return refuse("freeze: an alert path and a deploy record are required");
  if (!(await notify(io, { kind: "freeze.deploy", severity: "critical", text, ...base }))) return refuse("freeze: the operator alert could not be delivered, so nothing was deployed");
  try { io.record({ kind: "freeze-deploy", stage: "start", ...base }); } catch { return refuse("freeze: the deploy record could not be written, so nothing was deployed"); }
  io.log(`deploy: ok, running: ${p.command} ${p.args.join(" ")}`);
  const code = io.run(p.command, p.args, childEnvironment(processEnv, processEnv.CLOUDFLARE_API_TOKEN, p.account));
  let live = null; let bad = [];
  if (code === 0) {
    live = await readLiveVars(io, processEnv.CLOUDFLARE_API_TOKEN, p.account, PRODUCTION_WORKER);
    if (live === null) bad = ["the live config could not be re-read"];
    else for (const k of [PROVISIONING_VAR, SALES_VAR]) if (live[k] !== "false") bad.push(`live ${k} is ${JSON.stringify(live[k] ?? null)}, not "false"`);
    if (bad.length > 0) await notify(io, { kind: "freeze.live_check", severity: "critical", text: `FREEZE DEPLOY live check FAILED: ${bad.join("; ")}. ${text}`, ...base, problems: bad });
  }
  try { io.record({ kind: "freeze-deploy", stage: "done", ...base, exit: code, liveProblems: bad }); } catch { io.error("deploy: the closing deploy record could not be written"); }
  if (bad.length > 0) { io.error(`deploy: freeze live check FAILED\n${bad.map((x) => `  - ${x}`).join("\n")}`); return 1; }
  return code;
}

const invokedDirectly = typeof process !== "undefined" && Array.isArray(process.argv) && typeof process.argv[1] === "string"
  && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").slice(-2).join("/"));
async function main() {
  const { readFileSync, existsSync, mkdirSync, appendFileSync } = await import("node:fs");
  const os = await import("node:os");
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const dir = fileURLToPath(new URL("..", import.meta.url));
  const code = await deployWithPreflight(process.argv.slice(2), {
    env: process.env,
    fetch: (url, init) => fetch(url, init),
    configPath: `${dir}wrangler.jsonc`,
    exists: (f) => existsSync(f),
    readConfig: () => readFileSync(`${dir}wrangler.jsonc`, "utf8"),
    d1: (sql, { target, database }) => {
      const r = spawnSync("npx", ["--yes", `wrangler@${WRANGLER_VERSION}`, "d1", "execute", database, "--remote", "--json", "--env", target, "--config", `${dir}wrangler.jsonc`, "--command", sql],
        { cwd: dir, encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024, env: childEnvironment(process.env, process.env.CLOUDFLARE_API_TOKEN, target === "production" ? PRODUCTION_ACCOUNT : STAGING_ACCOUNT) });
      if (r.error || r.status !== 0) throw new Error("d1_execute_failed");
      const out = JSON.parse(r.stdout);
      const all = Array.isArray(out) ? out : [out];
      const first = all[0];
      if (!first || all.some((x) => !x || x.success === false)) throw new Error("d1_execute_failed"); // every statement of a batch must have succeeded
      return { results: first.results ?? [] };
    },
    secretList: ({ target, account }) => {
      const r = spawnSync("npx", ["--yes", `wrangler@${WRANGLER_VERSION}`, "secret", "list", "--format", "json", "--env", target, "--config", `${dir}wrangler.jsonc`],
        { cwd: dir, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024, env: childEnvironment(process.env, process.env.CLOUDFLARE_API_TOKEN, account) });
      if (r.error || r.status !== 0) throw new Error("secret_list_failed");
      return JSON.parse(r.stdout).map((x) => ({ name: x?.name })); // names only: nothing else leaves this function
    },
    bundleEpoch: () => readFileSync(`${dir}src/image-signature.ts`, "utf8"),
    run: (command, args, env) => spawnSync(command, args, { cwd: dir, stdio: "inherit", env: env ?? process.env }).status ?? 1,
    git: (args) => {
      const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
      return { status: r.error ? 1 : r.status ?? 1, stdout: r.stdout ?? "" };
    },
    now: () => Date.now(),
    who: () => `${os.userInfo().username}@${os.hostname()}`,
    alert: async (payload) => {
      const url = process.env.ALERT_WEBHOOK_URL;
      if (!url || new URL(url).protocol !== "https:") return false;
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": `freeze:${payload.kind}:${payload.head}:${payload.at}` }, body: JSON.stringify(payload), signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      return r.ok;
    },
    record: (entry) => {
      const root = `${os.homedir()}/.murage-deploy-records`; mkdirSync(root, { recursive: true, mode: 0o700 });
      appendFileSync(`${root}/freeze-deploys.jsonl`, `${JSON.stringify(entry)}\n`);
    },
    log: (m) => console.log(m),
    error: (m) => console.error(m),
  });
  process.exit(code);
}
if (invokedDirectly) void main();
