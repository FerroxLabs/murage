// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { callPhoneTool, TOOLS } from "./phone-proxy.ts";

function fixture(keyboard = "com.android.adbkeyboard/.AdbIME", connection = "ControlledInputConnection{active=true}") {
  const commands: string[][] = [];
  const adb = async (args: string[]) => {
    commands.push(args);
    if (args[0] === "devices") return Buffer.from("List of devices attached\nUSB_FIXTURE device model:Fixture\n");
    const command = args.slice(3);
    if (command[0] === "settings") return Buffer.from(keyboard);
    if (command[0] === "dumpsys") return Buffer.from(`mServedInputConnection=${connection}`);
    return Buffer.from("");
  };
  return { commands, adb, shell: () => commands.filter(c => c[2] === "shell").map(c => c.slice(3)) };
}
const text = (result: Awaited<ReturnType<typeof callPhoneTool>>) => result.content.filter(c => c.type === "text").map(c => c.text).join("\n");

describe("Android phone input", () => {
  it("keeps the ASCII command unchanged", async () => {
    const f = fixture("another.keyboard/.IME");
    expect(text(await callPhoneTool("type_text", { text: "hello world_1.,@-" }, f.adb))).toContain("Typed text");
    expect(f.shell()).toEqual([["input", "text", "hello%sworld_1.,@-"]]);
  });
  it("gives a plain setup message for Unicode without ADBKeyBoard", async () => {
    const f = fixture("another.keyboard/.IME");
    const result = await callPhoneTool("type_text", { text: "你好 😀" }, f.adb);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Set up ADBKeyBoard");
    expect(f.shell()).toEqual([["settings", "get", "secure", "default_input_method"]]);
  });
  it("sends UTF-8 as targeted base64, including shell punctuation", async () => {
    const f = fixture(); const value = "你好 😀 + ' $ ;";
    expect(text(await callPhoneTool("type_text", { text: value }, f.adb))).toContain("check");
    expect(f.shell().at(-1)).toEqual(["am", "broadcast", "-a", "ADB_INPUT_B64", "-p", "com.android.adbkeyboard", "--es", "msg", Buffer.from(value).toString("base64")]);
  });
  it.each(["mServedInputConnection", "mServedInputConnectionWrapper"])("refuses clear with no active field (%s)", async key => {
    const f = fixture(); const adb = async (args: string[]) => args.includes("dumpsys") ? Buffer.from(`${key}=null`) : f.adb(args);
    const result = await callPhoneTool("type_text", { text: "replace", clear: true }, adb);
    expect(result.isError).toBe(true); expect(text(result)).toContain("No text field is taking input");
    expect(f.shell().some(c => c[0] === "am")).toBe(false);
  });
  it("clears before typing even ASCII", async () => {
    const f = fixture(); await callPhoneTool("type_text", { text: "replace", clear: true }, f.adb);
    expect(f.shell().map(c => c[0])).toEqual(["settings", "dumpsys", "am", "am"]);
    expect(f.shell()[2]).toContain("ADB_CLEAR_TEXT"); expect(f.shell()[3]).toContain("ADB_INPUT_B64");
  });
  it("counts Unicode code points and refuses invalid text before commands", async () => {
    const f = fixture(); expect((await callPhoneTool("type_text", { text: "😀".repeat(256) }, f.adb)).isError).toBeUndefined();
    const invalid = fixture(); expect((await callPhoneTool("type_text", { text: "😀".repeat(257) }, invalid.adb)).isError).toBe(true);
    expect(invalid.commands).toEqual([]);
  });
  it.each([["wakeup", "KEYCODE_WAKEUP"], ["sleep", "KEYCODE_SLEEP"]])("executes and advertises %s", async (key, code) => {
    const f = fixture(); await callPhoneTool("press", { key }, f.adb);
    expect(f.shell()).toEqual([["input", "keyevent", code]]);
    expect(JSON.stringify(TOOLS.find(t => t.name === "press"))).toContain(key);
  });
});

