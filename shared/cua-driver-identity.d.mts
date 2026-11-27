export type FileIdentity = { dev: string; ino: string; size: string; mtimeNs: string; ctimeNs: string };
export type IdentityFs = {
  open(file: string, flags: number): Promise<number>;
  read(fd: number, buffer: Buffer, offset: number, length: number, position: number): Promise<number>;
  fstat(fd: number): Promise<Record<string, bigint | number>>;
  stat(file: string): Promise<Record<string, bigint | number>>;
  close(fd: number): Promise<void>;
};
export const defaultIdentityFs: IdentityFs;
export function fileIdentity(stat: Record<string, bigint | number>): FileIdentity;
export function verifyExeIdentity(
  file: string,
  pinSha256: string | undefined,
  fs?: IdentityFs,
  options?: { platform?: NodeJS.Platform; exclusive?: boolean },
): Promise<{ ok: true; identity: FileIdentity } | { ok: false; reason: string }>;
