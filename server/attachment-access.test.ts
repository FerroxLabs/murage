// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { attachmentReferencesIn, attachmentVisibleToRemote, messageJsonReferences, RemoteUploadGrants } from "./attachment-access.ts";

const store = (visible: string[], bots: Array<{ hidden?: boolean; avatarUrl?: string }> = []) => ({ visibleThreadIds: () => visible, bots });

describe("attachmentVisibleToRemote", () => {
  const none = new RemoteUploadGrants();
  const U = "companion";
  it("shows an image a visible conversation owns, and hides one only hidden conversations own", () => {
    expect(attachmentVisibleToRemote(store(["t1"]), "a.png", () => ["t1"], none, U)).toBe(true);
    expect(attachmentVisibleToRemote(store(["t1"]), "a.png", () => ["t9", "t1"], none, U)).toBe(true);
    expect(attachmentVisibleToRemote(store(["t1"]), "a.png", () => ["t9"], none, U)).toBe(false);
    // a mention in a hidden conversation does not undo a visible avatar
    expect(attachmentVisibleToRemote(store(["t1"], [{ avatarUrl: "/api/attachments/a.png" }]), "a.png", () => ["t9"], none, U)).toBe(true);
  });
  it("shows an avatar of a visible bot only, and an unmentioned image only to its uploader", () => {
    const bots = [{ avatarUrl: "/api/attachments/face.png" }, { hidden: true, avatarUrl: "/api/attachments/secret.png" }];
    expect(attachmentVisibleToRemote(store([], bots), "face.png", () => [], none, U)).toBe(true);
    expect(attachmentVisibleToRemote(store([], bots), "secret.png", () => [], none, U)).toBe(false);
    expect(attachmentVisibleToRemote(store([], bots), "loose.png", () => [], none, U)).toBe(false);
    const uploads = new RemoteUploadGrants();
    uploads.grant("loose.png", U);
    expect(attachmentVisibleToRemote(store([], bots), "loose.png", () => [], uploads, U)).toBe(true);
  });
  it("upload exception: uploader only, expires, and ends once a message mentions the picture", () => {
    let t = 0;
    const uploads = new RemoteUploadGrants(1000, () => t);
    uploads.grant("pending.png", "companion");
    // another kind of caller cannot use the exception
    expect(attachmentVisibleToRemote(store([]), "pending.png", () => [], uploads, "door")).toBe(false);
    expect(attachmentVisibleToRemote(store([]), "pending.png", () => [], uploads, "companion")).toBe(true);
    // it expires on its own
    t = 1000;
    expect(attachmentVisibleToRemote(store([]), "pending.png", () => [], uploads, "companion")).toBe(false);
    // upload, send into a visible conversation: visible while it is visible ...
    t = 2000; uploads.grant("sent.png", "companion");
    expect(attachmentVisibleToRemote(store(["t1"]), "sent.png", () => ["t1"], uploads, "companion")).toBe(true);
    // ... and refused once that conversation is hidden, though the grant has not expired
    expect(attachmentVisibleToRemote(store([]), "sent.png", () => ["t1"], uploads, "companion")).toBe(false);
    expect(uploads.allows("sent.png", "companion")).toBe(false);
    // a mention only in a hidden conversation also ends it
    uploads.grant("hidden.png", "companion");
    expect(attachmentVisibleToRemote(store([]), "hidden.png", () => ["t9"], uploads, "companion")).toBe(false);
    expect(attachmentVisibleToRemote(store([]), "hidden.png", () => [], uploads, "companion")).toBe(false);
  });
});

describe("grants are consumed at adoption", () => {
  const U = "companion";
  it("upload, set as avatar, hide the bot: the remote fetch is refused, with no GET in between", () => {
    const uploads = new RemoteUploadGrants();
    uploads.grant("face.png", U);
    uploads.consume("/api/attachments/face.png"); // the avatar was set
    expect(uploads.allows("face.png", U)).toBe(false);
    const hiddenBot = [{ hidden: true, avatarUrl: "/api/attachments/face.png" }];
    expect(attachmentVisibleToRemote(store([], hiddenBot), "face.png", () => [], uploads, U)).toBe(false);
  });
  it("upload, send: the grant is gone the moment the message is stored", () => {
    const uploads = new RemoteUploadGrants();
    uploads.grant("sent.png", U);
    uploads.consume("/tmp/data/attachments/sent.png"); // a stored message names the file path
    expect(uploads.allows("sent.png", U)).toBe(false);
    expect(attachmentVisibleToRemote(store([]), "sent.png", () => [], uploads, U)).toBe(false);
  });
  it("an un-adopted upload still works within the window, and unrelated references change nothing", () => {
    const uploads = new RemoteUploadGrants();
    uploads.grant("pending.png", U);
    uploads.consume("/api/attachments/other.png");
    uploads.consume("not-an-image.txt");
    expect(attachmentVisibleToRemote(store([]), "pending.png", () => [], uploads, U)).toBe(true);
  });
});


