// SPDX-License-Identifier: AGPL-3.0-or-later
export type AddressClass = "public" | "loopback" | "private" | "tailnet" | "local-name" | "refused";
export type LocalConfirmation = "this-computer" | "local-network";
export type RequestKind = "mcp" | "sse" | "metadata" | "token" | "register";
export type PolicyErrorCode =
  | "invalid-address"
  | "credentials-in-address"
  | "https-required"
  | "local-confirm"
  | "address-changed"
  | "refused-address"
  | "unresolved-address";
export type RedirectErrorCode = "redirect-not-allowed" | "too-many-redirects" | PolicyErrorCode;

export const LIMITS: Readonly<{
  metadataBytes: number;
  registerBytes: number;
  tokenBytes: number;
  mcpResponseBytes: number;
  sseEventBytes: number;
  toolsListed: number;
  dnsMs: number;
  connectMs: number;
  probeTotalMs: number;
  initializeRelayMs: number;
  toolCallMs: number;
  signInMs: number;
}>;

export function classifyAddress(address: string): AddressClass;
export function classifyHostname(hostname: string): AddressClass;
export function isRefusedClass(addressClass: AddressClass): boolean;
export function confirmationFor(addressClass: AddressClass): LocalConfirmation | "refused" | null;

export type ParsedServerUrl =
  | { ok: true; scheme: "http" | "https"; hostname: string; port: number; path: string; href: string }
  | { ok: false; code: "invalid-address" | "credentials-in-address" };
export function parseServerUrl(input: string): ParsedServerUrl;

export interface UrlPolicyInput {
  url: string;
  mode: "inspect" | "request";
  confirmed?: LocalConfirmation | null;
  resolved?: ReadonlyArray<{ address: string }>;
}
export type UrlPolicyResult =
  | { ok: true; addressClass: AddressClass; local: LocalConfirmation | null }
  | { ok: false; code: Exclude<PolicyErrorCode, "local-confirm"> }
  | { ok: false; code: "local-confirm"; needs: LocalConfirmation };
export function evaluateUrlPolicy(input: UrlPolicyInput): UrlPolicyResult;

export function redirectPolicyFor(kind: RequestKind): { maxHops: number; httpsOnly: boolean };
export function decideRedirect(input: { kind: RequestKind; hopsSoFar: number; from: string; location: string; allowPlainHttp?: boolean }):
  | { follow: true; url: string }
  | { follow: false; code: RedirectErrorCode };

export function sameOrigin(a: string, b: string): boolean;
export function logSafeUrl(value: string): string;
export function hopMode(mode: "inspect" | "request", hopsSoFar: number): "inspect" | "request";
