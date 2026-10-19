export const CHATGPT_TOKEN_URL: string;
export const XAI_TOKEN_URL_FALLBACK: string;
export const XAI_SCOPES: string;
export type NormalizedTokens = { accessToken: string; refreshToken?: string; idToken?: string; expiresAt?: number; accountId?: string; plan?: string; email?: string };
export function parseTokenResponse(provider: string, body: unknown, now?: number): NormalizedTokens | null;
export function s256Challenge(verifier: string): string;
