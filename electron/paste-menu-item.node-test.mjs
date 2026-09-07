import assert from "node:assert/strict";
import { test } from "node:test";
import { pasteMenuItem } from "./paste-menu-item.mjs";

function fixture({ editable = true, canPaste = false, formats = [], image = false } = {}) {
  let calls = 0;
  const item = pasteMenuItem(
    { isEditable: editable, editFlags: { canPaste } },
    { availableFormats: () => formats, readImage: () => ({ isEmpty: () => !image }) },
    { paste: () => { calls++; } },
  );
  return { item, calls: () => calls };
}

test("ordinary text retains native Paste role without reading clipboard", () => {
  const item = pasteMenuItem(
    { isEditable: true, editFlags: { canPaste: true } },
    { availableFormats: () => { throw new Error("must not read"); } },
    {},
  );
  assert.deepEqual(item, { label: "Paste", enabled: true, role: "paste" });
});

test("native images use webContents.paste when Chromium disables Paste", () => {
  const f = fixture({ image: true });
  assert.equal(f.item.enabled, true);
  assert.equal(f.item.role, undefined);
  f.item.click();
  assert.equal(f.calls(), 1);
});

for (const format of ["public.file-url", "NSFilenamesPboardType", "text/uri-list"]) {
  test(`file clipboard ${format} enables editable Paste`, () => {
    const f = fixture({ formats: [format] });
    assert.equal(f.item.enabled, true);
    f.item.click();
    assert.equal(f.calls(), 1);
  });
}

test("images cannot enable Paste outside an editable field", () => {
  assert.equal(fixture({ editable: false, image: true }).item.enabled, false);
  assert.equal(fixture({ editable: false, canPaste: true }).item.enabled, false);
});

test("empty, unrelated and unreadable clipboards keep Paste disabled", () => {
  assert.equal(fixture().item.enabled, false);
  assert.equal(fixture({ formats: ["text/plain"] }).item.enabled, false);
  for (const failAt of ["formats", "image"]) {
    const item = pasteMenuItem(
      { isEditable: true, editFlags: { canPaste: false } },
      {
        availableFormats: () => { if (failAt === "formats") throw new Error("denied"); return []; },
        readImage: () => { throw new Error("denied"); },
      },
      {},
    );
    assert.equal(item.enabled, false);
    assert.equal(item.role, "paste");
  }
});
