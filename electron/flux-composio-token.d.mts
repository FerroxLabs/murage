/** The credential-document fields the FluxRouter connected-apps token occupies. */
export interface FluxComposioTokenFields {
  fluxComposioBrokerToken?: string;
  fluxComposioBrokerTokenExpiresAt?: string;
  fluxComposioBrokerTokenKeyFingerprint?: string;
  fluxComposioAccountKind?: "personal" | "shared";
  fluxComposioTokenError?: string;
  fluxComposioTokenRefusedKeyFingerprint?: string;
}
export const FLUX_BROKER_TOKEN: RegExp;
export const FLUX_COMPOSIO_TOKEN_FIELDS: readonly (keyof FluxComposioTokenFields)[];
export const FLUX_BROKER_TOKEN_REMINT_WINDOW_MS: number;
export function sha256Hex(value: string): string;
export function fluxKeyFingerprint(fluxKey: string): string;
export function brokerTokenFingerprint(token: string): string;
export function clearFluxComposioBrokerToken<T extends FluxComposioTokenFields>(credentials: T): T;
