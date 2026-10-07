import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { COPY, originFromText, parseInvitation, parseTypedPairing, trimInput } from "./invitation";

const origins: { input: string; origin: string | null }[] = JSON.parse(
  readFileSync(new URL("../contract/origins.json", import.meta.url), "utf8"),
);

describe("what counts as a computer's address", () => {
  it.each(origins)("reads $input the way native does", ({ input, origin }) => {
    expect(originFromText(input)).toBe(origin);
  });
});

describe("the QR code", () => {
  it("reads the browser door's pairing link (spec §3.1)", () => {
    expect(parseInvitation("https://Mac.tailnet123.ts.net/enter#murage_pair_Ab-9_z")).toEqual({
      origin: "https://mac.tailnet123.ts.net",
      credential: "murage_pair_Ab-9_z",
    });
  });

  it("keeps a non-443 Serve port", () => {
    expect(parseInvitation("https://mac.tailnet123.ts.net:8444/enter#murage_pair_x")).toMatchObject({ origin: "https://mac.tailnet123.ts.net:8444" });
  });

  it("refuses anything that is not a pairing link, in words", () => {
    for (const text of ["hello", "https://example.com/", "https://mac.ts.net/enter", "https://mac.ts.net/enter#a&installId=x", "https://mac.ts.net/other#murage_pair_x"]) {
      expect(parseInvitation(text)).toEqual({ error: COPY.notACode });
    }
  });

  it("says an http link is not secure (spec §7)", () => {
    expect(parseInvitation("http://mac.tailnet123.ts.net/enter#murage_pair_x")).toEqual({ error: COPY.insecure, insecure: true });
  });

  it("refuses what native's PairingLink refuses", () => {
    for (const text of [
      "https://mac.tailnet123.ts.net/enter?x=1#murage_pair_x",
      "https://mac.tailnet123.ts.net/enter/#murage_pair_x",
      "https://100.101.102.103/enter#murage_pair_x",
      "https://mac.tailnet123.ts.net/enter#",
      `https://mac.tailnet123.ts.net/enter#${"a".repeat(513)}`,
      "http://example.com/",
    ]) {
      expect(parseInvitation(text)).toEqual({ error: COPY.notACode });
    }
  });

  it("trims pasted spaces and newlines first, the way native trims its input", () => {
    for (const text of ["  https://mac.tailnet123.ts.net/enter#murage_pair_x  ", "\nhttps://mac.tailnet123.ts.net/enter#murage_pair_x\r\n", "\t https://mac.tailnet123.ts.net/enter#murage_pair_x "]) {
      expect(parseInvitation(text)).toEqual({ origin: "https://mac.tailnet123.ts.net", credential: "murage_pair_x" });
    }
    expect(parseInvitation("\n http://mac.tailnet123.ts.net/enter#murage_pair_x \n")).toEqual({ error: COPY.insecure, insecure: true });
  });
});

describe("the launcher's trim", () => {
  it("is Swift's whitespacesAndNewlines: Unicode spaces, U+0009 to U+000D and U+0085, ends only", () => {
    expect(trimInput(" \t\n\u000b\f\r\u0085    a b\n")).toBe("a b");
    // U+FEFF is not whitespace to Swift or Java, though JavaScript's \s says it is.
    expect(trimInput("﻿a")).toBe("﻿a");
  });

  // contract/trim.json: Swift and Java trim the same (final review M4). U+200B,
  // U+FEFF and U+180E are format characters, not spaces, and stay put.
  const trims: { input: string; trimmed: string; origin: string | null }[] = JSON.parse(
    readFileSync(new URL("../contract/trim.json", import.meta.url), "utf8"),
  );
  it.each(trims)("trims $input to $trimmed, origin $origin", (c) => {
    expect(trimInput(c.input)).toBe(c.trimmed);
    expect(originFromText(trimInput(c.input))).toBe(c.origin);
  });
});

describe("typing the address and code", () => {
  it("accepts a bare MagicDNS name and six digits, spaced or not", () => {
    expect(parseTypedPairing(" mac.tailnet123.ts.net/ ", "123 456")).toEqual({ origin: "https://mac.tailnet123.ts.net", credential: "123456" });
    expect(parseTypedPairing("https://mac.tailnet123.ts.net:8444", "123-456")).toEqual({ origin: "https://mac.tailnet123.ts.net:8444", credential: "123456" });
  });

  it("explains each mistake", () => {
    expect(parseTypedPairing("", "123456")).toEqual({ error: COPY.badAddress });
    expect(parseTypedPairing("http://mac.tailnet123.ts.net", "123456")).toEqual({ error: COPY.insecure, insecure: true });
    expect(parseTypedPairing("mac.tailnet123.ts.net", "12345")).toEqual({ error: COPY.badCode });
    expect(parseTypedPairing("mac.tailnet123.ts.net", "abcdef")).toEqual({ error: COPY.badCode });
  });

  it("trims leading and trailing spaces and newlines from both fields", () => {
    const want = { origin: "https://mac.tailnet123.ts.net", credential: "123456" };
    expect(parseTypedPairing("\n  mac.tailnet123.ts.net  \n", "\n123456\n")).toEqual(want);
    expect(parseTypedPairing("\r\nhttps://mac.tailnet123.ts.net/\r\n", " \t123456\t ")).toEqual(want);
    expect(parseTypedPairing(" \n ", "123456")).toEqual({ error: COPY.badAddress });
    expect(parseTypedPairing("\nhttp://mac.tailnet123.ts.net\n", "123456")).toEqual({ error: COPY.insecure, insecure: true });
  });

  it("never turns a scheme on its own into a computer called https", () => {
    for (const address of ["https://", "https:", "https//mac.x", "http://", "ftp://", "HTTPS://", " https:// ", "https:/", "https:/mac.x", "http:", "https//", "\nhttps://\n"]) {
      expect(parseTypedPairing(address, "123456"), address).toEqual({ error: COPY.badAddress });
    }
    expect(parseTypedPairing("mac.x:8444", "123456")).toEqual({ origin: "https://mac.x:8444", credential: "123456" });
    expect(parseTypedPairing("mac.x/", "123456")).toEqual({ origin: "https://mac.x", credential: "123456" });
  });

  it("refuses an address native would refuse", () => {
    for (const address of ["100.101.102.103", "mac_x.tailnet123.ts.net", "user@mac.tailnet123.ts.net", "mac.tailnet123\n.ts.net", "ftp://mac.tailnet123.ts.net"]) {
      expect(parseTypedPairing(address, "123456")).toEqual({ error: COPY.badAddress });
    }
  });
});
