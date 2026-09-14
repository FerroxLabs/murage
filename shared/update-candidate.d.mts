export interface UpdateCandidate {
  readonly schemaVersion: 1;
  readonly candidateId: string;
  readonly version: string;
  readonly platform: "darwin" | "win32" | "linux";
  readonly arch: "x64" | "arm64" | "ia32" | "arm";
  readonly artifacts: readonly { readonly kind: "primary" | "package"; readonly sha512: string }[];
  readonly manifestDigests: readonly string[];
}
export function parseUpdateCandidate(value: unknown): UpdateCandidate;
export function canonicalUpdateDescriptor(value: unknown): string;
