// D8-4 item 6 (desktop and Android): no shipped string writes a bot's name in. The roster is read from source (bot-name-guard.ts), not typed here.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { androidStrings, botNamesWrittenIn, botRoster, REPO_ROOT } from "../../scripts/bot-name-guard.ts";

const roster = botRoster();
const PACKS = ["en", "de", "es", "fr", "hi", "ja", "pt-br", "zh"];
const RES = join(REPO_ROOT, "apps", "mobile", "android", "app", "src", "main", "res");

describe("the roster", () => {
  it("is read from the contract, the fixtures and the shipped library, and is not empty", () => {
    expect(roster.length).toBeGreaterThan(3);
  });
});

describe("desktop locale packs", () => {
  it("never write a roster bot name into any phone string, in any of the 8 languages", () => {
    for (const code of PACKS) {
      const pack = JSON.parse(readFileSync(join(REPO_ROOT, "src", "locales", `${code}.json`), "utf8")) as Record<string, string>;
      const phone = Object.fromEntries(Object.entries(pack).filter(([key]) => key.startsWith("phone.")));
      expect(Object.keys(phone).length, code).toBeGreaterThan(0);
      expect(botNamesWrittenIn(phone, roster), code).toEqual([]);
    }
  });
});

describe("Android string resources", () => {
  const dirs = readdirSync(RES).filter((d) => (d === "values" || d.startsWith("values-")) && existsSync(join(RES, d, "strings.xml")));
  it("never write a roster bot name into any string, in every shipped language", () => {
    expect(dirs.length).toBeGreaterThanOrEqual(8);
    for (const dir of dirs) {
      const strings = androidStrings(readFileSync(join(RES, dir, "strings.xml"), "utf8"));
      expect(Object.keys(strings).length, dir).toBeGreaterThan(0);
      expect(botNamesWrittenIn(strings, roster), dir).toEqual([]);
    }
  });
});

describe("the guard itself", () => {
  it("catches a roster name as a whole word, in the text or the key, and not inside another word", () => {
    const name = roster[0];
    expect(botNamesWrittenIn({ a: `Sent to ${name}.` }, roster)).toEqual([`a: ${name}`]);
    expect(botNamesWrittenIn({ [`send_to_${name}`.replace(/_/g, " ")]: "x" }, roster)).toHaveLength(1);
    expect(botNamesWrittenIn({ a: `${name}son` }, roster)).toEqual([]);
    expect(botNamesWrittenIn({ a: "Sent to {bot}." }, roster)).toEqual([]);
  });
  it("catches a name beside CJK text (the original ja and zh incidents) and not inside an ASCII word", () => {
    expect(botNamesWrittenIn({ ja: "あなたとしてSableに送信" }, ["Sable"])).toEqual(["ja: Sable"]);
    expect(botNamesWrittenIn({ zh: "已发送给Sable。" }, ["Sable"])).toEqual(["zh: Sable"]);
    expect(botNamesWrittenIn({ a: "Sablefish" }, ["Sable"])).toEqual([]);
    expect(botNamesWrittenIn({ a: "unSable" }, ["Sable"])).toEqual([]);
    expect(botNamesWrittenIn({ a: "Sable2" }, ["Sable"])).toEqual([]);
  });
  it("catches the incident: Sable written into the English hint and into an Android string", () => {
    expect(botNamesWrittenIn({ "phone.repairHint": "Pair this phone again so Sable can see your recent chat." }, roster)).toHaveLength(1);
    expect(botNamesWrittenIn(androidStrings('<string name="ask_x">Ask Sable</string>'), roster)).toHaveLength(1);
  });
});
