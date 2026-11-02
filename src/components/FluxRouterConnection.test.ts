import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FLUX_ACCOUNT_URL, FLUX_KEYRING_ENVIRONMENT_LINE, FLUX_KEYRING_NOTICE, FLUX_SIGNUP_URL, FluxRouterConnection, fluxActionError, serverSentence, type FluxRouterConnectionProps } from "./FluxRouterConnection";

const render = (props: Partial<FluxRouterConnectionProps> = {}) => renderToStaticMarkup(createElement(FluxRouterConnection, {
  configured: false,
  onSave: async () => {},
  onTest: async () => ({ modelCount: 2 }),
  onDisconnect: async () => {},
  ...props,
}));

describe("the single Flux Router connection card", () => {
  it("offers an empty password field and official signup when disconnected", () => {
    const html = render();
    expect(html).toContain('type="password"');
    expect(html).toContain('name="flux-router-key"');
    expect(html).toContain('>Connect</button>');
    expect(html).toContain(`href="${FLUX_SIGNUP_URL}"`);
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain('Test connection</button>');
  });
  it("shows presence only with explicit connected actions", () => {
    const html = render({ configured: true });
    expect(html).toContain("Connected · key saved");
    for (const action of ["Replace key", "Test connection", "Disconnect"]) expect(html).toContain(`>${action}</button>`);
    expect(html).not.toContain('<input');
    expect(html).toContain("It does not send a model request or verify that a model can answer.");
  });
  it("does not imply that an unresolved status is disconnected", () => {
    const html = render({ configured: null });
    expect(html).toContain("Loading connection…");
    expect(html).not.toContain("Not connected");
    expect(html).toContain('disabled=""');
  });
  it("requires a labelled choice for different saved keys", () => {
    const html = render({ configured: true, conflict: true, choices: [{ id: "work", label: "Work", enabled: true }, { id: "personal", label: "Personal", enabled: false }], onSelect: async () => {} });
    expect(html).toContain("Different Flux Router keys are saved");
    expect(html).toContain(">Use Work</button>");
    expect(html).toContain(">Use Personal (currently disabled)</button>");
    expect(html).not.toContain('<input');
    expect(html).not.toContain('>Replace key</button>');
    expect(html).not.toContain('>Test connection</button>');
  });
});

