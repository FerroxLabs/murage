// secret-scan: fixture (fake paths, policy test rows)
// S5-DATADIR-PATHS r4.1 D5e-ui: the Data folder row appears only while a root is "changed" and is gone after the confirm.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { t } from "@/lib/i18n";
import { changedDataRoots, DataFolderView, type DataRootRow } from "./DataFolderSettings";

const render = (rows: DataRootRow[], message?: string) => renderToStaticMarkup(createElement(DataFolderView, { rows, message, onUse: () => {} }));

describe("D5e-ui: Settings > Data folder", () => {
  it("shows nothing on an unchanged setup", () => {
    expect(render([{ name: "workspaces", state: "ok" }, { name: "providers", state: "absent" }])).toBe("");
    expect(render([{ name: "workspaces", state: "unavailable" }, { name: "providers", state: "refused" }])).toBe("");
  });
  it("shows one row per changed root, with the new location and Use this folder", () => {
    const html = render([{ name: "workspaces", state: "changed", candidate: "/Volumes/Work/ws" }, { name: "providers", state: "ok" }]);
    expect(html).toContain(t("settings.dataFolder.title"));
    expect(html).toContain(t("settings.dataFolder.row.workspaces"));
    expect(html).toContain("/Volumes/Work/ws");
    expect(html).toContain(t("settings.dataFolder.use"));
    expect(html).not.toContain(t("settings.dataFolder.row.providers"));
  });
  it("the row is gone once the confirm made the root ok", () => {
    expect(changedDataRoots([{ name: "workspaces", state: "changed", candidate: "/x" }])).toHaveLength(1);
    expect(render([{ name: "workspaces", state: "ok" }])).toBe("");
  });
  it("a changed root without a candidate shows no row (the GET sends one only in changed)", () => {
    expect(render([{ name: "providers", state: "changed" }])).toBe("");
  });
  it("the restart message shows when the confirm answered 409 restart", () => {
    expect(render([], t("settings.dataFolder.restart"))).toContain(t("settings.dataFolder.restart"));
  });
});
