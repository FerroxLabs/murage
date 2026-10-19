export interface ModelManifestFile { path: string; bytes: number; sha256: string }
export interface ModelManifestLike { files: ModelManifestFile[] }
export function manifestFileTarget(directory: string, relativePath: string): string | null;
export function sha256OfFile(file: string): Promise<string>;
export function modelSizesMatch(directory: string, manifest: ModelManifestLike): Promise<boolean>;
export function verifyModelDirectory(directory: string, manifest: ModelManifestLike, options?: { rejectLinks?: boolean }): Promise<{ ok: boolean; reason?: string }>;
export function linkedPathComponent(directory: string): Promise<string | null>;
export function linkedInternalComponent(directory: string, manifest: ModelManifestLike): Promise<string | null>;
export function modelSignature(directory: string, manifest: ModelManifestLike): string | null;
