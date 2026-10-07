import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { en } from "@/locales";
import { allLocalePacks } from "@/locales/testing";
import { PASTE_MESSAGES, PASTE_NOTE_TEMPLATES, parsePaste } from "../../shared/mcp-paste";
import { inspectInput, pasteNoteText, type MergedDraft, type ProbeView } from "@/lib/mcp-add-flow";
import { draftView, newCardState, pasteHoldsSecret, withProbe, type DraftCardState, type DraftView } from "@/lib/mcp-card-view";
import { McpDraftCard, type McpDraftCardActions } from "./McpDraftCard";
import { commandDetails, parseMcpArguments, parseMcpEnvironment, savedKeysAtRisk } from "./McpServersPanel";

describe("MCP server form", () => {
  it("uses one explicit argument per line", () => {
    expect(parseMcpArguments("-y\n  @scope/server  \n\n--read-only")).toEqual([
      "-y",
      "@scope/server",
      "--read-only",
    ]);
  });

  it("preserves write-only saved values without putting them back in the form", () => {
    expect(parseMcpEnvironment("TOKEN=\nMODE=read-only", ["TOKEN"])).toEqual({
      ok: true,
      env: { TOKEN: true, MODE: "read-only" },
    });
  });

  it("rejects malformed and duplicate environment names", () => {
    expect(parseMcpEnvironment("NOT A KEY=value")).toEqual({
      ok: false,
      error: "“NOT A KEY” is not a valid environment variable.",
    });
    expect(parseMcpEnvironment("TOKEN=one\nTOKEN=two")).toEqual({
      ok: false,
      error: "“TOKEN” is listed more than once.",
    });
  });
});

// ── the add-a-server cards (MCP-LINK T12) ───────────────────────────────

afterEach(() => { vi.unstubAllGlobals(); return setLocale("en"); });

const NOOP: McpDraftCardActions = {
  onName() {}, onField() {}, onKeyValue() {}, onMoveArgSecrets() {}, onHeader() {}, onSignIn() {}, onCancelSignIn() {}, onUseKey() {}, onUseSignIn() {},
  onSaveKey() {}, onConfirmLocal() {}, onBack() {}, onUseMoved() {}, onAdd() {}, onTurnOn() {}, onDone() {}, onKeepWaiting() {}, onRetry() {},
};

function draftOf(input: string, probe?: ProbeView): MergedDraft {
  const parsed = parsePaste(input);
  if (!parsed.ok) throw new Error(parsed.message);
  return { ...parsed.drafts[0]!, ...(probe ? { probe } : {}) };
}
const card = (state: DraftCardState) => renderToStaticMarkup(createElement(McpDraftCard, { state, actions: NOOP }));
describe("a secret in a pasted command's arguments (review L5)", () => {
  it("warns, hides the value, and offers to move it to an environment value", () => {
    const state = newCardState(draftOf("npx -y @x/server --api-key abc123secret"));
    const html = card(state);
    expect(html).toContain('data-view="ready"');
    expect(html).toContain("This command has a secret in its arguments");
    expect(html).toContain("Move to an environment value");
    expect(html).toContain("API_KEY");
    expect(html).not.toContain("abc123secret");
  });
  it("shows no warning for a command without a secret", () => {
    expect(card(newCardState(draftOf("npx -y @x/server --port 8080")))).not.toContain("Move to an environment value");
  });
});

const comfy = (probe: ProbeView, more: Partial<DraftCardState> = {}): DraftCardState => ({ ...newCardState(draftOf("https://cloud.comfy.org/mcp", probe)), ...more });

const COMFY_401: ProbeView = { ok: false, reason: "needs-sign-in", error: "x", signIn: { host: "cloud.comfy.org" }, apiKey: { headerHint: "x-api-key" } };
const TOOLS = Array.from({ length: 12 }, (_, i) => ({ name: `tool_${i}` }));

