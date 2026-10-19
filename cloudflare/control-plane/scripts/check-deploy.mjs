#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Deploy-time guard for the staging mail sink (TRUST-FIRST-FACTOR.md revision 2, part C; Astra TRUST-2 F2; Astra TRUSTCODE-1 P2-1).
// It is the inner validation module of scripts/deploy.mjs, the only supported way to deploy (`pnpm run deploy:staging`); `pnpm run
// check-deploy` still checks the file alone. `checkDeploy(text, env)` validates the configuration RESOLVED for one environment.
// Refuses (exit 1) when wrangler.jsonc
//   - declares MAIL_SINK or STAGING_MAIL_SINK anywhere outside env.staging (top level, another env, any key or value),
//   - lets env.staging's MAIL_SINK point at any database but the staging sink, or the staging sink id appear outside it,
//   - gives env.staging another Worker name or account than the staging ones (the sink belongs to that Worker only).
// Plain node, no dependencies. `checkConfig(text)` is exported for the tests.

export const STAGING_ENV = "staging";
export const STAGING_WORKER = "murage-control-plane-staging";
export const STAGING_ACCOUNT = "874fe1689a53e6f56ff74816a9f23b26";
export const SINK_BINDING = "MAIL_SINK";
export const SINK_VAR = "STAGING_MAIL_SINK";
export const SINK_DATABASE_NAME = "murage-cloud-staging-mailsink";
export const SINK_DATABASE_ID = "7c9c6777-f7a1-4804-8596-7933a523d392";
export const SINK_ALLOWLIST_VAR = "MAIL_SINK_ALLOWLIST";
export const PRODUCTION_WORKER = "murage-control-plane";
export const PRODUCTION_ACCOUNT = "b83123326a4b9ad76831b9cb9365b33b";
export const PRODUCTION_DB_ID = "5b7763a9-6674-451e-a5ba-4ba49ab30014";
export const STAGING_DB_ID = "2bbc01ca-09b4-4ca9-8cb1-5471f8abb070";

/** JSONC to JSON: drops // and block comments and trailing commas, leaving string contents (URLs included) untouched. */
export function stripJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i < 0) throw new Error("unterminated comment");
      i += 1;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** Every [path, key-or-string] in the tree, for "does this name appear here at all". */
function* walk(node, path) {
  if (typeof node === "string") yield [path, node];
  else if (Array.isArray(node)) for (let i = 0; i < node.length; i += 1) yield* walk(node[i], `${path}[${i}]`);
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      yield [`${path}.${k}`, k];
      yield* walk(v, `${path}.${k}`);
    }
  }
}

/** The problems with this wrangler.jsonc text; empty means it may be deployed. */
export function checkConfig(text) {
  let config;
  try { config = JSON.parse(stripJsonc(text)); } catch (e) { return [`wrangler.jsonc does not parse: ${e instanceof Error ? e.message : String(e)}`]; }
  const problems = [];
  const staging = config?.env?.[STAGING_ENV];
  const outside = { ...config, env: { ...(config.env ?? {}) } };
  delete outside.env[STAGING_ENV];
  for (const [path, s] of walk(outside, "$")) {
    if (s.includes(SINK_BINDING) || s.includes(SINK_VAR)) problems.push(`${path}: ${s.includes(SINK_VAR) ? SINK_VAR : SINK_BINDING} outside env.${STAGING_ENV}`);
    if (s.includes(SINK_DATABASE_ID) || s.includes(SINK_DATABASE_NAME)) problems.push(`${path}: the staging sink database outside env.${STAGING_ENV}`);
  }
  if (staging) {
    const sinks = (staging.d1_databases ?? []).filter((d) => d?.binding === SINK_BINDING);
    if (sinks.length > 1) problems.push(`env.${STAGING_ENV}: ${SINK_BINDING} declared more than once`);
    for (const d of sinks) {
      if (d.database_id !== SINK_DATABASE_ID) problems.push(`env.${STAGING_ENV}.${SINK_BINDING}: database_id must be ${SINK_DATABASE_ID}`);
      if (d.database_name !== SINK_DATABASE_NAME) problems.push(`env.${STAGING_ENV}.${SINK_BINDING}: database_name must be ${SINK_DATABASE_NAME}`);
    }
    for (const d of staging.d1_databases ?? []) {
      if (d?.binding !== SINK_BINDING && (d?.database_id === SINK_DATABASE_ID || d?.database_name === SINK_DATABASE_NAME)) {
        problems.push(`env.${STAGING_ENV}.${d?.binding}: the sink database bound under another name`);
      }
    }
    const mentions = [...walk(staging, `$.env.${STAGING_ENV}`)].some(([, s]) => s.includes(SINK_BINDING) || s.includes(SINK_VAR));
    if (mentions) {
      if (staging.name !== STAGING_WORKER) problems.push(`env.${STAGING_ENV}.name must be ${STAGING_WORKER} where the sink is declared`);
      if (staging.account_id !== STAGING_ACCOUNT) problems.push(`env.${STAGING_ENV}.account_id must be ${STAGING_ACCOUNT} where the sink is declared`);
      if (config.account_id === STAGING_ACCOUNT) problems.push("the top-level (production) account_id is the staging account");
    }
  }
  return problems;
}

