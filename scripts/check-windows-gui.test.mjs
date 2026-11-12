import { expect, it } from "vitest";
import { assertWindowsGui } from "./check-windows-gui.mjs";

function image(magic, subsystem) {
  const bytes = Buffer.alloc(512);
  bytes.writeUInt16LE(0x5a4d); bytes.writeUInt32LE(128, 0x3c);
  bytes.writeUInt32LE(0x4550, 128); bytes.writeUInt16LE(240, 148);
  bytes.writeUInt16LE(magic, 152); bytes.writeUInt16LE(subsystem, 220);
  return bytes;
}
it.each([0x10b, 0x20b])("requires GUI subsystem in PE optional header %s", magic => {
  expect(assertWindowsGui(image(magic, 2))).toEqual({ subsystem: 2, name: "WINDOWS_GUI" });
  expect(() => assertWindowsGui(image(magic, 3))).toThrow("WINDOWS_GUI_SUBSYSTEM_REQUIRED");
});
it("refuses missing, malformed and truncated PE headers", () => {
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(512), image(0, 2), image(0x20b, 2).subarray(0, 221)]) {
    expect(() => assertWindowsGui(bytes)).toThrow("WINDOWS_GUI_SUBSYSTEM_REQUIRED");
  }
});