describe("editing a command that holds saved values (review L6)", () => {
  const saved = { kind: "stdio", name: "gh", command: "npx", args: ["-y", "@x/a"], envKeys: ["GITHUB_TOKEN"], enabled: true } as never;
  it("asks about the kept values only when the command or arguments change", () => {
    expect(savedKeysAtRisk(saved, "node", ["-y", "@x/a"], { GITHUB_TOKEN: true })).toEqual(["GITHUB_TOKEN"]);
    expect(savedKeysAtRisk(saved, "npx", ["-y", "@x/b"], { GITHUB_TOKEN: true })).toEqual(["GITHUB_TOKEN"]);
    expect(savedKeysAtRisk(saved, "npx", ["-y", "@x/a"], { GITHUB_TOKEN: true }), "same command").toEqual([]);
    expect(savedKeysAtRisk(saved, "node", [], { GITHUB_TOKEN: "typed-now" }), "a value typed now is not a kept one").toEqual([]);
    expect(savedKeysAtRisk(undefined, "node", [], { A: true })).toEqual([]);
  });
});

describe("every card state", () => {
  it("shows both ways in for the ComfyUI paste: sign in, and an API key instead", () => {
    const html = card(comfy(COMFY_401));
    expect(html).toContain('data-view="sign-in"');
    expect(html).toContain("cloud.comfy.org uses sign-in.");
    expect(html).toContain("Sign in to cloud.comfy.org");
    expect(html).toContain("Use an API key instead");
    // the key field is not drawn until the owner asks for it
    expect(html).not.toContain("Paste your API key");
  });

  it("leads a key card with the field, the header chooser and the ComfyUI header pre-picked", () => {
    const state = comfy(COMFY_401, { useKey: true });
    expect(state.header).toBe("x-api-key");
    const html = card(state);
    expect(html).toContain('data-view="key"');
    expect(html).toContain("This server needs an API key.");
    expect(html).toContain('type="password"');
    expect(html).toContain("Sent as");
    expect(html).toContain("Authorization: Bearer");
    expect(html).toContain("X-API-Key");
    expect(html).toContain("Another header…");
    expect(html).toContain("Save and test");
    expect(html).toContain("Use sign-in instead");
  });

  it("names a rejected key, and a sign-in that ended", () => {
    expect(card(comfy({ ok: false, reason: "key-rejected", error: "x", apiKey: { headerHint: "authorization" } }, { tested: true }))).toContain("cloud.comfy.org did not accept this API key. Check it and try again.");
    const ended = card(comfy({ ok: false, reason: "sign-in-ended", error: "x", signIn: { host: "cloud.comfy.org" } }, { tested: true }));
    expect(ended).toContain("Your sign-in to cloud.comfy.org has ended. Sign in again.");
    expect(ended).toContain("Sign in again");
  });

  it("asks before a link that points at this computer or the local network", () => {
    const here = card(newCardState(draftOf("http://127.0.0.1:8811/mcp", { ok: false, reason: "local-confirm", error: "x", needs: "this-computer" })));
    expect(here).toContain("This link points to this computer. Only continue if you started this server yourself.");
    expect(here).toContain("Continue");
    expect(here).toContain("Go back");
    const lan = card(newCardState(draftOf("http://192.168.1.20:9000/mcp", { ok: false, reason: "local-confirm", error: "x", needs: "local-network" })));
    expect(lan).toContain("This link points to a device on your local network (192.168.1.20:9000). Only continue if you know what runs there.");
  });

  it("offers the new link when a server has moved, unless the new link holds a secret", () => {
    const moved = card(comfy({ ok: false, reason: "moved", error: "x", suggestUrl: "https://new.example.com/mcp" }));
    expect(moved).toContain("This server has moved to https://new.example.com/mcp. Use the new link?");
    expect(moved).toContain("Use the new link");
    const secret = card(comfy({ ok: false, reason: "moved", error: "x", suggestUrl: "https://new.example.com/mcp/s/%2A%2A%2A", suggestHoldsSecret: true }));
    expect(secret).not.toContain("Use the new link</button>");
    expect(secret).toContain("Paste the new link above to use it.");
  });

  it("says each reason in plain words, with the host", () => {
    const expected: Array<[string, string]> = [
      ["not-found", "Murage could not find cloud.comfy.org. Check the link and your internet connection."],
      ["unreachable", "cloud.comfy.org did not accept the connection. Check the link, or try again in a moment."],
      ["wrong-address", "Nothing at this address answers as an MCP server. Check that you copied the whole link."],
      ["https-required", "Murage connects to servers on the internet over https only. Check the link starts with https://."],
      ["address-changed", "This name now points somewhere else than when you added it. Remove it and add it again if that is expected."],
      ["server-error", "cloud.comfy.org had a problem answering. Try again in a moment."],
      ["no-answer", "The server did not answer in time. Try again in a moment."],
      ["blocked-address", "Murage does not connect to that kind of address."],
    ];
    for (const [reason, sentence] of expected) {
      const html = card(comfy({ ok: false, reason: reason as never, error: "raw server text" }));
      expect(html, reason).toContain('data-view="error"');
      expect(html, reason).toContain(sentence);
      expect(html, reason).not.toContain("raw server text");
      expect(html, reason).toContain("Try again");
    }
  });

  it("fills a snippet's labelled fields, keeps the pasted secret only in its password field, and out of the draft", () => {
    const token = "ghp_PASTED_SECRET_VALUE_123";
    const state = newCardState(draftOf(JSON.stringify({ mcpServers: { github: { command: "npx", args: ["-y", "@x/github"], env: { GITHUB_TOKEN: token, LOG_LEVEL: "info" } } } })));
    // the value moved from the draft to the typed values: nothing else in the state holds it
    expect(JSON.stringify(state.draft)).not.toContain(token);
    expect(Object.values(state.typed)).toEqual([token]);
    const html = card(state);
    expect(html).toContain('data-view="ready"');
    expect(html).toContain("GITHUB_TOKEN");
    expect(html).toContain("Secret values are hidden as you type.");
    expect(html).toContain("LOG_LEVEL");
    expect(html).toContain('value="info"');
    // only a password input may carry it
    expect(html.replace(/<input[^>]*type="password"[^>]*>/g, "")).not.toContain(token);
    expect(html.match(/type="password"/g)).toHaveLength(1);
    expect(html).toContain("Add and test");
  });

  it("does not move a placeholder, and knows when a paste held a secret", () => {
    const placeholder = newCardState(draftOf('{"mcpServers":{"x":{"command":"npx","args":["-y","x"],"env":{"API_KEY":"<your key here>"}}}}'));
    expect(placeholder.typed).toEqual({});
    expect(pasteHoldsSecret([placeholder.draft])).toBe(false);
    expect(pasteHoldsSecret([draftOf("NOTES_TOKEN=abc123 npx -y @x/notes")])).toBe(true);
    expect(pasteHoldsSecret([draftOf("https://hooks.example.com/mcp/s/AbCdEfGhIjKlMnOpQrStUvWxYz0123/run")])).toBe(true);
    expect(pasteHoldsSecret([draftOf("https://cloud.comfy.org/mcp")])).toBe(false);
  });

  it("empties the paste box when the secret is in a command's arguments too (review L5)", () => {
    expect(pasteHoldsSecret([draftOf("npx -y @x/notes --api-key abc123")])).toBe(true);
    expect(pasteHoldsSecret([draftOf("npx -y @x/notes --port 8080")])).toBe(false);
  });

  it("a saved command server's details never draw a credential held in its arguments (review L5)", () => {
    expect(commandDetails({ command: "npx", args: ["-y", "@x/notes", "--api-key", "abc123"] })).toBe("npx -y @x/notes --api-key ••••");
    expect(commandDetails({ command: "npx", args: ["-y", "@x/notes", "--port", "8080"] })).toBe("npx -y @x/notes --port 8080");
  });

  it("picks the header from a probe that arrives later, the same way as the first", () => {
    const first = newCardState(draftOf("http://127.0.0.1:8811/mcp", { ok: false, reason: "local-confirm", error: "x", needs: "this-computer" }));
    expect(first.header).toBe("authorization");
    expect(withProbe(COMFY_401)).toMatchObject({ header: "x-api-key", probe: COMFY_401 });
    expect(withProbe(undefined).header).toBe("authorization");
  });

  it("shows a link that holds a key masked, never whole", () => {
    const link = "https://hooks.example.com/mcp/s/AbCdEfGhIjKlMnOpQrStUvWxYz0123/run";
    const html = card(newCardState(draftOf(link)));
    expect(html).not.toContain("AbCdEfGhIjKlMnOpQrStUvWxYz0123");
  });

  it("keeps a snippet's Bearer prefix fixed and asks for the token only", () => {
    const html = card(newCardState(draftOf('{"mcpServers":{"gh":{"url":"https://api.githubcopilot.com/mcp/","headers":{"Authorization":"Bearer ${input:github_token}"}}}}')));
    expect(html).toContain('data-view="ready"');
    expect(html).toContain('type="password"');
    expect(html).not.toContain("Bearer ${input");
  });

  it("stages the wait for a first run, and offers Keep waiting when it is still installing", () => {
    const base = newCardState(draftOf("npx -y @scope/server"));
    expect(card({ ...base, busy: "installing", elapsed: 1 })).toContain("Starting the server…");
    expect(card({ ...base, busy: "installing", elapsed: 12 })).toContain("Setting it up for the first time. This can take a minute or two.");
    expect(card({ ...base, busy: "installing", elapsed: 75 })).toContain("Still setting up. Big servers take longer the first time.");
    const still = card({ ...base, tested: true, probe: { ok: false, reason: "still-installing", error: "x" } });
    expect(still).toContain("It is still installing.");
    expect(still).toContain("Keep waiting");
  });

  it("waits for the browser sign-in with a Cancel, and says so", () => {
    const html = card(comfy(COMFY_401, { busy: "signing" }));
    expect(html).toContain("Finish signing in in your browser. This window updates when you are done.");
    expect(html).toContain("Cancel");
  });

  it("reports a connection with its tool count, and turns on only when asked", () => {
    const html = card(comfy({ ok: true, tools: TOOLS }, { tested: true, savedName: "comfy" }));
    expect(html).toContain('data-view="connected"');
    expect(html).toContain("Connected. 12 tools found.");
    expect(html).toContain("See the tools");
    expect(html).toContain("Turn on for my bots");
    expect(html).toContain("Done");
    expect(card(comfy({ ok: true, tools: [{ name: "one" }] }, { tested: true }))).toContain("Connected. 1 tool found.");
    expect(card(comfy({ ok: true, tools: [] }, { tested: true }))).toContain("Connected. The server lists no tools yet.");
    expect(card(comfy({ ok: true, tools: TOOLS }, { tested: true, enabled: true, name: "comfy" }))).toContain("comfy is on.");
  });

  it("derives one view per state", () => {
    const seen = new Set<DraftView>();
    const cases: DraftCardState[] = [
      comfy(COMFY_401), comfy(COMFY_401, { useKey: true }), comfy(COMFY_401, { busy: "signing" }), comfy(COMFY_401, { busy: "saving" }), comfy(COMFY_401, { busy: "testing" }),
      comfy({ ok: true, tools: [] }), comfy({ ok: true, tools: [] }, { tested: true }), comfy({ ok: true, tools: [] }, { enabled: true }),
      comfy({ ok: false, reason: "local-confirm", error: "x", needs: "this-computer" }), comfy({ ok: false, reason: "moved", error: "x" }),
      comfy({ ok: false, reason: "not-found", error: "x" }), comfy({ ok: false, reason: "needs-key", error: "x" }),
      newCardState(draftOf("npx -y @s/x")), { ...newCardState(draftOf("npx -y @s/x")), busy: "installing" },
    ];
    for (const state of cases) seen.add(draftView(state));
    expect([...seen].sort()).toEqual(["added", "connected", "error", "installing", "key", "local-confirm", "moved", "ready", "saving", "sign-in", "signing", "testing"]);
  });

  it("cannot start a sign-in without the desktop app, and says why", () => {
    vi.stubGlobal("window", { muragebox: {} });
    const html = card(comfy(COMFY_401));
    expect(html).toContain("Sign in needs the Murage desktop app.");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Sign in to cloud\.comfy\.org/);
  });

  it("puts a tooltip where a person may wonder", () => {
    const html = card(comfy(COMFY_401));
    expect(html).toContain('title="Opens your browser so you can sign in to cloud.comfy.org.');
    expect(card(comfy(COMFY_401, { useKey: true }))).toContain('title="The name of the header the server reads your key from.');
  });

  it("follows the chosen language", async () => {
    await setLocale("de");
    const html = card(comfy(COMFY_401));
    expect(html).toContain("cloud.comfy.org verwendet eine Anmeldung.");
    expect(html).toContain("Bei cloud.comfy.org anmelden");
    expect(html).toContain("Stattdessen einen API-Schlüssel verwenden");
    expect(html).not.toContain("Use an API key instead");
  });
});

