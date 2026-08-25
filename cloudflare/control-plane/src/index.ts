import { accountSession, createAuth } from "./auth";
import { readConfig, type ControlPlaneConfig } from "./config";
import { errorResponse, HTTPError, json, preflight, secureResponse, withBoundedRequestBody } from "./http";
import { limitedOTPResponse } from "./otp-rate-limit";
import {
  createInstallation,
  installationSelf,
  listInstallations,
  revokeInstallation,
  rotateInstallationCredential,
} from "./installations";

const ROTATE_ROUTE = /^\/v1\/installations\/([^/]+)\/credentials\/rotate$/;
const INSTALLATION_ROUTE = /^\/v1\/installations\/([^/]+)$/;

async function route(request: Request, env: Env, ctx: ExecutionContext, config: ControlPlaneConfig, requestId: string) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return preflight(request, config);

  if (url.pathname.startsWith("/api/auth/")) {
    const limited = await limitedOTPResponse(request, env);
    if (limited) return limited;
    const response = await createAuth(env, ctx, config, requestId).handler(request);
    return response.status >= 500 ? errorResponse(500, "internal_error") : response;
  }

  const auth = createAuth(env, ctx, config, requestId);
  if (request.method === "GET" && url.pathname === "/v1/me") {
    const session = await accountSession(request, auth);
    if (!session) throw new HTTPError(401, "unauthorized");
    return json({
      user: {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
        emailVerified: session.user.emailVerified,
      },
    });
  }
  if (request.method === "GET" && url.pathname === "/v1/installations") {
    return listInstallations(request, env, auth);
  }
  if (request.method === "POST" && url.pathname === "/v1/installations") {
    return createInstallation(request, env, auth);
  }
  if (request.method === "GET" && url.pathname === "/v1/installations/self") {
    return installationSelf(request, env);
  }

  const rotate = url.pathname.match(ROTATE_ROUTE);
  if (request.method === "POST" && rotate) {
    return rotateInstallationCredential(request, rotate[1], env, auth);
  }
  const installation = url.pathname.match(INSTALLATION_ROUTE);
  if (request.method === "DELETE" && installation) {
    return revokeInstallation(request, installation[1], env, auth);
  }
  return errorResponse(404, "not_found");
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const requestId = crypto.randomUUID();
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return secureResponse(json({ ok: true, service: "openmausbot-control-plane" }), request, null, requestId);
    }

    let config: ControlPlaneConfig | null = null;
    try {
      config = readConfig(env);
      const origin = request.headers.get("origin");
      if (origin && !config.allowedOrigins.has(origin)) {
        return secureResponse(errorResponse(403, "origin_not_allowed"), request, config, requestId);
      }
      const boundedRequest = await withBoundedRequestBody(request);
      return secureResponse(await route(boundedRequest, env, ctx, config, requestId), request, config, requestId);
    } catch (error) {
      if (error instanceof HTTPError) {
        return secureResponse(errorResponse(error.status, error.code), request, config, requestId);
      }
      console.error(JSON.stringify({ message: "request failed", requestId }));
      return secureResponse(errorResponse(500, "internal_error"), request, config, requestId);
    }
  },
} satisfies ExportedHandler<Env>;
