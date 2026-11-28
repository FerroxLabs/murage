import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { endPairingNote } from "./telegram-end-pairing";

describe("endPairingNote", () => {
  it("names cancelled and maybe-delivered apart", () => {
    const note = endPairingNote({ pending: 2, uncertain: 1 });
    expect(note).toContain("2 waiting messages are cancelled and will not be sent.");
    expect(note).toContain("may or may not have been delivered");
    expect(note).toContain("1 earlier message may or may not have been delivered and will not be sent again.");
  });
  it("says nothing is waiting when nothing is", () => {
    expect(endPairingNote({ pending: 0, uncertain: 0 })).toBe("Nothing is waiting to be sent. A message being sent at that moment may or may not have been delivered.");
    expect(endPairingNote(null)).toContain("Nothing is waiting");
  });
  it("is shown on the Telegram card while a pairing is linked", () => {
    const src = readFileSync(fileURLToPath(new URL("../components/TelegramSettings.tsx", import.meta.url)), "utf8");
    expect(src).toContain('from "@/lib/telegram-end-pairing"');
    expect(src).toMatch(/linked && <p[^>]*>\{endPairingNote\(status\)\}<\/p>/);
  });
});
