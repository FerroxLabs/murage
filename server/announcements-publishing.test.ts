// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The publishing kit (tools/announcements/): the lint runs the app's rules,
// what sign.mjs writes is exactly what the harness accepts, and the workflow
// template asks the owner before anything is signed. Keys are made per run.
import { generateKeyPairSync } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  ANNOUNCEMENT_ACCENTS,
  ANNOUNCEMENT_ACTIONS,
  ANNOUNCEMENT_KINDS,
  ANNOUNCEMENT_LAYOUTS,
  ANNOUNCEMENT_PLATFORMS,
  checkAnnouncementFeed,
} from "../shared/announcements.ts";
import { announcementKeys, verifyAnnouncementSignature } from "./announcements.ts";
// @ts-expect-error plain .mjs publishing scripts, no type declarations
import { lint } from "../tools/announcements/lint.mjs";
// @ts-expect-error plain .mjs publishing scripts, no type declarations
import { rawPublicKey, signFeed } from "../tools/announcements/sign.mjs";

const KIT = new URL("../tools/announcements/", import.meta.url);
const pem = () => generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString();

let repo: string;
beforeEach(() => {
  // a copy of the example, laid out as the private repo will be
  repo = mkdtempSync(join(tmpdir(), "murage-announcements-repo-"));
  cpSync(new URL("example/", KIT), repo, { recursive: true });
});
const yml = () => join(repo, "announcements.yml");
const edit = (change: (text: string) => string) => writeFileSync(yml(), change(readFileSync(yml(), "utf8")));

describe("lint", () => {
  it("passes the example and previews it for the reviewer", () => {
    const result = lint(yml());
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.feed.items.map((item: { id: string }) => item.id)).toEqual(["search-mid-call", "flux-slow-2026-10-02"]);
    expect(result.feed.items[0].image).toBe("https://updates.ferroxlabs.com/murage/images/search-mid-call.webp");
    expect(result.summary).toContain("### Search while you talk");
  });

  it("fails on the copy rules, unknown fields and values, and missing or fake pictures", () => {
    const cases: Array<[(text: string) => string, RegExp]> = [
      [(text) => text.replace("Search while you talk", "Search — while you talk"), /dash/],
      [(text) => text.replace("from the live web.", "safe and sound."), /safe/],
      [(text) => text.replace("accent: blue", "accent: neon"), /accent/],
      [(text) => text.replace("layout: split", "layout: carousel"), /layout/],
      [(text) => text.replace("kind: info", "kind: info\n    colour: red"), /unknown field/],
      [(text) => text.replace("image: search-mid-call.webp", "image: missing.webp"), /does not exist/],
      [(text) => text.replace("url: https://ferroxlabs.com/murage", "url: http://ferroxlabs.com/murage"), /link/],
      [(text) => text.replace("target: settings-models", "target: open-anything"), /action/],
      [(text) => text.replace('endsAt: "2026-10-31T09:00:00Z"', 'endsAt: "2026-09-01T09:00:00Z"'), /endsAt/],
      [(text) => text.replace("id: flux-slow-2026-10-02", "id: search-mid-call"), /twice/],
    ];
    for (const [change, error] of cases) {
      cpSync(new URL("example/announcements.yml", KIT), yml());
      edit(change);
      const result = lint(yml());
      expect(result.ok, String(error)).toBe(false);
      expect(result.errors.join("\n"), String(error)).toMatch(error);
    }
    cpSync(new URL("example/announcements.yml", KIT), yml());
    writeFileSync(join(repo, "images", "search-mid-call.webp"), "<svg/>");
    expect(lint(yml()).errors.join("\n")).toMatch(/not a PNG, JPEG or WebP/);
  });

  it("keeps the editor schema's lists in step with the app's", () => {
    const schema = JSON.parse(readFileSync(new URL("announcements.schema.json", KIT), "utf8"));
    const fields = schema.properties.items.items.properties;
    expect(fields.kind.enum).toEqual([...ANNOUNCEMENT_KINDS]);
    expect(fields.layout.enum).toEqual([...ANNOUNCEMENT_LAYOUTS]);
    expect(fields.accent.enum).toEqual([...ANNOUNCEMENT_ACCENTS]);
    expect(fields.action.properties.target.enum).toEqual([...ANNOUNCEMENT_ACTIONS]);
    expect(fields.platforms.items.enum).toEqual([...ANNOUNCEMENT_PLATFORMS]);
  });
});

describe("sign", () => {
  it("writes bytes, signature and pictures that the harness accepts", () => {
    const key = pem();
    const out = join(repo, "out");
    const result = signFeed(yml(), out, { privateKeyPem: key, expectedPublicKey: rawPublicKey(key), issuedAt: "2026-09-25T10:00:00Z" });
    const bytes = readFileSync(join(out, "announcements.json"));
    const signature = readFileSync(join(out, "announcements.json.sig"), "utf8");
    expect(verifyAnnouncementSignature(bytes, signature, announcementKeys([result.publicKey]))).toBe(true);
    expect(verifyAnnouncementSignature(bytes, signature, announcementKeys([rawPublicKey(pem())]))).toBe(false);
    const checked = checkAnnouncementFeed(bytes);
    expect(checked.ok && checked.value.items.length).toBe(2);
    expect(checked.ok && checked.value.issuedAt).toBe("2026-09-25T10:00:00Z");
    expect(readFileSync(join(out, "images", "search-mid-call.webp")).equals(readFileSync(join(repo, "images", "search-mid-call.webp")))).toBe(true);
  });

  it("refuses the wrong key, a missing key and anything the lint fails", () => {
    const out = join(repo, "out");
    expect(() => signFeed(yml(), out, { privateKeyPem: pem(), expectedPublicKey: rawPublicKey(pem()) })).toThrow(/does not match/);
    expect(() => signFeed(yml(), out, { privateKeyPem: "" })).toThrow(/not set/);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    expect(() => signFeed(yml(), out, { privateKeyPem: rsa })).toThrow(/Ed25519/);
    edit((text) => text.replace("accent: blue", "accent: neon"));
    expect(() => signFeed(yml(), out, { privateKeyPem: pem() })).toThrow(/lint/);
  });
});

describe("the workflow template", () => {
  const workflow = parse(readFileSync(new URL("github/publish.yml", KIT), "utf8"));
  it("lints every pull request and signs only on main, behind the owner's approval", () => {
    expect(Object.keys(workflow.on)).toEqual(expect.arrayContaining(["pull_request", "push"]));
    expect(workflow.on.push.branches).toEqual(["main"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs.publish.needs).toBe("lint");
    expect(workflow.jobs.publish.environment).toBe("announcements-production");
    expect(workflow.jobs.publish.if).toContain("refs/heads/main");
  });
  it("gives secrets only to the approved job", () => {
    expect(JSON.stringify(workflow.jobs.lint)).not.toContain("secrets.");
    expect(JSON.stringify(workflow.jobs.publish)).toContain("secrets.ANNOUNCEMENTS_SIGNING_KEY");
  });
});
