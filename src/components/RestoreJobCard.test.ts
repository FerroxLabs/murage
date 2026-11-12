// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RestoreJobCardView, dismissRestoreJob, readRestoreJob, restoreJobText, type RestoreJobStatus } from "./RestoreJobCard";

const action = { label: "OK", method: "POST", path: "/api/restore-job/dismiss" };
const aborted: RestoreJobStatus = { state: "aborted", code: "aborted", line: "server english", action };
const stuck: RestoreJobStatus = { state: "running", code: "finishing", line: "server english", action: null };
const render = (status: RestoreJobStatus | null, extra: object = {}) => renderToStaticMarkup(createElement(RestoreJobCardView, { status, canDismiss: true, onDismiss: () => {}, ...extra }));

const S1 = "A restore may still be in progress. Try again later.";
const S2_DESKTOP = "The last restore did not finish. Your information has not changed. Select OK to clear this message, then you can start a restore again.";
const S2_PHONE = "The last restore did not finish. The app's data has not changed. The owner can select OK in Murage on their computer, or on their phone for a Cloud home, to clear this message and try again.";

describe("Restore job card", () => {
  it("is hidden with no job", () => {
    expect(render(null)).toBe("");
    expect(render({ state: "none", code: null, line: null, action: null })).toBe("");
  });
  it("shows the locale text for the server code, never the server English line", () => {
    expect(render(aborted)).toContain(S2_DESKTOP);
    expect(render(aborted)).not.toContain("server english");
    expect(render(stuck)).toContain(S1);
    expect(render({ state: "unreadable", code: "stuck_or_unreadable", line: "x", action: null })).toContain(S1);
  });
  it("hides on a code it does not know", () => {
    expect(render({ state: "running", code: "brand_new" as never, line: "x", action: null })).toBe("");
  });
  it("offers OK only when the server gives the action", () => {
    expect(render(aborted)).toContain(">OK<");
    expect(render(stuck)).not.toContain("<button");
  });
  it("the label is the locale OK, whatever label the server sent", () => {
    expect(render({ ...aborted, action: { ...action, label: "Whatever" } })).toContain(">OK<");
  });
  it("a surface that cannot dismiss sees the owner-phone wording with no Press OK and no button", () => {
    const markup = render(aborted, { canDismiss: false });
    expect(markup).toContain(S2_PHONE.replace("'", "&#x27;"));
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("Press OK");
    expect(render(aborted)).not.toContain("Press OK");
  });
  it("S1: canDismiss decides the button (mutant canDismiss={true} would show OK to a phone)", () => {
    expect(render(aborted, { canDismiss: true })).toContain("<button");
    expect(render(aborted, { canDismiss: false })).not.toContain("<button");
  });
  it("S4: the button is disabled while busy and enabled otherwise", () => {
    expect(render(aborted, { busy: true })).toMatch(/<button[^>]*disabled=""/);
    expect(render(aborted, { busy: false })).not.toMatch(/<button[^>]*\sdisabled=""/);
  });
  it("OK calls dismiss and the card then hides", async () => {
    const calls: string[] = [];
    const api = vi.fn(async (path: string, init?: RequestInit) => { calls.push(`${init?.method ?? "GET"} ${path}`); return path.endsWith("dismiss") ? { state: "none", code: null, line: null, action: null } : aborted; });
    expect(await readRestoreJob(api)).toEqual(aborted);
    const after = await dismissRestoreJob(api, aborted.action!);
    expect(calls).toEqual(["GET /api/restore-job/status", "POST /api/restore-job/dismiss"]);
    expect(render(after)).toBe("");
  });
  it("a failed read hides the card", async () => {
    expect(await readRestoreJob(async () => { throw new Error("x"); })).toBeNull();
  });
  it("S3: a thrown dismiss re-reads the status and returns what it read (not null)", async () => {
    const calls: string[] = [];
    const api = vi.fn(async (path: string, init?: RequestInit) => { calls.push(`${init?.method ?? "GET"} ${path}`); if (init?.method === "POST") throw new Error("409"); return aborted; });
    expect(await dismissRestoreJob(api, aborted.action!)).toEqual(aborted);
    expect(calls).toEqual(["POST /api/restore-job/dismiss", "GET /api/restore-job/status"]);
  });
});

