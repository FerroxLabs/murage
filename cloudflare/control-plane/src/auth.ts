import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { bearer, emailOTP } from "better-auth/plugins";

import type { ControlPlaneConfig } from "./config";
import { boundCustomer, looksLikeJWT } from "./customer-identity";
import { senderOrFail, sendOTPEmail } from "./email";

export function createAuth(
  env: Env,
  ctx: ExecutionContext,
  config: ControlPlaneConfig,
  requestId: string,
) {
  return betterAuth({
    appName: "Murage",
    baseURL: config.authBaseURL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB,
    trustedOrigins: [...config.allowedOrigins],
    logger: { disabled: true },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 60,
      customRules: {
        "/email-otp/send-verification-otp": { window: 60, max: 5 },
        "/sign-in/email-otp": { window: 60, max: 10 },
      },
    },
    advanced: {
      useSecureCookies: true,
      ipAddress: {
        // Cloudflare writes this header at the edge. Do not trust a client-
        // supplied x-forwarded-for chain for rate limits or session metadata.
        ipAddressHeaders: ["cf-connecting-ip"],
      },
      database: { generateId: "uuid" },
      backgroundTasks: {
        handler(promise) {
          ctx.waitUntil(promise);
        },
      },
    },
    databaseHooks: {
      session: {
        create: {
          // Defence in depth only. A Cloud account (a murage.ai members-area Supabase user) and a phone-companion
          // account are separate accounts: a Cloud account's "user".email is synthetic and undeliverable
          // (cloud-accounts.ts), so no email code reaches it and a companion sign-in with a Cloud member's address
          // finds or creates its OWN row and signs in normally. Should a session ever be asked for a Cloud row anyway,
          // it is refused: a Better Auth session must never act as a Cloud account.
          async before(session) {
            const cloud = await env.DB.prepare("SELECT 1 AS x FROM supabase_identities WHERE user_id=?").bind(session.userId).first();
            if (cloud) {
              console.log(JSON.stringify({ message: "better auth session refused for a cloud account row", requestId }));
              throw new APIError("FORBIDDEN", { message: "Forbidden.", code: "forbidden" });
            }
          },
        },
      },
    },
    plugins: [
      emailOTP({
        otpLength: 8,
        expiresIn: 10 * 60,
        allowedAttempts: 5,
        storeOTP: "hashed",
        resendStrategy: "rotate",
        disableSignUp: false,
        rateLimit: { window: 60, max: 5 },
        async sendVerificationOTP(input) {
          await sendOTPEmail(senderOrFail(env), config.emailFrom, input, requestId);
        },
      }),
      bearer({ requireSignature: true }),
    ],
  });
}

export type ControlPlaneAuth = ReturnType<typeof createAuth>;

type BetterAuthSession = Awaited<ReturnType<ControlPlaneAuth["api"]["getSession"]>>;

/** The signed-in account, by route scope (customer-identity.ts). On a Cloud route (account, billing, legal, homes) it is
 *  only ever the members-area Supabase identity mapped to its Cloud account; Better Auth is never consulted, so a
 *  companion session there is no session (401). Everywhere else (the companion routes: /v1/me, /v1/installations*) it
 *  is only ever the Better Auth bearer session: a Supabase token (JWT-shaped) is no session there. */
export async function accountSession(request: Request, auth: ControlPlaneAuth): Promise<BetterAuthSession> {
  const customer = boundCustomer(request);
  if (customer) return (await customer.resolve()) as unknown as BetterAuthSession;
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer\s+([^\s]+)$/i);
  if (!match || match[1].startsWith("murage_install_") || looksLikeJWT(match[1])) return null;

  return auth.api.getSession({
    headers: new Headers({ authorization: `Bearer ${match[1]}` }),
  });
}
