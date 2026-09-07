import { lstatSync, readFileSync } from "node:fs";

export type PersistedStateFailure = "unreadable" | "invalid-json" | "invalid-shape";

/** Startup must stop before migrations or new records can replace damaged
 * state. The stable fields let a startup/recovery surface explain the failure
 * without exposing the contents of the file or a JSON parser's input snippet. */
export class PersistedStateRecoveryError extends Error {
  readonly code = "PERSISTED_STATE_RECOVERY_REQUIRED";
  readonly filePath: string;
  readonly reason: PersistedStateFailure;
  readonly readErrorCode?: string;

  constructor(filePath: string, reason: PersistedStateFailure, cause?: unknown) {
    super(
      `Cannot load saved Murage state at ${filePath} (${reason}). ` +
      "The original file has not been replaced. Back up the file, repair or restore it " +
      "(or fix its read permissions), then restart Murage.",
      { cause },
    );
    this.name = "PersistedStateRecoveryError";
    this.filePath = filePath;
    this.reason = reason;
    this.readErrorCode = errorCode(cause);
  }
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

/** Validate the durable record envelope, not the modern Bot/Group schema.
 * Historical records legitimately omit tasks, default responders, and other
 * fields supplied by Store's migrations. Unknown fields must survive too. */
export function readPersistedJson(
  filePath: string,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): unknown {
  let raw: string;
  try {
    raw = read(filePath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      // A dangling symlink also produces ENOENT on read. It is existing state
      // that needs repair, not permission to replace it with an empty file.
      try {
        lstatSync(filePath);
      } catch (statError) {
        if (errorCode(statError) === "ENOENT") return undefined;
        throw new PersistedStateRecoveryError(filePath, "unreadable", statError);
      }
    }
    throw new PersistedStateRecoveryError(filePath, "unreadable", error);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // JSON errors can contain snippets of private saved data. Keep the public
    // recovery error actionable without retaining those parser messages.
    throw new PersistedStateRecoveryError(filePath, "invalid-json");
  }
  return parsed;
}

export function readPersistedRecords<T>(
  filePath: string,
  read?: (path: string) => string,
): T[] {
  const parsed = readPersistedJson(filePath, read);
  if (parsed === undefined) return [];
  if (!Array.isArray(parsed) || !parsed.every((record: unknown) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) return false;
    return "id" in record && typeof record.id === "string" && record.id.length > 0 &&
      "threadId" in record && typeof record.threadId === "string" && record.threadId.length > 0;
  })) {
    throw new PersistedStateRecoveryError(filePath, "invalid-shape");
  }
  return parsed as T[];
}
