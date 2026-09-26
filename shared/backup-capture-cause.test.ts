import { expect, it } from "vitest";
import { BACKUP_CAPTURE_CODES, captureFailureSentence, describeCaptureError, normalizeCaptureCause, redactCauseText } from "./backup-capture-failure.mjs";

it("redacts paths, keys and long tokens from a cause", () => {
  const text = redactCauseText(`EPERM: operation not permitted, link 'C:\\Users\\Sam Lee\\Murage Backups\\x.age' -> 'C:\\Users\\Sam Lee\\y' AGE-SECRET-KEY-1${"Q".repeat(58)} age1${"q".repeat(58)} /Users/sam/My Files/a.txt \\\\nas\\share\\a b`)!;
  for (const leaked of ["Sam Lee", "Murage Backups", "AGE-SECRET-KEY", "age1q", "/Users/sam", "nas", "share"]) expect(text).not.toContain(leaked);
  expect(text).toContain("EPERM: operation not permitted, link");
  expect(redactCauseText("x".repeat(500))!.length).toBeLessThanOrEqual(200);
});

it("keeps only allow-listed fields in a cause", () => {
  expect(normalizeCaptureCause({ step: "publish", errno: "EBUSY", syscall: "link", path: "C:\\secret", exitCode: 1, tool: "age", stderr: "age: error: open C:\\Users\\Sam Lee\\k.txt", extra: 1 }))
    .toEqual({ step: "publish", errno: "EBUSY", syscall: "link", exitCode: 1, tool: "age", stderr: "age: error: open <path>" });
  expect(normalizeCaptureCause({ step: "anything-else", errno: "not an errno" })).toBeNull();
});

it("describes a wrapped filesystem error by its inner errno", () => {
  const inner = Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC", syscall: "write" });
  const outer = Object.assign(new Error("x", { cause: inner }), { code: "BACKUP_DISK_FULL", captureStep: "encrypt" });
  expect(describeCaptureError(outer)).toMatchObject({ step: "encrypt", errno: "ENOSPC", syscall: "write", code: "BACKUP_DISK_FULL" });
});

it("every capture code has its own sentence, and none of the file-error ones blames the recovery key (W-D1)", () => {
  const fallback = captureFailureSentence({ stage: "capture", code: "UNKNOWN_CAPTURE_FAILURE" });
  for (const code of BACKUP_CAPTURE_CODES) expect(captureFailureSentence({ stage: "capture", code }), code).not.toBe(fallback);
  for (const code of ["ENCRYPTED_BACKUP_FAILED", "BACKUP_DISK_FULL", "BACKUP_FOLDER_NOT_WRITABLE", "BACKUP_FILE_IN_USE"]) {
    const sentence = captureFailureSentence({ stage: "capture", code });
    expect(sentence).not.toMatch(/recovery key/i);
    expect(sentence).not.toMatch(/\u2014|\bsafe\b/i);
  }
});
