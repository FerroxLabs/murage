import { z } from "zod";

const INSTALLATION_CREDENTIAL =
  /^omb_install_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
const INSTALLATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const recordSchema = z.record(z.string(), z.unknown());
const stringSchema = z.string();
const emailInputSchema = z.string().max(254);
const otpInputSchema = z.string().max(32);
const clientInstanceSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

const plainObject = (value) => recordSchema.safeParse(value).data ?? null;

const boundedSecret = (value, maximum = 8_192) =>
  z.string().min(20).max(maximum).regex(/^\S+$/).safeParse(value).data ?? null;

export class ControlPlaneError extends Error {
  constructor(code, status = 0) {
    super(code);
    this.name = "ControlPlaneError";
    this.code = code;
    this.status = status;
  }
}

/** Production accepts HTTPS only. A loopback HTTP origin remains available
 * for an explicitly configured development Worker. Paths, credentials, and
 * query strings are rejected so every request stays under the audited API. */
export function normalizeControlPlaneURL(value) {
  const input = stringSchema.safeParse(value).data?.trim() ?? "";
  if (!input) return "";
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    return "";
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    return "";
  }
  return parsed.origin;
}

export function normalizeAccountEmail(value) {
  const email = emailInputSchema.safeParse(value).data?.trim().toLowerCase() ?? "";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "";
  return email;
}

function validatedUser(value) {
  const user = plainObject(value);
  const email = normalizeAccountEmail(user?.email);
  const id = z.string().min(1).max(256).safeParse(user?.id).data;
  if (!email || !id) return null;
  return { id, email };
}

function validatedInstallation(value) {
  const installation = plainObject(value);
  if (
    !INSTALLATION_ID.test(installation?.id ?? "") ||
    !clientInstanceSchema.safeParse(installation?.clientInstanceId).success
  ) {
    return null;
  }
  return {
    id: installation.id,
    clientInstanceId: clientInstanceSchema.parse(installation.clientInstanceId),
    name: z.string().safeParse(installation.name).data ?? "This computer",
    platform: installation.platform,
    appVersion: z.string().safeParse(installation.appVersion).data ?? null,
  };
}

function validatedEndpoint(value) {
  const endpoint = plainObject(value);
  let url;
  try {
    url = new URL(endpoint?.url);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    return null;
  }
  return { url: url.origin };
}