describe("the Name field sits like every other field of the form", () => {
  it("its label is a line of its own above the input, with the form's label gap", () => {
    for (const html of [card(comfy(COMFY_401)), card(comfy(COMFY_401, { useKey: true }))]) {
      expect(html).toMatch(/<label class="[^"]*\bblock\b[^"]*"><span class="block text-\[12px\] font-medium text-ink-secondary">Name<\/span><input[^>]*class="[^"]*\bmt-1\.5\b/);
    }
  });
});

describe("the paste parser's sentences are translated where they are shown (display-side keys)", () => {
  it("every refusal and every note has a catalogue key whose English is the parser's own sentence", () => {
    const catalogue = en as Record<string, string>;
    for (const [reason, message] of Object.entries(PASTE_MESSAGES)) expect([reason, catalogue[`mcp.paste.fail.${reason}`]]).toEqual([reason, message]);
    for (const [key, template] of Object.entries(PASTE_NOTE_TEMPLATES)) expect([key, catalogue[`mcp.paste.note.${key}`]]).toEqual([key, template]);
  });

  it("English reads exactly as before", async () => {
    const refused = await inspectInput({ api: async () => { throw new Error("a refusal sends nothing"); } }, '[mcp_servers.x]\ncommand = "npx"');
    expect(refused).toEqual({ ok: false, message: PASTE_MESSAGES.toml });
    expect(pasteNoteText({ key: "ignoredKey", entry: "a", field: "local" })).toBe('Ignored "local" in a.');
  });

  it("a refused paste and the snippet notes read in the chosen language", async () => {
    const de = (await allLocalePacks()).de as Record<string, string>;
    await setLocale("de");
    const refused = await inspectInput({ api: async () => { throw new Error("a refusal sends nothing"); } }, '[mcp_servers.x]\ncommand = "npx"');
    expect(refused).toEqual({ ok: false, message: de["mcp.paste.fail.toml"] });
    expect(de["mcp.paste.fail.toml"]).not.toBe(PASTE_MESSAGES.toml);
    // a refusal the harness gives back is shown by its reason, in German too
    const paste = '{"mcpServers":{"a":{"command":"x","local":"this-computer"},"b":{"nothing":1}}}';
    const local = parsePaste(paste);
    if (!local.ok) throw new Error("expected drafts");
    const answered = await inspectInput({ api: async () => ({ ok: true, source: "json", drafts: [{ name: "a" }], notes: local.notes, noteKeys: local.noteKeys }) }, paste);
    expect(answered.ok && answered.notes).toEqual([
      de["mcp.paste.note.ignoredKey"]!.replace("{field}", "local").replace("{entry}", "a"),
      de["mcp.paste.note.skippedNothing"]!.replace("{entry}", "b"),
    ]);
    const harnessRefusal = await inspectInput({ api: async () => ({ ok: false, reason: "too-many", message: PASTE_MESSAGES["too-many"] }) }, "npx -y pkg");
    expect(harnessRefusal).toEqual({ ok: false, message: de["mcp.paste.fail.too-many"] });
  });
});

