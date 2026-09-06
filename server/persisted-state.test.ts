import { describe, expect, it } from "vitest";
import { PersistedStateRecoveryError, readPersistedRecords } from "./persisted-state.ts";

describe("persisted records", () => {
  it("treats only ENOENT as an absent collection", () => {
    expect(readPersistedRecords("missing.json", () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    })).toEqual([]);
    expect(readPersistedRecords("empty.json", () => "[]")).toEqual([]);
  });

  it.each(["EACCES", "EPERM", "EIO", "ENOTDIR"])("requires recovery on %s", (code) => {
    const cause = Object.assign(new Error("read failed"), { code });
    expect(() => readPersistedRecords("saved.json", () => { throw cause; })).toThrowError(
      expect.objectContaining({
        name: "PersistedStateRecoveryError", code: "PERSISTED_STATE_RECOVERY_REQUIRED",
        reason: "unreadable", filePath: "saved.json", readErrorCode: code, cause,
      }),
    );
  });

  it("also fails closed when a read error has no errno", () => {
    expect(() => readPersistedRecords("saved.json", () => { throw new Error("read failed"); }))
      .toThrow(PersistedStateRecoveryError);
  });

  it.each(["", "{", '{"privateCredential":"never-echo-this",']) (
    "does not expose malformed saved content in the recovery error", (raw) => {
      try {
        readPersistedRecords("saved.json", () => raw);
        expect.unreachable("malformed input must fail");
      } catch (error) {
        expect(error).toBeInstanceOf(PersistedStateRecoveryError);
        expect(String(error)).toContain("Back up the file");
        expect(String(error)).not.toContain("never-echo-this");
        expect((error as Error).cause).toBeUndefined();
      }
    },
  );

  it("preserves legacy omissions and unknown fields for Store migrations", () => {
    const legacy = [{ id: "bot-legacy", threadId: "thread-legacy", resumeCursors: { claude: "session" }, futureField: { kept: true } }];
    expect(readPersistedRecords("bots.json", () => JSON.stringify(legacy))).toEqual(legacy);
  });
});