describe("Android batch admission", () => {
  it.each([
    [{ action: "tap", x: 1, y: 2 }, { action: "shell", command: "anything" }],
    [{ action: "tap", x: 1, y: 2 }, { action: "batch", steps: [] }],
    [{ action: "tap", x: 1, y: 2 }, { action: "type_text", text: "" }],
    [{ action: "tap", x: 1, y: 2 }, { action: "press", key: "constructor" }],
    [{ action: "tap", x: 1, y: 2 }, { action: "press", key: "enter", serial: "OTHER" }],
  ])("runs nothing when a later step is disallowed", async (...steps) => {
    const f = fixture(); const result = await callPhoneTool("batch", { steps }, f.adb);
    expect(result.isError).toBe(true); expect(text(result)).toContain("No step was performed"); expect(f.commands).toEqual([]);
  });
  it("executes in order on one phone", async () => {
    const f = fixture(); const result = await callPhoneTool("batch", { steps: [{ action: "tap", x: 1, y: 2 }, { action: "type_text", text: "hello" }, { action: "press", key: "enter" }] }, f.adb);
    expect(result.isError).toBeUndefined(); expect(f.shell()).toEqual([["input", "tap", "1", "2"], ["input", "text", "hello"], ["input", "keyevent", "KEYCODE_ENTER"]]);
    expect(f.commands.filter(c => c[0] === "devices")).toHaveLength(1);
  });
  it("stops on failure and reports completed steps without inviting a full retry", async () => {
    const f = fixture(); const adb = async (args: string[]) => { if (args.includes("keyevent")) throw new Error("fixture failure"); return f.adb(args); };
    const result = await callPhoneTool("batch", { steps: [{ action: "tap", x: 1, y: 2 }, { action: "press", key: "enter" }, { action: "type_text", text: "later" }] }, adb);
    expect(text(result)).toContain("Step 2 failed"); expect(text(result)).toContain("do not repeat"); expect(f.shell()).toEqual([["input", "tap", "1", "2"]]);
    expect(result.isError).toBe(true);
  });
  it("honors cancellation between steps", async () => {
    const f = fixture(); let cancelled = false;
    const adb = async (args: string[]) => { const out = await f.adb(args); if (args.includes("tap")) cancelled = true; return out; };
    const result = await callPhoneTool("batch", { steps: [{ action: "tap", x: 1, y: 2 }, { action: "press", key: "enter" }] }, adb, () => cancelled);
    expect(text(result)).toContain("cancelled"); expect(f.shell()).toEqual([["input", "tap", "1", "2"]]);
  });
});

it("keeps batch behind the existing Android approval gate", async () => {
  const { isOwnQuiet, isOwnRead, isOwnUnasked } = await import("../../shared/own-servers.ts");
  expect(isOwnQuiet("own:phone", "batch")).toBe(false);
  expect(isOwnRead("own:phone", "batch")).toBe(false);
  expect(isOwnUnasked("own:phone", "batch")).toBe(false);
});

it.each([
  [], Array.from({ length: 11 }, () => ({ action: "read_screen" })),
  [{ action: "wait", seconds: -1 }], [{ action: "wait", seconds: 61 }],
  [{ action: "tap", x: "1", y: 2 }], [{ action: "tap", x: 1, y: Infinity }],
  [{ action: "type_text", text: "hello", clear: "true" }],
  [{ action: "read_screen", command: "anything" }],
])("rejects invalid batch bounds without phone commands", async (...steps) => {
  const f = fixture(); expect((await callPhoneTool("batch", { steps }, f.adb)).isError).toBe(true); expect(f.commands).toEqual([]);
});

it("launches and closes the documented isolated verification fixture", async () => {
  const { existsSync } = await import("node:fs");
  const { launchVerificationServer, runControlMurage } = await import("../../scripts/control-murage.ts");
  const session = await launchVerificationServer(process.env);
  console.info(JSON.stringify({ command: "launch", fixture: session.info }));
  try {
    const result = await runControlMurage(["doctor", "--url", session.info.url], { env: { MURAGE_URL: session.info.url, MURAGE_DATA_DIR: session.info.dataDir } });
    console.info(JSON.stringify({ command: "doctor", result }));
    expect(result).toMatchObject({ ok: true });
  } finally {
    await session.close();
    expect(existsSync(session.info.dataDir)).toBe(false);
    console.info(JSON.stringify({ command: "close", dataRemoved: true }));
  }
}, 120000);

it("refuses clear when the keyboard cannot prove an active field", async () => {
  const f = fixture();
  const adb = async (args: string[]) => args.includes("dumpsys") ? Buffer.from("unrecognized input state") : f.adb(args);
  expect((await callPhoneTool("type_text", { text: "replacement", clear: true }, adb)).isError).toBe(true);
  expect(f.shell().some(c => c[0] === "am")).toBe(false);
});

it("does not type if the clear broadcast fails", async () => {
  const f = fixture();
  const adb = async (args: string[]) => { if (args.includes("ADB_CLEAR_TEXT")) throw new Error("fixture failure"); return f.adb(args); };
  await expect(callPhoneTool("type_text", { text: "replacement", clear: true }, adb)).rejects.toThrow("fixture failure");
  expect(f.shell().some(c => c.includes("ADB_INPUT_B64"))).toBe(false);
});

it("cancels during a batch wait without running the next action", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture(); let cancelled = false;
    const pending = callPhoneTool("batch", { steps: [{ action: "wait", seconds: 60 }, { action: "press", key: "enter" }] }, f.adb, () => cancelled);
    await vi.advanceTimersByTimeAsync(100);
    cancelled = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(text(await pending)).toContain("cancelled"); expect(f.shell()).toEqual([]);
  } finally { vi.useRealTimers(); }
});

it("rejects excessive total waiting before contacting a phone", async () => {
  const f = fixture();
  expect((await callPhoneTool("batch", { steps: [{ action: "wait", seconds: 40 }, { action: "wait", seconds: 40 }] }, f.adb)).isError).toBe(true);
  expect(f.commands).toEqual([]);
});
