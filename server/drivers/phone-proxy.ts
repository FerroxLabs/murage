// SPDX-License-Identifier: AGPL-3.0-or-later
import { NotModelRequest } from "../../shared/engine-transport.ts";
import "../../shared/win-hide-child-process.mjs";
import { registerBusyloopPayloadSite } from "../../shared/flux-route.ts";
import { sendProxyFrame, proxyTransportLost, collectProxyUpstream } from "../proxy-turn-release.ts";
// First-party Android phone MCP server. It deliberately accepts physical USB
// devices only: no emulators, wireless debugging, network ADB, or Tailscale.
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";
import { PHONE_KEYS, PHONE_STEP_TOOLS, PhoneInputError, parsePhoneSteps, validatePhoneAction, type PhoneStep } from "../../shared/phone-steps.ts";
import { murageToolOnThisServer } from "../murage-tool-surface.ts";

type Json = Record<string, unknown>;
type Device = { serial: string; state: string; model: string; connection: "usb" | "network" | "emulator" };
type UiNode = { text: string; description: string; id: string; className: string; bounds: [number, number, number, number] };

const PACKAGE = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/;
const COMPONENT = /^([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)\/\S+$/;
const SAFE_TEXT = /^[A-Za-z0-9 _.,@-]+$/;
const KEYCODES = PHONE_KEYS;
const KNOWN_PACKAGES: Record<string, string> = {
  skyscanner: "net.skyscanner.android.main",
  uber: "com.ubercab",
};

function executableName(platform = process.platform) {
  return platform === "win32" ? "adb.exe" : "adb";
}

export function resolveAdbPath(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string | null {
  const executable = executableName(platform);
  const home = homedir();
  const candidates = [
    env.MURAGE_ADB_PATH,
    env.MURAGE_RESOURCES_PATH && join(env.MURAGE_RESOURCES_PATH, "android-platform-tools", platform, executable),
    ...(env.PATH ?? "").split(delimiter).map((entry) => entry && join(entry, executable)),
    platform === "darwin" && join(home, "Library/Android/sdk/platform-tools/adb"),
    platform === "darwin" && "/opt/homebrew/bin/adb",
    platform === "darwin" && "/usr/local/bin/adb",
    platform === "linux" && join(home, "Android/Sdk/platform-tools/adb"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

export async function runAdb(args: string[], options: { binary?: boolean; timeoutMs?: number } = {}): Promise<Buffer> {
  const adb = resolveAdbPath();
  if (!adb) throw new Error("Android platform tools are unavailable. Reopen Murage or install adb.");
  return new Promise((resolve, reject) => {
    const child = spawn(adb, [...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const stdout = collectProxyUpstream("phone", child.stdout);
    const stderr = collectProxyUpstream("phone", child.stderr);
    void stdout.catch(() => child.kill());
    void stderr.catch(() => child.kill());
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("The Android device command timed out"));
    }, options.timeoutMs ?? 12_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", async (code) => {
      clearTimeout(timer);
      try {
        const [out, err] = await Promise.all([stdout, stderr]);
        if (code !== 0) return reject(new Error(err.toString("utf8").trim() || `adb exited`));
        resolve(out);
      } catch (error) { reject(error); }
    });
  });
}

export function parseDevices(output: string): Device[] {
  const devices: Device[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("List of devices attached") || line.startsWith("* daemon")) continue;
    const [serial, state, ...fields] = line.split(/\s+/);
    if (!serial || !state) continue;
    const connection = serial.startsWith("emulator-")
      ? "emulator"
      : serial.includes(":") || serial.startsWith("adb-")
        ? "network"
        : "usb";
    const properties = Object.fromEntries(fields.flatMap((field) => {
      const split = field.indexOf(":");
      return split > 0 ? [[field.slice(0, split), field.slice(split + 1)]] : [];
    }));
    devices.push({
      serial,
      state,
      connection,
      model: String(properties.model ?? properties.product ?? "Android device").replaceAll("_", " "),
    });
  }
  return devices;
}

type Adb = typeof runAdb;
type OnDevice = (serial: string, args: string[], binary?: boolean) => Promise<Buffer>;

async function usbDevices(adb: Adb = runAdb) {
  if (adb === runAdb && !resolveAdbPath()) return [];
  return parseDevices((await adb(["devices", "-l"])).toString("utf8")).filter((device) => device.connection === "usb");
}

async function readySerial(requested: unknown, adb: Adb): Promise<string> {
  const devices = await usbDevices(adb);
  const serial = typeof requested === "string" && requested ? requested : process.env.PH_ANDROID_SERIAL;
  const candidates = serial ? devices.filter((device) => device.serial === serial) : devices;
  if (!candidates.length) throw new Error("No physical USB Android device is connected");
  if (candidates.length > 1 && !serial) throw new Error("Multiple USB Android devices are connected; pass serial");
  const device = candidates[0];
  if (device.state === "unauthorized") throw new Error("Unlock the phone and accept Allow USB debugging");
  if (device.state !== "device") throw new Error(`The Android device is ${device.state}`);
  return device.serial;
}

function normalize(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function parseLaunchablePackages(output: string): string[] {
  const packages: string[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const match = COMPONENT.exec(raw.trim());
    if (match && !packages.includes(match[1])) packages.push(match[1]);
  }
  return packages;
}

export function findPackages(name: string, packages: string[]) {
  if (PACKAGE.test(name) && packages.includes(name)) return [name];
  const needle = normalize(name);
  const known = KNOWN_PACKAGES[needle];
  if (known && packages.includes(known)) return [known];
  if (needle.length < 4) return [];
  const ranked = [
    (token: string) => token === needle,
    (token: string) => token.startsWith(needle),
    (token: string) => token.includes(needle),
  ];
  for (const matches of ranked) {
    const found = packages.filter((pkg) => pkg.split(".").some((token) => matches(normalize(token))));
    if (found.length) return found;
  }
  return [];
}

async function launchablePackages(serial: string, onDevice: OnDevice) {
  const output = await onDevice(serial, [
    "shell", "cmd", "package", "query-activities", "--brief",
    "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER",
  ]);
  return parseLaunchablePackages(output.toString("utf8"));
}

function decodeXml(value: string) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

export function parseUiNodes(xml: string): UiNode[] {
  const nodes: UiNode[] = [];
  for (const match of xml.matchAll(/<node\s+([^>]+?)\/?\s*>/g)) {
    const attributes: Record<string, string> = {};
    for (const attribute of match[1].matchAll(/([\w:-]+)="([^"]*)"/g)) {
      attributes[attribute[1]] = decodeXml(attribute[2]);
    }
    const bounds = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(attributes.bounds ?? "");
    if (!bounds) continue;
    const text = attributes.text ?? "";
    const description = attributes["content-desc"] ?? "";
    if (!text && !description && !attributes["resource-id"]) continue;
    nodes.push({
      text,
      description,
      id: attributes["resource-id"] ?? "",
      className: attributes.class ?? "",
      bounds: [Number(bounds[1]), Number(bounds[2]), Number(bounds[3]), Number(bounds[4])],
    });
  }
  return nodes;
}

async function readNodes(serial: string, onDevice: OnDevice) {
  const streamed = (await onDevice(serial, ["shell", "uiautomator", "dump", "/dev/tty"])).toString("utf8");
  const streamedStart = streamed.indexOf("<?xml");
  if (streamedStart >= 0) return parseUiNodes(streamed.slice(streamedStart));

  const remotePath = "/data/local/tmp/murage-window.xml";
  await onDevice(serial, ["shell", "uiautomator", "dump", remotePath]);
  const saved = (await onDevice(serial, ["shell", "cat", remotePath])).toString("utf8");
  void onDevice(serial, ["shell", "rm", "-f", remotePath]).catch(() => undefined);
  const savedStart = saved.indexOf("<?xml");
  return parseUiNodes(savedStart >= 0 ? saved.slice(savedStart) : saved);
}

function nodeLines(nodes: UiNode[]) {
  return nodes.slice(0, 250).map((node, index) => {
    const label = [node.text, node.description].filter(Boolean).join(" · ");
    return `${index}: ${JSON.stringify(label || node.id)} bounds=${node.bounds.join(",")} class=${node.className}`;
  }).join("\n") || "No accessible Android UI text is visible.";
}

// Sibling tools in these descriptions are named on this server: the list
// cannot know the caller's engine or the name it mounted the phone under.
const SINGLE_TOOLS = [
  { name: "status", description: "Check physical USB Android devices and USB-debugging authorization before any Android phone task.", inputSchema: { type: "object", properties: {} } },
  { name: "read_screen", description: "Read visible text, accessibility labels, resource ids, and pixel bounds from the connected Android screen. Use after every action to verify the result.", inputSchema: { type: "object", properties: { serial: { type: "string" } } } },
  { name: "screenshot", description: "Capture the connected Android screen when accessibility text is insufficient. Returns a PNG image.", inputSchema: { type: "object", properties: { serial: { type: "string" } } } },
  { name: "list_apps", description: `List installed launchable Android package names, optionally filtered by a human app name. Prefer ${murageToolOnThisServer("open_app")} first.`, inputSchema: { type: "object", properties: { query: { type: "string" }, serial: { type: "string" } } } },
  { name: "open_app", description: "Open an installed Android app directly by its human name, such as Uber or Skyscanner. Do not scan the app drawer first.", inputSchema: { type: "object", properties: { name: { type: "string" }, serial: { type: "string" } }, required: ["name"] } },
  { name: "tap_text", description: `Tap visible Android text or an accessibility label, then use ${murageToolOnThisServer("read_screen")} to verify.`, inputSchema: { type: "object", properties: { text: { type: "string" }, exact: { type: "boolean" }, index: { type: "integer", minimum: 0 }, serial: { type: "string" } }, required: ["text"] } },
  { name: "tap", description: `Tap Android screen pixel coordinates obtained from ${murageToolOnThisServer("read_screen")} or ${murageToolOnThisServer("screenshot")}.`, inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, serial: { type: "string" } }, required: ["x", "y"] } },
  { name: "swipe", description: `Swipe the Android screen in a direction, then use ${murageToolOnThisServer("read_screen")} to verify.`, inputSchema: { type: "object", properties: { direction: { type: "string", enum: ["up", "down", "left", "right"] }, serial: { type: "string" } }, required: ["direction"] } },
  { name: "type_text", description: "Type into the focused Android field. Letters, digits, spaces and _.,@- use Android input; other text needs ADBKeyBoard selected on the phone. Set clear to true to empty the field first (also needs ADBKeyBoard). Tap the field first and read the screen afterward. Never enter passwords, payment details, or one-time codes.", inputSchema: { type: "object", properties: { text: { type: "string", minLength: 1, maxLength: 256 }, clear: { type: "boolean" }, serial: { type: "string" } }, required: ["text"] } },
  { name: "press", description: "Press an Android navigation or keyboard key. wakeup turns the screen on; sleep turns it off. Ask the owner to unlock any PIN, pattern or password lock.", inputSchema: { type: "object", properties: { key: { type: "string", enum: Object.keys(KEYCODES) }, serial: { type: "string" } }, required: ["key"] } },
] as const;

