import type { NormalizedTokens } from "./model-signin-oauth.mjs";
type Provider = "chatgpt" | "supergrok";
type Entry = { provider: string; connectionId: string; revision: string; state: string; accessToken?: string; accountId?: string; expiresAt?: number; email?: string; plan?: string };
export type AcquireContext = { provider: Provider; clientId: string; signal: AbortSignal; epoch: number; isCurrent(): boolean };
export type Acquisition = { kind: "tokens"; provider: Provider; clientId: string; tokenUrl: string; tokens: NormalizedTokens; epoch: number } | { kind: "error"; error: string; epoch: number };
export function createModelSignIn(deps: {
 readDocument(): Record<string, unknown>;
 updateDocument(derive: (document: Record<string, unknown>) => Record<string, unknown>): Promise<unknown>;
 publish(entries: Entry[]): void;
 openExternal(url: string): Promise<void>;
 createServer(): unknown;
 acquireTokens?(context: AcquireContext): Promise<Acquisition>;
 env?: Record<string, string | undefined>; platform?: string; fetch?: typeof fetch;
 now?: () => number; randomId: () => string; setTimeout?: typeof setTimeout; clearTimeout?: typeof clearTimeout;
}): {
 start(provider: Provider): Promise<{ ok: boolean; error?: string; email?: string; plan?: string }>;
 refresh(provider: Provider, options?: { reactive?: boolean }): Promise<boolean>;
 cancel(provider: Provider): boolean; signOut(provider: Provider): Promise<boolean>;
 status(): Array<{ provider: Provider; enabled: boolean; state: string; acceptsCode: boolean; email?: string; plan?: string }>;
 resume(): void; dispose(): void;
};
