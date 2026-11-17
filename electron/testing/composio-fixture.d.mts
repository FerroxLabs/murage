export function ensureFluxComposioBrokerToken<T extends Record<string, unknown>>(options: { credentials: T; fluxKey?: string; fluxBrokerUrl: string; fetchImpl?: typeof fetch; force?: boolean; [key: string]: unknown }): Promise<T>;
export function revokeFluxComposioBrokerToken(options: Record<string, unknown>): Promise<boolean>;
export function prepareLegacyComposioClaim<T extends Record<string, unknown>>(options: { credentials: T; [key: string]: unknown }): Promise<T>;
export function claimLegacyComposioInstall<T extends Record<string, unknown>>(options: { credentials: T; [key: string]: unknown }): Promise<T>;
export function ensureManagedComposioCredentials<T extends Record<string, unknown>>(options: { credentials: T; [key: string]: unknown }): Promise<T>;
export function deriveManagedComposioCredentials(options: Record<string, unknown>): <T extends Record<string, unknown>>(credentials: T) => Promise<T>;
