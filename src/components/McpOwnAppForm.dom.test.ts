// @vitest-environment jsdom
import { act, createElement } from "react";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { cleanup, installDOMHarness, mount, settle } from "../testing/dom-harness";
import type { Message } from "@/state/store";
import { McpSignInCard } from "./McpSignInCard";

const resume = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("@/state/store", () => ({ api: resume }));
let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const message = { id: "m1", mcpSignIn: { name: "fixture", host: "mcp.example", bot: "Fixture", status: "required" } } as Message;

it("offers desktop own-app entry only after registration is refused, then signs in with the pinned address", async () => {
  const redirectUri = "http://127.0.0.1:4321/callback";
  const useOwnApp = vi.fn(async () => ({ ok: true, redirectUri, tokenHost: "auth.example" }));
  const signIn = vi.fn()
    .mockResolvedValueOnce({ ok: false, error: "no-registration", message: "Registration unavailable" })
    .mockResolvedValueOnce({ ok: true });
  vi.stubGlobal("muragebox", { mcpServers: { signIn, useOwnApp } });
  mount(createElement(McpSignInCard, { botId: "b1", threadId: "t1", message }));
  await settle();
  expect(document.querySelector("summary")).toBeNull();
  const button = () => Array.from(document.querySelectorAll("button")).find(item => item.textContent?.trim() === "Sign in")!;
  await act(async () => button().click());
  expect(document.querySelector("summary")?.textContent).toBe("Use my own app");
  const id = document.querySelector<HTMLInputElement>('input[name="clientId"]')!;
  const secret = document.querySelector<HTMLInputElement>('input[name="clientSecret"]')!;
  expect(secret.type).toBe("password");
  id.value = "fixture-client";
  secret.value = "fixture-value";
  await act(async () => { secret.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  expect(useOwnApp.mock.calls).toEqual([["fixture", { clientId: "fixture-client", clientSecret: "fixture-value" }]]);
  expect(secret.value).toBe("");
  expect(document.body.textContent).toContain(redirectUri);
  expect(resume).not.toHaveBeenCalled();
  await act(async () => button().click());
  expect(signIn).toHaveBeenCalledTimes(2);
  expect(resume).toHaveBeenCalledWith("/api/bots/b1/mcp-sign-in-cards/m1/resume", { method: "POST", body: '{"threadId":"t1"}' });
});
