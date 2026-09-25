import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RemoteSignOut } from "./RemoteSignOut";

const settings = readFileSync(new URL("./SettingsModal.tsx", import.meta.url), "utf8");

describe("the remote sign-out control", () => {
  it("starts as one clearly named button that does nothing until confirmed", () => {
    const html = renderToStaticMarkup(createElement(RemoteSignOut));
    expect(html).toContain("Sign out this device");
    expect(html).toContain('type="button"');
    expect(html).not.toContain("Signing out");
  });

  it("appears only on a confirmed remote surface, in General", () => {
    const general = settings.slice(settings.indexOf('{section === "general" && ('), settings.indexOf('{desktop === true && section === "backups"'));
    expect(general).toContain("{desktop === false && <RemoteSignOut />}");
  });
});