// Step schemas reuse the individual tools, without allowing a device change.
export const TOOLS = [...SINGLE_TOOLS, {
  name: "batch",
  description: `Run 1 to 10 phone steps in order on one phone. Each step has action (the bare name of ${PHONE_STEP_TOOLS.map(name => murageToolOnThisServer(name)).join(", ")}, or wait) and that tool's fields. All steps are checked before any run. Wait seconds defaults to 2, at most 60 seconds total. Add ${murageToolOnThisServer("read_screen")} last to verify; stop where the next screen is uncertain. On failure, earlier steps may have run: read the screen before retrying.`,
  inputSchema: { type: "object", additionalProperties: false, required: ["steps"], properties: {
    serial: { type: "string" }, steps: { type: "array", minItems: 1, maxItems: 10, items: { oneOf: [
      ...SINGLE_TOOLS.filter(tool => (PHONE_STEP_TOOLS as readonly string[]).includes(tool.name)).map(tool => ({
        type: "object", additionalProperties: false,
        properties: { action: { type: "string", enum: [tool.name] }, ...Object.fromEntries(Object.entries(tool.inputSchema.properties).filter(([key]) => key !== "serial")) },
        required: ["action", ...("required" in tool.inputSchema ? tool.inputSchema.required : [])],
      })),
      { type: "object", additionalProperties: false, properties: { action: { type: "string", enum: ["wait"] }, seconds: { type: "number", minimum: 0, maximum: 60 } }, required: ["action"] },
    ] } },
  } },
}] as const;

