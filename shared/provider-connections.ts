/** Presets a pasted API key can create. */
export type KeyProviderPreset = "anthropic" | "openai" | "openrouter" | "deepseek" | "mistral" | "flux" | "groq" | "xai" | "requesty" | "google";
/** Plan sign-in presets (ChatGPT, Grok). Created only by the desktop sign-in
 * flow; never stored in the key bank and never carry a key. */
export type SignInPreset = "chatgpt" | "supergrok";
export type ProviderPreset = KeyProviderPreset | SignInPreset;
export type ProviderProtocol = "openai" | "anthropic" | "responses";
/** Private server/Electron record. Never include key in public responses. */
export interface ProviderConnectionRecord { id: string; preset: ProviderPreset; label: string; enabled: boolean; key: string; revision: string }
export interface ProviderModel {
  connectionId: string; preset: ProviderPreset; id: string; label: string; enabled: boolean; chatEligible: boolean;
  capabilities: { chat: boolean; vision?: boolean; tools?: boolean; reasoning?: boolean };
  outputModalities: string[]; contextWindow?: number;
  pricing?: { inputPerMillion?: number; outputPerMillion?: number; source: string; updatedAt: number };
}
/** `payment` is the provider's HTTP 402 (ERRORS-NAME-THE-SERVICE): before 1.0.18 it fell into `unavailable` and the card said
 * "try again later" to an account that needed payment. */
export type ProviderCatalogError = "unauthorized" | "forbidden" | "payment" | "rate-limited" | "offline" | "invalid-catalog" | "unavailable" | "connection-changed" | "needs-sign-in";
export interface ProviderCatalog {
  connectionId: string; models: ProviderModel[]; fetchedAt?: number; stale: boolean;
  /** `httpStatus` is the provider's own status when it answered (never set for a timeout or an unreachable address). */
  error?: { code: ProviderCatalogError; message: string; httpStatus?: number };
  assurance: "catalog-only";
}
export interface PublicProviderConnection {
  id: string; preset: ProviderPreset; label: string; enabled: boolean; revision: string;
  baseUrl: string; protocol: ProviderProtocol; configured: boolean; legacy?: boolean; managedIn?: "engines" | "connections" | "images";
  state: "saved" | "catalog-ready" | "needs-attention";
  catalog: ProviderCatalog;
  /** Present only on a plan sign-in connection. Never carries a token. */
  signIn?: import("./model-signin.ts").SignInConnectionInfo;
}
export type ProviderConnectionMutation =
  | { action: "create"; preset: KeyProviderPreset; label?: string; key: string }
  | { action: "update"; id: string; revision: string; label?: string; key?: string; enabled?: boolean }
  | { action: "remove"; id: string; revision: string };
