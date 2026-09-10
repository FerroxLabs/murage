import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FLUX_SIGNUP_URL, FluxRouterConnection, type FluxRouterConnectionProps } from "./FluxRouterConnection";

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
