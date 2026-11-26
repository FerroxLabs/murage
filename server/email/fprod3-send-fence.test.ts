// N5 (fprod3 r3b section 8): the one place a send leaves Murage refuses an archived bot's send, after the last await and before the request.
import { describe, expect, it } from "vitest";
import { FluxEmailClient, withEmailSpendBot } from "./flux-email-client.ts";
import { emailCredentialProvider } from "./email-secrets.ts";
import { createMemoryEmailSecrets } from "../testing/email-store-fixture.ts";
import { FakeFlux } from "../testing/fake-flux-email.ts";

function world(fenced: Set<string>) {
  const fake = new FakeFlux(), secrets = createMemoryEmailSecrets();
  secrets.setOwner({ token: "owner-token", keyId: "owner" });
  secrets.setBotKey("one", { token: "bot-one-token", keyId: "one" });
  secrets.setBotKey("two", { token: "bot-two-token", keyId: "two" });
  const client = new FluxEmailClient({ fetch: fake.fetch, apiBase: "https://api.flux.test", appBase: "https://app.flux.test", credentials: emailCredentialProvider(secrets, () => null), botFenced: id => fenced.has(id) });
  fake.on("POST", /\/messages$/, { status: 200, body: { status: "sent" } });
  fake.on("POST", /\/approve$/, { status: 200, body: { sends: [] } });
  return { fake, client };
}

describe("N5: an archived bot's email send never reaches Flux", () => {
  it("a bot-key send is refused locally with no request", async () => {
    const { fake, client } = world(new Set(["one"]));
    const outcome = await client.request({ kind: "bot", botId: "one", charge: true }, "POST", "/v1/inboxes/i/messages", { body: { text: "x" }, idempotencyKey: "k1" });
    expect(outcome).toMatchObject({ kind: "local_refused", code: "bot_archived" });
    expect(fake.requests).toHaveLength(0);
  });
  it("an owner approval billed to an archived bot (the spend-bot scope) is refused with no request", async () => {
    const { fake, client } = world(new Set(["one"]));
    const outcome = await withEmailSpendBot("one", () => client.approve("approval-one", ["held-one"], "owner"));
    expect(outcome).toMatchObject({ kind: "local_refused", code: "bot_archived" });
    expect(fake.requests).toHaveLength(0);
  });
  it("control: another bot's send and an unscoped owner call still go out", async () => {
    const { fake, client } = world(new Set(["one"]));
    const sent = await client.request({ kind: "bot", botId: "two", charge: true }, "POST", "/v1/inboxes/i/messages", { body: { text: "x" }, idempotencyKey: "k2" });
    expect(sent.kind).not.toBe("local_refused");
    await client.approve("outside", [], "owner");
    expect(fake.requests.length).toBe(2);
  });
});

describe("N6: the fenced card host writes nothing into an archived bot's thread", () => {
  it("rows, outcome, activity and notices are dropped for a fenced bot and pass through for another", async () => {
    const { fencedEmailHost } = await import("./cards.ts");
    const calls: string[] = [];
    const host = {
      botName: () => "Bot", threadExists: () => true, card: () => null,
      appendCard: () => { calls.push("append"); return "m1"; }, patchCard: (_t: string, _m: string, d: { options: string[]; answered?: string }) => { calls.push(`patch:${d.options.length}:${d.answered ?? ""}`); },
      outcome: () => { calls.push("outcome"); }, activity: () => { calls.push("activity"); }, notify: () => { calls.push("notify"); },
    };
    const wrapped = fencedEmailHost(host as never, id => id === "one", thread => (thread === "t1" ? "one" : "two"));
    expect(wrapped.threadExists("t1")).toBe(false);
    expect(wrapped.appendCard("t1", "one", {} as never)).toBe("");
    wrapped.outcome("t1", {} as never); wrapped.activity("t1", "x", true); wrapped.notify("email-status", "one", "t1", "b");
    wrapped.patchCard("t1", "m", { title: "t", options: ["Allow"] });
    expect(calls).toEqual(["patch:0:answered"]);
    calls.length = 0;
    expect(wrapped.threadExists("t2")).toBe(true);
    expect(wrapped.appendCard("t2", "two", {} as never)).toBe("m1");
    wrapped.outcome("t2", {} as never); wrapped.activity("t2", "x", true); wrapped.notify("email-status", "two", "t2", "b");
    expect(calls).toEqual(["append", "outcome", "activity", "notify"]);
  });
});
