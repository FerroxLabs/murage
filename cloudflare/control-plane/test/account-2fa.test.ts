// SPDX-License-Identifier: AGPL-3.0-or-later
// The old cloud.murage.ai portal's WebAuthn step-up ran on a Better Auth session. A Better Auth (phone-companion) session
// may never act on a Cloud route, so the routes are retired for good: 410, whatever the bearer or the old switch.
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createAuth } from "../src/auth";
import { readConfig } from "../src/config";
import { createWorker } from "../src/index";

const worker = createWorker();
const testEnv = () => ({ ...env, MACHINE_OPEN_LIMIT: undefined, MACHINE_BEARER_LIMIT: undefined, CLOUD_LEGACY_CUSTOMER_AUTH: "1",
  PORTAL_ORIGIN: "https://cloud.murage.ai" }) as unknown as Env;

async function call(path: string, token: string | null, method = "GET") {
  const headers = new Headers({ "content-type": "application/json" });
  if (token) headers.set("authorization", `Bearer ${token}`);
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://auth.murage.test${path}`, { method, headers, body: method === "GET" ? undefined : "{}" }), testEnv(), ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
async function companionSignIn(email: string) {
  const ctx = createExecutionContext();
  const auth = createAuth(env, ctx, readConfig(env), crypto.randomUUID());
  const otp = await auth.api.createVerificationOTP({ body: { email, type: "sign-in" } });
  await waitOnExecutionContext(ctx);
  const response = await worker.fetch(new Request("https://auth.murage.test/api/auth/sign-in/email-otp", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, otp, name: "t" }),
  }), testEnv(), createExecutionContext());
  const token = response.headers.get("set-auth-token");
  if (!token) throw new Error("no token");
  return token;
}

describe("retired portal second factor", () => {
  it("answers 410 step_up_moved on every /v1/account/2fa route, even for a Better Auth session with the old switch set", async () => {
    const token = await companionSignIn("twofa@example.test");
    for (const [path, method] of [["/v1/account/2fa", "GET"], ["/v1/account/2fa/register/options", "POST"], ["/v1/account/2fa/assert/options", "POST"],
      ["/v1/account/2fa/register", "POST"], ["/v1/account/2fa/assert", "POST"]] as const) {
      for (const bearer of [token, null]) {
        const res = await call(path, bearer, method);
        expect([path, res.status, (await res.json<{ error: string }>()).error]).toEqual([path, 410, "step_up_moved"]);
      }
    }
  });
});
