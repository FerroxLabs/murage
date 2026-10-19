import { cloudHomeCopy } from "./copy.ts";
import { WORKSPACE_CREDENTIALS } from "../../electron/workspace-credentials.mjs";
import { readServerSecrets, updateServerCredentials } from "./server-secrets.ts";

// This table extends the desktop inventory, never maintains a smaller copy.
export const CLOUD_CREDENTIAL_FIELDS = [
  ...WORKSPACE_CREDENTIALS,
  { section: "openaiCompat", field: "key", name: "openaiCompatKey", env: "OPENAI_COMPAT_API_KEY" },
  { section: "composio", field: "apiKey", name: "connectedAppsKey", env: "COMPOSIO_API_KEY" },
  { section: "flux", field: "apiKey", name: "fluxApiKey", env: "FLUX_API_KEY" },
] as const;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function cloudCredentialPatch(config: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  const source = record(config);
  for (const row of CLOUD_CREDENTIAL_FIELDS) {
    const value = record(source?.[row.section])?.[row.field];
    if (typeof value === "string") result[row.name] = value;
  }
  return result;
}

export function withoutCloudCredentials<T extends object>(config: T): T {
  const result = structuredClone(config);
  const source = result as Record<string, unknown>;
  for (const row of CLOUD_CREDENTIAL_FIELDS) {
    const section = record(source[row.section]);
    if (section && Object.hasOwn(section, row.field)) section[row.field] = "";
  }
  return result;
}

export function assertNoCloudPlaintext(config: unknown): void {
  if (Object.values(cloudCredentialPatch(config)).some(Boolean)) throw new Error(cloudHomeCopy.cloudCredentialsMustBeSavedThroughTheEncryptedSupervisorStore);
}

export function withCloudCredentials<T extends object>(config: T): T {
  const secrets = readServerSecrets();
  if (!secrets) return config;
  const result = structuredClone(config);
  const source = result as Record<string, unknown>;
  for (const row of CLOUD_CREDENTIAL_FIELDS) {
    const value = secrets.credentials[row.name];
    if (value !== undefined) source[row.section] = { ...record(source[row.section]), [row.field]: value };
  }
  return result;
}

export function syncCloudCredentialMemory(config: unknown): void {
  updateServerCredentials(cloudCredentialPatch(config));
}
