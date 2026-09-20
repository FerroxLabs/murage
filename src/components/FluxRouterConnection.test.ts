import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FLUX_SIGNUP_URL, FluxRouterConnection, fluxActionError, serverSentence, type FluxRouterConnectionProps } from "./FluxRouterConnection";

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
