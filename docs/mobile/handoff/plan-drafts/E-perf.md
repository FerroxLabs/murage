# Group E: Performance (spec §6, apart from compression)

Scope: code splitting, the first-paint payload budget in CI, phone mode (event stream and
boot hydration), transcript rendering, image thumbnails and the ComputerPanel phone poll.
Compression is group B, and nothing here depends on it: the budget measures brotli sizes
itself.

Evidence gathered read-only on `mobile/v1` @ `121c79fb`. Line numbers are from that commit.
A static import walk of `src/main.tsx` (a throwaway regex walker, run in the scratchpad)
reaches **445** modules today. The same walk with the six edges cut by E1–E3 reaches
**352**, and none of them is `@tiptap/*`, `onnxruntime-web`, `CallView`, `GroupCallView`,
`SettingsModal`, `ComputerPanel`, `MarkdownEditor` or `markdown-fidelity`. Today the chains
are `App → SettingsModal → HouseRulesSettings → SkillEditor → markdown-fidelity → @tiptap/*`,
`ChatView → WorkspacePane → MarkdownEditor → RichMarkdownEditor`,
`ChatHeader/ChatView → CallView → call-mic → silero-vad → onnxruntime-web/wasm` and
`App → BotSettingsDialog → SettingsPanel → BotSkillsPanel → SkillPicker → SkillReader → SkillEditor`.
That last chain is why BotSettingsDialog is split in E2 as well, even though the brief
did not name it.

HARD RULE for whoever runs this plan: no `vite build` or other real build on the Mac. The
one build-dependent step (E5 Step 6, measuring the budget) runs on Hetzner
(`ssh hetzner-dsm`, `/root/fuigo-builds/<lane>/`). Every other step here is a vitest run.

---

### Task E1: Lazy call screens and a lazily loaded speech detector

**Files:**
- Create: `src/components/CallControls.tsx`
- Create: `src/components/LazyFallback.tsx`
- Create: `src/lib/vad-threshold.ts`
- Create: `src/first-paint.test.ts`
- Modify: `src/components/CallView.tsx:1,32-33,36,48,81-247,249`
- Modify: `src/components/GroupCallView.tsx:9,12,20,29-47,59`
- Modify: `src/lib/call-mic.ts:24,200-202`
- Modify: `src/lib/silero-vad.ts:14-22`
- Modify: `src/components/ChatHeader.tsx:34`, `src/components/ChatView.tsx:85`, `src/components/GroupView.tsx:36`
- Modify: `src/components/naming.test.ts:72`
- Test: `src/first-paint.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks. React.lazy chunk-load failures are handled by the
  §3.6 plumbing task's reload-once handler (`vite:preloadError`). See Notes 5.
- Produces:
  - `src/components/CallControls.tsx` exports `CallButton`, `CallTargetButton`,
    `CallOverlay`, `GroupCallButton` and `GroupCallOverlay`, with the same props as today.
  - `src/components/CallView.tsx` exports `Call({ bot })`, and
    `src/components/GroupCallView.tsx` exports `GroupCall({ group, members })`. Only
    CallControls imports them, through `lazy()`.
  - `src/components/LazyFallback.tsx` exports `LazyFallback()`, which E2 reuses.
  - `src/lib/vad-threshold.ts` exports `SPEECH_CONFIDENCE`. `silero-vad.ts` re-exports it.
  - `src/first-paint.test.ts` exports nothing. E2 and E3 add cases to it, using its
    `staticallyReached()` and `graph` helpers, which live in that file.

- [ ] **Step 1: Write the failing test**

`src/first-paint.test.ts`:
```ts
// The first paint loads only what a chat needs (spec §6).
//
// A phone over cellular pays for every byte of the entry chunk before it can
// show a single message, and Vite puts in that chunk everything reachable
// from src/main.tsx through static imports. The call screen with its speech
// model runtime, both Markdown editors with Tiptap, Settings, and the computer
// panel are each opened by a tap, so each is reached through `lazy()` or
// `await import()` instead. That is a property of the import graph, not of a
// build, so this reads the graph the way a bundler does: esbuild's metafile,
// which records for every import whether it is static or dynamic. No build
// output is written or needed.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Metafile, type Plugin } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

const graphOnly: Plugin = {
  name: "first-paint-graph",
  setup(build) {
    // Vite-only suffixes (?url, ?raw) name a file, not a module.
    build.onResolve({ filter: /\?(?:url|raw)$/ }, (args) => ({ path: args.path, external: true }));
    // `@/…` is the app (tsconfig paths); every other bare specifier is a
    // package, recorded by name and not walked.
    build.onResolve({ filter: /^[^./@]|^@(?!\/)/ }, (args) => ({ path: args.path, external: true }));
  },
};

let graph: Metafile;
beforeAll(async () => {
  const result = await build({
    entryPoints: [join(root, "src/main.tsx")],
    absWorkingDir: root,
    bundle: true,
    write: false,
    metafile: true,
    format: "esm",
    platform: "browser",
    loader: { ".css": "empty", ".webp": "empty", ".png": "empty", ".svg": "empty", ".jpg": "empty" },
    logLevel: "silent",
    plugins: [graphOnly],
  });
  graph = result.metafile;
}, 60_000);

/** Every module and package main.tsx reaches through static imports alone. */
export function staticallyReached(meta: Metafile, entry = "src/main.tsx"): Set<string> {
  const reached = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length) {
    for (const edge of meta.inputs[queue.pop()!]?.imports ?? []) {
      if (edge.kind === "dynamic-import" || reached.has(edge.path)) continue;
      reached.add(edge.path);
      if (!edge.external) queue.push(edge.path);
    }
  }
  return reached;
}

const importsOf = (file: string) => graph.inputs[file]?.imports ?? [];

