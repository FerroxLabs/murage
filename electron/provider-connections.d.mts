import type { KeyProviderPreset, ProviderConnectionRecord, ProviderPreset, ProviderProtocol } from "../shared/provider-connections.ts";
export const PROVIDER_PRESETS: Readonly<Record<KeyProviderPreset, { label: string; baseUrl: string; catalogUrl: string; protocol: ProviderProtocol }>>;
export function parseProviderBank(raw: unknown): ProviderConnectionRecord[];
export function assertProviderKey(preset: unknown, key: unknown): void;
export function isFluxKeyShape(key: unknown): boolean;
export const NOT_A_FLUX_KEY: string;
export function keyIssuer(key: unknown): KeyProviderPreset | null;
export function mutateProviderBank(raw: unknown, input: unknown, createId: () => string): ProviderConnectionRecord[];

export function providerBankRevision(raw: unknown): string;
