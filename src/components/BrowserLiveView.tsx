import { useEffect, useRef } from "react";
export type LiveBrowserFrame = { generation: number; seq: number; data: string; width: number; height: number };
export function BrowserLiveView({ frame, generation, held, onInput }: { frame: LiveBrowserFrame | null; generation: number; held: boolean; onInput: (event: Record<string, unknown>) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const current = useRef({ generation, seq: frame?.seq });
  current.current = { generation, seq: frame?.seq };
  useEffect(() => {
    const target = canvas.current;
    if (!target) return;
    target.getContext("2d")?.clearRect(0, 0, target.width, target.height);
    if (!frame || frame.generation !== generation) return;
    let alive = true;
    const image = new Image();
    image.onload = () => {
      if (!alive || current.current.generation !== frame.generation || current.current.seq !== frame.seq) return;
      target.width = image.naturalWidth; target.height = image.naturalHeight;
      target.getContext("2d")?.drawImage(image, 0, 0);
    };
    image.src = `data:image/jpeg;base64,${frame.data}`;
    return () => { alive = false; image.onload = null; };
  }, [frame, generation]);
  const pointer = (event: React.PointerEvent<HTMLCanvasElement>, eventType: string) => {
    if (!held) return;
    event.preventDefault();
    const el = event.currentTarget; const bounds = el.getBoundingClientRect();
    if (eventType === "mousePressed") { el.focus(); el.setPointerCapture(event.pointerId); }
    onInput({ type: "input_mouse", eventType, x: (event.clientX - bounds.left) * el.width / bounds.width, y: (event.clientY - bounds.top) * el.height / bounds.height, button: event.button === 2 ? "right" : "left", clickCount: 1 });
  };
  const key = (event: React.KeyboardEvent, eventType: string) => {
    if (!held || event.key === "Tab" && !event.ctrlKey) return;
    event.preventDefault();
    const modifiers = (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
    onInput({ type: "input_keyboard", eventType, key: event.key, code: event.code, windowsVirtualKeyCode: event.keyCode, modifiers, ...(eventType === "keyDown" && event.key.length === 1 && !event.ctrlKey && !event.metaKey ? { text: event.key } : {}) });
  };
  return <canvas ref={canvas} width={1280} height={800} tabIndex={held ? 0 : -1} aria-label={held ? "Browser page. Type to interact; Tab leaves the page." : "Live browser preview"} className="block w-full rounded-xl bg-inset outline-none focus-visible:ring-2 focus-visible:ring-accent" style={{ touchAction: held ? "none" : "auto", aspectRatio: frame ? `${frame.width}/${frame.height}` : "16/10" }} onPointerDown={e => pointer(e, "mousePressed")} onPointerMove={e => { if (e.buttons) pointer(e,"mouseMoved"); }} onPointerUp={e => pointer(e, "mouseReleased")} onKeyDown={e => key(e, "keyDown")} onKeyUp={e => key(e, "keyUp")} onContextMenu={e => { if (held) e.preventDefault(); }} onWheel={event => {
    if (!held) return;
    const el = event.currentTarget, bounds = el.getBoundingClientRect();
    onInput({ type: "input_mouse", eventType: "mouseWheel", x: (event.clientX - bounds.left) * el.width / bounds.width, y: (event.clientY - bounds.top) * el.height / bounds.height, deltaX: event.deltaX, deltaY: event.deltaY });
  }} />;
}
