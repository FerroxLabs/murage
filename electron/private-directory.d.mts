export function tightenOwnedDirectory(
  directory: string,
  options?: { platform?: NodeJS.Platform; uid?: number; fileSystem?: typeof import("node:fs") },
): boolean;
