// SPDX-License-Identifier: AGPL-3.0-or-later
// Android batch admission is finite and independent of engine tool names.
export const PHONE_KEYS = {
  back: "KEYCODE_BACK", delete: "KEYCODE_DEL", down: "KEYCODE_DPAD_DOWN",
  enter: "KEYCODE_ENTER", escape: "KEYCODE_BACK", home: "KEYCODE_HOME",
  left: "KEYCODE_DPAD_LEFT", recent: "KEYCODE_APP_SWITCH", return: "KEYCODE_ENTER",
  right: "KEYCODE_DPAD_RIGHT", sleep: "KEYCODE_SLEEP", space: "KEYCODE_SPACE",
  tab: "KEYCODE_TAB", up: "KEYCODE_DPAD_UP", wakeup: "KEYCODE_WAKEUP",
} as const;
export const PHONE_STEP_TOOLS = ["open_app", "tap_text", "tap", "swipe", "type_text", "press", "read_screen"] as const;
export type PhoneStepTool = typeof PHONE_STEP_TOOLS[number];
export type PhoneStep = Record<string, unknown> & { action: PhoneStepTool | "wait" };
export class PhoneInputError extends Error {}
const fields: Record<PhoneStep["action"], readonly string[]> = {
  open_app: ["name"], tap_text: ["text", "exact", "index"], tap: ["x", "y"],
  swipe: ["direction"], type_text: ["text", "clear"], press: ["key"], read_screen: [], wait: ["seconds"],
};
const invalid = (message: string): never => { throw new PhoneInputError(message); };
export function validatePhoneAction(action: PhoneStep["action"], args: Record<string, unknown>): void {
  const string = (key: string) => typeof args[key] === "string" && String(args[key]).trim().length > 0;
  const boolean = (key: string) => args[key] === undefined || typeof args[key] === "boolean";
  const pixel = (key: string) => typeof args[key] === "number" && Number.isFinite(args[key]) && Number(args[key]) >= 0 && Number(args[key]) <= 10000;
  if (action === "open_app" && !string("name")) invalid("An app name is required");
  if (action === "tap_text" && (!string("text") || !boolean("exact") || (args.index !== undefined && (!Number.isInteger(args.index) || Number(args.index) < 0)))) invalid("Text, a boolean exact and a nonnegative integer index are required");
  if (action === "tap" && (!pixel("x") || !pixel("y"))) invalid("Android coordinates must be numbers from 0 to 10000");
  if (action === "swipe" && !["up", "down", "left", "right"].includes(String(args.direction))) invalid("Invalid swipe direction");
  if (action === "type_text") {
    if (typeof args.text !== "string" || !args.text || [...args.text].length > 256) invalid("Android text must be 1 to 256 characters");
    if (!boolean("clear")) invalid("clear must be true or false");
  }
  if (action === "press" && (typeof args.key !== "string" || !Object.hasOwn(PHONE_KEYS, args.key.toLowerCase()))) invalid("Unsupported Android key");
  if (action === "wait" && args.seconds !== undefined && (typeof args.seconds !== "number" || !Number.isFinite(args.seconds) || args.seconds < 0 || args.seconds > 60)) invalid("Wait seconds must be a number from 0 to 60");
}

/** Validate every step before even enumerating devices. No nested tools, shell,
 * per-step device changes, unknown fields or implicit type conversions. */
export function parsePhoneSteps(raw: unknown): PhoneStep[] {
  try {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 10) invalid("A batch needs 1 to 10 steps");
    const steps = (raw as unknown[]).map((value): PhoneStep => {
      if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Each step must be an object");
      const step = { ...value as Record<string, unknown> };
      const action = step.action;
      if (typeof action !== "string" || !Object.hasOwn(fields, action)) invalid("Unsupported batch action");
      const allowed = fields[action as PhoneStep["action"]];
      if (Object.keys(step).some(key => key !== "action" && !allowed.includes(key))) invalid("A batch step contains a disallowed field");
      validatePhoneAction(action as PhoneStep["action"], step);
      return step as PhoneStep;
    });
    const waitSeconds = steps.reduce((sum, step) => sum + (step.action === "wait" ? Number(step.seconds ?? 2) : 0), 0);
    if (waitSeconds > 60) invalid("A batch may wait at most 60 seconds in total");
    return steps;
  } catch (error) {
    if (error instanceof PhoneInputError) throw new PhoneInputError(`${error.message}. No step was performed.`);
    throw error;
  }
}
