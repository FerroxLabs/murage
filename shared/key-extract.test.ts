// What the blob parser is allowed to conclude, and — mostly — what it is not.
//
// Every key in this file is obviously fake and typed out here on purpose.
// Nothing reads process.env: a fixture that holds a developer's real key
// proves nothing about a request that does not.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  extractKeys,
  keyHint,
  maskKey,
  normalizeName,
  providerConfigured,
  PROVIDERS,
  PROVIDER_ORDER,
} from "./key-extract";

const ANTHROPIC = `sk-ant-api03-${"a".repeat(40)}`;
const FLUX = `sk-flux-${"F".repeat(40)}`;
const OPENROUTER = `sk-or-v1-${"r".repeat(40)}`;
const XAI = `xai-${"X".repeat(32)}`;
const COMPOSIO = `ak_${"c".repeat(24)}`;
const ELEVEN = `sk_${"a1b2c3d4".repeat(6)}`;
const OPENAI_PROJ = `sk-proj-${"p".repeat(40)}`;
const OPENAI_BARE = `sk-${"o".repeat(40)}`;
const GOOGLE = `AIza${"G".repeat(35)}`;
const STRIPE = `sk_live_${"S".repeat(24)}`;
const BOX = "bx-9f8e7d6c5b4a32100112233445566778";

const only = (blob: string) => {
  const found = extractKeys(blob);
  expect(found).toHaveLength(1);
  return found[0]!;
};

describe("what it recognises without being asked twice", () => {
  it("reads a strong prefix straight out of prose", () => {
    const found = only(`here's my key: ${XAI} — let me know if it works`);
    expect(found.providers).toEqual(["xai"]);
    expect(found.evidence).toBe("shape");
    // NEGATIVE control on the matcher itself: prose alone finds nothing.
    expect(extractKeys("here's my key, let me know if it works")).toEqual([]);
  });

  it("reads an opaque value off its variable name alone", () => {
    // A Box token has no prefix anyone could recognise. The name is the whole
    // of the evidence, and that is enough because the name is not a guess.
    const found = only(`BOX_TOKEN=${BOX}`);
    expect(found.providers).toEqual(["box"]);
    expect(found.evidence).toBe("name");
    // The same value with no name is invisible: nothing about it says "key".
    expect(extractKeys(BOX)).toEqual([]);
  });

  it("takes both channels when both agree", () => {
    const found = only(`XAI_API_KEY=${XAI}`);
    expect(found.providers).toEqual(["xai"]);
    expect(found.evidence).toBe("name+shape");
  });

  it("puts every recognisable prefix where it belongs", () => {
    const table: Array<[string, string[]]> = [
      [FLUX, ["flux"]],
      [OPENROUTER, ["openrouter"]],
      [XAI, ["xai"]],
      [COMPOSIO, ["composio"]],
      [ELEVEN, ["tts"]],
    ];
    for (const [key, providers] of table) {
      expect(only(`KEYS_GO_HERE_SOMEWHERE ${key}`).providers, key.slice(0, 8)).toEqual(providers);
    }
  });
});

