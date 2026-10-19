// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { createWorker } from "../src/index";
import { authFetch, cloudMember, jwksFetch, supabaseEnv } from "./cloud-member";

const worker = createWorker(undefined, undefined, {}, {}, {}, { jwksFetch, authFetch });
let staging = false;
const testEnv = () => ({ ...env, ...supabaseEnv, MACHINE_OPEN_LIMIT: undefined, MACHINE_BEARER_LIMIT: undefined, CLOUD_CP0_STAGING: staging ? "1" : "0" }) as Env;

async function get(token: string | null, method = "GET") {
  const headers = new Headers();
  if (token) headers.set("authorization", `Bearer ${token}`);
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request("https://auth.murage.test/v1/homes", { method, headers }), testEnv(), ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
// The owner is a Cloud member: these are Cloud routes, which take only the Supabase identity (customer-identity.ts).
const signIn = cloudMember;
const now = Date.now();
const seedHome = (id: string, owner: string, state: string, desired: string, hostname: string | null, createdAt: number) => env.DB.batch([
  env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,created_at,updated_at)
    VALUES (?,?,?,?,?,'sha256:x','k',?,?)`).bind(id, `inst-${id}`, owner, desired, state, createdAt, createdAt),
  ...(hostname ? [env.DB.prepare(`INSERT INTO machine_endpoints (machine_id,hostname,tunnel_name,status,created_at,updated_at)
    VALUES (?,?,?,'ready',?,?)`).bind(id, hostname, `t-${id}`, now, now)] : []),
]);

afterEach(async () => {
  staging = false;
  await env.DB.batch([env.DB.prepare("DELETE FROM cloud_homes"), env.DB.prepare("DELETE FROM machine_endpoints"),
    env.DB.prepare("DELETE FROM machine_owners"), env.DB.prepare("DELETE FROM cloud_machines")]);
});

describe("GET /v1/homes", () => {
  it("lists only the signed-in owner's live homes with id, name, publicOrigin and status", async () => {
    const owner = await signIn("homes-owner@example.test");
    const other = await signIn("homes-other@example.test");
    await seedHome("home-a", owner.userId, "ready", "ready", "h-aaaa1111.murage.test", now);
    await seedHome("home-b", owner.userId, "suspended", "ready", "h-bbbb2222.murage.test", now + 1);
    await seedHome("home-gone", owner.userId, "deleted", "deleted", "h-cccc3333.murage.test", now + 2);
    await seedHome("home-foreign", other.userId, "ready", "ready", "h-dddd4444.murage.test", now + 3);
    const response = await get(owner.token);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ homes: [
      { id: "home-a", name: "Cloud home", status: "ready", publicOrigin: "https://h-aaaa1111.murage.test", door: "v1" },
      { id: "home-b", name: "Cloud home", status: "suspended", publicOrigin: "https://h-bbbb2222.murage.test", door: "v1" },
    ] });
    expect(await (await get(other.token)).json()).toEqual({ homes: [{ id: "home-foreign", name: "Cloud home", status: "ready", publicOrigin: "https://h-dddd4444.murage.test", door: "v1" }] });
  });

  it("answers an empty list for an account with no homes and gives a home with no endpoint a null origin", async () => {
    const owner = await signIn("homes-empty@example.test");
    expect(await (await get(owner.token)).json()).toEqual({ homes: [] });
    await seedHome("home-pending", owner.userId, "provisioning", "ready", null, now);
    expect(await (await get(owner.token)).json()).toEqual({ homes: [{ id: "home-pending", name: "Cloud home", status: "provisioning", publicOrigin: null, door: "v1" }] });
  });

  it("refuses no session, an installation token and non-GET methods", async () => {
    expect((await get(null)).status).toBe(401);
    expect((await get("murage_install_notasession")).status).toBe(401);
    expect((await get("garbage")).status).toBe(401);
    const owner = await signIn("homes-method@example.test");
    expect((await get(owner.token, "POST")).status).toBe(405);
  });

  it("includes an owner-assigned staging machine only when staging is on", async () => {
    const owner = await signIn("homes-staging@example.test");
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO cloud_machines (id,home_id,generation,state,created_at,public_origin,admin_url) VALUES ('mcq-1','mcq-1',1,'active',?,?,?)`)
        .bind(now, "https://h-eeee5555.murage.test", "https://admin.murage.test"),
      env.DB.prepare(`INSERT INTO machine_endpoints (machine_id,hostname,tunnel_name,status,created_at,updated_at) VALUES ('mcq-1','h-eeee5555.murage.test','t-mcq-1','ready',?,?)`).bind(now, now),
      env.DB.prepare("INSERT INTO machine_owners (machine_id,owner_user_id,assigned_at) VALUES ('mcq-1',?,?)").bind(owner.userId, now),
    ]);
    expect(await (await get(owner.token)).json()).toEqual({ homes: [] });
    staging = true;
    expect(await (await get(owner.token)).json()).toEqual({ homes: [{ id: "mcq-1", name: "Cloud home", status: "active", publicOrigin: "https://h-eeee5555.murage.test", door: "v1" }] });
  });
});
