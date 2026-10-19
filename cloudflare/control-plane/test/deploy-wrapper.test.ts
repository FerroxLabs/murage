// SPDX-License-Identifier: AGPL-3.0-or-later
// Astra TRUSTCODE-1 P2-1: scripts/deploy.mjs is the only deploy. It refuses every wrangler argument but the environment, validates the
// configuration resolved for that environment, then runs exactly `npx --yes wrangler@4.149.0 deploy --env <env>`.
import { describe, expect, it } from "vitest";
import wranglerText from "../wrangler.jsonc?raw";
import packageText from "../package.json?raw";
import { checkDeploy, SINK_DATABASE_ID } from "../scripts/check-deploy.mjs";
import { deploy, plan, WRANGLER_VERSION } from "../scripts/deploy.mjs";

const config = () => JSON.parse(wranglerText.split("\n").filter((l: string) => !/^\s*\/\//.test(l)).join("\n"));
const mutated = (mutate: (c: Record<string, any>) => void) => { const c = config(); mutate(c); return JSON.stringify(c); };

/** Runs deploy() against this config text; returns what was executed and what was said. */
function run(argv: string[], text = wranglerText, env: Record<string, string> = {}) {
  const ran: [string, string[]][] = []; const errors: string[] = [];
  const code = deploy(argv, { env, readConfig: () => text, run: (c: string, a: string[]) => { ran.push([c, a]); return 0; }, log: () => undefined, error: (m: string) => { errors.push(m); } });
  return { code, ran, errors: errors.join("\n") };
}

describe("scripts/deploy.mjs (Astra TRUSTCODE-1 P2-1)", () => {
  it("the checked-in config deploys to staging with exactly one command: npx --yes wrangler@4.149.0 deploy --env staging", () => {
    expect(WRANGLER_VERSION).toBe("4.149.0");
    expect(checkDeploy(wranglerText, "staging")).toEqual([]);
    expect(run(["staging"])).toEqual({ code: 0, errors: "", ran: [["npx", ["--yes", "wrangler@4.149.0", "deploy", "--env", "staging"]]] });
  });
  it("production validates the top level and runs deploy with no --env (there is no env.production block)", () => {
    expect(checkDeploy(wranglerText, "production")).toEqual([]);
    expect(run(["production"]).ran).toEqual([["npx", ["--yes", "wrangler@4.149.0", "deploy"]]]);
  });
  it("refuses any extra wrangler argument, no argument, an unknown environment: nothing runs", () => {
    for (const argv of [["staging", "--name", "other"], ["staging", "--var", "STAGING_MAIL_SINK:1"], ["--env", "staging"], ["staging", "--env", "production"],
      ["staging", "--config", "x.jsonc"], ["staging", "staging"], [], ["prod"], ["--name=x"], [""]]) {
      const r = run(argv);
      expect(r.code, JSON.stringify(argv)).toBe(1);
      expect(r.ran, JSON.stringify(argv)).toEqual([]);
      expect(r.errors).toContain("REFUSED");
    }
  });
  it("refuses an account or environment override in the process environment that disagrees", () => {
    expect(run(["staging"], wranglerText, { CLOUDFLARE_ACCOUNT_ID: "b83123326a4b9ad76831b9cb9365b33b" }).ran).toEqual([]);
    expect(run(["staging"], wranglerText, { CLOUDFLARE_ENV: "production" }).ran).toEqual([]);
    expect(run(["staging"], wranglerText, { CLOUDFLARE_ACCOUNT_ID: "874fe1689a53e6f56ff74816a9f23b26", CLOUDFLARE_ENV: "staging" }).code).toBe(0);
  });
  it("a config with MAIL_SINK in production (top level or env.production) refuses", () => {
    for (const text of [
      mutated((c) => { c.d1_databases.push({ binding: "MAIL_SINK", database_name: "murage-cloud-staging-mailsink", database_id: SINK_DATABASE_ID }); }),
      mutated((c) => { c.env.production = { d1_databases: [{ binding: "MAIL_SINK", database_name: "x", database_id: "y" }] }; }),
      mutated((c) => { c.vars.STAGING_MAIL_SINK = "1"; }),
      mutated((c) => { c.vars.MAIL_SINK_ALLOWLIST = "@example.test"; }),
    ]) {
      const r = run(["production"], text);
      expect(r.code).toBe(1); expect(r.ran).toEqual([]);
    }
  });
  it("staging with a different sink id, a missing sink, another name or account or DB id, or the sink vars outside env.staging.vars refuses", () => {
    const refused = (mutate: (c: Record<string, any>) => void, snippet?: string) => {
      const r = run(["staging"], mutated(mutate)); expect(r.code).toBe(1); expect(r.ran).toEqual([]);
      if (snippet) expect(r.errors).toContain(snippet);
    };
    refused((c) => { c.env.staging.d1_databases[1].database_id = "2bbc01ca-09b4-4ca9-8cb1-5471f8abb070"; }, "database_id must be");
    refused((c) => { c.env.staging.d1_databases = c.env.staging.d1_databases.filter((d: { binding: string }) => d.binding !== "MAIL_SINK"); }, "MAIL_SINK must be present exactly once");
    refused((c) => { c.env.staging.d1_databases.push({ ...c.env.staging.d1_databases[1] }); });
    refused((c) => { c.env.staging.name = "murage-control-plane"; }, "Worker name must be");
    refused((c) => { c.env.staging.account_id = c.account_id; }, "account_id must be");
    refused((c) => { c.env.staging.d1_databases[0].database_id = c.d1_databases[0].database_id; }, "DB binding must be");
    refused((c) => { c.env.staging.d1_databases.push({ binding: "OTHER", database_name: "o", database_id: "o" }); }, "unexpected D1 binding");
    refused((c) => { c.env.staging.services[0].service = "x"; c.env.staging.STAGING_MAIL_SINK = "1"; }, "only belongs in env.staging.vars");
    refused((c) => { c.env.staging.secrets.MAIL_SINK_ALLOWLIST = "1"; }, "only belongs in env.staging.vars");
    refused((c) => { c.vars.MAIL_SINK_ALLOWLIST = "@example.test"; });
  });
  it("the sink vars as keys of env.staging.vars are accepted", () => {
    expect(checkDeploy(mutated((c) => { c.env.staging.vars.STAGING_MAIL_SINK = "1"; c.env.staging.vars.MAIL_SINK_ALLOWLIST = "@staging.murage.test"; }), "staging")).toEqual([]);
  });
  it("unreadable config and unknown environments refuse; plan() builds no command for them", () => {
    expect(run(["staging"], "{ nope").code).toBe(1);
    expect(plan(["staging", "--name", "x"]).command).toBeUndefined();
    expect(checkDeploy(wranglerText, "qa")[0]).toContain("unknown environment");
  });
  it("package.json: deploy:staging is `node scripts/deploy.mjs staging`", () => {
    expect(JSON.parse(packageText).scripts["deploy:staging"]).toBe("node scripts/deploy.mjs staging");
  });
});

describe("R16: REFUND_KEY_SECRET is a required secret", () => {
  it("R16 secrets: the production (top-level) and staging required lists both name REFUND_KEY_SECRET", () => {
    const c = config();
    expect(c.secrets.required).toContain("REFUND_KEY_SECRET");
    expect(c.env.staging.secrets.required).toContain("REFUND_KEY_SECRET");
    expect(checkDeploy(wranglerText, "production")).toEqual([]);
    expect(checkDeploy(wranglerText, "staging")).toEqual([]);
  });
});