type ToolResult = { content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; isError?: boolean };
const textResult = (text: string, isError = false): ToolResult => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });

async function callTool(name: string, args: Json, adb: Adb, cancelled: () => boolean): Promise<ToolResult> {
  if (name === "status") {
    const available = adb !== runAdb || Boolean(resolveAdbPath());
    const devices = available ? await usbDevices(adb) : [];
    return textResult(JSON.stringify({ available, devices }, null, 2));
  }
  const steps = name === "batch" ? parsePhoneSteps(args.steps) : undefined;
  if (!steps) {
    if (!SINGLE_TOOLS.some(tool => tool.name === name)) throw new PhoneInputError("Unknown phone tool");
    if ((PHONE_STEP_TOOLS as readonly string[]).includes(name)) validatePhoneAction(name as PhoneStep["action"], args);
  }
  const checkCancelled = () => { if (cancelled()) throw new PhoneInputError("The client cancelled this call"); };
  checkCancelled();
  const serial = await readySerial(args.serial, adb);
  const onDevice: OnDevice = (target, command, binary = false) => {
    checkCancelled();
    return adb(["-s", target, ...command], { binary });
  };
  if (!steps) return callToolOn(serial, name, args, onDevice);
  const lines: string[] = [];
  for (const [index, { action, ...fields }] of steps.entries()) {
    try {
      checkCancelled();
      let output: string;
      if (action === "wait") {
        const deadline = Date.now() + Number(fields.seconds ?? 2) * 1000;
        while (Date.now() < deadline) {
          checkCancelled();
          await new Promise(resolve => setTimeout(resolve, Math.min(100, deadline - Date.now())));
        }
        output = "Waited";
      } else {
        const result = await callToolOn(serial, action, fields, onDevice);
        output = result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
      }
      lines.push(`${index + 1}. ${action}: ${output}`);
    } catch (error) {
      const reason = error instanceof PhoneInputError ? error.message : "Android command failed";
      return textResult([...lines, `Step ${index + 1} failed: ${reason}. Its effect is unknown; read_screen or screenshot before retrying. Earlier steps completed; do not repeat them. Later steps were not performed.`].join("\n"), true);
    }
  }
  return textResult(lines.join("\n"));
}