export function createControlPlaneClient({
  baseURL,
  fetchImpl = globalThis.fetch,
  timeoutSignal = (milliseconds) => AbortSignal.timeout(milliseconds),
  timeoutMs = 15_000,
}) {
  const origin = normalizeControlPlaneURL(baseURL);
  if (!origin) throw new ControlPlaneError("control_plane_unavailable");

  const request = async (path, { method = "GET", token, body, allowEmpty = false } = {}) => {
    const headers = new Headers({ accept: "application/json" });
    if (token) headers.set("authorization", `Bearer ${token}`);
    if (body !== undefined) headers.set("content-type", "application/json");
    let response;
    try {
      const init = {
        method,
        headers,
        redirect: "error",
        signal: timeoutSignal(timeoutMs),
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      response = await fetchImpl(`${origin}${path}`, init);
    } catch {
      throw new ControlPlaneError("network_unavailable");
    }

    let payload = null;
    if (response.status !== 204) {
      payload = await response.json().catch(() => null);
    }
    if (!response.ok) {
      const code = z.string().regex(/^[a-z0-9_]{1,64}$/).safeParse(plainObject(payload)?.error).data;
      throw new ControlPlaneError(
        code ?? "request_failed",
        response.status,
      );
    }
    if (!allowEmpty && !plainObject(payload)) {
      throw new ControlPlaneError("invalid_response", response.status);
    }
    return { response, payload };
  };

  const accountInstallations = async (accountToken) => {
    if (!boundedSecret(accountToken)) throw new ControlPlaneError("signed_out", 401);
    const { payload } = await request("/v1/installations", { token: accountToken });
    if (!Array.isArray(payload.installations)) {
      throw new ControlPlaneError("invalid_response");
    }
    const installations = payload.installations.map(validatedInstallation);
    if (installations.some((installation) => !installation)) {
      throw new ControlPlaneError("invalid_response");
    }
    return installations;
  };

  return {
    origin,

    async health() {
      const { payload } = await request("/healthz");
      if (
        payload.ok !== true ||
        payload.service !== "openmausbot-control-plane"
      ) {
        throw new ControlPlaneError("control_plane_unavailable");
      }
      return true;
    },

    async requestOTP(rawEmail) {
      const email = normalizeAccountEmail(rawEmail);
      if (!email) throw new ControlPlaneError("invalid_email");
      await request("/api/auth/email-otp/send-verification-otp", {
        method: "POST",
        body: { email, type: "sign-in" },
      });
      // The server deliberately gives the same result for known and unknown
      // addresses. Preserve that enumeration-safe contract in the UI.
      return { email };
    },

    async verifyOTP(rawEmail, rawOTP) {
      const email = normalizeAccountEmail(rawEmail);
      const otp = otpInputSchema.safeParse(rawOTP).data?.replaceAll(/\s|-/g, "") ?? "";
      if (!email) throw new ControlPlaneError("invalid_email");
      if (!/^\d{8}$/.test(otp)) throw new ControlPlaneError("invalid_otp");
      const { response, payload } = await request("/api/auth/sign-in/email-otp", {
        method: "POST",
        body: { email, otp, name: email.split("@", 1)[0] },
      });
      // Better Auth's response JSON includes its raw database token. The
      // signed bearer plugin intentionally publishes a different credential
      // in this header; only that signed value may cross our API boundary.
      const accountToken = boundedSecret(response.headers.get("set-auth-token"));
      const user = validatedUser(payload.user);
      if (!accountToken || !user || user.email !== email) {
        throw new ControlPlaneError("invalid_response", response.status);
      }
      return { accountToken, user };
    },

    async me(accountToken) {
      if (!boundedSecret(accountToken)) throw new ControlPlaneError("signed_out", 401);
      const { payload } = await request("/v1/me", { token: accountToken });
      const user = validatedUser(payload.user);
      if (!user) throw new ControlPlaneError("invalid_response");
      return user;
    },

    async listInstallations(accountToken) {
      return accountInstallations(accountToken);
    },

    async ensureInstallation({ accountToken, currentCredential, clientInstanceId, name, platform, appVersion }) {
      if (
        !clientInstanceSchema.safeParse(clientInstanceId).success
      ) {
        throw new ControlPlaneError("invalid_client_identity");
      }

      if (INSTALLATION_CREDENTIAL.test(currentCredential ?? "")) {
        try {
          const { payload } = await request("/v1/installations/self", { token: currentCredential });
          const installation = validatedInstallation(payload.installation);
          if (installation?.clientInstanceId === clientInstanceId) {
            return {
              installation,
              credential: currentCredential,
              credentialExpiresAt:
                Number.isSafeInteger(payload.credentialExpiresAt) ? payload.credentialExpiresAt : null,
            };
          }
        } catch (error) {
          // A transient outage must not rotate a perfectly usable identity.
          // Only a definitive 401 falls through to account recovery.
          if (!(error instanceof ControlPlaneError) || error.status !== 401) throw error;
        }
      }

      if (!boundedSecret(accountToken)) throw new ControlPlaneError("signed_out", 401);
      const installations = await accountInstallations(accountToken);
      const existing = installations.find((item) => item.clientInstanceId === clientInstanceId);
      const result = existing
        ? await request(`/v1/installations/${encodeURIComponent(existing.id)}/credentials/rotate`, {
            method: "POST",
            token: accountToken,
          })
        : await request("/v1/installations", {
            method: "POST",
            token: accountToken,
            body: { clientInstanceId, name, platform, appVersion },
          });
      const installation = existing ?? validatedInstallation(result.payload.installation);
      const credential = result.payload.credential;
      if (!installation || !INSTALLATION_CREDENTIAL.test(credential ?? "")) {
        throw new ControlPlaneError("invalid_response");
      }
      return {
        installation,
        credential,
        credentialExpiresAt:
          Number.isSafeInteger(result.payload.credentialExpiresAt)
            ? result.payload.credentialExpiresAt
            : null,
      };
    },

    async ensureEndpoint(installationCredential) {
      if (!INSTALLATION_CREDENTIAL.test(installationCredential ?? "")) {
        throw new ControlPlaneError("signed_out", 401);
      }
      const { payload } = await request("/v1/installations/self/endpoint", {
        method: "POST",
        token: installationCredential,
      });
      const endpoint = validatedEndpoint(payload.endpoint);
      const connectorToken = boundedSecret(payload.connectorToken, 16_384);
      if (!endpoint || !connectorToken) throw new ControlPlaneError("invalid_response");
      return { endpoint, connectorToken };
    },

    async deleteEndpoint(installationCredential) {
      if (!INSTALLATION_CREDENTIAL.test(installationCredential ?? "")) {
        throw new ControlPlaneError("signed_out", 401);
      }
      await request("/v1/installations/self/endpoint", {
        method: "DELETE",
        token: installationCredential,
        allowEmpty: true,
      });
    },

    async revokeInstallation(accountToken, installationId) {
      if (!boundedSecret(accountToken) || !INSTALLATION_ID.test(installationId ?? "")) {
        throw new ControlPlaneError("signed_out", 401);
      }
      await request(`/v1/installations/${encodeURIComponent(installationId)}`, {
        method: "DELETE",
        token: accountToken,
        allowEmpty: true,
      });
    },

    async signOut(accountToken) {
      if (!boundedSecret(accountToken)) return;
      await request("/api/auth/sign-out", {
        method: "POST",
        token: accountToken,
      });
    },
  };
}
