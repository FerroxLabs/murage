// The native log must keep the shape of a session-setup message and lose the
// credential values. These tests use the exact shapes the drivers actually
// write — the ACP `env: [{name,value}]` wire form and the claude mcpServers
// object form — so a change to either shape breaks the test, not the secret.
import { describe, expect, it } from "vitest";

import { redactSecrets } from "./redact.ts";

const flat = (value: unknown) => JSON.stringify(value);

describe("redactSecrets", () => {
  it("masks the tokens in an ACP session/new, keeping the shape", () => {
    const sessionNew = {
      jsonrpc: "2.0",
      id: 3,
      method: "session/new",
      params: {
        cwd: "/Users/someone",
        mcpServers: [
          {
            name: "agents",
            command: "/usr/bin/node",
            args: ["/app/agents-proxy.js"],
            env: [
              { name: "MURAGE_BOT_ID", value: "bot-123" },
              { name: "MURAGE_COMMS_TOKEN", value: "s3cret-comms-token-value" },
            ],
          },
          {
            name: "computer",
            command: "/usr/bin/node",
            args: ["/app/computer-proxy.js"],
            env: [
              { name: "MURAGEBOX_BOX_ID", value: "box-9" },
              { name: "MURAGEBOX_BOX_TOKEN", value: "box_live_abcdefghijklmnop" },
            ],
          },
        ],
      },
    };

    const out = flat(redactSecrets(sessionNew));

    expect(out).not.toContain("s3cret-comms-token-value");
    expect(out).not.toContain("box_live_abcdefghijklmnop");
    // shape survives: still the same method, servers, names and non-secret env
    expect(out).toContain("session/new");
    expect(out).toContain("MURAGE_COMMS_TOKEN");
    expect(out).toContain("MURAGEBOX_BOX_TOKEN");
    expect(out).toContain("bot-123");
    expect(out).toContain("box-9");
    expect(out).toContain("/app/agents-proxy.js");
    // and it says how long the value was, which is what you debug with
    expect(out).toContain("«redacted 24 chars»");
  });

  it("masks a Composio key in an MCP header and an env object", () => {
    const config = {
      mcpServers: {
        composio: {
          type: "http",
          url: "https://app.composio.dev/tool_router/v3/trs_test/mcp",
          headers: { "x-api-key": "ak_live_supersecret" },
        },
        computer: { env: { ELECTRON_RUN_AS_NODE: "1", MURAGEBOX_BOX_TOKEN: "box_live_zzz" } },
      },
    };

    const out = flat(redactSecrets(config));
    expect(out).not.toContain("ak_live_supersecret");
    expect(out).not.toContain("box_live_zzz");
    expect(out).toContain("app.composio.dev");
    expect(out).toContain("ELECTRON_RUN_AS_NODE");
    expect(out).toContain('"1"'); // a non-secret value is untouched
  });

  it("still content-redacts an ACP env entry whose name is not secret-shaped", () => {
    // A credential can land under an ordinary-looking variable name (a
    // custom env var, a feature flag someone repurposed) — the ACP
    // {name,value} shortcut must not skip the content pass just because
    // the NAME alone doesn't scream "secret".
    const alpha = "abcdefghijklmnopqrstuvwxyz0123456789";
    const leaked = `sk-ant-api03-${alpha}`;
    const sessionNew = {
      params: {
        mcpServers: [
          {
            name: "custom",
            env: [
              { name: "SESSION_CONFIG", value: leaked },
              { name: "FEATURE_FLAG", value: "enabled" },
            ],
          },
        ],
      },
    };

    const out = flat(redactSecrets(sessionNew));
    expect(out).not.toContain(leaked);
    expect(out).toContain("SESSION_CONFIG");
    expect(out).toContain("FEATURE_FLAG");
    expect(out).toContain("enabled");
    expect(out).toMatch(/«redacted \d+ chars»/);
  });

  it("leaves ordinary protocol traffic alone", () => {
    const update = {
      method: "session/update",
      params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "the key to this bug" } } },
    };
    expect(redactSecrets(update)).toEqual(update);
  });

  it("does not mangle words that merely contain 'key'", () => {
    const msg = { keyboard: "cmd+k", monkey: "business", keys: "SECRET-LIST", hotkey: "ctrl" };
    const out = redactSecrets(msg) as Record<string, string>;
    expect(out.keyboard).toBe("cmd+k");
    expect(out.monkey).toBe("business");
    expect(out.hotkey).toBe("ctrl");
    // `keys` standing alone IS treated as a credential holder
    expect(out.keys).toContain("redacted");
  });

  it("survives cycles-adjacent depth and non-objects", () => {
    expect(redactSecrets("plain")).toBe("plain");
    expect(redactSecrets(null)).toBe(null);
    expect(redactSecrets(42)).toBe(42);
    let deep: Record<string, unknown> = { token: "deep-secret" };
    for (let i = 0; i < 20; i++) deep = { nested: deep };
    expect(() => redactSecrets(deep)).not.toThrow();
    // This case nested a secret 20 deep and only asserted "does not throw",
    // so it passed for as long as the depth budget handed the subtree back
    // unscrubbed. Asserting the actual point now.
    expect(JSON.stringify(redactSecrets(deep))).not.toContain("deep-secret");
  });

  // ── two fail-open holes, found by an external audit 2026-09-05 ──
  //
  // Both mattered for one reason: redactSecrets is the ONLY scrub between a
  // provider payload and ~/.murage/events/*.ndjson, which the code itself
  // calls "a file people paste into bug reports". A scrub that fails open on
  // an unusual shape is worse than no scrub, because it is trusted.

  it("scrubs every property of an array entry, not just its value", () => {
    // The {name, value} shortcut exists for ACP env entries, but it fired on
    // ANY array element with string name+value and spread the rest through
    // untouched.
    const json = JSON.stringify(redactSecrets([
      {
        name: "setting",
        value: "enabled",
        authorization: "Bearer 0123456789abcdef0123456789abcdef",
        metadata: { password: "example-password-123" },
      },
    ]));

    expect(json).not.toContain("0123456789abcdef0123456789abcdef");
    expect(json).not.toContain("example-password-123");
    expect(json).toContain("setting");
    expect(json).toContain("enabled");
  });

  it("fails closed past the depth budget instead of returning the subtree", () => {
    let payload: unknown = { token: "SECRET-0123456789abcdef" };
    for (let i = 0; i < 13; i++) payload = { nested: payload };

    expect(JSON.stringify(redactSecrets(payload))).not.toContain("SECRET-0123456789abcdef");
  });

  it("does not throw on a cycle past the depth budget", () => {
    // The fail-closed path serialises the subtree, and JSON.stringify throws
    // on a cycle. That is precisely where guessing is worst.
    const cyclic: Record<string, unknown> = { name: "root" };
    cyclic.self = cyclic;
    let payload: unknown = cyclic;
    for (let i = 0; i < 13; i++) payload = { nested: payload };

    expect(() => redactSecrets(payload)).not.toThrow();
  });
});