async function callToolOn(serial: string, name: string, args: Json, onDevice: OnDevice): Promise<ToolResult> {
  if (name === "read_screen") return textResult(nodeLines(await readNodes(serial, onDevice)));
  if (name === "screenshot") {
    const png = await onDevice(serial, ["exec-out", "screencap", "-p"], true);
    if (!png.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) throw new Error("Android returned an invalid screenshot");
    return { content: [{ type: "text", text: `Android screenshot from ${serial}` }, { type: "image", data: png.toString("base64"), mimeType: "image/png" }] };
  }
  if (name === "list_apps") {
    const packages = await launchablePackages(serial, onDevice);
    const query = typeof args.query === "string" ? args.query : "";
    return textResult((query ? findPackages(query, packages) : packages).join("\n") || "No matching launchable app found");
  }
  if (name === "open_app") {
    const appName = String(args.name ?? "").trim();
    if (!appName) throw new Error("name is required");
    const matches = findPackages(appName, await launchablePackages(serial, onDevice));
    if (matches.length !== 1) throw new Error(matches.length ? `App name is ambiguous: ${matches.join(", ")}` : `No installed launchable app matches ${JSON.stringify(appName)}`);
    await onDevice(serial, ["shell", "monkey", "-p", matches[0], "-c", "android.intent.category.LAUNCHER", "1"]);
    return textResult(`Opened ${appName} (${matches[0]})`);
  }
  if (name === "tap_text") {
    const query = String(args.text ?? "").trim().toLowerCase();
    if (!query) throw new Error("text is required");
    const exact = args.exact === true;
    const hits = (await readNodes(serial, onDevice)).filter((node) => {
      const labels = [node.text, node.description].filter(Boolean).map((value) => value.toLowerCase());
      return labels.some((label) => exact ? label === query : label.includes(query));
    });
    const index = Number.isInteger(args.index) ? Number(args.index) : 0;
    const hit = hits[index];
    if (!hit) throw new Error(`No visible Android text matches ${JSON.stringify(args.text)}`);
    const [x1, y1, x2, y2] = hit.bounds;
    await onDevice(serial, ["shell", "input", "tap", String(Math.round((x1 + x2) / 2)), String(Math.round((y1 + y2) / 2))]);
    return textResult(`Tapped ${JSON.stringify(hit.text || hit.description)}`);
  }
  if (name === "tap") {
    const x = Number(args.x); const y = Number(args.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 10000 || y > 10000) throw new Error("Invalid Android coordinates");
    await onDevice(serial, ["shell", "input", "tap", String(Math.round(x)), String(Math.round(y))]);
    return textResult(`Tapped ${Math.round(x)},${Math.round(y)}`);
  }
  if (name === "swipe") {
    const direction = String(args.direction ?? "");
    const size = (await onDevice(serial, ["shell", "wm", "size"])).toString("utf8");
    const match = /(\d+)x(\d+)/.exec(size);
    if (!match) throw new Error("Could not read Android screen size");
    const width = Number(match[1]); const height = Number(match[2]);
    const points: Record<string, [number, number, number, number]> = {
      up: [width / 2, height * 0.75, width / 2, height * 0.25],
      down: [width / 2, height * 0.25, width / 2, height * 0.75],
      left: [width * 0.75, height / 2, width * 0.25, height / 2],
      right: [width * 0.25, height / 2, width * 0.75, height / 2],
    };
    const point = points[direction];
    if (!point) throw new Error("Invalid swipe direction");
    await onDevice(serial, ["shell", "input", "swipe", ...point.map((value) => String(Math.round(value))), "260"]);
    return textResult(`Swiped ${direction}`);
  }
  if (name === "type_text") {
    const value = String(args.text);
    if (args.clear !== true && SAFE_TEXT.test(value)) {
      await onDevice(serial, ["shell", "input", "text", value.replaceAll(" ", "%s")]);
      return textResult("Typed text into the focused Android field");
    }
    const keyboard = (await onDevice(serial, ["shell", "settings", "get", "secure", "default_input_method"])).toString("utf8").trim();
    if (keyboard !== "com.android.adbkeyboard/.AdbIME") throw new PhoneInputError("Set up ADBKeyBoard (https://github.com/senzhk/ADBKeyBoard) and choose it as the phone's keyboard to type this text or clear a field");
    const broadcast = (action: string, ...extras: string[]) => onDevice(serial, ["shell", "am", "broadcast", "-a", action, "-p", "com.android.adbkeyboard", ...extras]);
    if (args.clear === true) {
      const state = (await onDevice(serial, ["shell", "dumpsys", "input_method"])).toString("utf8");
      // Fail closed on an absent or null served connection: older keyboards
      // can crash when asked to clear without a field taking input.
      const connection = /\bmServedInputConnection(?:Wrapper)?=(\S+)/.exec(state)?.[1];
      if (!connection || connection === "null") throw new PhoneInputError("No text field is taking input, so nothing was cleared or typed. Tap the field first");
      await broadcast("ADB_CLEAR_TEXT");
    }
    await broadcast("ADB_INPUT_B64", "--es", "msg", Buffer.from(value, "utf8").toString("base64"));
    return textResult("Sent text to ADBKeyBoard. Use read_screen to check the field before continuing");
  }
  if (name === "press") {
    const key = String(args.key ?? "").toLowerCase();
    if (!Object.hasOwn(KEYCODES, key)) throw new Error("Unsupported Android key");
    await onDevice(serial, ["shell", "input", "keyevent", KEYCODES[key as keyof typeof KEYCODES]]);
    return textResult(`Pressed ${key}`);
  }
  throw new Error(`Unknown phone tool: ${name}`);
}

