// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// B4: clicking a project opens its chat, and a project remembers the tab the
// owner last left it on. GroupView remounts per channel (App.tsx keys it by
// group id), so the memory has to live outside the component.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import {
  PROJECT_TAB_KEY,
  forgetProjectTab,
  loadProjectTab,
  projectViewTab,
  resetProjectTabsForTest,
  saveProjectTab,
} from "./project-tab";

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value)),
  };
}

const throwing = {
  getItem: () => { throw new Error("blocked"); },
  setItem: () => { throw new Error("blocked"); },
  removeItem: () => { throw new Error("blocked"); },
} as unknown as Storage;

beforeEach(() => resetProjectTabsForTest());

describe("the project tab", () => {
  it("opens on Chat when nothing is remembered", () => {
    expect(loadProjectTab("g1", memoryStorage())).toBe("chat");
  });

  it("remembers the last tab per project, across a remount", () => {
    const storage = memoryStorage();
    saveProjectTab("g1", "overview", storage);
    saveProjectTab("g2", "chat", storage);
    resetProjectTabsForTest();
    expect(loadProjectTab("g1", storage)).toBe("overview");
    expect(loadProjectTab("g2", storage)).toBe("chat");
    expect(loadProjectTab("g3", storage)).toBe("chat");
  });

  it("still remembers for this session when storage refuses", () => {
    saveProjectTab("g1", "overview", throwing);
    expect(loadProjectTab("g1", throwing)).toBe("overview");
  });

  it("ignores a stored value it did not write", () => {
    const storage = memoryStorage();
    storage.setItem(PROJECT_TAB_KEY, JSON.stringify({ g1: "settings", g2: 4 }));
    expect(loadProjectTab("g1", storage)).toBe("chat");
    storage.setItem(PROJECT_TAB_KEY, "{not json");
    expect(loadProjectTab("g1", storage)).toBe("chat");
  });

  it("keeps the stored list bounded", () => {
    const storage = memoryStorage();
    for (let i = 0; i < 260; i += 1) saveProjectTab(`g${i}`, "overview", storage);
    const stored = JSON.parse(storage.getItem(PROJECT_TAB_KEY) ?? "{}") as Record<string, string>;
    expect(Object.keys(stored).length).toBeLessThanOrEqual(200);
    // the newest survive
    expect(stored.g259).toBe("overview");
  });

  it("forgets a deleted project", () => {
    const storage = memoryStorage();
    saveProjectTab("g1", "overview", storage);
    forgetProjectTab("g1", storage);
    resetProjectTabsForTest();
    expect(loadProjectTab("g1", storage)).toBe("chat");
  });

  it("a project still being set up shows its setup, whatever was remembered", () => {
    // The setup card lives in the chat pane and the tabs are hidden while it
    // shows, so a remembered Overview would strand the owner on a page with no
    // way to reach setup or the composer.
    expect(projectViewTab({ remembered: "overview", setupPending: true })).toBe("chat");
    expect(projectViewTab({ remembered: "overview", setupPending: false })).toBe("overview");
    expect(projectViewTab({ remembered: "chat", setupPending: false })).toBe("chat");
  });
});

describe("GroupView uses the remembered tab", () => {
  const source = readFileSync(new URL("../components/GroupView.tsx", import.meta.url), "utf8");

  it("starts from the remembered tab, never a hard-coded Overview", () => {
    expect(source).not.toContain('useState<"overview" | "chat">("overview")');
    expect(source).not.toContain('setProjectTab("overview")');
    expect(source).toMatch(/useState<ProjectTab>\(\(\) => loadProjectTab\(group\.id\)\)/);
  });

  it("saves every tab change for this project", () => {
    expect(source).toMatch(/const chooseProjectTab = useCallback\(\(tab: ProjectTab\) => \{\s*setProjectTab\(tab\);\s*saveProjectTab\(group\.id, tab\);/);
    expect(source).not.toMatch(/onClick=\{\(\) => setProjectTab\(/);
    expect(source).not.toMatch(/onOpenChat=\{\(\) => setProjectTab\(/);
  });

  it("decides what shows through projectViewTab", () => {
    expect(source).toContain("const shownProjectTab = projectViewTab({ remembered: projectTab, setupPending });");
    expect(source).toContain('const showChat = activeTab === "chat";');
  });

  it("making a channel a project shows the home page it just promised", () => {
    // "Say what the work is for and it gets a home page." The dialog's words.
    const dialog = source.slice(source.indexOf("function MakeProjectDialog("), source.indexOf("export function GroupView("));
    expect(dialog).toMatch(/patch: \{ channelProject: \{ goal: trimmed \} \} \}\);\s*onMade\(\);/);
    expect(source).toContain('onMade={() => chooseProjectTab("overview")}');
  });
});

describe("deleting a project", () => {
  it("drops its remembered tab with its drafts", () => {
    const store = readFileSync(new URL("../state/store.tsx", import.meta.url), "utf8");
    expect(store).toMatch(/case "deleteGroup":\s*forgetDeletedDrafts\(\{ groupId: action\.groupId \}\);\s*forgetProjectTab\(action\.groupId\);/);
  });
});

it("remembers all six project views after a reload", () => {
  for (const tab of ["chat", "board", "overview", "files", "memory", "activity"] as const) {
    const storage = memoryStorage(); resetProjectTabsForTest();
    saveProjectTab("g", tab, storage); resetProjectTabsForTest();
    expect(loadProjectTab("g", storage)).toBe(tab);
  }
});
