import { expect, it } from "vitest";
import { relativeFileLink, workspaceFilePath } from "./workspace-links";

it("recognises a relative file link and nothing else", () => {
  expect(relativeFileLink("reports/weekly.md")).toBe("reports/weekly.md");
  expect(relativeFileLink("./reports/weekly.md")).toBe("reports/weekly.md");
  expect(relativeFileLink("reports/weekly%20notes.md")).toBe("reports/weekly notes.md");
  for (const href of ["https://example.com/a", "mailto:a@b.co", "/Users/me/a.md", "C:\\a.md", "file:///a.md", "#fn-1", "?q=1", "//evil.example/a", "", undefined]) {
    expect(relativeFileLink(href)).toBeNull();
  }
});
it("refuses a relative link that climbs out of the folder or hides", () => {
  for (const href of ["../secret.md", "reports/../../secret.md", ".env", "reports/.hidden/a.md", "a%2F..%2F..%2Fb", "bad%E0%A4.md"]) {
    expect(relativeFileLink(href), href).toBe("");
  }
});
it("joins a relative link onto the conversation's folder in that folder's own separators", () => {
  expect(workspaceFilePath("/Users/me/.murage/workspaces/b1/t1", "reports/weekly.md")).toBe("/Users/me/.murage/workspaces/b1/t1/reports/weekly.md");
  expect(workspaceFilePath("/Users/me/desk/", "a.md")).toBe("/Users/me/desk/a.md");
  expect(workspaceFilePath("C:\\Users\\Maus\\.murage\\workspaces\\b1", "reports/weekly.md")).toBe("C:\\Users\\Maus\\.murage\\workspaces\\b1\\reports\\weekly.md");
  expect(workspaceFilePath("", "a.md")).toBeNull();
  expect(workspaceFilePath("/ws", "../a.md")).toBeNull();
});
