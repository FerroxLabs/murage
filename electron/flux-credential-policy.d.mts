import type { ProviderConnectionRecord } from "../shared/provider-connections.ts";
export interface FluxAlias { id: string; label: string; enabled: boolean; revision: string }
export interface FluxCredentialState { bank?: string; workspaceKey?: string; aliases?: FluxAlias[] }
export interface FluxCredentialChange { action: "connect" | "replace" | "select" | "disconnect" | "consolidate"; revision: string; key?: string; connectionId?: string }
export function fluxCredentialRevision(state: FluxCredentialState): string;
export function fluxCredentialStatus(state: FluxCredentialState): { configured: boolean; revision: string; conflict: boolean; choices: { id: string; label: string; enabled: boolean }[] };
export function planFluxCredentialChange(state: FluxCredentialState, input: unknown): { workspaceKey: string; bank: string; aliases: FluxAlias[] };
export function resolveFluxAlias(alias: FluxAlias, workspaceKey: string | undefined, canonicalRevision: string): ProviderConnectionRecord | null;