describe("the first paint", () => {
  it("really is reading the app's graph, so an empty answer cannot pass", () => {
    const reached = staticallyReached(graph);
    expect(reached.size).toBeGreaterThan(200);
    for (const file of ["src/App.tsx", "src/components/ChatView.tsx", "src/components/ChatHeader.tsx", "react"]) {
      expect(reached, file).toContain(file);
    }
  });

  it("leaves the call screens and the speech model runtime to the first call", () => {
    const reached = staticallyReached(graph);
    for (const file of ["src/components/CallView.tsx", "src/components/GroupCallView.tsx", "src/lib/call-mic.ts", "src/lib/silero-vad.ts"]) {
      expect(reached, file).not.toContain(file);
      // …and they are still in the app, one dynamic import away
      expect(graph.inputs[file], file).toBeDefined();
    }
    expect([...reached].filter((path) => path.startsWith("onnxruntime-web"))).toEqual([]);
    // The buttons stay: the header shows them before anyone calls.
    expect(reached).toContain("src/components/CallControls.tsx");
  });

  it("loads the speech detector with the microphone, not with the call screen", () => {
    const silero = importsOf("src/lib/call-mic.ts").filter((edge) => edge.path === "src/lib/silero-vad.ts");
    expect(silero.map((edge) => edge.kind)).toEqual(["dynamic-import"]);
  });
});
```

In `src/components/naming.test.ts` line 72, add `"./CallControls.tsx"` to the file list.
The call button's copy moves there, so the check has to follow it:
```ts
  it.each(["./RenameTitle.tsx", "./ChatHeader.tsx", "./SettingsPanel.tsx", "./Sidebar.tsx", "./CallView.tsx", "./CallControls.tsx", "./SpeakButton.tsx", "./ChatView.tsx"])(
```

- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run src/first-paint.test.ts`
Expected: FAIL. "leaves the call screens…" fails with `expected Set{…} not to contain 'src/components/CallView.tsx'`, and "loads the speech detector…" fails with `expected [ 'import-statement' ] to deeply equal [ 'dynamic-import' ]`. `naming.test.ts` fails with ENOENT for `CallControls.tsx`.

- [ ] **Step 3: Write minimal implementation**

`src/components/LazyFallback.tsx`:
```tsx
// What a surface loaded on first use shows while its chunk arrives (spec §6).
// On a desktop that is a frame or two. On a phone over cellular it can be a
// second, and a tap that shows nothing for a second reads as a tap that did
// not land.
import { Loader2 } from "lucide-react";

export function LazyFallback() {
  return (
    <div role="status" aria-label="Loading" className="fixed inset-0 z-50 flex items-center justify-center bg-black/20">
      <Loader2 size={20} className="animate-spin text-ink-secondary" aria-hidden="true" />
    </div>
  );
}
```

`src/components/CallControls.tsx`: the header comment and imports come first. Below them,
cut `CallView.tsx` lines 81–241 (`CallButton` and `CallTargetButton`) and paste them in
unchanged. Then cut `GroupCallView.tsx` lines 29–41 (`GroupCallButton`) and paste it in
unchanged. Last come the two overlays:
```tsx
import { t } from "@/lib/i18n";
// The call controls that are on screen before anyone calls: the header's
// call buttons and the overlay switch. The call screens behind them (the
// turn-taking loop, the voice host, the microphone and its speech model)
// load on the first call (spec §6), so a phone that never calls never
// downloads them.
import { lazy, Suspense, useEffect, useId, useRef, useState } from "react";
import { Phone, PhoneOff } from "lucide-react";

import { useStore, type Bot, type Group } from "@/state/store";
import { endCall, startCall, takeCallRequest, useCallRequest, useOnCall } from "@/lib/call";
import { cn } from "@/lib/cn";
import { track } from "@/lib/analytics";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { LazyFallback } from "./LazyFallback";

const Call = lazy(() => import("./CallView").then((module) => ({ default: module.Call })));
const GroupCall = lazy(() => import("./GroupCallView").then((module) => ({ default: module.GroupCall })));

// ← CallView.tsx lines 81–241 (CallButton, CallTargetButton) go here, unchanged
// ← GroupCallView.tsx lines 29–41 (GroupCallButton) go here, unchanged

export function CallOverlay({ bot }: { bot: Bot }) {
  const active = useOnCall() === bot.id;
  if (!active) return null;
  return (
    <Suspense fallback={<LazyFallback />}>
      <Call bot={bot} />
    </Suspense>
  );
}

export function GroupCallOverlay({ group, members }: { group: Group; members: Bot[] }) {
  const active = useOnCall() === group.id;
  if (!active) return null;
  return (
    <Suspense fallback={<LazyFallback />}>
      <GroupCall group={group} members={members} />
    </Suspense>
  );
}
```
(The two `// ←` lines are instructions to whoever does the move. Do not commit them.)

`src/components/CallView.tsx`:
- Delete line 1 (`import { t } from "@/lib/i18n";`). No `t(` is left once the buttons move.
- Line 32 becomes `import { useCallback, useEffect, useRef, useState } from "react";`.
- Line 33 becomes `import { Loader2, Mic, MicOff, PhoneOff, X } from "lucide-react";`.
- Line 36 becomes `import { currentCall, deferCallCleanup, endCall } from "@/lib/call";`.
- Delete line 48 (`import { track } from "@/lib/analytics";`).
- Delete lines 81–247: `CallButton` and `CallTargetButton`, which moved, and `CallOverlay`, which is replaced.
- Line 249 `function Call({ bot }: { bot: Bot }) {` becomes `export function Call({ bot }: { bot: Bot }) {`.

`src/components/GroupCallView.tsx`:
- Line 9 becomes `import { currentCall, deferCallCleanup, endCall } from "@/lib/call";`.
- Delete line 12 (`track`) and line 20 (`CallTargetButton`).
- Delete lines 29–47 (`GroupCallButton`, which moved, and `GroupCallOverlay`, which is replaced).
- `function GroupCall(` (line 59 before these deletions) becomes `export function GroupCall(`.

Callers:
- `src/components/ChatHeader.tsx:34` becomes `import { CallButton } from "./CallControls";`.
- `src/components/ChatView.tsx:85` becomes `import { CallOverlay } from "./CallControls";`.
- `src/components/GroupView.tsx:36` becomes `import { GroupCallButton, GroupCallOverlay } from "./CallControls";`.

`src/lib/vad-threshold.ts`:
```ts
/** Silero's "this is speech" probability (Pipecat's VAD_CONFIDENCE). Its own
 *  module so the call's microphone can compare against it without loading
 *  the model runtime that produces the number (see call-mic.ts). */
export const SPEECH_CONFIDENCE = 0.7;
```

`src/lib/silero-vad.ts`: replace lines 14–22 (the imports down to the `SPEECH_CONFIDENCE`
declaration) with:
```ts
import * as ort from "onnxruntime-web/wasm";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import mjsUrl from "onnxruntime-web/ort-wasm-simd-threaded.mjs?url";
import { SPEECH_CONFIDENCE } from "./vad-threshold";

export { SPEECH_CONFIDENCE };

const CHUNK = 512;
const CONTEXT = 64;
const RATE = 16_000;
```
(The old `/** Pipecat's VAD_CONFIDENCE. */ export const SPEECH_CONFIDENCE = 0.7;` goes. Line 24
`RESET_AFTER_QUIET_CHUNKS` stays as it is.)

`src/lib/call-mic.ts`:
- Line 24 becomes two lines:
```ts
import type { SileroVad } from "./silero-vad";
import { SPEECH_CONFIDENCE } from "./vad-threshold";
```
- Lines 200–202 (`void SileroVad.load().then((vad) => { … });`) become:
```ts
    // onnxruntime is the heaviest thing a call needs and nothing else needs
    // it, so the model and its runtime arrive with the first open microphone
    // rather than with the app (spec §6). A chunk that fails to load is the
    // same as a model that cannot run: the loudness gate carries the call.
    void import("./silero-vad")
      .then(({ SileroVad }) => SileroVad.load())
      .catch(() => null)
      .then((vad) => {
        if (this.stream) this.vad = vad;
      });
```

- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run src/first-paint.test.ts src/components/naming.test.ts src/components/ChatView.test.ts src/components/ApprovalCard.test.ts && pnpm typecheck`
Expected: PASS. (`typecheck` is `tsc -b`, not a bundle build, so it is allowed on the Mac.
It catches any unused import left behind.)

- [ ] **Step 5: Commit**
```
git add src/components/CallControls.tsx src/components/LazyFallback.tsx src/lib/vad-threshold.ts src/first-paint.test.ts src/components/CallView.tsx src/components/GroupCallView.tsx src/lib/call-mic.ts src/lib/silero-vad.ts src/components/ChatHeader.tsx src/components/ChatView.tsx src/components/GroupView.tsx src/components/naming.test.ts
git commit -m "perf(ui): load call screens and the speech model on first call"
```

---

### Task E2: Lazy Settings, bot settings and the computer panel

**Files:**
- Modify: `src/App.tsx:1,8,10,12,341-351`
- Test: `src/first-paint.test.ts`

**Interfaces:**
- Consumes: `LazyFallback` and `staticallyReached()` from E1.
- Produces: `SettingsModal`, `BotSettingsDialog` and `ComputerPanel` are only reachable
  through `lazy()` in `App.tsx`. Their named exports do not change, so the tests that import
  them directly (`SettingsSearch.test.ts`, `ComputerPanel.test.ts` and others) still work.

- [ ] **Step 1: Write the failing test**

Append to the `describe("the first paint", …)` block in `src/first-paint.test.ts`:
```ts
  it("opens Settings, a bot's settings and the computer panel on first use", () => {
    const reached = staticallyReached(graph);
    for (const file of ["src/components/SettingsModal.tsx", "src/components/BotSettingsDialog.tsx", "src/components/SettingsPanel.tsx", "src/components/ComputerPanel.tsx"]) {
      expect(reached, file).not.toContain(file);
      expect(graph.inputs[file], file).toBeDefined();
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run src/first-paint.test.ts -t "opens Settings"`
Expected: FAIL with `expected Set{…} not to contain 'src/components/SettingsModal.tsx'`

- [ ] **Step 3: Write minimal implementation**

`src/App.tsx`:
- Line 1 becomes `import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";`
- Delete lines 8, 10 and 12 (the `BotSettingsDialog`, `ComputerPanel` and `SettingsModal` imports).
- After line 31 (`import { InstallPrompt } from "./components/InstallPrompt";`) add:
```tsx
import { LazyFallback } from "@/components/LazyFallback";

// Opened by a tap, so loaded by one (spec §6). Settings alone pulls in every
// settings page and, through House rules and the skill editor, Tiptap; a phone
// that never opens them never downloads them. One Suspense per surface, so a
// panel loading does not blank one that is already open.
const BotSettingsDialog = lazy(() => import("@/components/BotSettingsDialog").then((module) => ({ default: module.BotSettingsDialog })));
const ComputerPanel = lazy(() => import("@/components/ComputerPanel").then((module) => ({ default: module.ComputerPanel })));
const SettingsModal = lazy(() => import("@/components/SettingsModal").then((module) => ({ default: module.SettingsModal })));
```
- Replace lines 341–351 with:
```tsx
      {state.settingsOpen && bot && (
        <Suspense fallback={<LazyFallback />}>
          <BotSettingsDialog key={bot.id} bot={bot} />
        </Suspense>
      )}
      {state.computerOpen && bot && (
        <Suspense fallback={<LazyFallback />}>
          <ComputerPanel
            key={bot.id}
            bot={bot}
            onOpenVmWorkspace={openLocalVmWorkspace}
            onExpandBrowser={openBrowserWorkspace}
          />
        </Suspense>
      )}
      {state.inspectorOpen && bot && <InspectorPanel bot={bot} />}
      {state.appSettingsOpen && (
        <Suspense fallback={<LazyFallback />}>
          <SettingsModal />
        </Suspense>
      )}
```

- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run src/first-paint.test.ts src/components/SettingsSearch.test.ts src/components/SettingsSurface.test.ts src/components/ComputerPanel.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**
```
git add src/App.tsx src/first-paint.test.ts
git commit -m "perf(ui): load Settings, bot settings and the computer panel on first open"
```

---

### Task E3: Lazy Markdown editor in the workspace pane

**Files:**
- Modify: `src/components/WorkspacePane.tsx:24,47,180-211,603,649,796`
- Test: `src/first-paint.test.ts`

**Interfaces:**
- Consumes: `staticallyReached()` from E1.
- Produces: `WorkspacePaneSurface`'s internal `editorFor` becomes
  `(tab, read) => Promise<EditorEntry>`. The component's props do not change.
  `MarkdownEditor.tsx` keeps every export it has today.

- [ ] **Step 1: Write the failing test**

Append to `describe("the first paint", …)`:
```ts
  it("leaves both Markdown editors and Tiptap to the first edit", () => {
    const reached = staticallyReached(graph);
    for (const file of ["src/components/MarkdownEditor.tsx", "src/components/editor/RichMarkdownEditor.tsx", "src/lib/markdown-fidelity.ts"]) {
      expect(reached, file).not.toContain(file);
      expect(graph.inputs[file], file).toBeDefined();
    }
    expect([...reached].filter((path) => path.startsWith("@tiptap/"))).toEqual([]);
  });
```

- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run src/first-paint.test.ts -t "Markdown editors"`
Expected: FAIL with `expected Set{…} not to contain 'src/components/MarkdownEditor.tsx'`

- [ ] **Step 3: Write minimal implementation**

`src/components/WorkspacePane.tsx`:
- Line 24: add `lazy, Suspense,` to the React import:
  `import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";`
- Line 47 becomes:
```tsx
import type { MarkdownEditorController } from "./MarkdownEditor";
```
  Then, after the last import (the `WORKSPACE_FILES_ROUTES` block that ends at line 57), add:
```tsx
// The editor, its Tiptap kit and the fidelity checker are one chunk, loaded
// the first time a file is opened for editing (spec §6). Previewing never
// needs them.
const MarkdownEditor = lazy(() => import("./MarkdownEditor").then((module) => ({ default: module.MarkdownEditor })));
```
- Replace lines 180–184 (the head of `editorFor`, from `const editorFor = useCallback(` through `if (existing) void existing.controller.dispose();`) with:
```tsx
  const editorFor = useCallback(async (tab: WorkspaceTab, read: WorkspaceReadResult): Promise<EditorEntry> => {
    const existing = editors.current.get(tab.id);
    if (existing && existing.key === tabKey(tab)) return existing;
    const { MarkdownEditorController } = await import("./MarkdownEditor");
    // Another load of this tab may have registered an editor while the chunk
    // was on the wire; adopt it rather than open a second session.
    const settled = editors.current.get(tab.id);
    if (settled && settled.key === tabKey(tab)) return settled;
    settled?.unsubscribe();
    if (settled) void settled.controller.dispose();
```
  Lines 185–210 (from `const session = …` to `return entry;`) do not change. The
  `}, [api, drafts, dispatch]);` on line 211 stays.
- Line 603 becomes `  editorFor: (tab: WorkspaceTab, read: WorkspaceReadResult) => Promise<EditorEntry>;`
- Line 649 becomes:
```tsx
        if (tab.mode === "edit" && kind === "markdown") {
          const entry = await editorFor(tab, read);
          if (!live()) return;
          setLoad({ status: "editor", entry, read });
        } else setLoad({ status: "ready", read });
```
  (Line 650, `else setLoad({ status: "ready", read });`, is part of this replacement and is
  deleted. A chunk that fails to load lands in the existing `catch` on line 651 and shows as
  a read error.)
- Line 796 becomes:
```tsx
      {load.status === "editor" && (
        <Suspense fallback={<p role="status" className="text-[12.5px] text-ink-secondary">{t("workspacePane.opening", { name })}</p>}>
          <MarkdownEditor controller={load.entry.controller} title={tab.relativePath} />
        </Suspense>
      )}
```

- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run src/first-paint.test.ts src/components/WorkspacePane.test.ts src/components/MarkdownEditor.test.ts && pnpm typecheck`
Expected: PASS. WorkspacePane.test only renders to static markup, where effects never run,
so `load` stays `"loading"` and the lazy editor is never rendered. Its controller tests
import `MarkdownEditorController` directly.

- [ ] **Step 5: Commit**
```
git add src/components/WorkspacePane.tsx src/first-paint.test.ts
git commit -m "perf(ui): load the Markdown editor and Tiptap on first edit"
```

---

### Task E4: First-paint payload budget in CI

**Files:**
- Create: `scripts/check-bundle-budget.mjs`
- Create: `scripts/check-bundle-budget.test.mjs`
- Modify: `vite.config.ts:10` (add `build.manifest`)
- Modify: `package.json:26` (add a script)
- Modify: `.github/workflows/ci.yml:228` (add a step after `production UI build` in the human-spec shard job)
- Test: `scripts/check-bundle-budget.test.mjs`

**Interfaces:**
- Consumes: the Vite manifest at `dist/.vite/manifest.json`, which Vite 7 writes when
  `build.manifest: true`.
- Produces, from `scripts/check-bundle-budget.mjs`:
  - `FIRST_PAINT_BROTLI_BUDGET` (bytes)
  - `DOOR_ASSET` (RegExp)
  - `firstPaintFiles(manifest, entry = "index.html"): string[]`
  - `brotliSize(bytes: Buffer): number`
  - `checkBudget(distDir: string, budget?: number): { ok: boolean; total: number; budget: number; files: Array<{ file: string; raw: number; brotli: number }>; doorMisses: string[] }`
  - A CLI, run as `pnpm check:bundle-budget [distDir]`

**The budget: 750 KiB brotli (quality 11) for `index.html` plus the entry chunk, its static
imports and their CSS.**

How that number was reached:
- The newest build on this disk (`muragemobile/integration-20260922/dist`, which predates
  onnxruntime) has an entry `index-*.js` of 5,072,957 bytes. That is 876,661 bytes at brotli
  q11 (1,008,585 at q5 and 1,139,884 as gzip -9). Its CSS is 18,229 bytes at q11. Measured
  with `node:zlib` in the scratchpad.
- The spec puts today's entry chunk at 5.07–5.5 MB, so today's first paint is about
  900–950 KiB at q11.
- E1–E3 remove Tiptap and ProseMirror, the `onnxruntime-web/wasm` API, and about 1.0 MB of
  app source out of 6.9 MB statically reached (source bytes, comments included). A fair
  estimate is 200–250 KiB brotli, which lands at about 700 KiB.
- So 750 KiB is the post-split size with headroom. It is **not** the spec's "40–60%
  smaller", which would be about 400–550 KiB. See Notes 1 for why the listed splits do not
  reach that, and what would.

Decision rule for Step 6: once E1–E3 have landed, measure on Hetzner. If the measurement is
below 700 KiB, lower the constant to the measurement rounded up to 10 KiB, plus 20 KiB, so
the check keeps its teeth. If it is above 750 KiB, one of the splits did not take. The
script's per-file listing shows which one. Raising the budget is not the fix.

- [ ] **Step 1: Write the failing test**

`scripts/check-bundle-budget.test.mjs`:
```js
// The first-paint budget (spec §6: "CI fails if the first-paint brotli size
// goes over budget"). The real dist/ only exists after a build, so the logic
// is proved here against a fixture build: a manifest, an entry, a static
// import, a lazy chunk the first paint must NOT count, and the CSS.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
import { BROWSER_STATIC } from "../companion/src/routes.ts";
import { DOOR_ASSET, FIRST_PAINT_BROTLI_BUDGET, brotliSize, checkBudget, firstPaintFiles } from "./check-bundle-budget.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) safeWipeSync(root); });

/** A dist/ with random (incompressible) bytes, so brotli sizes are predictable. */
function fixture({ lazyName = "assets/CallView-Cc3.js" } = {}) {
  const dist = mkdtempSync(join(tmpdir(), "murage-budget-"));
  roots.push(dist);
  mkdirSync(join(dist, "assets"));
  mkdirSync(join(dist, ".vite"));
  const files = {
    "index.html": Buffer.from('<!doctype html><script type="module" src="/assets/index-Aa1.js"></script>'),
    "assets/index-Aa1.js": randomBytes(4000),
    "assets/vendor-Bb2.js": randomBytes(3000),
    "assets/index-Dd4.css": randomBytes(500),
    [lazyName]: randomBytes(50_000),
  };
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dist, name), bytes);
  const manifest = {
    "index.html": { file: "assets/index-Aa1.js", src: "index.html", isEntry: true, imports: ["_vendor-Bb2.js"], dynamicImports: ["src/components/CallView.tsx"], css: ["assets/index-Dd4.css"] },
    "_vendor-Bb2.js": { file: "assets/vendor-Bb2.js", imports: ["index.html"] },
    "src/components/CallView.tsx": { file: lazyName, isDynamicEntry: true, imports: ["_vendor-Bb2.js"] },
  };
  writeFileSync(join(dist, ".vite", "manifest.json"), JSON.stringify(manifest));
  return { dist, files, manifest };
}

describe("first-paint payload budget", () => {
  it("counts the entry, its static imports and their CSS, and not a lazy chunk", () => {
    const { manifest } = fixture();
    expect(firstPaintFiles(manifest)).toEqual(["assets/index-Aa1.js", "assets/index-Dd4.css", "assets/vendor-Bb2.js"]);
  });

  it("totals the brotli size of exactly those files plus the page", () => {
    const { dist, files } = fixture();
    const expected = ["index.html", "assets/index-Aa1.js", "assets/vendor-Bb2.js", "assets/index-Dd4.css"]
      .reduce((sum, name) => sum + brotliSize(files[name]), 0);
    const result = checkBudget(dist, 1_000_000);
    expect(result.total).toBe(expected);
    expect(result.ok).toBe(true);
  });

  it("fails one byte over the budget and passes at it", () => {
    const { dist } = fixture();
    const { total } = checkBudget(dist, 1_000_000);
    expect(checkBudget(dist, total).ok).toBe(true);
    expect(checkBudget(dist, total - 1).ok).toBe(false);
  });

  it("fails a chunk the browser door would 404, even a lazy one", () => {
    // companion/src/routes.ts serves /assets/ only for [\w-]+ names: a phone
    // would get a 404 for this chunk while the desktop works.
    const { dist } = fixture({ lazyName: "assets/ort.wasm.min-Cc3.js" });
    const result = checkBudget(dist, 1_000_000);
    expect(result.doorMisses).toEqual(["assets/ort.wasm.min-Cc3.js"]);
    expect(result.ok).toBe(false);
  });

  it("agrees with the browser door about script and style names", () => {
    const door = BROWSER_STATIC.filter((entry) => entry.method === "GET").map((entry) => entry.path);
    const served = (name) => door.some((path) => path.test(`/${name}`));
    for (const name of ["assets/CallView-Cc3_x.js", "assets/index-Dd4.css", "assets/ort.wasm.min-Cc3.js", "assets/a b.js"]) {
      expect(DOOR_ASSET.test(name), name).toBe(served(name));
    }
  });

  it("refuses a dist/ without a manifest instead of passing it", () => {
    const dist = mkdtempSync(join(tmpdir(), "murage-budget-"));
    roots.push(dist);
    expect(() => checkBudget(dist)).toThrow(/build\.manifest/);
  });

  it("holds the budget the spec set, not a placeholder", () => {
    expect(FIRST_PAINT_BROTLI_BUDGET).toBe(750 * 1024);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run scripts/check-bundle-budget.test.mjs`
Expected: FAIL with `Failed to load url ./check-bundle-budget.mjs` (the module does not exist yet)

- [ ] **Step 3: Write minimal implementation**

`scripts/check-bundle-budget.mjs`:
```js
// The first-paint payload budget (spec §6).
//
// A phone opening Murage over cellular downloads index.html, the entry chunk,
// every chunk the entry statically imports, and their CSS before it can draw a
// message. That set is what this measures, compressed the way the door will
// send it (brotli), after `vite build` and against the manifest Vite writes
// (vite.config.ts `build.manifest`). Chunks behind `lazy()` or `import()` are
// not counted; that is the point of them.
//
// It also fails a script or stylesheet the browser door would refuse. The door
// serves `/assets/` by an exact name pattern (companion/src/routes.ts
// BROWSER_STATIC), so a chunk named with a dot in its stem 404s on a phone and
// works on the desktop, which no desktop test would notice.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants } from "node:zlib";

/** 750 KiB at brotli quality 11. Set after the E1–E3 splits from the measured
 *  pre-split first paint (~900–950 KiB); the reasoning is in the plan that
 *  introduced it. Lower it when the first paint shrinks; never raise it to
 *  make a regression pass. */
export const FIRST_PAINT_BROTLI_BUDGET = 750 * 1024;

/** The door's `/assets/` pattern for the file types this checks (js, css). */
export const DOOR_ASSET = /^assets\/[\w-]+\.(?:js|css|woff2|svg|png|json)$/;

export function brotliSize(bytes) {
  return brotliCompressSync(bytes, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength },
  }).byteLength;
}

/** The files the first paint loads: the entry chunk, its static imports
 *  (transitively), and their CSS. Dynamic imports are not followed. */
export function firstPaintFiles(manifest, entry = "index.html") {
  const files = new Set();
  const seen = new Set();
  const visit = (key) => {
    if (seen.has(key)) return;
    seen.add(key);
    const chunk = manifest[key];
    if (!chunk) throw new Error(`the Vite manifest has no chunk "${key}"`);
    if (key !== entry || chunk.file) files.add(chunk.file);
    for (const css of chunk.css ?? []) files.add(css);
    for (const next of chunk.imports ?? []) visit(next);
  };
  visit(entry);
  return [...files].sort();
}

function readManifest(distDir) {
  const path = join(distDir, ".vite", "manifest.json");
  if (!existsSync(path)) {
    throw new Error(`${path} is missing: build with vite.config.ts build.manifest on, then run this again`);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

export function checkBudget(distDir, budget = FIRST_PAINT_BROTLI_BUDGET) {
  const manifest = readManifest(distDir);
  const files = ["index.html", ...firstPaintFiles(manifest)].map((file) => {
    const bytes = readFileSync(join(distDir, file));
    return { file, raw: bytes.byteLength, brotli: brotliSize(bytes) };
  });
  const total = files.reduce((sum, entry) => sum + entry.brotli, 0);
  const emitted = new Set(Object.values(manifest).flatMap((chunk) => [chunk.file, ...(chunk.css ?? [])]));
  const doorMisses = [...emitted].filter((file) => /\.(?:js|css)$/.test(file) && !DOOR_ASSET.test(file)).sort();
  return { ok: total <= budget && doorMisses.length === 0, total, budget, files, doorMisses };
}

const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const distDir = process.argv[2] ?? fileURLToPath(new URL("../dist", import.meta.url));
  const result = checkBudget(distDir);
  for (const entry of result.files) process.stdout.write(`  ${kib(entry.brotli).padStart(11)} br  ${kib(entry.raw).padStart(11)} raw  ${entry.file}\n`);
  process.stdout.write(`First paint: ${kib(result.total)} brotli, budget ${kib(result.budget)}.\n`);
  if (result.total > result.budget) {
    process.stderr.write(`Over the first-paint budget by ${kib(result.total - result.budget)}. Something reached from src/main.tsx statically that should load on first use (see src/first-paint.test.ts).\n`);
  }
  if (result.doorMisses.length) {
    process.stderr.write(`The browser door would refuse these chunks (companion/src/routes.ts BROWSER_STATIC):\n${result.doorMisses.map((file) => `  ${file}`).join("\n")}\n`);
  }
  if (!result.ok) process.exitCode = 1;
}
```

`vite.config.ts`: after the `plugins: [...]` line (line 10) add:
```ts
  build: {
    // dist/.vite/manifest.json: which files the first paint loads, read by
    // scripts/check-bundle-budget.mjs after every CI build (spec §6)
    manifest: true,
  },
```

`package.json`: after line 26 (`"check:contrast": …`) add:
```json
    "check:bundle-budget": "node scripts/check-bundle-budget.mjs",
```

`.github/workflows/ci.yml`: in the human-spec shard job, right after the
`production UI build` step (lines 227–228), add:
```yaml
      - name: First-paint payload budget
        # spec §6; one shard is enough, every shard built the same dist/
        if: matrix.human_shard == 1
        run: pnpm check:bundle-budget
```

- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run scripts/check-bundle-budget.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**
```
git add scripts/check-bundle-budget.mjs scripts/check-bundle-budget.test.mjs vite.config.ts package.json .github/workflows/ci.yml
git commit -m "ci: fail the build when the first-paint brotli payload goes over budget"
```

- [ ] **Step 6: Measure on Hetzner (after E1–E3 have landed) and apply the decision rule**
Run on the build box, never on the Mac:
`ssh hetzner-dsm 'cd /root/fuigo-builds/<lane>/app && pnpm install --frozen-lockfile && pnpm exec vite build && pnpm check:bundle-budget'`
Expected: `First paint: <N> KiB brotli, budget 750.0 KiB.` with exit code 0. Put `<N>` in the
commit message. If `<N>` is below 700, change `FIRST_PAINT_BROTLI_BUDGET` and the last test
together, to `ceil(N/10)*10 + 20` KiB. Then delete the lane's `dist/` and `node_modules` on
Hetzner.

---

### Task E5: One definition of "this client is a phone"

**Files:**
- Create: `src/lib/phone-client.ts`
- Test: `src/lib/phone-client.test.ts`

**Interfaces:**
- Consumes: nothing. This task deliberately does not depend on the §3.6 native-shell
  detection task. It reads the user-agent token that §3.2 defines (`MurageApp/<version>`)
  directly, so either task can land first.
- Produces:
  - `phoneClientFrom(probe: PhoneProbe): boolean`
  - `isPhoneClient(): boolean`, memoised per page load
  - `phonePollMs(desktopMs: number, phone: boolean): number`
  - `type PhoneProbe = { userAgent: string; coarsePointer: boolean; shortSide: number; desktopBridge: boolean }`

- [ ] **Step 1: Write the failing test**

`src/lib/phone-client.test.ts`:
```ts
import { describe, expect, it } from "vitest";

import { phoneClientFrom, phonePollMs, type PhoneProbe } from "./phone-client";

const iphone: PhoneProbe = { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1", coarsePointer: true, shortSide: 390, desktopBridge: false };

describe("phoneClientFrom", () => {
  it("is a phone for the native shell whatever the screen says", () => {
    expect(phoneClientFrom({ ...iphone, userAgent: `${iphone.userAgent} MurageApp/1.0.0 (ios)`, coarsePointer: false, shortSide: 1024 })).toBe(true);
  });

  it("is a phone for a touch screen whose short side is phone-sized", () => {
    expect(phoneClientFrom(iphone)).toBe(true);
  });

  it("stays a phone held sideways: the short side does not rotate", () => {
    // 844x390 in landscape is wider than md, which a viewport query would
    // read as a tablet; the screen's short side is still 390.
    expect(phoneClientFrom({ ...iphone, shortSide: 390 })).toBe(true);
  });

  it("is not a phone for a tablet", () => {
    expect(phoneClientFrom({ ...iphone, shortSide: 820 })).toBe(false);
  });

  it("is not a phone for a narrow desktop window: the pointer is fine", () => {
    expect(phoneClientFrom({ ...iphone, userAgent: "Mozilla/5.0 (Macintosh) Chrome/140", coarsePointer: false, shortSide: 390 })).toBe(false);
  });

  it("is never a phone inside the desktop app, even on a touch laptop", () => {
    expect(phoneClientFrom({ ...iphone, desktopBridge: true })).toBe(false);
  });
});

describe("phonePollMs", () => {
  it("halves the rate on a phone and leaves the desktop alone", () => {
    expect(phonePollMs(4000, true)).toBe(8000);
    expect(phonePollMs(30_000, true)).toBe(60_000);
    expect(phonePollMs(4000, false)).toBe(4000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run src/lib/phone-client.test.ts`
Expected: FAIL with `Failed to resolve import "./phone-client"`

- [ ] **Step 3: Write minimal implementation**

`src/lib/phone-client.ts`:
```ts
// Is this client a phone? (spec §6 "phone mode")
//
// A phone pays for bytes and battery the desktop does not notice: live screen
// frames every few seconds, every thread's transcript at boot, a computer
// preview polled every 4 s. Those decisions all ask this one question, once
// per page load, so they can never disagree.
//
// A phone is the native shell (its user agent carries `MurageApp/`, spec
// §3.2), or a coarse pointer on a screen whose SHORT side is phone-sized. The
// short side of the screen, not the viewport width: a phone turned sideways
// is 844 px wide and is still a phone, and a desktop window dragged narrow is
// not one. The desktop app's bridge rules out a touch-screen laptop.

export interface PhoneProbe {
  userAgent: string;
  coarsePointer: boolean;
  /** min(screen.width, screen.height), CSS px. */
  shortSide: number;
  /** window.muragebox exists: the Electron preload ran. */
  desktopBridge: boolean;
}

/** Below Tailwind's md: the line NARROW_MEDIA_QUERY (lib/media-query.ts) draws. */
const PHONE_SHORT_SIDE = 768;
const NATIVE_SHELL = /\bMurageApp\//;

export function phoneClientFrom(probe: PhoneProbe): boolean {
  if (probe.desktopBridge) return false;
  if (NATIVE_SHELL.test(probe.userAgent)) return true;
  return probe.coarsePointer && probe.shortSide > 0 && probe.shortSide < PHONE_SHORT_SIDE;
}

let answer: boolean | undefined;

/** Asked once per page load; rotating the phone does not change it. */
export function isPhoneClient(): boolean {
  if (answer !== undefined) return answer;
  const screen = globalThis.screen;
  answer = phoneClientFrom({
    userAgent: globalThis.navigator?.userAgent ?? "",
    coarsePointer: globalThis.matchMedia?.("(pointer: coarse)").matches ?? false,
    shortSide: screen ? Math.min(screen.width, screen.height) : 0,
    desktopBridge: Boolean((globalThis as { muragebox?: unknown }).muragebox),
  });
  return answer;
}

/** A poll interval for a phone: half the rate, same shape (see ComputerPanel). */
export function phonePollMs(desktopMs: number, phone: boolean): number {
  return phone ? desktopMs * 2 : desktopMs;
}
```

- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run src/lib/phone-client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**
```
git add src/lib/phone-client.ts src/lib/phone-client.test.ts
git commit -m "feat(ui): one phone-client check for phone mode"
```

---

### Task E6: Phone mode: no live screen frames, and a slim boot for every thread but the one on screen

**Files:**
- Modify: `src/lib/scrollback.ts:21` (add after `MESSAGE_PAGE_SIZE`)
- Modify: `src/state/store.tsx:52,2687,2694,2808,3050`
- Modify: `server/thread-paging-api.test.ts` (append a describe block)
- Test: `src/lib/scrollback.test.ts`, `src/state/phone-mode.test.ts` (new), `server/thread-paging-api.test.ts`

**Interfaces:**
- Consumes: `isPhoneClient()` from E5. The server's `/api/bots?messages=n` and
  `newestPageLimit()` (`server/index.ts:2927-2929`) do not change.
- Produces:
  - `PHONE_HYDRATE_PAGE = 1`
  - `hydratePageSize(phone: boolean): number`
  - `needsNewestPage(owner: { messages: Message[]; hasMore?: boolean }): boolean`

  All three are exported from `src/lib/scrollback.ts`.

**Why `messages=1`, not the spec's `messages=0`:** see Notes 2. In short, `0` drops open
approval cards and every thread's last message, and leaves nothing to page back from.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/scrollback.test.ts`. Also extend its import on line 4 to
`import { createScrollback, hydratePageSize, MESSAGE_PAGE_MAX, MESSAGE_PAGE_SIZE, needsNewestPage, PHONE_HYDRATE_PAGE, unheardMessages } from "./scrollback";`
```ts
describe("phone hydrate (spec §6)", () => {
  it("asks for one row per thread on a phone and a full page elsewhere", () => {
    expect(hydratePageSize(true)).toBe(PHONE_HYDRATE_PAGE);
    expect(PHONE_HYDRATE_PAGE).toBe(1);
    expect(hydratePageSize(false)).toBe(MESSAGE_PAGE_SIZE);
  });

  it("tops up a slim thread to a full page with one ordinary scrollback request", async () => {
    const r = rig(300, 1);
    expect(needsNewestPage(r.state.bots[0])).toBe(true);
    await r.scrollback.loadOlder("t");
    expect(r.requests).toEqual([`/api/threads/t/messages?limit=${MESSAGE_PAGE_SIZE}&before=m299`]);
    expect(r.state.bots[0].messages).toHaveLength(MESSAGE_PAGE_SIZE + 1);
    expect(needsNewestPage(r.state.bots[0])).toBe(false);
  });

  it("leaves a short thread alone once it holds all of it", async () => {
    const r = rig(40, 1);
    await r.scrollback.loadOlder("t");
    expect(r.state.bots[0].messages).toHaveLength(40);
    expect(r.state.bots[0].hasMore).toBe(false);
    expect(needsNewestPage(r.state.bots[0])).toBe(false);
  });

  it("never tops up a desktop page, which is full whenever there is more", () => {
    expect(needsNewestPage({ messages: Array.from({ length: MESSAGE_PAGE_SIZE }, (_, i) => ({ id: `m${i}` }) as Message), hasMore: true })).toBe(false);
    expect(needsNewestPage({ messages: [{ id: "m0" } as Message], hasMore: false })).toBe(false);
  });
});
```
(`rig(total, held)` at `scrollback.test.ts:8-35` already exposes `state` through a getter
and `requests`, so it needs no change.)

New `src/state/phone-mode.test.ts` (a source contract, the same style as
`ChatView.test.ts`, because the store's boot effect needs a live stream and DOM to run):
```ts
// Phone mode's wiring in the store (spec §6). The rules themselves are unit
// tested in lib/phone-client.test.ts and lib/scrollback.test.ts; this pins that
// the store actually asks them, at the two places the spec names.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const store = readFileSync(fileURLToPath(new URL("./store.tsx", import.meta.url)), "utf8");

describe("phone mode in the store", () => {
  it("hydrates with the phone's page size, not a fixed one", () => {
    expect(store).toContain("api(`/api/bots?messages=${hydratePageSize(phone)}`)");
    expect(store).not.toContain("api(`/api/bots?messages=${MESSAGE_PAGE_SIZE}`).then(({ bots, groups, computerControl })");
  });

  it("opens the event stream without live screen frames on a phone", () => {
    expect(store).toMatch(/openLiveEvents\(\{\s*screens: phone \? false : undefined,/);
  });

  it("asks the answer once, at the top of the boot effect", () => {
    expect(store.match(/const phone = isPhoneClient\(\);/g)).toHaveLength(1);
  });

  it("tops up the conversation on screen through the scrollback path", () => {
    expect(store).toMatch(/needsNewestPage\(onScreen\)/);
    expect(store).toMatch(/dispatch\(\{ type: "loadOlderMessages", threadId: topUpThread \}\)/);
  });
});
```

Append to `server/thread-paging-api.test.ts`:
```ts
describe("a phone's slim hydrate (spec §6)", () => {
  it("still carries the open request card, and says there is more", async () => {
    expect((await call("POST", `/api/bots/${ids.bot}/tasks/${ids.long}?messages=0`)).status).toBe(200);
    const slim = (await call("GET", "/api/bots?messages=1")).body.bots.find((bot: any) => bot.id === ids.bot);
    expect(slim.threadId).toBe(ids.long);
    // one row was asked for; the page reaches back to the open card
    expect(slim.messages).toHaveLength(LONG - CARD_AT);
    expect(slim.messages[0].id).toBe(ids.card);
    expect(slim.hasMore).toBe(true);
    // zero is "settings only": the card a phone has to answer would be gone
    const bare = (await call("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === ids.bot);
    expect(bare.messages).toEqual([]);
  });

  it("is the newest row alone for a thread with nothing open", async () => {
    expect((await call("POST", `/api/bots/${ids.bot}/tasks/${ids.short}?messages=0`)).status).toBe(200);
    const slim = (await call("GET", "/api/bots?messages=1")).body.bots.find((bot: any) => bot.id === ids.bot);
    expect(texts(slim.messages)).toEqual(["short 2"]);
    expect(slim.hasMore).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run src/lib/scrollback.test.ts src/state/phone-mode.test.ts server/thread-paging-api.test.ts`
Expected:
- scrollback fails with `hydratePageSize is not a function` or an equivalent import error.
- phone-mode fails with `expected '…' to contain 'api(\`/api/bots?messages=${hydratePageSize(phone)}\`)'`.
- thread-paging passes already. That is intended: it pins the server behaviour the client
  now depends on, so a later change to `newestPageLimit` cannot quietly break phones.

- [ ] **Step 3: Write minimal implementation**

`src/lib/scrollback.ts`, after line 21 (`export const MESSAGE_PAGE_SIZE = 100;`):
```ts
/** A phone's boot page per thread (spec §6 phone mode). One row, which the
 * server widens to reach back to every open request card and the active
 * branch head (server newestPageLimit), so a phone still sees what needs it
 * and each thread's latest line, without every thread's history. `0` would
 * be settings only: no cards, no latest line, and nothing to page back from. */
export const PHONE_HYDRATE_PAGE = 1;

export function hydratePageSize(phone: boolean): number {
  return phone ? PHONE_HYDRATE_PAGE : MESSAGE_PAGE_SIZE;
}

/** A conversation holding less than a newest page while the server has more:
 * a phone's slim boot page. A snapshot or switch always holds at least a full
 * page when there is more, so on the desktop this is never true. */
export function needsNewestPage(owner: { messages: Message[]; hasMore?: boolean }): boolean {
  return Boolean(owner.hasMore) && owner.messages.length < MESSAGE_PAGE_SIZE;
}
```

`src/state/store.tsx`:
- Line 52 becomes
  `import { createScrollback, hydratePageSize, MESSAGE_PAGE_SIZE, needsNewestPage } from "@/lib/scrollback";`
  and a new import follows line 55:
  `import { isPhoneClient } from "@/lib/phone-client";`
- After line 2687 (`}, [botPatchQueue,threadWrites]);`, the end of the `dispatch` useMemo) add:
```tsx
  // Phone mode boots every thread as a one-row page (hydratePageSize). The
  // conversation on screen gets its newest page right away, through the same
  // request "Load earlier" makes, whenever it is selected or switched to.
  const onScreen =
    state.bots.find((candidate) => candidate.id === state.selectedId) ??
    state.groups.find((candidate) => candidate.id === state.selectedId);
  const topUpThread = onScreen && needsNewestPage(onScreen) ? onScreen.threadId : null;
  useEffect(() => {
    if (topUpThread && !stateRef.current.loadingOlder[topUpThread]) dispatch({ type: "loadOlderMessages", threadId: topUpThread });
  }, [topUpThread, dispatch]);
```
  This cannot loop. A successful top-up leaves a full page or `hasMore: false`, so
  `topUpThread` becomes `null`. A failed one leaves the same value, so the effect does not
  run again, and the "Load earlier" button is still there.
- Line 2694, directly after `let alive = true;` at the top of the boot effect, add:
```tsx
    // Asked once for the life of this effect: the stream and the hydrate
    // below must agree about what kind of client this is.
    const phone = isPhoneClient();
```
- Line 2808 becomes `        api(\`/api/bots?messages=${hydratePageSize(phone)}\`).then(({ bots, groups, computerControl }) => {`
  and the comment above it (lines 2805–2807) gains one sentence:
  `// A phone asks for one row per thread and pages the one on screen in (spec §6).`
- Line 3050 becomes:
```tsx
      stopLive = openLiveEvents({
        // A phone never receives live computer frames: a base64 capture every
        // few seconds while a bot works is the heaviest thing on the stream.
        // Its computer panel polls instead (ComputerPanel, sseFlowing).
        screens: phone ? false : undefined,
```
  The rest of that object literal (lines 3051–3062) does not change.

- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run src/lib/scrollback.test.ts src/state/phone-mode.test.ts server/thread-paging-api.test.ts src/lib/live-events.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**
```
git add src/lib/scrollback.ts src/lib/scrollback.test.ts src/state/store.tsx src/state/phone-mode.test.ts server/thread-paging-api.test.ts
git commit -m "perf(ui): phone mode boots slim and drops live screen frames"
```

---

### Task E7: The computer panel polls at half rate on a phone

**Files:**
- Modify: `src/components/ComputerPanel.tsx:34,606,631`
- Modify: `src/components/ComputerPanel.test.ts` (append)
- Test: `src/components/ComputerPanel.test.ts`

**Interfaces:**
- Consumes: `isPhoneClient()` and `phonePollMs()` from E5.
- Produces: nothing new.

A smaller image was **not** done. It is not simple: see Notes 7.

- [ ] **Step 1: Write the failing test**

Append to `src/components/ComputerPanel.test.ts`. Its line 1 imports only `vitest`, so
add `import { readFileSync } from "node:fs";` and `import { fileURLToPath } from "node:url";`
below it:
```ts
describe("the preview poll on a phone (spec §6)", () => {
  const source = readFileSync(fileURLToPath(new URL("./ComputerPanel.tsx", import.meta.url)), "utf8");
  it("halves both preview polls on a phone and leaves the desktop's rate alone", () => {
    expect(source).toContain("setInterval(shoot, phonePollMs(bot.busy ? 4000 : 30_000, phone))");
    expect(source).toContain("window.setInterval(() => void shoot(), phonePollMs(bot.busy ? 3000 : 30_000, phone))");
    expect(source).toMatch(/const phone = isPhoneClient\(\);/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run src/components/ComputerPanel.test.ts -t "on a phone"`
Expected: FAIL with `expected '…' to contain 'setInterval(shoot, phonePollMs(bot.busy ? 4000 : 30_000, phone))'`

- [ ] **Step 3: Write minimal implementation**

`src/components/ComputerPanel.tsx`:
- After line 34 (`import { usePageVisible } from "@/lib/page-visible";`) add
  `import { isPhoneClient, phonePollMs } from "@/lib/phone-client";`
- Line 585 (`const pageVisible = usePageVisible();`) is followed by:
```tsx
  // A phone also gets no live frames (store: screens off), so the poll below
  // is its only feed; half the rate keeps a drawer left open off the radio.
  const phone = isPhoneClient();
```
- Line 606 becomes `    const timer = setInterval(shoot, phonePollMs(bot.busy ? 4000 : 30_000, phone));`
- Line 631 becomes `    const timer = window.setInterval(() => void shoot(), phonePollMs(bot.busy ? 3000 : 30_000, phone));`

`phone` is constant for the page's life, so neither effect's dependency list changes.

- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run src/components/ComputerPanel.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**
```
git add src/components/ComputerPanel.tsx src/components/ComputerPanel.test.ts
git commit -m "perf(ui): halve the computer preview poll on phones"
```

---

### Task E8: Transcript window capped at both ends

**Files:**
- Modify: `src/lib/transcript-window.ts` (append after `windowAfterPrepend`, line 95)
- Test: `src/lib/transcript-window.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, all exported from `src/lib/transcript-window.ts` (E10 uses them):
  - `MAX_MOUNTED_ROWS = 360`
  - `type WindowBounds = { start: number; end: number | null }`
  - `expandEarlier(bounds, total, size?, cap?): WindowBounds`
  - `expandLater(bounds, total, size?, cap?): WindowBounds`
  - `trimFollowedTail(bounds, total, following, size?, cap?): WindowBounds`

  `trimFollowedTail` returns the same object when nothing changes.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/transcript-window.test.ts`, and add `MAX_MOUNTED_ROWS, expandEarlier,
expandLater, trimFollowedTail` to its import:
```ts
describe("a capped window (spec §6)", () => {
  it("caps at three windows", () => {
    expect(MAX_MOUNTED_ROWS).toBe(TRANSCRIPT_WINDOW_SIZE * 3);
  });

  it("reads back without a cap until three windows are mounted", () => {
    // tail of 1000: 880..end; two clicks back mounts 360 rows, all of them
    expect(expandEarlier({ start: 880, end: null }, 1000)).toEqual({ start: 760, end: null });
    expect(expandEarlier({ start: 760, end: null }, 1000)).toEqual({ start: 640, end: null });
  });

  it("unmounts the newest rows once reading back passes the cap", () => {
    // 640..1000 is 360 mounted; one more step back drops the newest 120
    expect(expandEarlier({ start: 640, end: null }, 1000)).toEqual({ start: 520, end: 880 });
    expect(expandEarlier({ start: 520, end: 880 }, 1000)).toEqual({ start: 400, end: 760 });
  });

  it("clamps at the top of the thread and still honours the cap", () => {
    expect(expandEarlier({ start: 50, end: 400 }, 1000)).toEqual({ start: 0, end: 360 });
  });

  it("reads forward again, unmounting the oldest rows past the cap", () => {
    expect(expandLater({ start: 400, end: 760 }, 1000)).toEqual({ start: 520, end: 880 });
  });

  it("becomes a live tail again when reading forward reaches the end", () => {
    expect(expandLater({ start: 520, end: 880 }, 1000)).toEqual({ start: 640, end: null });
  });

  it("reads forward inside the cap without moving the start", () => {
    expect(expandLater({ start: 100, end: 220 }, 1000)).toEqual({ start: 100, end: 340 });
  });

  it("cuts a followed live tail back to one window once it passes the cap", () => {
    // a long live session appended 361 rows since the window was opened
    expect(trimFollowedTail({ start: 0, end: null }, 361, true)).toEqual({ start: 241, end: null });
  });

  it("leaves a tail the reader is not following exactly where it is", () => {
    const bounds = { start: 0, end: null };
    expect(trimFollowedTail(bounds, 5000, false)).toBe(bounds);
  });

  it("leaves a finite window, and a tail inside the cap, alone", () => {
    const finite = { start: 0, end: 400 };
    expect(trimFollowedTail(finite, 5000, true)).toBe(finite);
    const small = { start: 0, end: null };
    expect(trimFollowedTail(small, MAX_MOUNTED_ROWS, true)).toBe(small);
  });

  it("does not grow past the cap on an empty or short thread", () => {
    expect(expandEarlier({ start: 0, end: null }, 0)).toEqual({ start: 0, end: null });
    expect(expandLater({ start: 0, end: 10 }, 10)).toEqual({ start: 0, end: null });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run src/lib/transcript-window.test.ts -t "capped window"`
Expected: FAIL with `MAX_MOUNTED_ROWS is not defined` (or `expandEarlier is not a function`)

- [ ] **Step 3: Write minimal implementation**

Append to `src/lib/transcript-window.ts`:
```ts
/** The most transcript rows mounted at once (spec §6). Reading back used to
 * grow the window without end: every "Show earlier" added a window and none
 * was ever taken away, so an hour of scrollback on a phone meant thousands of
 * live rows. Three windows is one on screen with a window of slack each way. */
export const MAX_MOUNTED_ROWS = TRANSCRIPT_WINDOW_SIZE * 3;

export interface WindowBounds {
  start: number;
  /** null: a live tail that grows with appends. */
  end: number | null;
}

/** "Show earlier" (or reaching the top). The start steps back; past the cap
 * the newest rows unmount, and the end becomes finite so "Show later" can
 * bring them back. The reader is reading back, so the rows dropped are the
 * ones below the screen. */
export function expandEarlier(
  bounds: WindowBounds,
  total: number,
  size: number = TRANSCRIPT_WINDOW_SIZE,
  cap: number = MAX_MOUNTED_ROWS,
): WindowBounds {
  const start = expandWindowStart(Math.min(bounds.start, total), size);
  const end = bounds.end === null ? total : Math.min(bounds.end, total);
  if (end - start <= cap) return { start, end: bounds.end === null ? null : end };
  return { start, end: start + cap };
}

/** "Show later". The mirror image: the end steps forward, and past the cap
 * the oldest rows unmount. Reaching the end of the thread is a live tail
 * again. */
export function expandLater(
  bounds: WindowBounds,
  total: number,
  size: number = TRANSCRIPT_WINDOW_SIZE,
  cap: number = MAX_MOUNTED_ROWS,
): WindowBounds {
  const end = bounds.end === null ? total : Math.min(total, bounds.end + size);
  const start = Math.max(bounds.start, end - cap);
  return { start, end: end >= total ? null : end };
}

/** A tail the reader is following grows with every append; a long live
 * session would mount rows without end. Past the cap it is cut back to one
 * fresh window. Only while following: the reader is pinned to the bottom, so
 * rows leaving the top were already off screen. A reader who scrolled up is
 * never moved (anchored window, see resolveTranscriptWindow). */
export function trimFollowedTail(
  bounds: WindowBounds,
  total: number,
  following: boolean,
  size: number = TRANSCRIPT_WINDOW_SIZE,
  cap: number = MAX_MOUNTED_ROWS,
): WindowBounds {
  if (!following || bounds.end !== null || total - bounds.start <= cap) return bounds;
  return { start: tailWindowStart(total, size), end: null };
}
```

- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run src/lib/transcript-window.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**
```
git add src/lib/transcript-window.ts src/lib/transcript-window.test.ts
git commit -m "perf(ui): cap mounted transcript rows at both ends"
```

---

### Task E9: Row-anchored scroll restore and "seen" rows

**Files:**
- Create: `src/lib/transcript-rows.ts`
- Test: `src/lib/transcript-rows.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type ScrollAnchor = { key: string; id: string; offset: number }`
  - `captureRowAnchor(scroller: AnchorScroller, key: string, edge: "first" | "last"): ScrollAnchor | null`
  - `restoreRowAnchor(scroller: AnchorScroller, anchor: ScrollAnchor): boolean`
  - `observeSeenRows(root: SeenRoot, scroller: Element, Observer?: typeof IntersectionObserver): () => void`
  - `ROW_SELECTOR = "[data-row]"`
  - `SEEN_ATTRIBUTE = "data-seen"`

  Both views (E10) use all of these.

Why this exists: today's restore shifts `scrollTop` by the growth in `scrollHeight`. That is
right only when rows are added above and nothing is removed. With E8's cap, one step can add
rows above and remove rows below, or add rows below and remove rows above, and the height
delta scrolls the reader to the wrong place. The transcript scroller has
`[overflow-anchor:none]` (`ChatView.tsx:1539`, `GroupView.tsx:1694`), so the browser will
not correct it either. Anchoring on a row that survives the change is right in every case.

- [ ] **Step 1: Write the failing test**

`src/lib/transcript-rows.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";

import { captureRowAnchor, observeSeenRows, restoreRowAnchor } from "./transcript-rows";

/** A scroller whose rows sit at fixed document offsets; scrollTop is live. */
function scroller(rows: Array<[id: string, top: number]>, scrollTop = 0) {
  const el = {
    scrollTop,
    rows: rows.map(([id, top]) => ({ dataset: { row: id }, top })),
    getBoundingClientRect: () => ({ top: 100 }),
    querySelectorAll: () => el.rows.map((row) => ({
      dataset: row.dataset,
      getBoundingClientRect: () => ({ top: 100 + row.top - el.scrollTop }),
    })),
  };
  return el;
}

describe("row anchors", () => {
  it("keeps the first row still when a page lands above it and the bottom is trimmed", () => {
    const el = scroller([["m100", 0], ["m101", 80], ["m102", 160]], 40);
    const anchor = captureRowAnchor(el as never, "t", "first")!;
    expect(anchor).toEqual({ key: "t", id: "m100", offset: -40 });
    // 120 older rows (6000 px) mounted above; the newest rows unmounted below,
    // so scrollHeight grew by much less than 6000: a height delta would be wrong
    el.rows = [["m0", 0] as const, ["m100", 6000] as const].map(([id, top]) => ({ dataset: { row: id }, top }));
    expect(restoreRowAnchor(el as never, anchor)).toBe(true);
    expect(el.scrollTop).toBe(6040);
  });

  it("keeps the last row still when reading forward trims the top", () => {
    const el = scroller([["m0", 0], ["m1", 500], ["m2", 900]], 700);
    const anchor = captureRowAnchor(el as never, "t", "last")!;
    expect(anchor.id).toBe("m2");
    el.rows = [["m2", 300], ["m3", 700]].map(([id, top]) => ({ dataset: { row: id as string }, top: top as number }));
    restoreRowAnchor(el as never, anchor);
    expect(el.scrollTop).toBe(100);
  });

  it("does nothing when the anchor row is gone (a branch switch)", () => {
    const el = scroller([["m0", 0]], 10);
    expect(restoreRowAnchor(el as never, { key: "t", id: "gone", offset: 0 })).toBe(false);
    expect(el.scrollTop).toBe(10);
  });

  it("has no anchor in an empty transcript", () => {
    expect(captureRowAnchor(scroller([]) as never, "t", "first")).toBeNull();
  });
});

describe("seen rows", () => {
  it("marks a row the first time it is on screen and stops watching it", () => {
    const observed: unknown[] = [];
    const unobserved: unknown[] = [];
    let callback!: (entries: Array<{ isIntersecting: boolean; target: { setAttribute(name: string, value: string): void } }>) => void;
    class FakeObserver {
      constructor(cb: typeof callback, readonly options: { root: unknown }) { callback = cb; }
      observe(target: unknown) { observed.push(target); }
      unobserve(target: unknown) { unobserved.push(target); }
      disconnect = vi.fn();
    }
    const row = { setAttribute: vi.fn() };
    const other = { setAttribute: vi.fn() };
    const root = { querySelectorAll: vi.fn(() => [row, other]) };
    const stop = observeSeenRows(root as never, {} as never, FakeObserver as never);
    expect(root.querySelectorAll).toHaveBeenCalledWith("[data-row]:not([data-seen])");
    expect(observed).toEqual([row, other]);
    callback([{ isIntersecting: true, target: row }, { isIntersecting: false, target: other }]);
    expect(row.setAttribute).toHaveBeenCalledWith("data-seen", "");
    expect(other.setAttribute).not.toHaveBeenCalled();
    expect(unobserved).toEqual([row]);
    stop();
  });

  it("is a no-op where IntersectionObserver does not exist", () => {
    const root = { querySelectorAll: vi.fn(() => []) };
    expect(() => observeSeenRows(root as never, {} as never, undefined)()).not.toThrow();
    expect(root.querySelectorAll).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run src/lib/transcript-rows.test.ts`
Expected: FAIL with `Failed to resolve import "./transcript-rows"`

- [ ] **Step 3: Write minimal implementation**

`src/lib/transcript-rows.ts`:
```ts
// Two things a long transcript needs from its rows (spec §6).
//
// 1. Row anchors. Scrollback used to be kept still by shifting scrollTop by
//    the growth in scrollHeight. That is right only when rows are added above
//    and nothing leaves; with a capped window (transcript-window.ts) one step
//    can add above and remove below, or the reverse. Browser scroll anchoring
//    is off on the transcript scroller, so nothing else corrects it. A row
//    that survives the change is kept at the same distance from the top of
//    the scroller instead.
//
// 2. Seen rows. `content-visibility: auto` skips layout and paint for rows off
//    screen, sized by `contain-intrinsic-size: auto …`, the row's last rendered
//    size. A row that was never rendered has only the estimate, and on a
//    scroller without scroll anchoring the jump when it first renders lands
//    on the reader. So a row opts in (styles.css `[data-seen]`) only after it
//    has been on screen once and its real size is remembered.

export const ROW_SELECTOR = "[data-row]";
export const SEEN_ATTRIBUTE = "data-seen";

export interface ScrollAnchor {
  /** The transcript it was taken in; a switch in between drops it. */
  key: string;
  id: string;
  /** Row top minus scroller top, px, at capture. */
  offset: number;
}

interface AnchorRow {
  dataset: { row?: string };
  getBoundingClientRect(): { top: number };
}
export interface AnchorScroller {
  scrollTop: number;
  getBoundingClientRect(): { top: number };
  querySelectorAll(selector: string): ArrayLike<AnchorRow>;
}

const rowsOf = (scroller: AnchorScroller) => Array.from(scroller.querySelectorAll(ROW_SELECTOR));

export function captureRowAnchor(scroller: AnchorScroller, key: string, edge: "first" | "last"): ScrollAnchor | null {
  const rows = rowsOf(scroller);
  const row = edge === "first" ? rows[0] : rows[rows.length - 1];
  const id = row?.dataset.row;
  if (!row || !id) return null;
  return { key, id, offset: row.getBoundingClientRect().top - scroller.getBoundingClientRect().top };
}

/** False when the row is no longer mounted; scrollTop is then left alone. */
export function restoreRowAnchor(scroller: AnchorScroller, anchor: ScrollAnchor): boolean {
  const row = rowsOf(scroller).find((candidate) => candidate.dataset.row === anchor.id);
  if (!row) return false;
  scroller.scrollTop += row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.offset;
  return true;
}

interface SeenRow {
  setAttribute(name: string, value: string): void;
}
export interface SeenRoot {
  querySelectorAll(selector: string): ArrayLike<SeenRow>;
}

/** Watch the rows not yet seen; mark each on its first appearance. Returns
 * the disconnect. Call again after rows mount; seen rows are skipped. */
export function observeSeenRows(
  root: SeenRoot,
  scroller: Element,
  Observer: typeof IntersectionObserver | undefined = globalThis.IntersectionObserver,
): () => void {
  if (!Observer) return () => {};
  const observer = new Observer((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.setAttribute(SEEN_ATTRIBUTE, "");
      observer.unobserve(entry.target);
    }
  }, { root: scroller });
  for (const row of Array.from(root.querySelectorAll(`${ROW_SELECTOR}:not([${SEEN_ATTRIBUTE}])`))) observer.observe(row as unknown as Element);
  return () => observer.disconnect();
}
```

- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run src/lib/transcript-rows.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**
```
git add src/lib/transcript-rows.ts src/lib/transcript-rows.test.ts
git commit -m "perf(ui): row anchors and seen-row tracking for long transcripts"
```

---

### Task E10: Wire the capped window, row anchors and content-visibility into both transcripts

**Files:**
- Modify: `src/components/ChatView.tsx:108-116,952,983,1113,1220,1236,1358,1394-1419,1432-1438,1446-1450` (and add an effect after line 1358)
- Modify: `src/components/GroupView.tsx:74-82,217,428,1290,1306,1338,1356-1380,1389-1393,1400-1404`
- Modify: `src/styles.css:351` (insert after the `.dock-safe-bottom` rules)
- Create: `src/components/TranscriptRows.test.ts`
- Test: `src/components/TranscriptRows.test.ts`, `src/components/ChatView.test.ts`

**Interfaces:**
- Consumes: from E8, `expandEarlier`, `expandLater`, `trimFollowedTail` and
  `MAX_MOUNTED_ROWS`. From E9, `captureRowAnchor`, `restoreRowAnchor`, `observeSeenRows` and
  `type ScrollAnchor`.
- Produces: every top-level transcript item in both views is a
  `<div data-row={id} className="transcript-row flex flex-col gap-3">`. It used to be
  `className="contents"`. The inner `data-mid` wrappers that `focus-message.ts` uses do not
  change.

- [ ] **Step 1: Write the failing test**

`src/components/TranscriptRows.test.ts` (a source contract, the same approach as
`ChatView.test.ts`; see its header for why):
```ts
// Long threads scroll without jank (spec §6): both transcripts mount a capped
// window, keep the reader still by a surviving row rather than by height, and
// let rows the reader has already seen skip layout off screen. Browser proof
// is the human spec; this pins the wiring in both views and the CSS contract.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
const views: Array<[string, string]> = [["ChatView", read("./ChatView.tsx")], ["GroupView", read("./GroupView.tsx")]];
const styles = read("../styles.css");

describe("transcript rows", () => {
  it.each(views)("%s gives every top-level item a real, anchorable box", (_name, source) => {
    expect(source).not.toMatch(/<div key=\{(?:item\.id|m\.id)\} className="contents"/);
    expect(source).toMatch(/data-row=\{item\.id\} className="transcript-row flex flex-col gap-3"/);
    expect(source).toMatch(/data-row=\{m\.id\} className="transcript-row flex flex-col gap-3"/);
  });

  it.each(views)("%s pages and expands through the capped window", (_name, source) => {
    expect(source).toContain("expandEarlier({ start: startIndex, end: w.end }");
    expect(source).toContain("expandLater({ start: w.start, end: w.end }");
    expect(source).toContain("trimFollowedTail(w, ");
    expect(source).not.toContain("expandWindowStart(startIndex)");
  });

  it.each(views)("%s restores by row, not by height", (_name, source) => {
    expect(source).toContain("captureRowAnchor(");
    expect(source).toContain("restoreRowAnchor(");
    expect(source).not.toContain("el.scrollHeight - captured.height");
  });

  it.each(views)("%s marks seen rows as they mount", (_name, source) => {
    expect(source).toMatch(/observeSeenRows\(transcriptRef\.current, scrollRef\.current\)/);
  });

  it("skips only rows that have been seen, and keeps them measured", () => {
    expect(styles).toMatch(/\.transcript-row \{\s*contain-intrinsic-size: auto 120px;\s*\}/);
    expect(styles).toMatch(/\.transcript-row\[data-seen\] \{\s*content-visibility: auto;\s*\}/);
  });

  it("never clips an open menu inside a row", () => {
    // content-visibility implies paint containment: a dropdown (the voice
    // note's <details>, a card's menu) would be cut off at the row's edge.
    expect(styles).toMatch(/\.transcript-row:focus-within,\s*\.transcript-row:has\(details\[open\], \[aria-expanded="true"\]\) \{\s*content-visibility: visible;\s*\}/);
    // and the lift comes after the skip, so it wins at equal specificity
    expect(styles.indexOf("content-visibility: visible")).toBeGreaterThan(styles.indexOf("content-visibility: auto"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run src/components/TranscriptRows.test.ts`
Expected: FAIL. The first case fails with `expected '…' not to match /<div key=\{(?:item\.id|m\.id)\} className="contents"/`.

- [ ] **Step 3: Write minimal implementation**

**`src/styles.css`**: insert after line 351 (the closing `}` of
`:root[data-keyboard="open"] .dock-safe-bottom`):
```css

/* Long transcripts (spec §6). A row the reader has seen skips layout and
   paint while off screen, at its remembered size (`auto`). Rows opt in only
   once seen (src/lib/transcript-rows.ts): a never-rendered row has just the
   estimate, and the transcript scroller has scroll anchoring off, so its
   first render would move the text under the reader. */
.transcript-row {
  contain-intrinsic-size: auto 120px;
}
.transcript-row[data-seen] {
  content-visibility: auto;
}
/* content-visibility implies paint containment, which would clip a menu
   opened inside a row at the row's edge. A row with focus or an open menu
   renders normally. After the rule above, so it wins at equal specificity. */
.transcript-row:focus-within,
.transcript-row:has(details[open], [aria-expanded="true"]) {
  content-visibility: visible;
}
```

**`src/components/ChatView.tsx`**:
- Lines 108–116 (the `@/lib/transcript-window` import) become:
```tsx
import {
  TRANSCRIPT_WINDOW_SIZE,
  SCROLLBACK_TRIGGER_PX,
  expandEarlier,
  expandLater,
  focusWindowRange,
  resolveTranscriptWindow,
  tailWindowStart,
  trimFollowedTail,
  windowAfterPrepend,
} from "@/lib/transcript-window";
import { captureRowAnchor, observeSeenRows, restoreRowAnchor, type ScrollAnchor } from "@/lib/transcript-rows";
```
  (Keep line 108 exactly as it is if it names something other than
  `TRANSCRIPT_WINDOW_SIZE`. The change is: add `expandEarlier` and `expandLater`, drop
  `expandWindowStart`, and add `trimFollowedTail`.)
- Line 952 becomes `            <div key={item.id} data-row={item.id} className="transcript-row flex flex-col gap-3">`
- Line 983 becomes `            <div key={item.id} data-row={item.id} className="transcript-row flex flex-col gap-3">`
- Line 1113 becomes `          <div key={m.id} data-row={m.id} className="transcript-row flex flex-col gap-3" data-mid={m.id}>`
  (It keeps `data-mid`. `focus-message.ts:58` still finds it and flashes `lastElementChild`,
  which is still the row.)
- Line 1220 becomes `  const preExpandAnchor = useRef<ScrollAnchor | null>(null);`. Update the comment above
  it (lines 1216–1219) to read "Row anchor captured before…" instead of "Height captured before…".
- Line 1236 becomes
  `    setTranscriptWindow({ ...windowAfterPrepend(transcriptWindow, shift, preExpandAnchor.current?.key === transcriptKey), firstId: firstMessageId });`
- After line 1358 (`useFocusMessage(bot.threadId, messages.length > 0);`) add:
```tsx
  // A followed live tail stays within MAX_MOUNTED_ROWS (transcript-window.ts).
  useEffect(() => {
    setTranscriptWindow((w) => {
      const next = trimFollowedTail(w, messages.length, followRef.current);
      return next === w ? w : { ...w, ...next };
    });
  }, [messages.length, transcriptKey]);
  // Rows the reader has seen may skip layout off screen (styles.css).
  useEffect(() => {
    if (!transcriptRef.current || !scrollRef.current) return;
    return observeSeenRows(transcriptRef.current, scrollRef.current);
  }, [windowedMessages]);
```
- Replace lines 1394–1419 (the comment above `captureHeight`, then `captureHeight`,
  `restoreHeight`, `showEarlier` and the first `useLayoutEffect(restoreHeight…)`) with:
```tsx
  // Expanding or paging moves rows in and out around the reader. A row that
  // survives the change is kept where it was (transcript-rows.ts); browser
  // scroll anchoring is disabled on this container. The capture belongs to
  // the thread it was taken in: a switch between the capture and the commit
  // would otherwise move the new thread by the old one's rows.
  const captureAnchor = (edge: "first" | "last") => {
    preExpandAnchor.current = scrollRef.current ? captureRowAnchor(scrollRef.current, transcriptKey, edge) : null;
  };
  const restoreAnchor = () => {
    const el = scrollRef.current;
    const captured = preExpandAnchor.current;
    if (!captured || !el) return;
    preExpandAnchor.current = null;
    if (captured.key !== transcriptKey) return;
    restoreRowAnchor(el, captured);
    // keep the resume-follow heuristic from reading the restore as a
    // downward user scroll
    previousScrollTop.current = el.scrollTop;
  };
  const showEarlier = () => {
    captureAnchor("first");
    // expanding means reading scrollback — never let a mid-expand stream
    // event pin the viewport back to the bottom
    setBottomFollow(false);
    setTranscriptWindow((w) => ({ ...w, ...expandEarlier({ start: startIndex, end: w.end }, messages.length) }));
  };
  // transcriptKey is a dependency so a switch runs this and drops a capture
  // that belongs to the thread being left; `end` so a "Show later" that did
  // not move the start still settles its capture.
  useLayoutEffect(restoreAnchor, [transcriptWindow.start, transcriptWindow.end, transcriptKey]);
```
- Lines 1432–1438 (`loadOlder`, its `useLayoutEffect(restoreHeight, [firstMessageId, transcriptKey])`
  and the olderPending clear) become:
```tsx
  const loadOlder = () => {
    if (olderPending) return;
    captureAnchor("first");
    setBottomFollow(false);
    dispatch({ type: "loadOlderMessages", threadId: bot.threadId });
  };
  useLayoutEffect(restoreAnchor, [firstMessageId, transcriptKey]);
  // A page that came back empty or was dropped as stale moved nothing, so
  // its capture must not be applied to some later, unrelated growth.
  useLayoutEffect(() => {
    if (!olderPending) preExpandAnchor.current = null;
  }, [olderPending]);
```
- Lines 1446–1450 (`showLater`) become:
```tsx
  const showLater = () => {
    captureAnchor("last");
    setBottomFollow(false);
    setTranscriptWindow((w) => ({ ...w, ...expandLater({ start: w.start, end: w.end }, messages.length) }));
  };
```
  (`endIndex` is then unused in ChatView. Drop it from the destructuring at lines 1238–1244
  if `tsc` reports it, and keep `startIndex`.)

**`src/components/GroupView.tsx`**, the same edits at its lines:
- Lines 74–82 (the transcript-window import): add `expandEarlier` and `expandLater`, drop
  `expandWindowStart`, and add `trimFollowedTail`. Then add
  `import { captureRowAnchor, observeSeenRows, restoreRowAnchor, type ScrollAnchor } from "@/lib/transcript-rows";`
- Line 217 becomes `            <div key={item.id} data-row={item.id} className="transcript-row flex flex-col gap-3">`
- Line 428 becomes `          <div key={m.id} data-row={m.id} className="transcript-row flex flex-col gap-3" data-mid={m.id}>`
- Line 1290 becomes `  const preExpandAnchor = useRef<ScrollAnchor | null>(null);`
- Line 1306 becomes
  `    setTranscriptWindow({ ...windowAfterPrepend(transcriptWindow, shift, preExpandAnchor.current?.key === transcriptKey), firstId: firstMessageId });`
- After line 1338 (`useFocusMessage(group.threadId, group.messages.length > 0);`) add:
```tsx
  // A followed live tail stays within MAX_MOUNTED_ROWS (transcript-window.ts).
  useEffect(() => {
    setTranscriptWindow((w) => {
      const next = trimFollowedTail(w, group.messages.length, followRef.current);
      return next === w ? w : { ...w, ...next };
    });
  }, [group.messages.length, transcriptKey]);
  // Rows the reader has seen may skip layout off screen (styles.css).
  useEffect(() => {
    if (!transcriptRef.current || !scrollRef.current) return;
    return observeSeenRows(transcriptRef.current, scrollRef.current);
  }, [windowedMessages]);
```
- Replace lines 1356–1380 (the comment, `captureHeight`, `restoreHeight`, `showEarlier` and
  `useLayoutEffect(restoreHeight, [transcriptWindow.start, transcriptKey])`) with:
```tsx
  // Rows move in and out around the reader; a surviving row is kept where it
  // was (transcript-rows.ts, and see ChatView). The capture belongs to the
  // thread it was taken in.
  const captureAnchor = (edge: "first" | "last") => {
    preExpandAnchor.current = scrollRef.current ? captureRowAnchor(scrollRef.current, transcriptKey, edge) : null;
  };
  const restoreAnchor = () => {
    const el = scrollRef.current;
    const captured = preExpandAnchor.current;
    if (!captured || !el) return;
    preExpandAnchor.current = null;
    if (captured.key !== transcriptKey) return;
    restoreRowAnchor(el, captured);
    // keep the resume-follow heuristic from reading the restore as a
    // downward user scroll
    previousScrollTop.current = el.scrollTop;
  };
  const showEarlier = () => {
    captureAnchor("first");
    // expanding means reading scrollback — never let a mid-expand stream
    // event pin the viewport back to the bottom
    setBottomFollow(false);
    setTranscriptWindow((w) => ({ ...w, ...expandEarlier({ start: startIndex, end: w.end }, group.messages.length) }));
  };
  useLayoutEffect(restoreAnchor, [transcriptWindow.start, transcriptWindow.end, transcriptKey]);
```
- Lines 1384–1393 (`loadOlder`, `useLayoutEffect(restoreHeight, [firstMessageId, transcriptKey])`
  and the olderPending clear): in `loadOlder`, `captureHeight();` becomes
  `captureAnchor("first");`. `useLayoutEffect(restoreHeight, …)` becomes
  `useLayoutEffect(restoreAnchor, [firstMessageId, transcriptKey]);`. In the clear,
  `preExpandHeight.current = null` becomes `preExpandAnchor.current = null`.
- Lines 1401–1405 (`showLater`) become:
```tsx
  const showLater = () => {
    captureAnchor("last");
    setBottomFollow(false);
    setTranscriptWindow((w) => ({ ...w, ...expandLater({ start: w.start, end: w.end }, group.messages.length) }));
  };
```

`reachedTop()` does not change in either view. It calls `showEarlier`, which is now capped.

- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run src/components/TranscriptRows.test.ts src/components/ChatView.test.ts src/lib/transcript-window.test.ts src/lib/transcript-rows.test.ts && pnpm typecheck`
Expected: PASS. Then, in a browser against the isolated fixture
(`docs/verification/README.md`, never the live app): open a 1,000-message thread, scroll to
the top five times, and check that the number of `[data-row]` elements never goes over 360.
Scroll back down, and check that the row under the pointer does not jump at any step. Open a
voice note's "…" menu in a row that has scrolled off and back, and check that it is not
clipped. `src/e2e/*.human.spec.ts` specs run in CI, so this browser check needs no build on
the Mac beyond the Vite dev server.

- [ ] **Step 5: Commit**
```
git add src/components/ChatView.tsx src/components/GroupView.tsx src/styles.css src/components/TranscriptRows.test.ts
git commit -m "perf(ui): capped, anchored transcripts with content-visibility on seen rows"
```

---

### Task E11: Server `?w=` thumbnails

**Files:**
- Create: `shared/image-thumbnail.ts`
- Create: `server/image-thumbnail.ts`
- Test: `server/image-thumbnail.test.ts`

**Interfaces:**
- Consumes: sharp, resolved at runtime from beside `@huggingface/transformers`. It is
  already a production dependency, and it is already staged into the packaged app by
  `scripts/stage-memory-runtime.mjs`. See Notes 4.
- Produces:
  - `shared/image-thumbnail.ts`: `THUMBNAIL_WIDTHS = [320, 640, 1280] as const` and
    `type ThumbnailWidth`
  - `server/image-thumbnail.ts`: `thumbnailWidth(raw)`, `sharpResize(sharp)`,
    `loadResize()` and `createThumbnails({ resize, maxBytes })`, which returns
    `{ variant(key, bytes, mime, width): Promise<Thumbnail | null> }`, plus
    `type Thumbnail = { bytes: Buffer; mime: string }`

- [ ] **Step 1: Write the failing test**

`server/image-thumbnail.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";

import { createThumbnails, sharpResize, thumbnailWidth, type Resize } from "./image-thumbnail.ts";

describe("thumbnailWidth", () => {
  it("is absent without w, and one of the fixed widths with it", () => {
    expect(thumbnailWidth(null)).toBeUndefined();
    expect(thumbnailWidth("320")).toBe(320);
    expect(thumbnailWidth("1280")).toBe(1280);
  });

  it("refuses any other width, so a crawler of widths cannot fill the cache", () => {
    for (const raw of ["321", "0", "-320", "320.5", "", "abc", "99999"]) expect(thumbnailWidth(raw), raw).toBeNull();
  });
});

/** A fake sharp: `meta` is what metadata() reports; resizing yields `out`. */
function fakeSharp(meta: { width?: number; height?: number; orientation?: number; pages?: number }, out = Buffer.alloc(10)) {
  const calls: string[] = [];
  const image = {
    metadata: async () => meta,
    rotate() { calls.push("rotate"); return image; },
    resize(options: { width: number }) { calls.push(`resize:${options.width}`); return image; },
    webp(options: { quality: number }) { calls.push(`webp:${options.quality}`); return image; },
    toBuffer: async () => out,
  };
  return { sharp: vi.fn(() => image), calls };
}

describe("sharpResize", () => {
  it("shrinks a wide image to the asked width as WebP, upright", async () => {
    const { sharp, calls } = fakeSharp({ width: 4032, height: 3024 });
    await expect(sharpResize(sharp)(Buffer.alloc(1), 640)).resolves.toEqual({ bytes: Buffer.alloc(10), mime: "image/webp" });
    expect(calls).toEqual(["rotate", "resize:640", "webp:78"]);
  });

  it("measures a rotated phone photo by the width the reader sees", async () => {
    // EXIF 6: stored 4032x3024 landscape, shown 3024 wide; still wider than 640
    const shown = fakeSharp({ width: 4032, height: 3024, orientation: 6 });
    await expect(sharpResize(shown.sharp)(Buffer.alloc(1), 640)).resolves.not.toBeNull();
    // stored 600x2000 with EXIF 8: shown 2000 wide, so it IS shrunk
    const tall = fakeSharp({ width: 600, height: 2000, orientation: 8 });
    await expect(sharpResize(tall.sharp)(Buffer.alloc(1), 640)).resolves.not.toBeNull();
    // stored 2000x600 with EXIF 6: shown 600 wide, already small enough
    const narrow = fakeSharp({ width: 2000, height: 600, orientation: 6 });
    await expect(sharpResize(narrow.sharp)(Buffer.alloc(1), 640)).resolves.toBeNull();
  });

  it("leaves an image already no wider than asked, and an animation, as they are", async () => {
    await expect(sharpResize(fakeSharp({ width: 640 }).sharp)(Buffer.alloc(1), 640)).resolves.toBeNull();
    await expect(sharpResize(fakeSharp({ width: 4000, pages: 12 }).sharp)(Buffer.alloc(1), 640)).resolves.toBeNull();
  });
});

describe("createThumbnails", () => {
  const source = Buffer.alloc(1000, 1);
  const small = { bytes: Buffer.alloc(100, 2), mime: "image/webp" };

  it("resizes once per key and width, then serves from memory", async () => {
    const resize: Resize = vi.fn(async () => small);
    const thumbs = createThumbnails({ resize: async () => resize, maxBytes: 10_000 });
    expect(await thumbs.variant("a", source, "image/png", 320)).toEqual(small);
    expect(await thumbs.variant("a", source, "image/png", 320)).toEqual(small);
    expect(resize).toHaveBeenCalledTimes(1);
    await thumbs.variant("a", source, "image/png", 640);
    expect(resize).toHaveBeenCalledTimes(2);
  });

  it("never resizes a GIF: it would lose its animation", async () => {
    const resize: Resize = vi.fn(async () => small);
    const thumbs = createThumbnails({ resize: async () => resize, maxBytes: 10_000 });
    expect(await thumbs.variant("g", source, "image/gif", 320)).toBeNull();
    expect(resize).not.toHaveBeenCalled();
  });

  it("serves the original when there is no resizer, when it throws, or when it would not save bytes", async () => {
    expect(await createThumbnails({ resize: async () => null, maxBytes: 10_000 }).variant("a", source, "image/png", 320)).toBeNull();
    const throws: Resize = async () => { throw new Error("corrupt"); };
    expect(await createThumbnails({ resize: async () => throws, maxBytes: 10_000 }).variant("a", source, "image/png", 320)).toBeNull();
    const bigger: Resize = async () => ({ bytes: Buffer.alloc(2000), mime: "image/webp" });
    expect(await createThumbnails({ resize: async () => bigger, maxBytes: 10_000 }).variant("a", source, "image/png", 320)).toBeNull();
  });

  it("remembers an image that needs no thumbnail, so it is not decoded again", async () => {
    const resize: Resize = vi.fn(async () => null);
    const thumbs = createThumbnails({ resize: async () => resize, maxBytes: 10_000 });
    await thumbs.variant("tiny", source, "image/png", 320);
    await thumbs.variant("tiny", source, "image/png", 320);
    expect(resize).toHaveBeenCalledTimes(1);
  });

  it("drops the oldest thumbnails once the cache holds more than its bytes", async () => {
    const resize: Resize = vi.fn(async () => small);
    const thumbs = createThumbnails({ resize: async () => resize, maxBytes: 250 });
    await thumbs.variant("a", source, "image/png", 320);
    await thumbs.variant("b", source, "image/png", 320);
    await thumbs.variant("c", source, "image/png", 320); // 300 bytes: "a" goes
    await thumbs.variant("b", source, "image/png", 320);
    await thumbs.variant("a", source, "image/png", 320);
    expect(resize).toHaveBeenCalledTimes(4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run server/image-thumbnail.test.ts`
Expected: FAIL with `Failed to load url ./image-thumbnail.ts`

- [ ] **Step 3: Write minimal implementation**

`shared/image-thumbnail.ts`:
```ts
/** The widths `?w=` accepts on the image routes, and the widths the client's
 *  srcset names (spec §6). A fixed set so thumbnails cache well and a client
 *  cannot ask for one per pixel. */
export const THUMBNAIL_WIDTHS = [320, 640, 1280] as const;
export type ThumbnailWidth = (typeof THUMBNAIL_WIDTHS)[number];
```

`server/image-thumbnail.ts`:
```ts
// `?w=` thumbnails for chat images (spec §6).
//
// A phone scrolling an image-heavy chat downloaded every attachment at full
// size (a 4032 px photo is 3–5 MB) to draw it a few hundred pixels wide. The
// image routes now take `?w=` from a fixed set and answer a WebP no wider than
// that; the lightbox and Download still fetch the original.
//
// The resizer is sharp, loaded on first use from beside
// @huggingface/transformers: it is that package's dependency, and the
// packaged memory runtime already ships it there (scripts/
// stage-memory-runtime.mjs), so thumbnails add no dependency and no bytes.
// When it cannot load (a platform whose binary was not staged, a runtime
// without it) every request gets the original, which is what it got before
// this existed. A thumbnail never turns into a 500.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { THUMBNAIL_WIDTHS, type ThumbnailWidth } from "../shared/image-thumbnail.ts";

export { THUMBNAIL_WIDTHS };

/** undefined: no `w`, serve the original. null: a `w` outside the set (400). */
export function thumbnailWidth(raw: string | null): ThumbnailWidth | null | undefined {
  if (raw === null) return undefined;
  const width = Number(raw);
  return (THUMBNAIL_WIDTHS as readonly number[]).includes(width) ? (width as ThumbnailWidth) : null;
}

export interface Thumbnail {
  bytes: Buffer;
  mime: string;
}
/** Null when the image is already no wider than `width`, or is animated. */
export type Resize = (bytes: Buffer, width: number) => Promise<Thumbnail | null>;

// The slice of sharp's API used here; sharp is not a direct dependency, so
// its own types are not on the compiler's path.
interface SharpMetadata { width?: number; height?: number; orientation?: number; pages?: number }
interface SharpImage {
  metadata(): Promise<SharpMetadata>;
  rotate(): SharpImage;
  resize(options: { width: number; withoutEnlargement: boolean }): SharpImage;
  webp(options: { quality: number }): SharpImage;
  toBuffer(): Promise<Buffer>;
}
type Sharp = (input: Buffer, options: { limitInputPixels: number }) => SharpImage;

/** A phone panorama is ~60 MP; anything larger is not a photo worth decoding. */
const MAX_INPUT_PIXELS = 64_000_000;
const QUALITY = 78;

/** A Resize over a sharp factory. Exported for its test, which passes a fake. */
export function sharpResize(sharp: Sharp): Resize {
  return async (bytes, width) => {
    const meta = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    // A resize would keep only the first frame.
    if ((meta.pages ?? 1) > 1) return null;
    // EXIF orientations 5–8 turn the picture a quarter: the width the reader
    // sees is the stored height (every phone photo taken upright).
    const shown = (meta.orientation ?? 1) >= 5 ? meta.height : meta.width;
    if (!shown || shown <= width) return null;
    const out = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: QUALITY })
      .toBuffer();
    return { bytes: out, mime: "image/webp" };
  };
}

let loaded: Promise<Resize | null> | undefined;

/** sharp from beside transformers, once per process; null when unavailable. */
export function loadResize(): Promise<Resize | null> {
  loaded ??= (async () => {
    try {
      const beside = createRequire(fileURLToPath(import.meta.resolve("@huggingface/transformers")));
      return sharpResize(beside("sharp") as Sharp);
    } catch (error) {
      console.warn(`[thumbnails] unavailable, serving originals: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  })();
  return loaded;
}

/** Remembered "no thumbnail needed" answers; cleared wholesale when full. */
const MAX_ORIGINAL_MARKS = 10_000;

/** Thumbnails by source key and width, up to `maxBytes`, oldest out first.
 * Sources are immutable (a saved attachment, a settled message's pixels), so
 * an entry never goes stale. */
export function createThumbnails(options: { resize: () => Promise<Resize | null>; maxBytes: number }) {
  const cache = new Map<string, Thumbnail>();
  const original = new Set<string>();
  let held = 0;
  return {
    async variant(key: string, source: Buffer, mime: string, width: ThumbnailWidth): Promise<Thumbnail | null> {
      if (mime === "image/gif") return null;
      const id = `${key}@${width}`;
      if (original.has(id)) return null;
      const hit = cache.get(id);
      if (hit) {
        cache.delete(id);
        cache.set(id, hit);
        return hit;
      }
      const resize = await options.resize();
      if (!resize) return null;
      let made: Thumbnail | null;
      try {
        made = await resize(source, width);
      } catch {
        return null;
      }
      if (!made || made.bytes.byteLength >= source.byteLength) {
        if (original.size >= MAX_ORIGINAL_MARKS) original.clear();
        original.add(id);
        return null;
      }
      cache.set(id, made);
      held += made.bytes.byteLength;
      for (const [oldest, entry] of cache) {
        if (held <= options.maxBytes) break;
        cache.delete(oldest);
        held -= entry.bytes.byteLength;
      }
      return made;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run server/image-thumbnail.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**
```
git add shared/image-thumbnail.ts server/image-thumbnail.ts server/image-thumbnail.test.ts
git commit -m "feat(server): ?w= image thumbnails via the bundled sharp"
```

---

### Task E12: Serve `?w=` on the attachment and screen-image routes

**Files:**
- Modify: `server/index.ts:151` (imports), `10155` (after `json()`), `11981-11988`, `12118-12125`
- Modify: `server/attachments-http.test.ts` (append a test)
- Test: `server/attachments-http.test.ts`

**Interfaces:**
- Consumes: `createThumbnails`, `loadResize`, `thumbnailWidth` and `THUMBNAIL_WIDTHS` from
  E11.
- Produces:
  - `GET /api/attachments/:name?w=320|640|1280` and
    `GET /api/threads/:t/messages/:m/image?w=…` answer `image/webp` when the image was
    shrunk, or the original bytes and type otherwise.
  - Any other `w` is a 400.
  - Headers are unchanged otherwise (`private, max-age=31536000, immutable`; the attachment
    route keeps `x-content-type-options: nosniff`).
  - Old clients that send no `w` get exactly today's response.

- [ ] **Step 1: Write the failing test**

Append to `server/attachments-http.test.ts`, and add `import { crc32, deflateSync } from "node:zlib";`
to its imports:
```ts
/** An RGB PNG of the given size, written by hand so the test needs no image library. */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) { row[1 + x * 3] = x % 256; row[2 + x * 3] = (x * 7) % 256; }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

it("answers ?w= with a smaller WebP, the original when it is already small, and 400 for other widths", async () => {
  const session = await launchVerificationServer();
  try {
    const upload = async (bytes: Buffer) => {
      const saved = await (await fetch(`${session.info.url}/api/attachments`, { method: "POST", headers: { "content-type": "image/png" }, body: bytes })).json() as { path: string };
      return saved.path.split(/[\\/]/).at(-1)!;
    };
    const wide = png(2000, 40);
    const wideName = await upload(wide);
    const thumb = await fetch(`${session.info.url}/api/attachments/${wideName}?w=320`);
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get("content-type")).toBe("image/webp");
    expect(thumb.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(thumb.headers.get("x-content-type-options")).toBe("nosniff");
    const bytes = Buffer.from(await thumb.arrayBuffer());
    expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(bytes.subarray(8, 12).toString("ascii")).toBe("WEBP");
    expect(bytes.byteLength).toBeLessThan(wide.byteLength);
    // no w: the original, byte for byte, exactly as before
    const original = await fetch(`${session.info.url}/api/attachments/${wideName}`);
    expect(original.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await original.arrayBuffer())).toEqual(wide);
    // already narrower than asked: the original
    const small = png(200, 20);
    const smallName = await upload(small);
    const same = await fetch(`${session.info.url}/api/attachments/${smallName}?w=640`);
    expect(same.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await same.arrayBuffer())).toEqual(small);
    // a width outside the set
    const refused = await fetch(`${session.info.url}/api/attachments/${wideName}?w=321`);
    expect(refused.status).toBe(400);
    await refused.text();
  } finally { await session.close(); }
}, 30000);
```

- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run server/attachments-http.test.ts -t "answers ?w="`
Expected: FAIL with `expected 'image/png' to be 'image/webp'`

- [ ] **Step 3: Write minimal implementation**

`server/index.ts`:
- After the `./attachments.ts` import block (ending at line 151) add:
```ts
import { createThumbnails, loadResize, THUMBNAIL_WIDTHS, thumbnailWidth } from "./image-thumbnail.ts";
```
- After `json()` (lines 10150–10154) add:
```ts
/** Chat image thumbnails (spec §6): at most 32 MB of them, in memory. */
const thumbnails = createThumbnails({ resize: loadResize, maxBytes: 32 * 1024 * 1024 });

/** One immutable image, or its `?w=` thumbnail when that is smaller. */
async function sendImage(res: ServerResponse, url: URL, key: string, bytes: Buffer, mime: string, headers: Record<string, string> = {}) {
  const width = thumbnailWidth(url.searchParams.get("w"));
  if (width === null) return json(res, 400, { error: `w must be one of ${THUMBNAIL_WIDTHS.join(", ")}` });
  const body = (width !== undefined && (await thumbnails.variant(key, bytes, mime, width))) || { bytes, mime };
  res.writeHead(200, {
    "content-type": body.mime,
    "content-length": String(body.bytes.byteLength),
    // an attachment and a settled message's image never change
    "cache-control": "private, max-age=31536000, immutable",
    ...headers,
  });
  res.end(body.bytes);
}
```
- Screen image route, lines 11981–11988 (from `const bytes = Buffer.from(message.png, "base64");`
  through `return res.end(bytes);`) become:
```ts
      return sendImage(res, url, `screen:${m[1]}:${m[2]}`, Buffer.from(message.png, "base64"), message.mime ?? "image/png");
```
- Attachment route, lines 12118–12125 (from `res.writeHead(200, {` through
  `return res.end(attachment.bytes);`) become:
```ts
      return sendImage(res, url, `attachment:${m[1]}`, attachment.bytes, attachment.mime, { "x-content-type-options": "nosniff" });
```

- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run server/attachments-http.test.ts server/turn-images-http.test.ts server/image-thumbnail.test.ts`
Expected: PASS. If the WebP assertion fails with `image/png`, the server log will say
`[thumbnails] unavailable, serving originals: …`. That means sharp did not resolve from
beside transformers in this checkout: run `pnpm install --frozen-lockfile` so its native
binary is present. Do not relax the test.

- [ ] **Step 5: Commit**
```
git add server/index.ts server/attachments-http.test.ts
git commit -m "feat(server): serve ?w= thumbnails for attachments and screen images"
```

---

### Task E13: Client srcset for chat images, and phone-width screen frames

**Files:**
- Create: `src/lib/image-thumbnail.ts`
- Modify: `src/components/ImageMedia.tsx:23,208-214`
- Modify: `src/lib/paged-screen-frame.ts:6,13-15`
- Test: `src/lib/image-thumbnail.test.ts`, `src/components/ChatView.test.ts` (append)

**Interfaces:**
- Consumes: `THUMBNAIL_WIDTHS` (from `shared/image-thumbnail.ts`, E11), `isPhoneClient()`
  (E5), and the server behaviour from E12.
- Produces:
  - `thumbnailSrcSet(src: string): string | undefined`
  - `THUMBNAIL_SIZES: string`
  - `screenFramePath(threadId: string, messageId: string, phone: boolean): string`
  - `PHONE_SCREEN_FRAME_WIDTH = 1280`

- [ ] **Step 1: Write the failing test**

`src/lib/image-thumbnail.test.ts`:
```ts
import { describe, expect, it } from "vitest";

import { PHONE_SCREEN_FRAME_WIDTH, screenFramePath, thumbnailSrcSet } from "./image-thumbnail";

describe("thumbnailSrcSet", () => {
  it("offers the server's three widths for a same-origin attachment", () => {
    expect(thumbnailSrcSet("/api/attachments/abc-123.png")).toBe(
      "/api/attachments/abc-123.png?w=320 320w, /api/attachments/abc-123.png?w=640 640w, /api/attachments/abc-123.png?w=1280 1280w",
    );
  });

  it("leaves a GIF whole: the server would only send the animation back", () => {
    expect(thumbnailSrcSet("/api/attachments/abc.gif")).toBeUndefined();
  });

  it("never touches bytes that are not the harness's attachment route", () => {
    for (const src of ["data:image/png;base64,AAAA", "blob:https://x/1", "https://example.com/a.png", "/api/media/abc", "/api/attachments/abc.png?w=320"]) {
      expect(thumbnailSrcSet(src), src).toBeUndefined();
    }
  });
});

describe("screenFramePath", () => {
  it("asks a phone for a phone-width frame and the desktop for the original", () => {
    expect(screenFramePath("t1", "m1", true)).toBe(`/api/threads/t1/messages/m1/image?w=${PHONE_SCREEN_FRAME_WIDTH}`);
    expect(screenFramePath("t1", "m1", false)).toBe("/api/threads/t1/messages/m1/image");
  });
});
```

Append to `src/components/ChatView.test.ts`, in the describe that holds line 155 ("routes the
bot's screen frame through the shared thumbnail"):
```ts
  it("lets the browser pick a thumbnail width and keeps the original for the lightbox", () => {
    const media = read("./ImageMedia.tsx");
    expect(media).toContain("const srcSet = thumbnailSrcSet(item.src);");
    expect(media).toMatch(/srcSet=\{srcSet\}\s*sizes=\{srcSet \? THUMBNAIL_SIZES : undefined\}/);
  });
```

- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run src/lib/image-thumbnail.test.ts src/components/ChatView.test.ts -t "thumbnail"`
Expected: FAIL with `Failed to resolve import "./image-thumbnail"`

- [ ] **Step 3: Write minimal implementation**

`src/lib/image-thumbnail.ts`:
```ts
// Which image bytes a chat thumbnail asks for (spec §6). The server shrinks
// attachments and screen frames on `?w=` (server/image-thumbnail.ts); the
// browser picks a width from the srcset for the space and the screen's
// density. The lightbox and Download always use the original `src`.
import { THUMBNAIL_WIDTHS } from "../../shared/image-thumbnail";

/** Inline chat images are at most about the transcript column, and the whole
 *  width of a phone. */
export const THUMBNAIL_SIZES = "(max-width: 767.98px) 90vw, 480px";

/** Same shape the harness names attachments (attachmentImageUrl). */
const ATTACHMENT = /^\/api\/attachments\/[A-Za-z0-9-]+\.(?:png|jpg|webp)$/;

export function thumbnailSrcSet(src: string): string | undefined {
  if (!ATTACHMENT.test(src)) return undefined;
  return THUMBNAIL_WIDTHS.map((width) => `${src}?w=${width} ${width}w`).join(", ");
}

/** A phone never needs a screen frame wider than its own screen's pixels
 *  (a large iPhone is 1290 across), and a desktop capture is often 3000. */
export const PHONE_SCREEN_FRAME_WIDTH = 1280;

export function screenFramePath(threadId: string, messageId: string, phone: boolean): string {
  const path = `/api/threads/${threadId}/messages/${messageId}/image`;
  return phone ? `${path}?w=${PHONE_SCREEN_FRAME_WIDTH}` : path;
}
```

`src/components/ImageMedia.tsx`:
- After line 23 (`import { attachmentImageUrl } from "@/lib/composer-attachments";`) add
  `import { THUMBNAIL_SIZES, thumbnailSrcSet } from "@/lib/image-thumbnail";`
- In `ImageThumb`, directly before its `return (` (the one that renders the `<button>`, at
  line 194), add `  const srcSet = thumbnailSrcSet(item.src);`
- Lines 208–209 (`<img` / `src={item.src}`) become:
```tsx
      <img
        src={item.src}
        srcSet={srcSet}
        sizes={srcSet ? THUMBNAIL_SIZES : undefined}
```
  The rest of the `<img>` (`alt`, `loading="lazy"`, `decoding`, `referrerPolicy` and
  `onError`) does not change. An older host that ignores `?w=` sends the original for each
  candidate, so nothing breaks there.

`src/lib/paged-screen-frame.ts`:
- After line 6 add
  `import { screenFramePath } from "@/lib/image-thumbnail";` and
  `import { isPhoneClient } from "@/lib/phone-client";`
- Line 15 becomes
  `  const res = await fetch(screenFramePath(threadId, messageId, isPhoneClient()), { headers: desktopSurfaceHeaders() });`

- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run src/lib/image-thumbnail.test.ts src/components/ChatView.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**
```
git add src/lib/image-thumbnail.ts src/lib/image-thumbnail.test.ts src/components/ImageMedia.tsx src/lib/paged-screen-frame.ts src/components/ChatView.test.ts
git commit -m "perf(ui): srcset thumbnails for chat images, phone-width screen frames"
```

---

## Notes for the plan author

1. **The spec's "first-paint bundle 40–60% smaller" is not reachable with the four splits
   §6 lists.** The evidence is in the header and in E4. The splits cut the static graph from
   445 to 352 modules, and statically reached source from 6.9 MB to 5.9 MB, removing Tiptap
   with ProseMirror and onnxruntime-web along the way. My estimate is about a 25% smaller
   first paint (~700 KiB brotli from ~930). E4 sets a 750 KiB budget with a measure-and-lower
   rule, rather than a number that would fail the first CI run.

   Other large packages still reached statically from `main.tsx`: `posthog-js` (from
   `initAnalytics` in App), `yaml`, `react-markdown` with `remark-gfm` and micromark, `zod`,
   and `qrcode.react`. Also every static `src/` module, including `Sidebar`, `Composer` and
   `RoutinesPage`. `posthog-js` behind `await import()` in `initAnalytics`, and `yaml` (check
   who needs it on the client), are the next most likely wins. They are outside the brief, so
   I did not plan them.

2. **Phone boot uses `messages=1`, not `messages=0`.** At `server/index.ts:2927-2929`,
   `newestPageLimit(threadId, limit)` returns `0` for `0` ("Zero stays zero — that caller
   asked for settings"). For any `limit > 0` it widens the page to reach every open request
   card and the active branch head (`Store.newestPageSpan`, `server/store.ts:1708`). So
   `messages=0` would:
   - drop open approval cards from every thread the phone is not looking at;
   - blank the Sidebar's last-line previews (`Sidebar.tsx:387,486` read `group.messages.at(-1)`);
   - leave the scrollback code nothing to page back from (`scrollback.ts` `loadOlder` needs
     `messages[0].id`), which would need a new "load newest" path.

   `messages=1` costs one row per thread and reuses the existing `loadOlder`. E6's server
   test pins both behaviours.

3. **content-visibility on this transcript needs the "seen" gate.** Both transcript
   scrollers set `[overflow-anchor:none]` (`ChatView.tsx:1539`, `GroupView.tsx:1694`), so the
   browser will not correct a scroll jump when an off-screen row's estimated size is replaced
   by its real one. Applying `content-visibility: auto` to every row, as the brief suggested,
   would make scrolling up through a freshly opened long thread jump. E9 and E10 apply it
   only to rows that have been on screen once, which `contain-intrinsic-size: auto` has then
   measured. They also lift it for a row with focus or an open `<details>` or
   `aria-expanded` menu, because paint containment clips overflow. The voice-note menu at
   `ArtifactCards.tsx:284-289` is exactly that case. `:has()` needs Chromium 105+ or Safari
   15.4+, which every target has.

4. **Thumbnails reuse the sharp that already ships.** `sharp@0.34.5` is a production
   dependency of `@huggingface/transformers@4.2.0` (`pnpm-lock.yaml:6200-6206`), and
   `scripts/stage-memory-runtime.mjs` copies transformers with its dependencies and optional
   dependencies into `dist-server/node_modules`. The resolution in E11 goes through
   `import.meta.resolve("@huggingface/transformers")` and then `createRequire(...)("sharp")`,
   which works in the pnpm dev layout and in the packaged layout.

   It is coupled to transformers keeping sharp. If transformers drops it, thumbnails
   silently degrade to originals, and the E12 HTTP test fails in CI, which is the signal.
   The alternative is `sharp: "0.34.5"` as a direct dependency, marked external in
   `bundle-server.mjs` and staged like transformers. That is cleaner, but it means packaging
   work and a Sean decision, given the repo's stated reluctance to add native dependencies
   (`scripts/render-brand-icons.mjs:5-9`). Recommended: ship E11 as planned, and revisit if
   transformers is ever removed. A packaged build for an architecture whose `@img/sharp-*`
   binary was not staged (a cross-architecture mac build) also degrades to originals rather
   than failing.

5. **Lazy chunks and host updates.** E1–E3 use plain `React.lazy`. After a host update, a
   phone still holding the old `index.html` asks for chunk hashes that no longer exist. The
   door 404s them (`companion/src/routes.ts` BROWSER_STATIC). On loopback the harness returns
   `index.html` with a 200 (`server/index.ts` static miss), and the module then fails its MIME
   check. Either way the `lazy()` promise rejects, and without the §3.6 plumbing item "reload
   once on a lazy-chunk load failure", React sends the error to `RootErrorBoundary`. That
   item belongs to the plumbing group. It must land in the same release as E1–E3. The
   dependency should appear in the plan's ordering.

6. **The speech detector on phones also needs the door allowlist (spec §5).** After E1,
   `silero-vad` loads `ort-wasm-simd-threaded.*.wasm`/`.mjs` from `/assets/` and the model
   from `/vad/silero_vad.onnx`. `BROWSER_STATIC` only allows `/assets/[\w-]+\.(js|css|woff2|svg|png|json)`,
   so through the door the detector fails and the call falls back to the loudness gate. That
   is safe, because E1's `.catch(() => null)` covers it. The allowlist change is §5's host
   fix and not in this group. E4's door check deliberately checks only `.js` and `.css`, so
   it does not fail CI on the `.wasm` before that fix lands.

7. **ComputerPanel "smaller image" was not done.** The preview comes from three different
   producers: `POST /api/bots/:id/computer/screenshot` (the `box` and `vps` drivers through
   `sendScreenshot`), `POST /api/bots/:id/local-computer/screenshot` (Cua), and the Electron
   local capture. Each returns base64 inside JSON, not an image URL, so neither the `?w=`
   route nor srcset applies. Doing it properly means a `?w=` on `sendScreenshot`
   (`server/screenshot-response.ts`) using E11's resizer, plus a client parameter. That is a
   reasonable follow-up, but it is not "simple". E7 halves the poll rate instead, and E6's
   `screens=off` already stops live frames on phones.

8. **The esbuild graph test assumes esbuild drops TypeScript imports that are used only as
   types.** It does this without `verbatimModuleSyntax`, which `tsconfig.json` does not set.
   Every edit in E1–E3 also uses an explicit `import type`, so the test holds either way. If
   someone later turns on `verbatimModuleSyntax`, nothing changes for `import type`.

9. **Hetzner only for builds.** E4 Step 6 is the one step that needs `vite build`. Every
   other verification here is a vitest run or `tsc -b`, and neither bundles.

**Review Focus candidates:**
- **A lazy chunk whose name the browser door refuses.** Rollup keeps dots in chunk stems
  (for example a vendor chunk named after `ort.wasm.min`). The door's `/assets/[\w-]+\.js`
  would 404 it on phones only, with the desktop working, so no desktop test would notice.
  Covered by `scripts/check-bundle-budget.test.mjs`, in "fails a chunk the browser door
  would 404, even a lazy one" and "agrees with the browser door about script and style
  names". CI runs the real check after every build (E4).
- **A phone opening a thread other than the one it booted on.** With the slim boot, a thread
  first shows one row and would look empty until the reader scrolled up. Covered by
  `src/lib/scrollback.test.ts` ("tops up a slim thread to a full page with one ordinary
  scrollback request" and "leaves a short thread alone once it holds all of it"),
  `src/state/phone-mode.test.ts` ("tops up the conversation on screen through the scrollback
  path"), and `server/thread-paging-api.test.ts` ("still carries the open request card").
- **A menu opened inside a transcript row gets clipped** by content-visibility's paint
  containment. Examples are the voice note's "…" and a card's dropdown near the row's bottom
  edge. Covered by `src/components/TranscriptRows.test.ts` ("never clips an open menu inside
  a row"), and by the manual browser check in E10 Step 4.