import { redactSecretsInText, TEXT_RULES } from "./redact.ts";

// Content-shaped secrets: what a bot's own reply, a tool title, or a
// permission card can carry. High precision on purpose — a false positive
// here rewrites real code in the transcript.
describe("redactSecretsInText", () => {
  it("masks known key prefixes wherever they appear", () => {
    // fixtures are assembled at runtime so no token-shaped literal sits in
    // the source — GitHub's push protection (rightly) flags those
    const alpha = "abcdefghijklmnopqrstuvwxyz0123456789";
    const cases: Array<[string, RegExp]> = [
      [`set ANTHROPIC_API_KEY=sk-ant-api03-${alpha}`, /sk-ant/],
      [`OpenAI: sk-proj-${alpha}ABCD`, /sk-proj/],
      [`gh token ${"gh" + "p_"}${alpha}`, /ghp_/],
      [`fine-grained ${"github_" + "pat_"}11ABCDEFG0${alpha}`, /github_pat_/],
      [`slack ${"xox" + "b-"}${"123456789012"}-${"1234567890123"}-${alpha.slice(0, 24)}`, /xoxb-/],
      [`aws ${"AKIA" + "IOSFODNN7EXAMPLE"} and more`, /IOSFODNN7EXAMPLE/],
      [`google ${"AIza" + "SyA-"}${alpha.slice(0, 32)}`, /AIza/],
      [`npm ${"npm" + "_"}${alpha}`, /npm_[a-z]/],
    ];
    for (const [input, leak] of cases) {
      const out = redactSecretsInText(input);
      expect(out, input).not.toMatch(leak);
      expect(out).toMatch(/«redacted \d+ chars»/);
    }
  });

  it("masks JWTs, PEM private key blocks, and bearer tokens", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    expect(redactSecretsInText(`token ${jwt} ok`)).toBe(`token «redacted ${jwt.length} chars» ok`);
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n-----END OPENSSH PRIVATE KEY-----";
    const out = redactSecretsInText(`here:\n${pem}\ndone`);
    expect(out).not.toContain("b3BlbnNzaC1r");
    expect(out).toMatch(/BEGIN OPENSSH PRIVATE KEY[\s\S]*«redacted \d+ chars»[\s\S]*END OPENSSH PRIVATE KEY/);
    expect(redactSecretsInText('curl -H "Authorization: Bearer abc.def-ghi_jkl123456789"')).toBe('curl -H "Authorization: Bearer «redacted 24 chars»"');
  });

  it("is byte-for-byte idempotent for PEM blocks", () => {
    const privateKeyBody = "c3VwZXItc2VjcmV0LXByaXZhdGUta2V5LWJ5dGVz";
    const pem = [
      "-----BEGIN PRIVATE KEY-----",
      privateKeyBody,
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const once = redactSecretsInText(`before\n${pem}\nafter`);

    expect(redactSecretsInText(once)).toBe(once);
    expect(once).toContain(`«redacted ${privateKeyBody.length} chars»`);
  });

  it("masks the value of a secret-shaped key=value or key: value, keeping the key", () => {
    expect(redactSecretsInText("export DATABASE_PASSWORD=hunter2hunter2")).toBe("export DATABASE_PASSWORD=«redacted 14 chars»");
    expect(redactSecretsInText('{"api_key": "abcd1234efgh5678"}')).toBe('{"api_key": "«redacted 16 chars»"}');
    expect(redactSecretsInText("client_secret: 'zzzz-yyyy-xxxx-1'")).toBe("client_secret: '«redacted 16 chars»'");
    expect(redactSecretsInText("--token=abc123def456")).toBe("--token=«redacted 12 chars»");
  });

  // `key` on its own is ordinary English ("the key: value pair"), so the
  // secret-name list rightly refuses it — but inside a query string it names a
  // credential as often as `api_key` does, and it is the spelling a
  // self-hosted engine's URL uses. Only the query position is treated as one.
  it("masks a bare key= parameter inside a query string, and only there", () => {
    expect(redactSecretsInText("dial 10.1.2.3:8443/v1?key=fake-secret-canary failed"))
      .toBe("dial 10.1.2.3:8443/v1?key=«redacted 18 chars» failed");
    expect(redactSecretsInText("GET /api/chat?model=fixture&key=fake-secret-canary&stream=true"))
      .toBe("GET /api/chat?model=fixture&key=«redacted 18 chars»&stream=true");
    expect(redactSecretsInText("the key: leave this prose alone")).toBe("the key: leave this prose alone");
    expect(redactSecretsInText("monkey=business as usual here")).toBe("monkey=business as usual here");
  });

  // A short key is still a key. The length floor the other rules use is there
  // to keep ordinary prose readable, but in query position the name has
  // already decided what the value is — and a self-hosted engine's key can be
  // any length at all. Everywhere `redactSecretsInText` is the only defence
  // (the native protocol log, tool.name, tool.errorDetails) a four-character
  // secret was riding through.
  it("masks a short query key, and still leaves prose that only looks like one", () => {
    expect(redactSecretsInText("dial localhost:11434/api/chat?key=s3cr failed"))
      .toBe("dial localhost:11434/api/chat?key=«redacted 4 chars» failed");
    expect(redactSecretsInText("GET /api/chat?api_key=ab&stream=true"))
      .toBe("GET /api/chat?api_key=«redacted 2 chars»&stream=true");
    expect(redactSecretsInText("GET /catalog?monkey=business&donkey=work"))
      .toBe("GET /catalog?monkey=business&donkey=work");
    expect(redactSecretsInText("the key: leave this prose alone too")).toBe("the key: leave this prose alone too");
  });

  // The same reasoning, for the sibling name. `token` IS in the secret-name
  // vocabulary, but `KEY_VALUE`'s eight-character floor means a short one
  // still rode through — and in query position the parameter's name has
  // already settled what the value is, whatever its length.
  it("masks a short query token, and still leaves prose that only looks like one", () => {
    expect(redactSecretsInText("dial localhost:11434/api/chat?token=s3cr failed"))
      .toBe("dial localhost:11434/api/chat?token=«redacted 4 chars» failed");
    expect(redactSecretsInText("GET /api/chat?access_token=ab&stream=true"))
      .toBe("GET /api/chat?access_token=«redacted 2 chars»&stream=true");
    expect(redactSecretsInText("GET /catalog?notoken=plain&brokenly=true"))
      .toBe("GET /catalog?notoken=plain&brokenly=true");
    expect(redactSecretsInText("the token: leave this prose alone")).toBe("the token: leave this prose alone");
  });

  // The third narrowing, and the last of the prose-eating class MU-R5-1 spent
  // a round on: `max_tokens=4096` is the commonest parameter in this product's
  // domain, and a bare number is not a credential — no provider issues one, and
  // masking it turns the most diagnostic part of an engine's own request line
  // into noise. The `keys?` sibling (`?max_keys=10`) goes the same way.
  it("leaves a purely numeric query value alone, whatever the parameter is called", () => {
    for (const line of [
      "POST /v1/chat?max_tokens=4096&stream=true failed with 400",
      "GET /v1/models?max_keys=10 returned nothing",
      "engine asked for ?tokens=0 and gave up",
    ]) expect(redactSecretsInText(line), line).toBe(line);
    // …and a value that is not just digits is a credential as before.
    expect(redactSecretsInText("POST /v1/chat?max_tokens=4096f&stream=true failed"))
      .toBe("POST /v1/chat?max_tokens=«redacted 5 chars»&stream=true failed");
  });

  it("leaves ordinary text, code, hashes and URLs alone", () => {
    for (const s of [
      "the keyboard shortcut is cmd-k",
      "git commit 3f2a9c1e7b4d5a6f8e9c0b1a2d3e4f5a6b7c8d9e",
      "https://example.com/path?page=2&sort=asc",
      "const token = await getToken(); // fetches later",
      "password: (leave blank to keep the current one)",
      "Bearer tokens are sent in the Authorization header",
      "sk-8", // too short to be a key
    ]) {
      expect(redactSecretsInText(s), s).toBe(s);
    }
  });

  it("is applied to string values inside redactSecrets too", () => {
    const out = redactSecrets({ command: "curl -H 'Authorization: Bearer abcdefghijklmnop'", note: "fine" }) as Record<string, string>;
    expect(out.command).toContain("«redacted");
    expect(out.note).toBe("fine");
  });

  // Bare xAI, Groq and Hugging Face keys, adapted from OpenMausBot PR #987
  // (Apache-2.0). Synthetic fixtures are assembled at runtime so no
  // token-shaped literal sits in the source.
  describe("bare xAI, Groq and Hugging Face keys", () => {
    const alnum = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const xai = (suffix: number) => `${"xa" + "i-"}${(alnum + "_-").repeat(3).slice(0, suffix)}`;
    const groq = (suffix: number) => `${"gs" + "k_"}${alnum.repeat(2).slice(0, suffix)}`;
    const hf = (suffix: number) => `${"h" + "f_"}${alnum.repeat(2).slice(0, suffix)}`;

    it("masks each key at its minimum length and when longer", () => {
      for (const key of [xai(20), xai(64), groq(40), groq(56), hf(30), hf(40)]) {
        const input = `The key is ${key} and nothing else.`;
        const out = redactSecretsInText(input);
        expect(out, key).not.toContain(key);
        expect(out).toBe(`The key is «redacted ${key.length} chars» and nothing else.`);
      }
    });

    it("masks several keys in one ordinary sentence", () => {
      const [a, b, c] = [xai(24), groq(40), hf(34)];
      const out = redactSecretsInText(`xAI ${a}, Groq ${b}; Hugging Face ${c}.`);
      expect(out).toBe(`xAI «redacted ${a.length} chars», Groq «redacted ${b.length} chars»; Hugging Face «redacted ${c.length} chars».`);
    });

    it("leaves shorter look-alike prefixes readable", () => {
      for (const s of [
        `short ${xai(19)} value`,
        `short ${groq(39)} value`,
        `short ${hf(29)} value`,
        "the xai-provider and gsk_setting and hf_hub_download helpers",
        `identifier my_${hf(30)} is not a bare key`,
      ]) {
        expect(redactSecretsInText(s), s).toBe(s);
      }
    });

    it("masks keys nested in structured payloads and is stable on repeat", () => {
      const payload = {
        params: { update: { content: { text: `use ${xai(30)} for grok` } } },
        env: [{ name: "FEATURE", value: `${groq(44)}` }],
        notes: [`hub token ${hf(36)}`],
      };
      const once = redactSecrets(payload);
      const json = JSON.stringify(once);
      expect(json).not.toContain(xai(30));
      expect(json).not.toContain(groq(44));
      expect(json).not.toContain(hf(36));
      expect(json).toContain("for grok");
      expect(json).toContain("FEATURE");
      expect(redactSecrets(once)).toEqual(once);
      const text = redactSecretsInText(`x ${xai(22)} y`);
      expect(redactSecretsInText(text)).toBe(text);
    });
  });

  it("is idempotent for structurally identified credentials", () => {
    const input = {
      apiKey: "abcdefgh12345678",
      env: [{ name: "MURAGE_COMMS_TOKEN", value: "abcdefghijklmnop" }],
    };
    const once = redactSecrets(input);

    expect(redactSecrets(once)).toEqual(once);
  });
});