describe("clean() validation (S5 and Fable L2)", () => {
  const read = (value: unknown) => readRestoreJob(async () => value);
  it("rejects a non-object, a missing state and a non-string state", async () => {
    for (const bad of [null, undefined, "x", 5, [], {}, { state: 5 }]) expect(await read(bad), JSON.stringify(bad)).toBeNull();
  });
  it("derives the code from the state when an old server sends none, and drops an unknown code to null", async () => {
    expect(await read({ state: "running", line: null, action: null })).toMatchObject({ code: "finishing" });
    expect(await read({ state: "aborted", action: null })).toMatchObject({ code: "aborted" });
    expect(await read({ state: "unreadable", action: null })).toMatchObject({ code: "stuck_or_unreadable" });
    expect(await read({ state: "weird", action: null })).toMatchObject({ code: null });
  });
  it("keeps only an action that is a POST under /api/restore-job/", async () => {
    const withAction = (a: unknown) => read({ state: "aborted", code: "aborted", action: a });
    expect((await withAction({ label: "OK", method: "POST", path: "/api/restore-job/dismiss" }))!.action).toEqual({ label: "OK", method: "POST", path: "/api/restore-job/dismiss" });
    for (const bad of [
      { label: "OK", method: "POST", path: "/api/other/dismiss" },
      { label: "OK", method: "POST", path: "https://evil.example/api/restore-job/dismiss" },
      { label: "OK", method: "POST", path: "//evil.example/api/restore-job/x" },
      { label: "OK", method: "POST", path: "/api/restore-job/../email/x" },
      { label: "OK", method: "GET", path: "/api/restore-job/dismiss" },
      { label: "OK", method: "DELETE", path: "/api/restore-job/dismiss" },
      { label: "OK", path: 5 },
      "x",
    ]) expect((await withAction(bad))!.action, JSON.stringify(bad)).toBeNull();
  });
});

describe("restoreJobText maps every code to a locale string", () => {
  it("covers the status codes and the start-route codes", () => {
    expect(restoreJobText("finishing", true)).toBe(S1);
    expect(restoreJobText("restore_finishing", true)).toBe(S1);
    expect(restoreJobText("stuck_or_unreadable", false)).toBe(S1);
    expect(restoreJobText("aborted", true)).toBe(S2_DESKTOP);
    expect(restoreJobText("restore_aborted", false)).toBe(S2_PHONE);
    expect(restoreJobText("restore_failed", true)).toBe("That restore did not finish. You can try again.");
    expect(restoreJobText("backup_running", true)).toBe("A backup is running. Try the restore again when it has finished.");
    expect(restoreJobText("owner_only", true)).toBe("Only the owner can restore a backup, using Murage on their computer or, for a Cloud home, on their phone.");
    expect(restoreJobText("nope", true)).toBeNull();
    expect(restoreJobText(null, true)).toBeNull();
  });
  it("no string says Nothing changed, Press OK, a banned word or a dash", () => {
    for (const code of ["finishing", "aborted", "restore_failed", "backup_running", "owner_only"]) for (const d of [true, false]) {
      const text = restoreJobText(code, d)!;
      expect(text, code).not.toMatch(/Nothing changed|Press OK|\b(safe|unsafe|safety|free|Forge)\b|will fail|[–—]/i);
    }
  });
});

describe("the card is mounted in the Backups screen (S2)", () => {
  it("BackupSettings imports and renders RestoreJobCard", () => {
    const source = readFileSync(new URL("./BackupSettings.tsx", import.meta.url), "utf8");
    expect(source).toContain('import { RestoreJobCard } from "./RestoreJobCard";');
    expect(source).toMatch(/<RestoreJobCard\b[^>]*refreshKey=\{restoreCheck\}/);
    expect(source).toMatch(/setRestoreCheck\(n=>n\+1\)/);
  });
});
