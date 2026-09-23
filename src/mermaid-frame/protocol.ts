// The only conversation the app and a diagram frame have. The frame is a
// sandboxed iframe with an opaque origin: it cannot read the app, its storage
// or the desktop bridge, and the app believes nothing it says beyond these
// three shapes. Both sides parse every message with the functions below and
// drop anything else, so a diagram that somehow ran code in the frame could
// still only report a height.

/** Where the frame page is served, on the app's own origin. */
export const MERMAID_FRAME_PATH = "/mermaid-frame.html";
/** Longest diagram source the app sends. Longer ones show as source. */
export const MAX_DIAGRAM_SOURCE = 20_000;
/** How long the frame gives mermaid before giving up. */
export const FRAME_RENDER_TIMEOUT_MS = 8_000;
/** How long the app waits for the frame (load + render) before showing source. */
export const HOST_RENDER_TIMEOUT_MS = 12_000;
/** Heights the app will size a frame to, in CSS pixels. */
export const MIN_FRAME_HEIGHT = 24;
export const MAX_FRAME_HEIGHT = 4_000;

export type DiagramTheme = "light" | "dark";
export type FrameFailure = "parse" | "timeout" | "too-long" | "unavailable";

/** App → frame: draw this. */
export interface RenderRequest { type: "murage-mermaid:render"; id: number; source: string; theme: DiagramTheme }
/** Frame → app. */
export type FrameMessage =
  | { type: "murage-mermaid:ready" }
  | { type: "murage-mermaid:rendered"; id: number; height: number }
  | { type: "murage-mermaid:error"; id: number; reason: FrameFailure };

const FAILURES: readonly FrameFailure[] = ["parse", "timeout", "too-long", "unavailable"];

function record(data: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  if (Object.getPrototypeOf(data) !== Object.prototype) return null;
  const own = Object.keys(data);
  if (own.length !== keys.length || !own.every((key) => keys.includes(key))) return null;
  return data as Record<string, unknown>;
}

const isId = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0x7fffffff;

/** The height the app will actually use: whole pixels inside the bounds. */
export function clampFrameHeight(height: number): number {
  return Math.min(MAX_FRAME_HEIGHT, Math.max(MIN_FRAME_HEIGHT, Math.ceil(height)));
}

/** Read a message the frame received. Anything but a well-formed render request is null. */
export function parseRenderRequest(data: unknown): RenderRequest | null {
  const message = record(data, ["type", "id", "source", "theme"]);
  if (!message || message.type !== "murage-mermaid:render" || !isId(message.id)) return null;
  if (typeof message.source !== "string" || message.source.length > MAX_DIAGRAM_SOURCE) return null;
  if (message.theme !== "light" && message.theme !== "dark") return null;
  return { type: message.type, id: message.id, source: message.source, theme: message.theme };
}

/** Read a message the app received from a frame. Anything but the three shapes is null. */
export function parseFrameMessage(data: unknown): FrameMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const type = (data as { type?: unknown }).type;
  if (type === "murage-mermaid:ready") return record(data, ["type"]) ? { type } : null;
  if (type === "murage-mermaid:rendered") {
    const message = record(data, ["type", "id", "height"]);
    if (!message || !isId(message.id) || typeof message.height !== "number" || !Number.isFinite(message.height)) return null;
    return { type, id: message.id, height: clampFrameHeight(message.height) };
  }
  if (type === "murage-mermaid:error") {
    const message = record(data, ["type", "id", "reason"]);
    if (!message || !isId(message.id) || !FAILURES.includes(message.reason as FrameFailure)) return null;
    return { type, id: message.id, reason: message.reason as FrameFailure };
  }
  return null;
}