// Round 10 of the ACP error-rendering work moved the engine-error cut AFTER
// redaction, so `redactSecretsInText` now sees an engine's error text whole —
// bounded only by ENGINE_FRAME_MAX_BYTES (32 MiB) — on the server's single
// event loop. Three of its rules were quadratic on inputs with a word boundary
// at every other character, because from each boundary the regex engine
// rescans the run to its end: KEY_VALUE's `[A-Za-z0-9_-]*_` name prefix
// (`a-a-a-…` + `api_key=`: 3.3 s at 64 KiB, 15 s at 128 KiB), the JWT rule's
// first segment (`eyJ-eyJ-…`: 3.1 s at 64 KiB) and PEM_BLOCK's lazy body when
// no END follows (`-----BEGIN PRIVATE KEY-----` repeated: 2.9 s at 1 MiB).
// Every other rule was linear at 1 MiB. These are clocks, one per shape.
describe("redactSecretsInText is linear in its input", () => {
  const KIB = 1024;
  const shapes: Array<[string, (n: number) => string]> = [
    ["hyphenated words ending in a key name", (n) => `${"a-".repeat(n / 2)}api_key=SYNTHETICVALUE`],
    ["hyphenated words ending in a key name with no value", (n) => `${"a-".repeat(n / 2)}_token x`],
    ["hyphenated JWT prefixes", (n) => "eyJ-".repeat(n / 4)],
    ["PEM headers with no footer", (n) => "-----BEGIN PRIVATE KEY-----".repeat(Math.ceil(n / 27)).slice(0, n)],
    ["underscored key names", (n) => `${"_token".repeat(n / 6)} x`],
    ["dotted labels", (n) => "a.".repeat(n / 2)],
    // Round 11: the shapes that made two of the ACP locators quadratic, run
    // through every rule here as well.
    ["a run of percent signs", (n) => "%".repeat(n)],
    ["a run of tildes", (n) => "~".repeat(n)],
    ["a run of plus signs", (n) => "+".repeat(n)],
    ["a URL-encoded blob", (n) => "%41%42%2F".repeat(Math.ceil(n / 9)).slice(0, n)],
    ["a host and path, then a run of question marks", (n) => `host.com/${"?".repeat(n)}`],
    ["query keys with no value", (n) => "?key=".repeat(n / 5)],
    ["bearer words", (n) => "Bearer ".repeat(n / 7)],
    ["colon-separated words", (n) => "a:b:".repeat(n / 4)],
    ["one unbroken word", (n) => "x".repeat(n)],
  ];
  // CPU time, not wall time: a clock that reads the wall fails on a loaded
  // machine for reasons that are not this code's, while a quadratic pass is
  // seconds of CPU whatever else is running.
  const cpuMs = (run: () => void) => {
    const started = process.cpuUsage();
    run();
    const used = process.cpuUsage(started);
    return (used.user + used.system) / 1000;
  };
  it.each([
    ["64 KiB", 64, 40],
    ["128 KiB", 128, 60],
    ["1 MiB", 1024, 500],
  ])("redacts %s of every hostile shape inside its budget", (_size, kib, budgetMs) => {
    for (const [shape, make] of shapes) {
      const text = make(kib * KIB);
      expect(cpuMs(() => redactSecretsInText(text)), shape).toBeLessThan(budgetMs);
    }
  });

  // Round 11's rule: no rule is called linear without a measured number for
  // THAT rule. Each rule of the function, alone, on every hostile shape.
  it.each([
    ["64 KiB", 64, 40],
    ["128 KiB", 128, 60],
    ["1 MiB", 1024, 500],
  ])("each rule on its own redacts %s of every hostile shape inside its budget", (_size, kib, budgetMs) => {
    for (const [shape, make] of shapes) {
      const text = make(kib * KIB);
      for (const [rule, run] of TEXT_RULES) expect(cpuMs(() => run(text)), `${rule}, ${shape}`).toBeLessThan(budgetMs);
    }
  });
});

