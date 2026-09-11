// F4-T5: Open in app / Show in folder on the Workspace view.
//
// The renderer suite runs in node with no DOM, so this pins what a row and
// the file view offer: native buttons only when the desktop bridge is
// present, only for a regular file with a server revision, and named after
// the file for assistive technology. Clicking them, the browser warning and
// the on-disk revalidation are proved in electron/workspace-file-actions
// .node-test.mjs; the Finder behaviour itself is a macOS gate.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { FileRevision, WorkspaceEntry } from "../../shared/workspace-files";
import { WorkspaceFiles, WorkspaceRow } from "./WorkspaceFiles";

const source = readFileSync(fileURLToPath(new URL("./WorkspaceFiles.tsx", import.meta.url)), "utf8");
const file: WorkspaceEntry = { name: "report.html", relativePath: "outputs/report.html", kind: "file", state: "local", bytes: 42, modifiedAt: 1, revision: "r1.abcdefghij" as FileRevision };
const noop = () => {};
const row = (entry: WorkspaceEntry, onNative?: (action: "open" | "reveal") => void) =>
  renderToStaticMarkup(createElement(WorkspaceRow, { entry, showPath: false, busy: false, onOpen: noop, onView: noop, onSave: noop, onNative }));

describe("native buttons on a workspace row", () => {
  it("offers Open in app and Show in folder for a regular file when the desktop bridge is present", () => {
    const markup = row(file, noop);
    expect(markup).toContain('data-native-action="open"');
    expect(markup).toContain('aria-label="Open report.html in its app"');
    expect(markup).toContain(">Open in app</button>");
    expect(markup).toContain('data-native-action="reveal"');
    expect(markup).toContain('aria-label="Show report.html in its folder"');
    expect(markup).toContain(">Show in folder</button>");
  });

  it("shows nothing native in a plain browser", () => {
    const markup = row(file);
    expect(markup).not.toContain("data-native-action");
    expect(markup).toContain(">View current</button>");
  });

  it("offers nothing native for a link, a missing file, a folder or an unverifiable file", () => {
    for (const entry of [
      { ...file, kind: "link" as const, state: "unsupported" as const, revision: undefined },
      { ...file, state: "missing" as const, revision: undefined },
      { ...file, state: "unsupported" as const, revision: undefined },
      { name: "outputs", relativePath: "outputs", kind: "directory" as const, state: "local" as const },
    ]) expect(row(entry, noop), entry.relativePath).not.toContain("data-native-action");
  });

  it("disables the native buttons while another action runs", () => {
    const markup = renderToStaticMarkup(createElement(WorkspaceRow, { entry: file, showPath: false, busy: true, onOpen: noop, onView: noop, onSave: noop, onNative: noop }));
    expect(markup.match(/data-native-action="[a-z]+" class="[^"]*" disabled=""/g)).toHaveLength(2);
  });
});

describe("wiring the desktop proof depends on", () => {
  it("defaults to the desktop bridge and stays silent without it", () => {
    expect(source).toContain("onNativeAction = workspaceNativeAction()");
    expect(source).toContain("onNative={onNativeAction ? action => void native(entry, action) : undefined}");
    expect(source).toContain("{onNativeAction && canSaveEntry(viewing.entry) && <NativeButtons");
  });

  it("names the conversation and the entry, never a path on disk, and shows the refusal as is", () => {
    expect(source).toMatch(/const native = \(entry: WorkspaceEntry, action: "open" \| "reveal"\) => act\(async current => \{\s*if \(!scope \|\| !onNativeAction\) return;\s*try \{ await onNativeAction\(scope, entry, action\); \}/);
    expect(source).toContain('setError(reasonText(reason, t("filesWorkspace.nativeError")))');
    // No renderer-side confirm: the main process shows the browser warning
    // with fixed wording, so a file name can never become dialog text.
    expect(source).not.toContain("window.confirm");
  });

  it("renders without a scope in a browser, where there is no bridge", () => {
    const markup = renderToStaticMarkup(createElement(WorkspaceFiles, { scope: null, scopeLabel: "", refreshToken: 0, renderHtml: value => value, onSaved: noop }));
    expect(markup).toContain("Choose a bot above to browse the folder Murage resolved for its conversation.");
    expect(markup).not.toContain("data-native-action");
  });
});
