// Warm presence (designs/WARM-W1-1022-presence.md P-SIG 1a, W-PR3 j): on a local install the phone's composer warm and typing beats
// reach the server through a door. Both doors stamp the launch proof from the one shared function, so the server counts them as the
// owner's input in Murage (companionAuthorized). The browser door forwards browserProofHeaders (browser.ts:2141), the device door
// deviceProofHeaders (proxy.ts:498).
import { describe, expect, it } from "vitest";
import { browserProofHeaders, deviceProofHeaders } from "../src/routes.ts";

const token = "c".repeat(64);
const proof = { "x-murage-companion-token": token };

describe("W-PR3j warm and typing beats carry the launch proof through both doors", () => {
  for (const [door, headers] of [["browser door", browserProofHeaders], ["device door", deviceProofHeaders]] as const) {
    it(`${door}: POST /api/bots/:id/warm and /typing are stamped; other methods and a missing token are not`, () => {
      expect(headers("POST", "/api/bots/bot-1/warm", token)).toEqual(proof); // W-PR3j:warm
      expect(headers("POST", "/api/bots/bot-1/typing", token)).toEqual(proof); // W-PR3j:typing
      expect(headers("GET", "/api/bots/bot-1/warm", token)).toEqual({});
      expect(headers("POST", "/api/bots/bot-1/warm", undefined)).toEqual({});
      expect(headers("POST", "/api/bots/bot-1/warm/extra", token)).toEqual({});
    });
  }
});