// Injectable transport keeps phone verification isolated from physical devices.
export async function callPhoneTool(name: string, args: Json, adb: Adb = runAdb, cancelled = () => false): Promise<ToolResult> {
  try { return await callTool(name, args, adb, cancelled); }
  catch (error) {
    if (error instanceof PhoneInputError) return textResult(error.message, true);
    throw error;
  }
}

const send = (message: Json) => sendProxyFrame("phone", message);
const ok = (id: unknown, result: unknown) => NotModelRequest("Local phone MCP tool reply or error.", send({ jsonrpc: "2.0", id, result }));
const rpcError = (id: unknown, code: number, message: string) => NotModelRequest("Local phone MCP tool reply or error.", send({ jsonrpc: "2.0", id, error: { code, message } }));

const pendingBatches = new Map<unknown, { cancelled: boolean }>();

async function handle(message: Json) {
  const id = message.id;
  const method = message.method;
  const params = (message.params ?? {}) as Json;
  if (method === "initialize") return ok(id, { protocolVersion: String(params.protocolVersion ?? "2024-11-05"), capabilities: { tools: {} }, serverInfo: { name: "murage-phone", version: "1" } });
  if (method === "notifications/cancelled") {
    const batch = pendingBatches.get(params.requestId);
    if (batch) batch.cancelled = true;
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") return;
  if (method === "ping") return ok(id, {});
  if (method === "tools/list") return ok(id, { tools: TOOLS });
  if (method === "tools/call") {
    const name = String(params.name ?? "");
    if (!TOOLS.some((tool) => tool.name === name)) return rpcError(id, -32602, `Unknown tool: ${name}`);
    const batch = { cancelled: false };
    if (name === "batch") pendingBatches.set(id, batch);
    try {
      return ok(id, await callPhoneTool(name, (params.arguments ?? {}) as Json, runAdb, () => batch.cancelled));
    } catch {
      return proxyTransportLost("phone");
    } finally {
      pendingBatches.delete(id);
    }
  }
  if (id !== undefined) rpcError(id, -32601, `Method not found: ${String(method)}`);
}

if (process.argv[1] && existsSync(process.argv[1]) && /phone-proxy\.(?:ts|js)$/.test(process.argv[1])) {
  const lines = createInterface({ input: process.stdin, terminal: false });
  lines.on("line", (line) => {
    try {
      const message = registerBusyloopPayloadSite("read", JSON.parse(line)) as Json;
      void handle(message).catch((error) => rpcError(message.id, -32603, error instanceof Error ? error.message : String(error)));
    } catch {}
  });
}