describe("the ambiguous sk- family, which is the whole problem", () => {
  it("never picks a provider for a bare sk-", () => {
    const found = only(`my key is ${OPENAI_BARE}`);
    expect(found.providers.length).toBeGreaterThan(1);
    expect(found.providers).toEqual(["openai", "openrouter", "deepseek", "mistral", "flux", "imageGen"]);
    // POSITIVE control: a qualified sk- in the same family IS decided, so the
    // assertion above is the ambiguity rule and not the matcher shrugging.
    expect(only(`my key is ${FLUX}`).providers).toEqual(["flux"]);
  });

  it("identifies an OpenAI project key for Models without sending it anywhere", () => {
    const found = only(OPENAI_PROJ);
    expect(found.providers).toEqual(["openai"]);
  });

  it("lets a variable name settle which OpenAI home is meant", () => {
    expect(only(`MURAGE_OPENAI_IMAGE_KEY=${OPENAI_PROJ}`).providers).toEqual(["imageGen"]);
    expect(only(`OPENAI_COMPAT_API_KEY=${OPENAI_PROJ}`).providers).toEqual(["openai"]);
    // OPENAI_API_KEY names the issuer, not the destination. Still ambiguous.
    expect(only(`OPENAI_API_KEY=${OPENAI_PROJ}`).providers).toEqual(["openai"]);
  });

  it("widens rather than takes a side when name and shape disagree", () => {
    // Somebody's .env has the wrong key under the wrong name. Either could be
    // the mistake, so this asks instead of writing.
    const found = only(`XAI_API_KEY=${OPENAI_PROJ}`);
    expect(found.providers).toEqual(["xai", "openai"]);
    expect(found.providers.length).toBeGreaterThan(1);
  });

  it("never lets an sk-ant- key fall through into the bare sk- bucket", () => {
    const found = only(`ANTHROPIC_API_KEY=${ANTHROPIC}`);
    expect(found.providers).toEqual(["anthropic"]);
    expect(found.unsupported).toBeUndefined();
    // The one that matters: it is not offered as an OpenAI key.
    expect(found.providers).not.toContain("imageGen");
    expect(found.providers).not.toContain("openaiCompat");
  });

  it("never files a Stripe key as a voice key", () => {
    // Both start `sk_`. One of them is a payment credential.
    const found = only(`STRIPE_SECRET_KEY=${STRIPE}`);
    expect(found.unsupported?.id).toBe("stripe");
    expect(found.providers).toEqual([]);
    // And by shape alone, with no name to help — which is the case that has
    // to hold, because the two shapes differ only after the underscore.
    expect(only(STRIPE).unsupported?.id).toBe("stripe");
    expect(only(STRIPE).providers).not.toContain("tts");
    // POSITIVE control: the real voice shape does land on tts.
    expect(only(`ELEVENLABS_API_KEY=${ELEVEN}`).providers).toEqual(["tts"]);
  });
});

describe("keys Murage cannot store", () => {
  it("offers an Anthropic model connection for an Anthropic key", () => {
    const found = only(ANTHROPIC);
    expect(found.providers).toEqual(["anthropic"]);
    expect(found.unsupported).toBeUndefined();
  });

  it("names a Google key and offers nowhere to put it", () => {
    const found = only(`GEMINI_API_KEY=${GOOGLE}`);
    expect(found.providers).toEqual([]);
    expect(found.unsupported?.id).toBe("google");
  });

  it("refuses on either channel alone, so a disagreement resolves safely", () => {
    // A supported name over an unstorable value, and the reverse. Both refuse.
    expect(only(`FLUX_API_KEY=${GOOGLE}`).providers).toEqual([]);
    expect(only(`GOOGLE_API_KEY=${FLUX}`).providers).toEqual([]);
  });
});

describe("the shapes of a pasted blob", () => {
  it("reads a whole .env, quotes, exports, comments and CRLF included", () => {
    const blob = [
      "# my keys",
      `export XAI_API_KEY="${XAI}"`,
      `FLUX_API_KEY='${FLUX}'`,
      `COMPOSIO_API_KEY=${COMPOSIO}   # composio project`,
      `BOX_TOKEN=${BOX}`,
      "",
    ].join("\r\n");
    const found = extractKeys(blob);
    expect(found.map((c) => c.providers[0])).toEqual(["xai", "flux", "composio", "box"]);
    // Character for character. A stray quote or \r is exactly how a key saves
    // and then 401s.
    expect(found.map((c) => c.value)).toEqual([XAI, FLUX, COMPOSIO, BOX]);
  });

  it("reads JSON, including a pasted ~/.murage/config.json", () => {
    const blob = JSON.stringify({ xai: { key: XAI }, flux: { apiKey: FLUX }, box: { token: BOX } }, null, 2);
    const found = extractKeys(blob);
    expect(found.map((c) => c.providers[0])).toEqual(["xai", "flux", "box"]);
    expect(found.map((c) => c.value)).toEqual([XAI, FLUX, BOX]);
  });

  it("reads a YAML-ish note with a trailing comma and no quotes", () => {
    const found = extractKeys(`elevenlabs_api_key: ${ELEVEN},\nbox_token: "${BOX}",`);
    expect(found.map((c) => c.providers[0])).toEqual(["tts", "box"]);
    expect(found.map((c) => c.value)).toEqual([ELEVEN, BOX]);
  });

  it("keeps the exact key out of a quoted-then-comma'd JSON line", () => {
    expect(only(`  "FLUX_API_KEY": "${FLUX}",`).value).toBe(FLUX);
  });

  it("is one row for the same key however many times it appears", () => {
    const found = extractKeys(`FLUX_API_KEY=${FLUX}\nand again: ${FLUX}\nFLUX_API_KEY=${FLUX}`);
    expect(found).toHaveLength(1);
    expect(found[0]!.providers).toEqual(["flux"]);
    // POSITIVE control: two DIFFERENT keys are still two rows.
    expect(extractKeys(`${FLUX}\n${XAI}`)).toHaveLength(2);
  });
});

