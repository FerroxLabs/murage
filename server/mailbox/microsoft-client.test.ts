import { expect, it } from "vitest";
import { CLIENT_ID, MicrosoftClientConfig, TOKEN_ENDPOINT_RULING } from "./microsoft-client.ts";

const registered = "5b166d22-0966-4410-8a84-60c612abf731";

it("E29a is unavailable in the shipped configuration", () => {
  expect(new MicrosoftClientConfig().read()).toEqual({ available: false, reason: "no_registration" });
});

it.each(["", "  ", "undefined", "fixture"])("E29b refuses a malformed client identifier %j", clientId => {
  expect(new MicrosoftClientConfig(clientId).read()).toEqual({ available: false, reason: "no_registration" });
});

it("E29d requires both registration and the endpoint ruling", () => {
  expect(new MicrosoftClientConfig(registered, TOKEN_ENDPOINT_RULING).read()).toEqual({ available: true, clientId: registered });
});

it("E29e refuses a registered client without the endpoint ruling", () => {
  expect(new MicrosoftClientConfig(registered, "unruled").read()).toEqual({ available: false, reason: "endpoint_unruled" });
});

it("E29f records the endpoint ruling and leaves registration empty", () => {
  expect(TOKEN_ENDPOINT_RULING).toBe("Q-E14 approved");
  expect(CLIENT_ID).toBe("");
});
