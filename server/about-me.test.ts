// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ABOUT_ME_MAX_CHARS,
  aboutMePrompt,
  aboutMeSuggestion,
  countChars,
  handleAboutMeApi,
  readAboutMe,
  saveAboutMe,
} from "./about-me.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "murage-about-me-"));
});

describe("about me storage", () => {
  it("is empty and adds nothing to a prompt until the owner saves one", () => {
    expect(readAboutMe(dir)).toEqual({ text: "", saved: false, chars: 0, maxChars: ABOUT_ME_MAX_CHARS });
    expect(aboutMePrompt(dir)).toBe("");
  });

  it("saves owner-only and shows up on the very next prompt", () => {
    expect(aboutMePrompt(dir)).toBe(""); // prime the cache: a save must still show up
    const state = saveAboutMe("I run a candle shop. Keep answers short.", dir);
    expect(state).toMatchObject({ text: "I run a candle shop. Keep answers short.", saved: true, chars: 40 });
    const prompt = aboutMePrompt(dir);
    expect(prompt.startsWith("<about-the-owner>\n")).toBe(true);
    expect(prompt.endsWith("\nI run a candle shop. Keep answers short.\n</about-the-owner>\n\n")).toBe(true);
    if (process.platform !== "win32") expect(statSync(join(dir, "about-me.md")).mode & 0o777).toBe(0o600);
  });

  it("picks up a hand edit on the next prompt", () => {
    saveAboutMe("First.", dir);
    expect(aboutMePrompt(dir)).toContain("First.");
    writeFileSync(join(dir, "about-me.md"), "Second, a little longer.");
    expect(aboutMePrompt(dir)).toContain("Second, a little longer.");
    expect(aboutMePrompt(dir)).not.toContain("First.");
  });

  it("treats a cleared profile as saved and empty, so nothing rides and nothing is suggested again", () => {
    saveAboutMe("Something.", dir);
    const cleared = saveAboutMe("  \n ", dir);
    expect(cleared).toMatchObject({ saved: true, chars: 0 });
    expect(aboutMePrompt(dir)).toBe("");
    expect(existsSync(join(dir, "about-me.md"))).toBe(true);
  });

  it("refuses text over the cap in plain words and keeps the old text", () => {
    saveAboutMe("Kept.", dir);
    expect(() => saveAboutMe("x".repeat(ABOUT_ME_MAX_CHARS + 1), dir)).toThrow(`About me can be up to ${ABOUT_ME_MAX_CHARS.toLocaleString("en-US")} characters.`);
    expect(readAboutMe(dir).text).toBe("Kept.");
    expect(() => saveAboutMe("x".repeat(ABOUT_ME_MAX_CHARS), dir)).not.toThrow();
  });

  it("counts characters the way a person does, not bytes", () => {
    expect(countChars("café")).toBe(4);
    expect(countChars("👋 hi")).toBe(4);
  });
});

describe("the starting text", () => {
  it("says only what Murage already knows", () => {
    expect(aboutMeSuggestion({ name: "Sam Rivers", timeZone: "Europe/Dublin" })).toBe("My name is Sam Rivers.\nMy time zone is Europe/Dublin.\n");
    expect(aboutMeSuggestion({ name: "  ", timeZone: "America/Denver" })).toBe("My time zone is America/Denver.\n");
    expect(aboutMeSuggestion({})).toBe("");
  });
});

describe("the about me routes", () => {
  const readBody = (value: unknown) => async () => value;
  const seed = { name: "Sam", timeZone: "Europe/Dublin" };

  it("offers the starting text only before the first save", async () => {
    const first = await handleAboutMeApi({ method: "GET", path: "/api/about-me", readBody: readBody(undefined), seed }, dir);
    expect(first).toMatchObject({ status: 200, body: { text: "", saved: false, suggestion: "My name is Sam.\nMy time zone is Europe/Dublin.\n" } });
    await handleAboutMeApi({ method: "PUT", path: "/api/about-me", readBody: readBody({ text: "" }), seed }, dir);
    const after = await handleAboutMeApi({ method: "GET", path: "/api/about-me", readBody: readBody(undefined), seed }, dir);
    expect(after?.body).toMatchObject({ saved: true, suggestion: "" });
  });

  it("saves, and refuses bad bodies and long text with a reason", async () => {
    const put = (body: unknown) => handleAboutMeApi({ method: "PUT", path: "/api/about-me", readBody: readBody(body), seed }, dir);
    expect(await put({ text: "Hello." })).toMatchObject({ status: 200, body: { text: "Hello.", saved: true } });
    expect((await put({ text: 4 }))?.status).toBe(400);
    expect((await put({ text: "a", extra: true }))?.status).toBe(400);
    expect((await put([]))?.status).toBe(400);
    expect((await put({}))?.status).toBe(400);
    const long = await put({ text: "y".repeat(ABOUT_ME_MAX_CHARS + 1) });
    expect(long?.status).toBe(413);
    expect((long?.body as { error: string }).error).toMatch(/^About me can be up to/);
    expect(readAboutMe(dir).text).toBe("Hello.");
    expect((await handleAboutMeApi({ method: "DELETE", path: "/api/about-me", readBody: readBody(undefined), seed }, dir))?.status).toBe(405);
    expect(await handleAboutMeApi({ method: "GET", path: "/api/other", readBody: readBody(undefined), seed }, dir)).toBeNull();
  });
});