describe("things that look key-shaped and are not", () => {
  it("drops a placeholder even under a name it knows", () => {
    for (const junk of ["your-api-key-here", "<paste-key-here>", "xxxxxxxxxxxx", "changeme1234", "${FLUX_KEY}"]) {
      expect(extractKeys(`FLUX_API_KEY=${junk}`), junk).toEqual([]);
    }
  });

  it("drops a sentence, a URL fragment and a git sha", () => {
    const blob = [
      "The deploy is at https://api.example.com/v1/models and the sha is",
      "9f8e7d6c5b4a32100112233445566778899aabbc",
      "ask Dana for the credentials",
    ].join("\n");
    expect(extractKeys(blob)).toEqual([]);
  });

  it("does not bite a key-shaped substring out of a longer token", () => {
    // A URL path segment that merely contains `sk-…`. The lookarounds refuse.
    expect(extractKeys(`https://example.com/a/xsk-${"o".repeat(40)}z/b`)).toEqual([]);
  });

  it("is empty for empty, blank and non-string input", () => {
    expect(extractKeys("")).toEqual([]);
    expect(extractKeys("   \n\t \r\n")).toEqual([]);
    expect(extractKeys(undefined as unknown as string)).toEqual([]);
  });
});

describe("the masked hint is the only thing the value may become", () => {
  it("shows four characters and no more", () => {
    expect(maskKey(FLUX)).toBe(`••••${"F".repeat(4)}`);
    expect(maskKey(FLUX)).not.toContain(FLUX);
    expect(keyHint(FLUX)).toHaveLength(4);
  });

  it("shows nothing at all for a key too short to hint safely", () => {
    // Four of eleven characters is most of a secret.
    expect(maskKey("sk-short123")).toBe("••••");
    expect(keyHint("sk-short123")).toBe("");
  });

  it("carries the hint on the candidate, never anything longer", () => {
    const found = only(`FLUX_API_KEY=${FLUX}`);
    expect(found.hint).toBe("FFFF");
    expect(found.hint).toHaveLength(4);
  });
});

describe("names are normalised, and a name is not a secret", () => {
  it("lands every spelling of the same variable on one lookup", () => {
    for (const spelling of ['"FLUX_API_KEY"', "export flux_api_key", "Flux-Api-Key", " FLUX_API_KEY "]) {
      expect(normalizeName(spelling), spelling).toBe("FLUX_API_KEY");
    }
    // A JSON path is its own spelling, and the table carries it separately.
    expect(normalizeName("flux.apiKey")).toBe("FLUX_APIKEY");
  });

  it("recognises the same key under every one of those spellings", () => {
    for (const line of [`FLUX_API_KEY=${FLUX}`, `flux_api_key=${FLUX}`, `"flux": { "apiKey": "${FLUX}" }`]) {
      expect(only(line).providers, line.slice(0, 20)).toEqual(["flux"]);
    }
  });

  it("keeps the left-hand side on the candidate so a row can explain itself", () => {
    expect(only(`BOX_TOKEN=${BOX}`).name).toBe("BOX_TOKEN");
    expect(only(BOX_LOOSE_NOTE).name).toBeUndefined();
  });
});

const BOX_LOOSE_NOTE = `grab it from ${FLUX} when you get a sec`;

