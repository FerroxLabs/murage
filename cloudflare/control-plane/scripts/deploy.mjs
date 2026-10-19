#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// The ONLY supported deploy (Astra TRUSTCODE-1 P2-1):  pnpm run deploy:staging   (= node scripts/deploy.mjs staging)
// It (a) refuses every argument but the environment name, so no --name, --var, --config, --env override can reach wrangler; (b) validates
// wrangler.jsonc as RESOLVED for that environment (Worker name, account id, D1 ids, MAIL_SINK only on staging with the exact staging sink id,
// STAGING_MAIL_SINK / MAIL_SINK_ALLOWLIST only in env.staging.vars; scripts/check-deploy.mjs); (c) then runs exactly
//   npx --yes wrangler@4.149.0 deploy --env <env>
// itself, with nothing else on the command line. The checked config file is the one wrangler reads (wrangler.jsonc in this directory), and
// an account or environment override in the process environment that disagrees with the validated one is refused.
// Production has no env.production block, so its deploy is `deploy` with no --env (the top level IS production); `--env production` would
// make wrangler fall back to the top level with a warning, so the wrapper does not pass it.
import { checkDeploy, PRODUCTION_ACCOUNT, STAGING_ACCOUNT } from "./check-deploy.mjs";

export const WRANGLER_VERSION = "4.149.0";
const ENVIRONMENTS = ["staging", "production"];

/** The wrangler invocation for these CLI arguments, or the reasons it is refused. */
export function plan(argv, processEnv = {}) {
  const problems = [];
  if (argv.length !== 1) problems.push(`exactly one argument is allowed (${ENVIRONMENTS.join(" | ")}); got ${argv.length}. No wrangler flag (--name, --var, --env, --config, ...) may be passed.`);
  const target = argv[0];
  if (argv.length >= 1 && !ENVIRONMENTS.includes(target)) problems.push(`unknown environment ${JSON.stringify(target)} (${ENVIRONMENTS.join(" | ")})`);
  if (problems.length > 0) return { problems };
  const account = target === "staging" ? STAGING_ACCOUNT : PRODUCTION_ACCOUNT;
  if (processEnv.CLOUDFLARE_ACCOUNT_ID && processEnv.CLOUDFLARE_ACCOUNT_ID !== account) problems.push("CLOUDFLARE_ACCOUNT_ID in the environment is not this environment's account");
  if (processEnv.CLOUDFLARE_ENV && processEnv.CLOUDFLARE_ENV !== target) problems.push("CLOUDFLARE_ENV in the environment is not the requested environment");
  if (problems.length > 0) return { problems };
  const args = ["--yes", `wrangler@${WRANGLER_VERSION}`, "deploy", ...(target === "staging" ? ["--env", "staging"] : [])];
  return { target, command: "npx", args, problems };
}

/**
 * Validate and (unless refused) run. `io` = { readConfig(): string, run(command, args): number, env, log, error }. Returns the exit code.
 * Nothing runs unless every check passed.
 */
export function deploy(argv, io) {
  const p = plan(argv, io.env ?? {});
  let problems = p.problems;
  if (problems.length === 0) {
    let text;
    try { text = io.readConfig(); } catch (e) { problems = [`wrangler.jsonc cannot be read: ${e instanceof Error ? e.message : String(e)}`]; }
    if (text !== undefined) problems = checkDeploy(text, p.target);
  }
  if (problems.length > 0) {
    io.error(`deploy: REFUSED\n${problems.map((x) => `  - ${x}`).join("\n")}`);
    return 1;
  }
  io.log(`deploy: ok, running: ${p.command} ${p.args.join(" ")}`);
  return io.run(p.command, p.args);
}

const invokedDirectly = typeof process !== "undefined" && Array.isArray(process.argv) && typeof process.argv[1] === "string"
  && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").slice(-2).join("/"));
async function main() {
  const { readFileSync } = await import("node:fs");
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const dir = fileURLToPath(new URL("..", import.meta.url));
  const code = deploy(process.argv.slice(2), {
    env: process.env,
    readConfig: () => readFileSync(`${dir}wrangler.jsonc`, "utf8"),
    run: (command, args) => spawnSync(command, args, { cwd: dir, stdio: "inherit", env: process.env }).status ?? 1,
    log: (m) => console.log(m),
    error: (m) => console.error(m),
  });
  process.exit(code);
}
if (invokedDirectly) void main();