// The linear forms must match EXACTLY what the rules they replace matched —
// same spans, same output — or "no cut before redaction" buys nothing. The
// oracle is the rule set as it stood before round 10 (base 0.1.53 plus the
// QUERY_KEY rule), copied verbatim, run as the same replacement sequence, and
// compared with the shipped function on a deterministic fuzz corpus built
// from the atoms the rules care about plus the shapes reasoned about by hand.
describe("redactSecretsInText's linear rules match the rules they replaced", () => {
  const mask = (value: string) => (/^«redacted \d+ chars»$/.test(value) ? value : `«redacted ${value.length} chars»`);
  const OLD_KEY_PREFIXES: RegExp[] = [
    /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g,
    /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
    /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    /\bxox[abposr]-[A-Za-z0-9-]{20,}/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\bAIza[0-9A-Za-z_-]{30,}/g,
    /\bnpm_[A-Za-z0-9]{20,}/g,
    /\bxai-[A-Za-z0-9_-]{20,}/g,
    /\bgsk_[A-Za-z0-9]{40,}/g,
    /\bhf_[A-Za-z0-9]{30,}/g,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  ];
  const OLD_BEARER = /(\bBearer\s+)([A-Za-z0-9._~+/=-]{12,})/g;
  const OLD_PEM_BLOCK = /(-----BEGIN [A-Z ]*PRIVATE KEY-----)([\s\S]*?)(-----END [A-Z ]*PRIVATE KEY-----)/g;
  const OLD_KEY_VALUE =
    /\b((?:[A-Za-z0-9_-]*_)?(?:api[_-]?key|apikey|secret|token|password|passwd|authorization|auth[_-]?token|access[_-]?key|private[_-]?key)s?)(["']?\s*[=:]\s*)(["']?)([A-Za-z0-9._~+/=-]{8,})\3/gi;
  const OLD_QUERY_KEY = /([?&](?:[A-Za-z0-9_-]*[_-])?(?:keys?|tokens?)=)([A-Za-z0-9._~+/=-]+)/gi;
  const NUMERIC_VALUE = /^\d+$/;
  function before(text: string): string {
    if (!text || text.length < 8) return text;
    let out = text;
    out = out.replace(OLD_PEM_BLOCK, (_m, open: string, body: string, close: string) => `${open}\n${mask(body.trim())}\n${close}`);
    for (const re of OLD_KEY_PREFIXES) out = out.replace(re, (m) => mask(m));
    out = out.replace(OLD_BEARER, (_m, lead: string, tok: string) => `${lead}${mask(tok)}`);
    out = out.replace(OLD_KEY_VALUE, (_m, key: string, sep: string, quote: string, value: string) => `${key}${sep}${quote}${mask(value)}${quote}`);
    out = out.replace(OLD_QUERY_KEY, (match: string, lead: string, value: string) => (NUMERIC_VALUE.test(value) ? match : `${lead}${mask(value)}`));
    return out;
  }

  const ATOMS = [
    "a", "b", "Z", "1", "-", "_", ".", ":", "/", "@", "?", "&", "=", "\"", "'", " ", "\n", "\t", "+", "~", "%", "://",
    "http", "eyJ", "eyJabcdefgh", "abcdefghij", "token", "api_key", "apikey", "secret", "auth-token", "access_key",
    "private_key", "passwd", "s", "sk-", "Bearer ", "-----BEGIN PRIVATE KEY-----", "-----END PRIVATE KEY-----",
    "-----BEGIN RSA PRIVATE KEY-----", "-----END EC PRIVATE KEY-----", "-----BEGIN ", "PRIVATE KEY-----",
    "«redacted 8 chars»", "xyz", "\u{1f642}", "É",
  ];
  // A fixed linear congruential generator: the corpus is the same on every run.
  let seed = 12345;
  const next = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const random = () => Array.from({ length: 1 + next(24) }, () => ATOMS[next(ATOMS.length)]).join("");

  it.each([
    ["a scheme after a hyphen", "-https://x"],
    ["a key name reached through hyphens", "foo-bar_token=abcdefghij"],
    ["a hyphenated prefix on an underscored name", "x-api_key=abcdefghij"],
    ["a name glued to a word", "xapi_key=abcdefghij"],
    ["a name after a hyphen", "-token=abcdefghij"],
    ["hyphens, then the name", "a-a-a-api_key=abcdefghij"],
    ["an underscored prefix", "a_b_c_token=abcdefghij"],
    ["a JSON pair", "\"api_key\": \"abcdefghij\""],
    ["mismatched quotes", "token=\"abcdefgh'"],
    ["a name that is not at the end of its word", "MY_API_KEY_FOO=abcdefghij"],
    ["an upper-case name", "X_API_KEY=abcdefghij"],
    ["a compound name", "x-auth_token=abcdefghij"],
    ["a JWT after hyphenated look-alikes", "eyJ-eyJabcdefgh.abcdefghij.abcdefghij"],
    ["a JWT between hyphens", "-eyJabcdefgh.abcdefghij.abcdefghij-x"],
    ["a JWT after an underscore", "_eyJabcdefgh.abcdefghij.abcdefghij"],
    ["two PEM headers before one footer", "-----BEGIN PRIVATE KEY-----a-----BEGIN PRIVATE KEY-----b-----END PRIVATE KEY-----"],
    ["a PEM header with no footer", "-----BEGIN PRIVATE KEY----- x"],
    ["two PEM blocks", "-----BEGIN PRIVATE KEY-----\n\nabc\n\n-----END PRIVATE KEY-----\n-----BEGIN EC PRIVATE KEY-----z-----END EC PRIVATE KEY-----"],
    ["a PEM header with a repeated label", "-----BEGIN PRIVATE KEY PRIVATE KEY-----q-----END PRIVATE KEY-----"],
  ])("agrees on %s", (_shape, text) => {
    expect(redactSecretsInText(text)).toBe(before(text));
  });

  it("agrees on 30 000 fuzzed shapes", () => {
    for (let i = 0; i < 30_000; i++) {
      const text = random();
      expect(redactSecretsInText(text), JSON.stringify(text)).toBe(before(text));
    }
  });
});
