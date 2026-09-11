/** The credential-document fields the FluxRouter connected-apps token occupies. */
export interface FluxComposioTokenFields {
  fluxComposioBrokerToken?: string;
  fluxComposioBrokerTokenExpiresAt?: string;
  fluxComposioBrokerTokenKeyFingerprint?: string;
  fluxComposioAccountKind?: "personal" | "shared";
  fluxComposioTokenError?: string;
}
export const FLUX_BROKER_TOKEN: RegExp;
export const FLUX_COMPOSIO_TOKEN_FIELDS: readonly (keyof FluxComposioTokenFields)[];
export const FLUX_BROKER_TOKEN_REMINT_WINDOW_MS: number;
export function sha256Hex(value: string): string;
export function fluxKeyFingerprint(fluxKey: string): string;
export function clearFluxComposioBrokerToken<T extends FluxComposioTokenFields>(credentials: T): T;
export function revokeFluxComposioBrokerToken(options: {
  fluxBrokerUrl: string;
  token: string | undefined;
  fetchImpl?: typeof fetch;
  timeoutSignal?: (milliseconds: number) => AbortSignal;
}): Promise<boolean>;
export function ensureFluxComposioBrokerToken<T extends FluxComposioTokenFields>(options: {
  fluxBrokerUrl: string;
  credentials: T;
  fluxKey: string;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  timeoutSignal?: (milliseconds: number) => AbortSignal;
  now?: number;
  force?: boolean;
  onRateLimited?: () => void;
  label?: string;
}): Promise<T>;
