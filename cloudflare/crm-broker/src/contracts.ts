// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// HL-SOURCE-1. Data contracts only; this file provisions no Worker/storage/keys.
import { z } from "zod";
import { HIGHLEVEL_CRM_SCOPES } from "../../../server/highlevel/provider-contract.ts";
const id = z.string().min(1).max(180).regex(/^[A-Za-z0-9_-]+$/u);
const version = z.number().int().positive();
const secret = z.string().min(1).max(8192);
export const OAUTH_TOKEN_CONTRACT = Object.freeze({ version: "2021-07-28", method: "POST", origin: "https://services.leadconnectorhq.com",
  path: "/oauth/token", encoding: "application/x-www-form-urlencoded", userType: "Location", versionHeader: false } as const);
export const BROKER_ROUTES = Object.freeze(["/v1/crm/begin", "/v1/crm/callback", "/v1/crm/complete", "/v1/crm/lease", "/v1/crm/disconnect"] as const);
export const FLOW_LIFETIME_MS = 10 * 60 * 1000;
export const PROVIDER_AUTHORIZATION_URL = "https://marketplace.leadconnectorhq.com/v2/oauth/chooselocation";
/** No requested/previous scope fallback on exchange OR refresh. No Company/oauth.* path. */
export const grantedScopesSchema = z.array(z.string().min(1).max(128)).min(1).max(HIGHLEVEL_CRM_SCOPES.length)
  .refine(scopes => new Set(scopes).size === scopes.length && scopes.every(scope => !scope.startsWith("oauth.") && HIGHLEVEL_CRM_SCOPES.includes(scope)));
export const scopeInventorySchema = z.strictObject({ provenance: z.literal("oauth-token-response"), userType: z.literal("Location"),
  locationId: id, scopes: grantedScopesSchema, grantVersion: version, connectionEpoch: version });
export type ScopeInventory = z.infer<typeof scopeInventorySchema>;
/** Home receives an ACCESS lease only. Refresh credential and Marketplace secret remain broker-private. */
export const accessLeaseSchema = scopeInventorySchema.extend({ grantId: id, credentialVersion: version, accessToken: secret,
  expiresAt: z.number().int().positive() });
export type AccessLease = z.infer<typeof accessLeaseSchema>;
export const runtimeBindingSchema = z.strictObject({ runtimePrincipalId: id, installationId: id, homeId: id, contentOwnerId: id });
export type RuntimeBinding = z.infer<typeof runtimeBindingSchema>;
export const signedRuntimeRequestSchema = runtimeBindingSchema.extend({ requestId: id, issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(), signature: secret }).refine(value => value.expiresAt > value.issuedAt && value.expiresAt - value.issuedAt <= 60_000);
/** Enrollment is supplied by the MAIN-named authenticated runtime adapter, never the renderer.
 * Cryptographic algorithm/key provenance and staging origin remain deployment prerequisites. */
export interface RuntimeRequestVerifier { verify(request: z.infer<typeof signedRuntimeRequestSchema>, route: typeof BROKER_ROUTES[number]): Promise<RuntimeBinding | null> }
export const beginRequestSchema = runtimeBindingSchema.extend({ requestId: id, connectionEpoch: version });
export const beginResponseSchema = z.strictObject({ flowId: id, authorizationUrl: z.url().refine(value => {
  const url = new URL(value);
  return `${url.origin}${url.pathname}` === PROVIDER_AUTHORIZATION_URL && !url.username && !url.password && !url.hash;
}), completionCapability: secret, expiresAt: z.number().int().positive() });
export const completeRequestSchema = runtimeBindingSchema.extend({ flowId: id, completionCapability: secret, confirmedLocationId: id });
export const leaseRequestSchema = runtimeBindingSchema.extend({ grantId: id, grantVersion: version, connectionEpoch: version });
export const disconnectRequestSchema = leaseRequestSchema;
export const grantMetadataSchema = scopeInventorySchema.extend({ grantId: id, credentialVersion: version });
export const missingScopeSchema = z.strictObject({ code: z.literal("missing_scope"), operation: z.string().min(1).max(128),
  permissionIds: grantedScopesSchema, connectionId: id });
export type MissingScope = z.infer<typeof missingScopeSchema>;
/** The secure adapter owns runtime capability/locator epoch keys only; no OAuth refresh tokens.
 * prepare/commit are main-only, bank-before-metadata, serialized with disconnect. Retired epoch keys
 * are independent random entries and cannot be rederived from a retained master secret. */
export interface HighLevelCredentialCommit {
  prepare(binding: RuntimeBinding, expectedBankVersion: number): Promise<{ readonly commitId: string; readonly bankVersion: number }>;
  commit(commitId: string, expectedBankVersion: number): Promise<{ readonly bankVersion: number }>;
  retireEpoch(connectionId: string, connectionEpoch: number): Promise<void>;
}
