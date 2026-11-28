// @vitest-environment jsdom
// M9 r3 ASTRA H1, closed on the screen (r7): a new Bedrock account was created and then bound with `{}`, which the server refuses
// (server/bedrock-bindings.ts needs a profile and region on the first bind). This renders the real section, fills the Add form and
// presses "Save and check", and reads the bind request that went over the wire.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as Array<{ path: string; method: string; body: unknown }>);
vi.mock("@/state/store", () => ({
  api: async (path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ path, method, body: init?.body ? JSON.parse(init.body) : undefined });
    if (path === "/api/claude-accounts" && method === "GET") return { accounts: [] };
    if (path === "/api/bedrock/profiles") return { profiles: ["personal"] };
    if (path === "/api/claude-accounts" && method === "POST") return { account: { instanceId: "claude-bedrock-fixture" } };
    if (path === "/api/claude-accounts/claude-bedrock-fixture/bedrock") return { line: "Claude on Bedrock is ready." };
    throw new Error(`unexpected ${method} ${path}`);
  },
}));

let root: Root | undefined;
let host: HTMLDivElement;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove(); calls.length = 0; });

const typeInto = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const press = async (button: Element | null | undefined) => { expect(button, "button is on screen").toBeTruthy(); await act(async () => { (button as HTMLButtonElement).click(); }); };
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };

it("R3-B1-UI Add Claude on Amazon Bedrock, then Save and check, binds the new account with the profile and region typed", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const { ClaudeAccountsSettings } = await import("./ClaudeAccountsSettings");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(createElement(ClaudeAccountsSettings, {})));
  await flush();
  await press([...host.querySelectorAll("button")].find((b) => b.textContent === "Add Claude on Amazon Bedrock"));
  const form = host.querySelector('form[aria-label="Add Claude on Amazon Bedrock"]')!;
  const [name, profile, region] = [...form.querySelectorAll("input")] as HTMLInputElement[];
  await typeInto(name, "Work Bedrock");
  await typeInto(profile, "personal");
  await typeInto(region, "eu-west-1");
  await press([...form.querySelectorAll("button")].find((b) => b.textContent === "Save and check"));
  await flush();
  const created = calls.find((c) => c.path === "/api/claude-accounts" && c.method === "POST");
  expect(created?.body, "the account is created with its Bedrock settings").toMatchObject({ displayName: "Work Bedrock", bedrock: { profile: "personal", region: "eu-west-1" } });
  const bind = calls.find((c) => c.path === "/api/claude-accounts/claude-bedrock-fixture/bedrock");
  expect(bind?.method, "the first bind is sent").toBe("POST"); // R3-B1-UI-sent
  expect(bind?.body, "R3-B1-UI the first bind names the profile and region (never {})").toEqual({ profile: "personal", region: "eu-west-1" }); // R3-B1-UI-wire
});