describe("mcp.* copy", () => {
  const keys = Object.keys(en).filter((key) => key.startsWith("mcp."));

  it("follows the house rules in English and in every pack", async () => {
    expect(keys.length).toBeGreaterThan(100);
    for (const key of keys) {
      const value = en[key as keyof typeof en];
      expect(value, key).not.toMatch(/—|–|composio|price/i);
      expect(value, key).not.toMatch(/\b(safe|safely|safety|unsafe)\b/i);
    }
    const packs = await allLocalePacks();
    for (const [code, pack] of Object.entries(packs)) {
      for (const key of keys) {
        const value = (pack as Record<string, string | undefined>)[key];
        expect(value, `${code} ${key}`).toBeTruthy();
        expect(value, `${code} ${key}`).not.toMatch(/—|–|composio/i);
        const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
        expect(placeholders(value!), `${code} ${key} placeholders`).toBe(placeholders(en[key as keyof typeof en]));
      }
    }
  });

  it("is not written into the panel's source as loose text a person reads", () => {
    for (const file of ["McpServersPanel.tsx", "McpAddSection.tsx", "McpDraftCard.tsx", "../lib/mcp-card-view.ts"]) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      expect(source, file).not.toMatch(/—|\bComposio\b/);
      expect(source, file).not.toMatch(/"[^"\n]*\b(safe|safely|safety|unsafe)\b[^"\n]*"/i);
    }
  });
});
