import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FLUX_RESTART_FAILED, FLUX_RESTART_NEW_KEY, FLUX_RESTART_REMOVED_KEY, FluxRestartNotice, type FluxRestartNoticeProps } from "./FluxRestartNotice";

const render = (props: Partial<FluxRestartNoticeProps> = {}) => renderToStaticMarkup(createElement(FluxRestartNotice, { required: true, configured: true, ...props }));

describe("the Flux restart prompt after a key change", () => {
  it("asks for a restart with a Restart button after a key change on the desktop", () => {
    const html = render({ onRestart: async () => {} });
    expect(html).toContain(FLUX_RESTART_NEW_KEY);
    expect(html).toContain("Restart Murage to use the new key");
    expect(html).toContain('role="status"');
    expect(html).toMatch(/<button[^>]*>Restart Murage<\/button>/);
  });
  it("says the old key stops after a restart when the key was removed", () => {
    expect(render({ configured: false, onRestart: async () => {} })).toContain(FLUX_RESTART_REMOVED_KEY);
  });
  it("shows the sentence without a button where Murage cannot restart itself", () => {
    const html = render();
    expect(html).toContain(FLUX_RESTART_NEW_KEY);
    expect(html).not.toContain("<button");
  });
  it("shows nothing until a key changes", () => {
    expect(render({ required: false, onRestart: async () => {} })).toBe("");
  });
  it("uses plain words: no em dash, never 'safe'", () => {
    for (const line of [FLUX_RESTART_NEW_KEY, FLUX_RESTART_REMOVED_KEY, FLUX_RESTART_FAILED]) {
      expect(line).not.toMatch(/—/);
      expect(line.toLowerCase()).not.toContain("safe");
    }
  });
  it("Settings shows it from the server's restartRequired and wires the desktop restart", () => {
    const source = readFileSync(fileURLToPath(new URL("./ModelsSettings.tsx", import.meta.url)), "utf8");
    expect(source).toContain("<FluxRestartNotice required={Boolean(flux?.restartRequired)}");
    expect(source).toContain("window.muragebox?.restartForFluxKey");
  });
});
