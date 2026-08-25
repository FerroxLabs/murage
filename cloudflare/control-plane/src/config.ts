import { z } from "zod";

const MAX_ALLOWED_ORIGINS = 20;
const secretSchema = z.string().min(32);
const emailSchema = z.email().max(254);
const originsSchema = z.string();

export interface ControlPlaneConfig {
  authBaseURL: string;
  allowedOrigins: ReadonlySet<string>;
  emailFrom: string;
}

function exactHTTPSOrigin(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid HTTPS origin`);
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) {
    throw new Error(`${label} must be an exact HTTPS origin`);
  }
  return url.origin;
}

export function readConfig(env: Env): ControlPlaneConfig {
  if (!secretSchema.safeParse(env.BETTER_AUTH_SECRET).success) {
    throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters");
  }

  const emailFrom = emailSchema.safeParse(env.EMAIL_FROM);
  if (!emailFrom.success) throw new Error("EMAIL_FROM must be a valid email address");

  const authBaseURL = exactHTTPSOrigin(env.BETTER_AUTH_URL, "BETTER_AUTH_URL");
  const origins = originsSchema.safeParse(env.ALLOWED_ORIGINS);
  if (!origins.success) throw new Error("ALLOWED_ORIGINS must be a comma-separated string");
  const values = origins.data.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length > MAX_ALLOWED_ORIGINS) {
    throw new Error("ALLOWED_ORIGINS contains too many entries");
  }
  const allowedOrigins = new Set(values.map((value) => exactHTTPSOrigin(value, "ALLOWED_ORIGINS")));
  allowedOrigins.add(authBaseURL);
  return { authBaseURL, allowedOrigins, emailFrom: emailFrom.data };
}