/**
 * The problems with deploying this wrangler.jsonc text to `env` ("staging" or "production"); empty means it may be deployed.
 * On top of checkConfig: the Worker name, account id and every D1 database id of the RESOLVED environment must be exactly the known ones,
 * MAIL_SINK exists only for staging (with the exact staging sink id), and STAGING_MAIL_SINK / MAIL_SINK_ALLOWLIST may appear only as keys
 * of env.staging.vars.
 */
export function checkDeploy(text, target) {
  if (target !== STAGING_ENV && target !== "production") return [`unknown environment ${JSON.stringify(target)} (staging or production)`];
  const problems = checkConfig(text);
  let config;
  try { config = JSON.parse(stripJsonc(text)); } catch { return problems; }
  const staging = target === STAGING_ENV;
  const resolved = staging ? config?.env?.[STAGING_ENV] : { ...config, ...(config?.env?.production ?? {}) };
  if (!resolved) return [...problems, `no ${target} configuration`];
  const want = staging
    ? { name: STAGING_WORKER, account: STAGING_ACCOUNT, db: STAGING_DB_ID }
    : { name: PRODUCTION_WORKER, account: PRODUCTION_ACCOUNT, db: PRODUCTION_DB_ID };
  if (resolved.name !== want.name) problems.push(`${target}: Worker name must be ${want.name}`);
  if (resolved.account_id !== want.account) problems.push(`${target}: account_id must be ${want.account}`);
  const dbs = Array.isArray(resolved.d1_databases) ? resolved.d1_databases : [];
  const main = dbs.filter((d) => d?.binding === "DB");
  if (main.length !== 1 || main[0].database_id !== want.db) problems.push(`${target}: the DB binding must be exactly one database, id ${want.db}`);
  const sinks = dbs.filter((d) => d?.binding === SINK_BINDING);
  if (staging && (sinks.length !== 1 || sinks[0].database_id !== SINK_DATABASE_ID)) problems.push(`staging: ${SINK_BINDING} must be present exactly once, id ${SINK_DATABASE_ID}`);
  if (!staging && sinks.length > 0) problems.push(`${target}: ${SINK_BINDING} must not exist`);
  for (const d of dbs) if (d?.binding !== "DB" && d?.binding !== SINK_BINDING) problems.push(`${target}: unexpected D1 binding ${JSON.stringify(d?.binding)}`);
  // The sink vars: only as keys of env.staging.vars (checkConfig already refuses them anywhere outside env.staging).
  if (staging) {
    for (const [path, s] of walk(resolved, `$.env.${STAGING_ENV}`)) {
      if (!(s.includes(SINK_VAR) || s.includes(SINK_ALLOWLIST_VAR))) continue;
      if (!new RegExp(`^\\$\\.env\\.${STAGING_ENV}\\.vars\\.(${SINK_VAR}|${SINK_ALLOWLIST_VAR})$`).test(path)) problems.push(`${path}: ${s.includes(SINK_VAR) ? SINK_VAR : SINK_ALLOWLIST_VAR} only belongs in env.${STAGING_ENV}.vars`);
    }
  }
  return [...new Set(problems)];
}

const invokedDirectly = typeof process !== "undefined" && Array.isArray(process.argv) && typeof process.argv[1] === "string"
  && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").slice(-2).join("/"));
async function main() {
  const { readFileSync } = await import("node:fs");
  const file = process.argv[2] ?? "wrangler.jsonc";
  const problems = checkConfig(readFileSync(file, "utf8"));
  if (problems.length > 0) {
    console.error(`check-deploy: REFUSED (${file})\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`check-deploy: ok (${file})`);
}
if (invokedDirectly) void main();
