// A capability with no path to it is not a capability.
//
// The server learned to let the workspace Chief of Staff stand up a team's
// first lead — and the tool she actually calls was never told. The schema
// declared no `lead` property, the proxy forwarded none, and the description
// still said the team "must already have a lead". So the first time she tried
// to create an inbox watcher she had exactly one qualifying team to put it
// in, chose it, and filed a mail-triage specialist under a founder-coaching
// lead. She reported it as odd. It was, and it was mine.
//
// Three files have to agree for this to work at all, and none of them imports
// another: the tool schema the model reads, the proxy that forwards the call,
// and the handler that acts on it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const proxy = readFileSync(fileURLToPath(new URL("./agents-proxy.ts", import.meta.url)), "utf8");
const server = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
const tool = proxy.slice(proxy.indexOf('name: "create_bot"'), proxy.indexOf('name: "request_credential"'));

describe("create_bot can be told to make a team lead", () => {
  it("declares the flag, or the model can never send it", () => {
    expect(tool).toContain("lead: {");
    expect(tool).toMatch(/lead: \{\s*type: "boolean"/);
  });

  it("tells the Chief the capability exists, in the description she reads", () => {
    // The old text said the team "must already have a lead", which described
    // a dead end and was the only thing she had to go on.
    expect(tool).not.toContain("that team must already have a lead");
    expect(tool).toContain("pass lead: true to create its lead first");
  });

  it("forwards it, rather than dropping it between the model and the route", () => {
    const call = proxy.slice(proxy.indexOf('if (name === "create_bot")'));
    const body = call.slice(0, call.indexOf("createdThisTurn += 1"));
    expect(body).toContain("args.lead === true");
    expect(body).toContain("...(lead ? { lead: true } : {})");
  });

  it("is still refused to anyone but the workspace Chief, and to an occupied team", () => {
    // The narrowness is the point: this must not become a way to mint a
    // second Chief of Staff, which is single-holder and refused even to a
    // person until the incumbent stands down.
    expect(server).toContain('return json(res, 403, { error: "only the workspace Chief of Staff can create a team lead" });');
    expect(server).toContain("wantsLead && lead");
    expect(server).toContain('store.setChiefOfStaff(safeBot.id, undefined, "section")');
  });
});