describe("an idempotent upload retry after adoption", () => {
  it("cannot reissue a consumed grant", () => {
    const uploads = new RemoteUploadGrants();
    uploads.grant("face.png", "companion");
    uploads.consume("/api/attachments/face.png");
    uploads.grant("face.png", "companion"); // the retry
    expect(uploads.allows("face.png", "companion")).toBe(false);
  });
});

describe("an ended exception cannot be reopened by forgetting", () => {
  const U = "companion";
  it("a retry that finds the file already there never grants, however old the adoption or the grant", () => {
    let t = 0;
    const uploads = new RemoteUploadGrants(1000, () => t);
    uploads.grantUpload("face.png", U, true);
    expect(uploads.allows("face.png", U)).toBe(true);
    uploads.consume("/api/attachments/face.png");
    // push far more adoptions than the bounded set remembers
    for (let i = 0; i < 4 * 512 + 50; i++) uploads.consume(`/api/attachments/other-${i}.png`);
    uploads.grantUpload("face.png", U, false); // the retry: the file existed
    expect(uploads.allows("face.png", U)).toBe(false);
    // a restart forgets everything in memory: the retry still gets no grant
    const restarted = new RemoteUploadGrants(1000, () => t);
    restarted.grantUpload("face.png", U, false);
    expect(restarted.allows("face.png", U)).toBe(false);
    // an expired grant is not renewed by a retry either
    uploads.grantUpload("late.png", U, true);
    t = 5000;
    uploads.grantUpload("late.png", U, false);
    expect(uploads.allows("late.png", U)).toBe(false);
  });
  it("a retry while the first grant is live leaves it as it was", () => {
    let t = 0;
    const uploads = new RemoteUploadGrants(1000, () => t);
    uploads.grantUpload("keep.png", U, true);
    t = 600;
    uploads.grantUpload("keep.png", U, false);
    expect(uploads.allows("keep.png", U)).toBe(true);
    t = 1000;
    expect(uploads.allows("keep.png", U), "not extended by the retry").toBe(false);
  });
});

describe("one reference definition", () => {
  it("deduplicates exact basenames without discarding a shorter filename reference", () => {
    const json = JSON.stringify({ text: "abc-123.png ABC-123.PNG", attachments: [{ path: "/legacy/prefix-abc-123.png" }] });
    const names = attachmentReferencesIn(json, ["/legacy/prefix-abc-123.png", "C:\\legacy\\PREFIX-ABC-123.PNG"]);
    expect(names).toEqual(["prefix-abc-123.png", "abc-123.png"]);
    for (const name of names) expect(messageJsonReferences(json, name)).toBe(true);
  });
  it("is case-insensitive, covers structured paths and text, and ignores longer tokens' tails", () => {
    expect(messageJsonReferences('{"text":"![x](/api/attachments/ABC-1.PNG)"}', "abc-1.png")).toBe(true);
    expect(messageJsonReferences('{"text":"see xyzabc-1.png"}', "abc-1.png")).toBe(false);
    expect(attachmentReferencesIn('{"attachments":[{"path":"/d/a.png"}]}', ["/d/a.png"])).toEqual(["a.png"]);
  });
  it("consuming by a differently-cased reference ends the grant", () => {
    const uploads = new RemoteUploadGrants();
    uploads.grant("abc-1.png", "companion");
    uploads.consume("/api/attachments/ABC-1.PNG");
    expect(uploads.allows("abc-1.png", "companion")).toBe(false);
    uploads.grant("abc-1.png", "companion");
    expect(uploads.allows("abc-1.png", "companion")).toBe(false);
  });
});

describe("scanning a very long message for picture names", () => {
  it("is linear in a long run of name characters with no dot (an 850 KB message once froze the server)", () => {
    const started = Date.now();
    expect(attachmentReferencesIn(JSON.stringify({ text: "pressure:" + "x".repeat(850_000) }))).toEqual([]);
    expect(attachmentReferencesIn("y".repeat(850_000) + ".png and b-2.JPEG")).toEqual(["y".repeat(850_000) + ".png", "b-2.JPEG"]);
    expect(Date.now() - started).toBeLessThan(1500);
  });
  it("keeps the leftmost, non-overlapping token semantics", () => {
    expect(attachmentReferencesIn("a.png.png x.webpfoo ..gif -.jpg")).toEqual(["a.png", "x.webp", "-.jpg"]);
  });
});
