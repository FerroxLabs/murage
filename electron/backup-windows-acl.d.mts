// Types for the parts of backup-windows-acl.mjs the server imports.
export type WindowsAclListing = { owner: string; protected: boolean; rules: { allow: boolean; sid: string; mask: number; inherited: boolean }[] };
export function currentUserSid(options?: object): string;
export function readAcl(target: string, options?: object): WindowsAclListing;
export function aclIsOwnerOnly(acl: WindowsAclListing, sid: string): boolean;
export function restrictToOwner(target: string, options?: { directory?: boolean }): void;
