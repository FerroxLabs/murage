import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

const hooks = vi.hoisted(() => ({ set: vi.fn(), dispatch: vi.fn(), effects: [] as Array<() => unknown>, layerContent: [] as Array<{ onEscape?: () => void }> }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => unknown) => { hooks.effects.push(effect); },
  useLayoutEffect: () => {},
  useRef: (value: unknown) => ({ current: value }),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  useState: (value: unknown) => [value, hooks.set],
}));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { bots: [], groups: [] }, dispatch: hooks.dispatch }), api: vi.fn() }));
vi.mock("@/lib/use-surface", () => ({ useDesktopSurface: () => true }));
vi.mock("@/lib/focus-message", () => ({ landOnSearchHit: vi.fn() }));
vi.mock("@/lib/chat-previews", async (original) => ({
  ...await original<typeof import("@/lib/chat-previews")>(),
  useChatResource: () => ({ eligible: false, data: null, listGen: null }),
}));
// The palette is a layer (PULLBACK-1018): its Esc comes from the layer engine, which this records.
vi.mock("./LayerSlot", () => ({ useLayerContainer: (_ref: unknown, content: { onEscape?: () => void }) => { hooks.layerContent.push(content); return { active: true, keepFocusOnClose: vi.fn() }; } }));
vi.mock("./LayerSurface", () => ({ LayerSurface: ({ children }: { children: unknown }) => children }));

import { ChatFindBar } from "./ChatFindBar";
import { CommandPalette } from "./CommandPalette";
import { CommandPaletteHost } from "./CommandPaletteHost";

type Element = ReactElement<{ children?: unknown; onKeyDown?: (event: unknown) => void }>;
function inputIn(value: unknown): Element | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) return value.map(inputIn).find(Boolean);
  const element = value as Element;
  return element.type === "input" ? element : inputIn(element.props?.children);
}
/** The palette's key handler sits on its backdrop, inside the LayerSurface wrapper. */
function paletteKeys(close = vi.fn()): (event: unknown) => void {
  const surface = CommandPalette({ request: { token: 1, query: "", opener: null, openingSequence: 0 }, isCurrent: () => true, onClose: close }) as Element;
  return (surface.props.children as Element).props.onKeyDown!;
}

beforeEach(() => { vi.clearAllMocks(); hooks.effects.length = 0; hooks.layerContent.length = 0; });
afterEach(() => vi.unstubAllGlobals());

describe("IME candidate keys stay in search inputs", () => {
  // The open chord lives in the host only since PULLBACK-1018 (the palette is mounted per request).
  it("ignores composing open chords before and after lazy loading", () => {
    const listeners = new Map<string, (event: unknown) => void>();
    vi.stubGlobal("window", { addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener), removeEventListener: vi.fn() });
    vi.stubGlobal("document", { activeElement: null });
    CommandPaletteHost({});
    for (const effect of hooks.effects) effect();
    const onKey = listeners.get("keydown")!;
    for (const composition of [{ isComposing: true, keyCode: 75 }, { isComposing: false, keyCode: 229 }]) {
      const event = { key: "k", ctrlKey: true, ...composition, preventDefault: vi.fn() };
      onKey(event);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    expect(hooks.set).not.toHaveBeenCalled();
    onKey({ key: "k", ctrlKey: true, isComposing: false, keyCode: 75, preventDefault: vi.fn() });
    expect(hooks.set).toHaveBeenCalledOnce();
  });
  for (const key of ["Enter", "Escape", "ArrowDown", "ArrowUp"]) {
    for (const nativeEvent of [{ isComposing: true, keyCode: 13 }, { isComposing: false, keyCode: 229 }]) {
      it(`${key} with ${JSON.stringify(nativeEvent)} does not navigate or close`, () => {
        const close = vi.fn();
        const find = ChatFindBar({ threadId: "thread", onClose: close });
        const paletteClose = vi.fn();
        const onKeyDown = paletteKeys(paletteClose);
        const event = { key, nativeEvent, preventDefault: vi.fn(), stopPropagation: vi.fn() };
        inputIn(find)!.props.onKeyDown!(event);
        onKeyDown(event);
        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(close).not.toHaveBeenCalled();
        expect(paletteClose).not.toHaveBeenCalled();
        expect(hooks.set).not.toHaveBeenCalled();
        expect(hooks.dispatch).not.toHaveBeenCalled();
        // The palette's Escape is the layer engine's; lazy-overlay-contract pins that it leaves a composing Escape alone by either signal.
      });
    }
  }
  it("plain Escape still closes both surfaces", () => {
    const close = vi.fn();
    const event = { key: "Escape", nativeEvent: { isComposing: false, keyCode: 27 }, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    inputIn(ChatFindBar({ threadId: "thread", onClose: close }))!.props.onKeyDown!(event);
    expect(close).toHaveBeenCalledOnce();
    const paletteClose = vi.fn();
    paletteKeys(paletteClose);
    expect(hooks.layerContent.at(-1)?.onEscape).toBe(paletteClose);
    hooks.layerContent.at(-1)!.onEscape!();
    expect(paletteClose).toHaveBeenCalledOnce();
  });
});