// ── the refusal reaches the person ─────────────────────────────────────
//
// Replacing a Flux Router key was refused with "The connection could not be
// changed. Refresh connections and try again." There was nothing to refresh:
// a bot was mid-task, and the server had said exactly that. A bare `catch`
// in this card threw the sentence away, so the owner was told to do the one
// thing that could not help. The card now shows what it was told.
describe("a refused Flux Router change says why", () => {
  /** The server's own words, from server/index.ts's `assertIdle`. */
  const BUSY = "Finish running work before changing Flux credentials.";
  /** The same refusal once it names the bot, which the server is gaining. */
  const BUSY_NAMED = "Finish running work before changing Flux credentials. Mel is still finishing a task in Inbox triage.";

  it("shows the server's sentence rather than the card's own guess", () => {
    for (const kind of ["save", "disconnect", "select"] as const) {
      expect(fluxActionError(kind, new Error(BUSY))).toBe(BUSY);
      expect(fluxActionError(kind, new Error(BUSY_NAMED))).toBe(BUSY_NAMED);
    }
    // The fallbacks are the old wording, and they are what a failure with
    // nothing worth reading still gets.
    expect(fluxActionError("save", new Error("Failed to fetch"))).toBe("The connection could not be changed. Refresh connections and try again.");
    expect(fluxActionError("select", new Error("Failed to fetch"))).toBe("The connection could not be selected. Refresh connections and try again.");
    expect(fluxActionError("test", new Error("Failed to fetch"))).toBe("Could not check the model catalog. Try again when Flux Router is available.");
  });

  it("survives the hop through ModelsSettings and the desktop bridge", async () => {
    // ModelsSettings.fluxChanged awaits the mutation and wraps nothing, so an
    // onSave built the way it builds one hands the rejection straight on.
    const onSave = async (key: string) => { if (key) throw Object.assign(new Error(BUSY), { status: 409 }); };
    await expect(onSave("flux-key")).rejects.toThrow(BUSY);
    await onSave("flux-key").catch((cause) => expect(fluxActionError("save", cause)).toBe(BUSY));
    // Electron wraps a main-process rejection in its channel text. The same
    // refusal must read the same whether it came over IPC or over fetch.
    expect(fluxActionError("save", new Error(`Error invoking remote method 'flux-connection:mutate': Error: ${BUSY_NAMED}`))).toBe(BUSY_NAMED);
  });

  it("keeps plumbing out of the card", () => {
    for (const machinery of [
      "BACKUP_BUSY",
      "409 Conflict",
      "500 Internal Server Error",
      "ECONNREFUSED 127.0.0.1:8799",
      "Cannot read properties of undefined (reading 'flux').",
      "Failed at /Users/someone/.murage/credentials.json.",
      "Fetch to https://fluxrouter.ai/v1/models failed.",
      "Error: <html><body>502</body></html>",
      "Something went wrong.\n    at mutate (store.tsx:1710:9)",
      "",
      "Short.",
    ]) expect(serverSentence(machinery), machinery).toBe("");
    expect(serverSentence(undefined)).toBe("");
    expect(serverSentence({ message: BUSY })).toBe("");
    // 400 characters is the ceiling: past that it is a dump, not a sentence.
    expect(serverSentence(new Error(`${"Very long. ".repeat(60)}`))).toBe("");
  });

  it("lets a long refusal wrap instead of stretching the card", () => {
    const card = readFileSync(fileURLToPath(new URL("./FluxRouterConnection.tsx", import.meta.url)), "utf8");
    expect(card).toContain('id="flux-router-error" role="alert" className="mt-2 break-words');
    // The defect itself: a catch that ignores what it caught. Both of this
    // card's failure paths hand the cause on, and neither is bare.
    expect(card).not.toMatch(/catch\s*\{/);
    expect(card).toMatch(/catch \(cause\) \{\n\s+setError\(fluxActionError\(kind, cause\)\);/);
    expect(card).toContain('catch (cause) { setError(fluxActionError("select", cause)); }');
  });
});

// THE CARD MUST NOT SELL WHAT THEY ALREADY BOUGHT.
//
// It said "Connected · key saved", offered Replace, Test and Disconnect, and
// underneath invited the owner to SIGN UP for the thing he was already paying
// for. He photographed it and asked why. The same door serves both people;
// only the sentence on it, and where it leads, changes.
describe("the outbound Flux Router link", () => {
  it("sends a connected owner to their own usage, not to the sign-up form", () => {
    const html = render({ configured: true });
    expect(html).toContain(`href="${FLUX_ACCOUNT_URL}"`);
    expect(html).toContain("Check your Flux Router usage");
    expect(html, "nobody with a saved key should be asked to sign up").not.toContain("Sign up for Flux Router");
    expect(html).not.toContain(`href="${FLUX_SIGNUP_URL}"`);
  });
  it("still sends somebody with no key to sign up", () => {
    const html = render({ configured: false });
    expect(html).toContain(`href="${FLUX_SIGNUP_URL}"`);
    expect(html).toContain("Sign up for Flux Router");
    expect(html).not.toContain(`href="${FLUX_ACCOUNT_URL}"`);
  });
  it("does not promise usage before the card knows whether a key is saved", () => {
    const html = render({ configured: null });
    expect(html).toContain("Loading connection…");
    expect(html).not.toContain("Check your Flux Router usage");
  });
  it("hides the sign-in button and its copy when no sign-in handler is given, keeping paste and signup", () => {
    const html = render();
    expect(html).not.toContain("Sign in with Flux Router");
    expect(html).not.toContain("Opens your browser");
    expect(html).toContain('name="flux-router-key"');
    expect(html).toContain(`href="${FLUX_SIGNUP_URL}"`);
  });
  it("shows the sign-in button when the handler is given", () => {
    const html = render({ onSignin: async () => {} });
    expect(html).toContain("Sign in with Flux Router");
    expect(html).toContain('name="flux-router-key"');
  });
});

describe("a computer with no unlocked keyring (LINUX-NOKEYRING-ENV-KEY)", () => {
  const ENV = { id: "legacy-flux-environment", label: "Existing environment key", enabled: true };
  const MAIN_REFUSAL = "Murage will not save this key yet. This computer has no unlocked keyring, so a saved key would only be hidden, not protected. "
    + "Install and unlock a keyring such as gnome-keyring or KWallet, then restart Murage and try again. "
    + "If you want keys kept as plain text on this computer anyway, start Murage with MURAGE_ALLOW_PLAINTEXT_SECRETS=1.";
  const text = (html: string) => html.replace(/&#x27;|&#39;/g, "'");
  it("says up front why no key can be saved, before anyone clicks, connected or not", () => {
    for (const configured of [false, true]) {
      const html = text(render({ configured, saveBlocked: "keyring" }));
      expect(html).toContain(FLUX_KEYRING_NOTICE);
      expect(html).not.toContain(FLUX_KEYRING_ENVIRONMENT_LINE);
    }
    // a key saved earlier still reads as connected, with Test
    expect(render({ configured: true, saveBlocked: "keyring" })).toContain(">Test connection</button>");
  });
  it("adds the environment line only when the place Murage started from holds a key", () => {
    const html = text(render({ configured: false, saveBlocked: "keyring", choices: [ENV] }));
    expect(html).toContain(FLUX_KEYRING_NOTICE);
    expect(html).toContain(FLUX_KEYRING_ENVIRONMENT_LINE);
    expect(html.indexOf(FLUX_KEYRING_NOTICE)).toBeLessThan(html.indexOf("Use Existing environment key"));
  });
  it("says nothing of a keyring when the desktop did not report one missing", () => {
    for (const saveBlocked of [undefined, "other" as never]) {
      const html = text(render({ configured: false, choices: [ENV], saveBlocked }));
      expect(html).not.toContain(FLUX_KEYRING_NOTICE);
      expect(html).not.toContain(FLUX_KEYRING_ENVIRONMENT_LINE);
    }
  });
  it("answers main's keyring refusal with the same plain sentence, bare or wrapped by Electron", () => {
    for (const kind of ["save", "disconnect", "select"] as const) {
      expect(fluxActionError(kind, new Error(MAIN_REFUSAL))).toBe(FLUX_KEYRING_NOTICE);
      expect(fluxActionError(kind, new Error(`Error invoking remote method 'flux-connection:mutate': Error: ${MAIN_REFUSAL}`))).toBe(FLUX_KEYRING_NOTICE);
    }
    // the plumbing filter is not loosened for anything else
    expect(serverSentence(new Error("Set MURAGE_SOMETHING_ELSE=1 to continue."))).toBe("");
  });
  it("is passed on by Models settings from the status it reads", () => {
    const source = readFileSync(fileURLToPath(new URL("./ModelsSettings.tsx", import.meta.url)), "utf8");
    expect(source).toMatch(/<FluxRouterConnection [^>]*saveBlocked=\{flux\?\.saveBlocked\}/);
  });
  it("uses plain words: no em dash, never safe", () => {
    for (const line of [FLUX_KEYRING_NOTICE, FLUX_KEYRING_ENVIRONMENT_LINE]) expect(line).not.toMatch(/\u2014|\bsafe\b/i);
  });
});
