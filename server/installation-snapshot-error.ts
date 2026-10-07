// SPDX-License-Identifier: AGPL-3.0-or-later
export class InstallationSnapshotError extends Error {
  readonly code: string;
  /** The item in the data folder the refusal is about, relative to it and
   * with "/" separators, so the person is told which file to look at. */
  readonly path?: string;
  constructor(code: string, options?: { cause?: unknown; path?: string }) {
    super(`Murage database snapshot refused (${code}). Original installation data was preserved.`, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "InstallationSnapshotError";
    this.code = code;
    if (options?.path) this.path = options.path.split("\\").join("/");
  }
}

