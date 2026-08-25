const MAX_ALLOWED_ORIGINS = 20;

export interface ControlPlaneConfig {
  authBaseURL: string;
  allowedOrigins: ReadonlySet<string>;
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
  if (env.BETTER_AUTH_SECRET.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters");
  }

  const authBaseURL = exactHTTPSOrigin(env.BETTER_AUTH_URL, "BETTER_AUTH_URL");
  const values = env.ALLOWED_ORIGINS.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length > MAX_ALLOWED_ORIGINS) {
    throw new Error("ALLOWED_ORIGINS contains too many entries");
  }
  const allowedOrigins = new Set(values.map((value) => exactHTTPSOrigin(value, "ALLOWED_ORIGINS")));
  allowedOrigins.add(authBaseURL);
  return { authBaseURL, allowedOrigins };
}
