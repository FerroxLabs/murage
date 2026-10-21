export interface SddlRule { allow: boolean; sid: string; mask: number; inherited: boolean; inheritOnly: boolean }
export interface SddlAcl { owner: string | null; protected: boolean; rules: SddlRule[] }
export const SDDL_FIXED_SIDS: Record<string, string>;
export const SDDL_DOMAIN_RIDS: Record<string, number>;
export const SDDL_FOREST_RIDS: Record<string, number>;
export const SDDL_MACHINE_RIDS: Record<string, number>;
export const UNKNOWN_ACCOUNT_FIX: string;
export interface DomainSids { account: string | null; primary: string | null; forestRoot: string | null }
export function aclFail(fix?: string): Error & { fix?: string };
export function sddlSid(text: string, options?: { domains?: DomainSids | null }): string;
export function parseSddlAcl(sddl: string, options?: { domains?: DomainSids | null }): SddlAcl;
export function savedAclEntries(bytes: Uint8Array): Array<{ name: string; sddl: string }>;
export function sddlMask(text: string): number;