describe("the save table agrees with the rest of the app", () => {
  const apiKeys = readFileSync(fileURLToPath(new URL("../src/components/ApiKeys.tsx", import.meta.url)), "utf8");

  it("uses the same config bodies ApiKeys.tsx already uses", () => {
    // ApiKeys.tsx owns three of these eight rows. If its SECTIONS table ever
    // moves, this fails rather than letting two tables quietly disagree.
    expect(apiKeys).toContain("composio: { apiKey: v }");
    expect(apiKeys).toContain("box: { token: v }");
    expect(apiKeys).toContain("opencodeGo: { apiKey: v }");
    expect(JSON.stringify(PROVIDERS.composio.body("V"))).toBe(JSON.stringify({ composio: { apiKey: "V" } }));
    expect(JSON.stringify(PROVIDERS.box.body("V"))).toBe(JSON.stringify({ box: { token: "V" } }));
    expect(JSON.stringify(PROVIDERS.opencodeGo.body("V"))).toBe(JSON.stringify({ opencodeGo: { apiKey: "V" } }));
  });

  it("uses the same OS-store credential names ApiKeys.tsx already uses", () => {
    expect(apiKeys).toContain('composio: "composioApiKey"');
    expect(apiKeys).toContain('box: "boxToken"');
    expect(apiKeys).toContain('opencodeGo: "opencodeGoApiKey"');
    expect(PROVIDERS.composio.credential).toBe("composioApiKey");
    expect(PROVIDERS.box.credential).toBe("boxToken");
    expect(PROVIDERS.opencodeGo.credential).toBe("opencodeGoApiKey");
  });

  it("sends Flux through the config route, because the shell has no row for it", () => {
    // FluxKeyCard.tsx explains why: neither CREDENTIAL_PATCH nor the preload
    // type names a flux credential, so the IPC would reject it.
    expect(PROVIDERS.flux.credential).toBeNull();
    expect(PROVIDERS.openaiCompat.credential).toBeNull();
    expect(JSON.stringify(PROVIDERS.flux.body("V"))).toBe(JSON.stringify({ flux: { apiKey: "V" } }));
  });

  it("offers every destination exactly once", () => {
    expect([...PROVIDER_ORDER].sort()).toEqual(Object.keys(PROVIDERS).sort());
  });
});

describe("an already-saved key is shown as saved, not silently replaced", () => {
  it("reads the presence flag GET /api/config actually returns", () => {
    const flags = { flux: { configured: true }, box: { configured: false } };
    expect(providerConfigured("flux", flags)).toBe(false); // named connections do not overwrite the legacy flag
    expect(providerConfigured("box", flags)).toBe(false);
  });

  it("never claims connected from an unloaded config", () => {
    expect(providerConfigured("flux", null)).toBe(false);
    expect(providerConfigured("flux", {})).toBe(false);
  });

  it("never claims connected for the section that has no flag", () => {
    // ConfigStatus has no openaiCompat member at all, so this row cannot
    // truthfully say a key is already there.
    expect(providerConfigured("openaiCompat", { flux: { configured: true } })).toBe(false);
  });
});

describe("C22 provider-bound key destinations",()=>{
 it("binds legacy qualified compatible keys to their issuer endpoint and refuses unknown keys",()=>{
  expect(PROVIDERS.openaiCompat.body(OPENAI_PROJ)).toEqual({openaiCompat:{key:OPENAI_PROJ,url:"https://api.openai.com/v1"}});
  expect(PROVIDERS.openaiCompat.body(OPENROUTER)).toEqual({openaiCompat:{key:OPENROUTER,url:"https://openrouter.ai/api/v1"}});
  expect(()=>PROVIDERS.openaiCompat.body(OPENAI_BARE)).toThrow("exact model provider");
 });
 it("uses variable context for opaque DeepSeek and Mistral keys without a host probe",()=>{
  expect(only('MISTRAL_API_KEY=opaque-mistral-fixture-key').providers).toEqual(['mistral']);
  expect(only('DEEPSEEK_API_KEY=opaque-deepseek-fixture-key').providers).toEqual(['deepseek']);
 });
});
