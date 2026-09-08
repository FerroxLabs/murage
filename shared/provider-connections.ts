export type ProviderPreset = "anthropic" | "openai" | "openrouter" | "deepseek" | "mistral" | "flux" | "groq" | "xai";
export type ProviderProtocol = "openai" | "anthropic" | "responses";
/** Private server/Electron record. Never include key in public responses. */
export interface ProviderConnectionRecord { id: string; preset: ProviderPreset; label: string; enabled: boolean; key: string; revision: string }
export interface ProviderModel {
  connectionId: string; preset: ProviderPreset; id: string; label: string; enabled: boolean; chatEligible: boolean;
  capabilities: { chat: boolean; vision?: boolean; tools?: boolean; reasoning?: boolean };
  outputModalities: string[]; contextWindow?: number;
  pricing?: { inputPerMillion?: number; outputPerMillion?: number; source: string; updatedAt: number };
}
export type ProviderCatalogError = "unauthorized" | "forbidden" | "rate-limited" | "offline" | "invalid-catalog" | "unavailable" | "connection-changed";
export interface ProviderCatalog {
  connectionId: string; models: ProviderModel[]; fetchedAt?: number; stale: boolean;
  error?: { code: ProviderCatalogError; message: string };
  assurance: "catalog-only";
}
export interface PublicProviderConnection {
  id: string; preset: ProviderPreset; label: string; enabled: boolean; revision: string;
  baseUrl: string; protocol: ProviderProtocol; configured: boolean; legacy?: boolean; managedIn?: "engines" | "connections" | "images";
  state: "saved" | "catalog-ready" | "needs-attention";
  catalog: ProviderCatalog;
}
export type ProviderConnectionMutation =
  | { action: "create"; preset: ProviderPreset; label?: string; key: string }
  | { action: "update"; id: string; revision: string; label?: string; key?: string; enabled?: boolean }
  | { action: "remove"; id: string; revision: string };
