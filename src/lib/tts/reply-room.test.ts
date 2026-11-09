import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";
import { toggleReadAloud, isReading, readAloudLabel } from "../read-aloud";
import { replyController, useReadAloudSpeech } from "./reply-speech";
import { replyFrame, REPLY_AUDIO_MIME } from "../../../shared/reply-speech";
const observed = vi.hoisted(() => ({ changed: vi.fn(), cleanups: [] as Array<() => void> }));
vi.mock("../surface", () => ({ knownComputer: () => true, surface: async () => "desktop" }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useSyncExternalStore: (subscribe: (fn: () => void) => () => void, snapshot: () => unknown) => { observed.cleanups.push(subscribe(observed.changed)); return snapshot(); } }));
afterEach(() => { replyController.disconnect(); for (const cleanup of observed.cleanups.splice(0)) cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("S-manual-room real menu and subscription own fetching, buffered playback, replacement and second-click Stop with switch off", async () => {
  const requests: any[] = [], players: any[] = [];
  vi.stubGlobal("Audio", class {
    onended: (() => void) | null = null; onerror: (() => void) | null = null;
    pause = vi.fn(); play = vi.fn(async () => {}); removeAttribute() {} load() {}
    constructor() { players.push(this); }
  });
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fixture"); const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async (path: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); requests.push({ path, body });
    if (path.endsWith("/session")) return new Response(JSON.stringify({ sessionId: "s", bootId: "boot", threadId: "room-thread", revision: 0 }));
    if (path.endsWith("/cancel")) return new Response(null, { status: 204 });
    if (path.endsWith("/target")) return new Response(JSON.stringify({ accountScopeId: "account", planVersion: "plan", holdUntil: 0, serverNow: 1 }));
    return new Response(new Blob([replyFrame({ type: "start", value: { attemptId: "attempt", revision: 0, mime: "audio/mpeg" } }), replyFrame({ type: "audio", bytes: Uint8Array.of(255) }), replyFrame({ type: "complete" })]), { headers: { "content-type": REPLY_AUDIO_MIME } });
  }));
  replyController.setEnabled(false); replyController.configure({ desktop: true, hydrated: true, threadId: "room-thread", visible: true, call: false }); replyController.hello("connection", "boot"); replyController.caughtUp(); await vi.waitFor(() => expect(replyController.snapshot.status).toBe("idle"));
  const source = readFileSync(new URL("../../components/GroupView.tsx", import.meta.url), "utf8");
  const file = ts.createSourceFile("GroupView.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX); let arrow = "";
  const visit = (node: ts.Node) => { if (ts.isVariableDeclaration(node) && node.name.getText(file) === "roomActions") arrow = node.initializer!.getText(file); ts.forEachChild(node, visit); }; visit(file); expect(arrow).toBeTruthy();
  const menu = (messageId: string) => {
    const scope = { group: { id: "room", threadId: "room-thread" }, speaks: () => ({ id: "bot", voice: "marin" }), speech: useReadAloudSpeech(), state: { config: { tts: { configured: true } } }, isReading, readAloudLabel, toggleReadAloud, speaker: { state: { status: "idle" }, speak: vi.fn(), stop: vi.fn() }, markOwner: () => null, outcomeSheetActions: () => [], outcomes: {}, onReply: vi.fn(), dispatch: vi.fn(), React: { createElement: () => null }, Square: "square", Volume2: "volume", MessageSquareReply: "reply", PinOff: "pin-off", Pin: "pin" };
    const compiled = ts.transpileModule(`return (${arrow});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
    return new Function(...Object.keys(scope), compiled)(...Object.values(scope))({ id: messageId, text: "raw source must not be posted" }).find((item: any) => item.id === "speak");
  };
  menu("one").onSelect(); expect(menu("one").label).toBe("Stop"); await vi.waitFor(() => expect(players).toHaveLength(1)); expect(menu("one").label).toBe("Stop");
  const staleEnded = players[0].onended;
  menu("two").onSelect(); expect(players[0].pause).toHaveBeenCalledOnce(); await vi.waitFor(() => expect(players).toHaveLength(2)); staleEnded(); expect(menu("two").label).toBe("Stop");
  replyController.setEnabled(true); replyController.receive({ kind: "speech.ready", threadId: "room-thread", messageId: "queued", settlementId: "settled", bootId: "boot", revision: 0 }); expect(players).toHaveLength(2);
  menu("two").onSelect(); expect(players[1].pause).toHaveBeenCalledOnce(); expect(menu("two").label).toBe("Read aloud"); expect(revoke).toHaveBeenCalledTimes(2); expect(observed.changed).toHaveBeenCalled();
  const synthesis = requests.filter(request => request.path === "/api/tts/reply"); expect(synthesis.map(request => request.body.messageId)).toEqual(["one", "two"]); expect(synthesis.every(request => request.body.threadId === "room-thread" && !Object.hasOwn(request.body, "text"))).toBe(true);
});
