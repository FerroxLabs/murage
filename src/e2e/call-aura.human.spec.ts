// The call aura, mood and read-along (call-aura-design.md) on a story page:
// the call screen's own pieces (CallMood, CallAvatar, CallCaption) mounted
// with the phase, the avatar and the voice levels under the test's hand,
// so every phase can be looked at for each avatar shape, at 1440 and 390.
// Screenshots land in MURAGE_AURA_SHOTS when set, else the evidence dir.
// Nothing here touches a server, a key or a data directory.
import { test, expect, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
import { axeScriptPath } from "./axe";

let server: ViteDevServer, origin: string, cache: string;

const PHASES = ["connecting", "listening", "thinking", "working", "speaking", "muted", "held", "reconnecting"] as const;
const AVATARS = ["circle", "square", "sprite", "mascot"] as const;

test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  cache = mkdtempSync(join(tmpdir(), "murage-call-aura-"));
  server = await createServer({
    configFile: false, root, cacheDir: cache, envFile: false,
    optimizeDeps: { noDiscovery: true, include: ["react", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime", "lucide-react"] },
    resolve: { alias: { "@": `${root}/src` } },
    server: { host: "127.0.0.1", watch: null, hmr: false },
    plugins: [tailwindcss(), {
      name: "call-aura-fixture", enforce: "pre",
      resolveId(id) { if (id === "/__aura.js") return "\0aura-entry"; },
      load(id) {
        if (id.endsWith("/src/styles.css")) return readFileSync(id, "utf8").replace('@import "tailwindcss";', '@import "tailwindcss" source(none);\n@source "./components";');
        if (id !== "\0aura-entry") return;
        return `
import React, { useState, useEffect } from "react"; import { createRoot } from "react-dom/client";
import { CallAvatar } from "/src/components/CallAvatar.tsx";
import { CallMood } from "/src/components/CallMood.tsx";
import { CallCaption } from "/src/components/CallCaption.tsx";
import { useAvatarAura } from "/src/components/CallAura.tsx";
import { useKeyboardHints } from "/src/lib/use-keyboard-hints.ts";
import { BotVoiceLevel, OwnerVoiceLevel } from "/src/lib/audio-level.ts";
import { auraPhaseFor } from "/src/lib/call-aura.ts";
import "/src/styles.css";
// the voices, under the page's hand: the bot's level and the owner's pulses
window.__botLevel = 0;
const bot = new BotVoiceLevel(() => null);
bot.level = () => window.__botLevel;
bot.hearing = () => true;
const owner = new OwnerVoiceLevel();
window.__ownerPulse = () => owner.pulse();
window.__ownerPush = (rms) => owner.push(rms);
const signals = { bot, owner };
const AVATARS = {
  circle: { avatarUrl: "/api/attachments/portrait.png", avatarCrop: "circle" },
  square: { avatarUrl: "/api/attachments/square.png", avatarCrop: "square" },
  sprite: { avatarUrl: "/api/attachments/sprite.png", avatarCrop: "circle" },
  mascot: { avatarUrl: null, avatarCrop: "mascot" },
};
const STATUS = { connecting: "Connecting…", listening: "Listening", thinking: "One moment", working: "Working", speaking: "Speaking", muted: "Muted", held: "Call paused", reconnecting: "Call paused" };
function Fixture() {
  const [state, setState] = useState({ avatar: "circle", phase: "listening", heard: "" });
  useEffect(() => { window.__set = (patch) => setState((s) => ({ ...s, ...patch })); window.__ready = true; }, []);
  const bot = { id: "ada", name: "Ada", color: "green", ...AVATARS[state.avatar] };
  const call = { listening: "listening", thinking: "sending", working: "working", speaking: "speaking", connecting: "listening", muted: "listening", held: "working", reconnecting: "speaking" }[state.phase];
  const flags = { connecting: state.phase === "connecting", muted: state.phase === "muted", held: state.phase === "held", lost: state.phase === "reconnecting" };
  const aura = useAvatarAura(bot);
  const keyboardHints = useKeyboardHints();
  const auraPhase = auraPhaseFor({ phase: call, ...flags });
  const speaking = state.phase === "speaking" || state.phase === "reconnecting";
  return React.createElement("div", { className: "pointer-events-auto absolute inset-0 isolate flex flex-col items-center justify-center gap-6 bg-app", "data-fixture-phase": state.phase, "data-fixture-avatar": state.avatar },
    React.createElement(CallMood, { phase: auraPhase, color: aura.mood, signals }),
    React.createElement(CallAvatar, { bot, phase: call, ...flags, signals }),
    React.createElement("div", { className: "flex flex-col items-center gap-1.5 text-center" },
      React.createElement("div", { className: "text-[20px] font-medium text-ink" }, "Ada"),
      React.createElement("div", { className: "text-[13.5px] text-ink-secondary" }, STATUS[state.phase])),
    React.createElement(CallCaption, {
      phase: call, heard: state.phase === "listening" ? state.heard : (speaking || state.phase === "thinking" ? "What's on the board today?" : ""),
      caption: speaking ? "Three meetings today, the first at ten." : state.phase === "thinking" ? undefined : undefined,
      spoken: speaking ? ["Here is what I found on the board."] : undefined,
      queued: speaking ? ["Nothing else is due before Thursday."] : undefined,
      progress: () => 0.45, pushToTalk: false }),
    React.createElement("div", { className: "flex items-center gap-3" },
      React.createElement("button", { className: "flex items-center gap-2 rounded-full border border-hairline/50 px-4 py-2.5 text-[13.5px] text-ink" }, "Mute"),
      React.createElement("button", { className: "flex items-center gap-2 rounded-full bg-danger px-5 py-2.5 text-[14px] font-medium text-white", "data-call-hang-up": true }, "Hang up")),
    keyboardHints ? React.createElement("div", { className: "text-[11.5px] text-ink-secondary/70", "data-call-keyboard-hints": true }, "Talk over me to interrupt · Space interrupts · Esc hangs up") : null);
}
createRoot(document.getElementById("root")).render(React.createElement(Fixture));`;
      },
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (req.url?.split("?")[0] !== "/__aura") return next();
          res.setHeader("content-type", "text/html");
          res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body class="bg-app"><div id="root"></div><script type="module" src="/__aura.js"></script>');
        });
      },
    }],
  });
  await server.listen(0);
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await server?.close(); safeWipeSync(cache); });

/** Three avatars drawn in the page, so no photo and no image API: a portrait
 *  (circle), a square tile, and a 32 px pixel-art sprite with transparency. */
async function routeAvatars(page: Page) {
  const images = await page.evaluate(() => {
    const portrait = document.createElement("canvas"); portrait.width = 320; portrait.height = 400;
    let c = portrait.getContext("2d")!;
    c.fillStyle = "#16384a"; c.fillRect(0, 0, 320, 400); c.fillStyle = "#7ad6c3"; c.fillRect(0, 300, 320, 100);
    c.fillStyle = "#e9b78e"; c.beginPath(); c.ellipse(160, 165, 85, 110, 0, 0, Math.PI * 2); c.fill();
    c.fillStyle = "#352827"; c.beginPath(); c.ellipse(160, 82, 93, 52, 0, Math.PI, Math.PI * 2); c.fill();
    c.fillRect(118, 157, 13, 9); c.fillRect(190, 157, 13, 9); c.strokeStyle = "#873b35"; c.lineWidth = 7; c.beginPath(); c.arc(160, 205, 33, 0.2, Math.PI - 0.2); c.stroke();
    const square = document.createElement("canvas"); square.width = 256; square.height = 256;
    c = square.getContext("2d")!;
    const g = c.createLinearGradient(0, 0, 256, 256); g.addColorStop(0, "#6b2fd6"); g.addColorStop(1, "#d63f8b");
    c.fillStyle = g; c.fillRect(0, 0, 256, 256); c.fillStyle = "#ffd166"; c.beginPath(); c.moveTo(128, 40); c.lineTo(216, 200); c.lineTo(40, 200); c.closePath(); c.fill();
    const sprite = document.createElement("canvas"); sprite.width = 32; sprite.height = 32;
    c = sprite.getContext("2d")!;
    const px = (x: number, y: number, w: number, h: number, color: string) => { c.fillStyle = color; c.fillRect(x, y, w, h); };
    px(10, 2, 12, 3, "#3fae6e"); px(8, 5, 16, 10, "#3fae6e"); px(11, 8, 3, 3, "#0a0a0a"); px(18, 8, 3, 3, "#0a0a0a"); px(13, 12, 6, 1, "#0a0a0a");
    px(6, 15, 20, 9, "#2a7a4c"); px(2, 16, 4, 6, "#3fae6e"); px(26, 16, 4, 6, "#3fae6e"); px(9, 24, 5, 6, "#1c7a4c"); px(18, 24, 5, 6, "#1c7a4c"); px(15, 0, 2, 3, "#ffd166");
    return { portrait: portrait.toDataURL("image/png").split(",")[1], square: square.toDataURL("image/png").split(",")[1], sprite: sprite.toDataURL("image/png").split(",")[1] };
  });
  await page.route("**/api/attachments/portrait.png", (route) => route.fulfill({ contentType: "image/png", body: Buffer.from(images.portrait, "base64") }));
  await page.route("**/api/attachments/square.png", (route) => route.fulfill({ contentType: "image/png", body: Buffer.from(images.square, "base64") }));
  await page.route("**/api/attachments/sprite.png", (route) => route.fulfill({ contentType: "image/png", body: Buffer.from(images.sprite, "base64") }));
}

/** The colour the page actually shows at an element's centre, read off a
 *  screenshot decoded in the page itself (no PNG library here): what a
 *  person sees, wash and all, where a computed style would only say what
 *  the element asked for. */
async function shownColor(page: Page, selector: string, at: [number, number] = [0.12, 0.5]): Promise<[number, number, number] & { where: string }> {
  const shot = (await page.screenshot()).toString("base64");
  const { rgb, where } = await page.evaluate(async ({ shot, selector, at }) => {
    const el = document.querySelector(selector)!;
    const box = el.getBoundingClientRect();
    const image = new Image();
    await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("shot")); image.src = `data:image/png;base64,${shot}`; });
    const scale = image.naturalWidth / window.innerWidth;
    const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const ctx = canvas.getContext("2d")!; ctx.drawImage(image, 0, 0);
    // a little left of centre, clear of the label's white glyphs
    const x = Math.round((box.left + box.width * at[0]) * scale), y = Math.round((box.top + box.height * at[1]) * scale);
    const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
    return { rgb: [r, g, b] as [number, number, number], where: `${selector} at ${x},${y} of ${image.naturalWidth}x${image.naturalHeight} (rect ${JSON.stringify(box)}, inner ${window.innerWidth}x${window.innerHeight}, scroll ${window.scrollX},${window.scrollY})` };
  }, { shot, selector, at });
  return Object.assign(rgb, { where });
}

function hue([r, g, b]: [number, number, number]): number {
  const R = r / 255, G = g / 255, B = b / 255, max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min;
  if (d === 0) return 0;
  const h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return h * 60;
}

const OWNER_HUE = hue([96, 150, 255]);
/** Where the ground is read: the empty strip at the foot of the screen,
 *  below the controls and the hints at both widths, far from the avatar's
 *  own rings. */
const GROUND_AT: [number, number] = [0.5, 0.96];

/** The owner talking: a pulse every 300 ms until ownerQuiet at the phase
 *  change, then a wait for the wash to be up. A single pulse is gone before
 *  a slow screenshot lands on a busy machine. */
async function ownerTalks(page: Page, min = 0.5): Promise<void> {
  await page.evaluate(() => {
    const w = window as any;
    w.__ownerPulse();
    w.__ownerTimers = [setInterval(() => w.__ownerPulse(), 300)];
  });
  await expect.poll(() => page.locator('[data-mood="owner"]').evaluate((el) => Number(el.style.opacity)), { message: "owner wash up", timeout: 5000 }).toBeGreaterThan(min);
}

/** The avatar's own image is on screen (not still loading, not fallen back
 *  to the mascot) before anything is looked at. */
async function avatarShown(page: Page, avatar: string): Promise<void> {
  if (avatar === "mascot") return;
  await expect.poll(
    () => page.evaluate(() => { const img = document.querySelector<HTMLImageElement>("[data-call-avatar-phase] img"); return img ? `${img.complete}:${img.naturalWidth}` : "no img"; }),
    { message: `${avatar} image shown`, timeout: 10000 },
  ).toMatch(/^true:[1-9]/);
}

/** The owner stops talking: no pulse still to come runs on into the bot's
 *  turn. Called before every phase change. */
async function ownerQuiet(page: Page): Promise<void> {
  await page.evaluate(() => { for (const timer of (window as any).__ownerTimers ?? []) clearInterval(timer); (window as any).__ownerTimers = []; });
}

/** The owner's wash has gone from the ground (its release is 1.1 s). */
async function ownerWashDown(page: Page): Promise<void> {
  await expect.poll(() => page.locator('[data-mood="owner"]').evaluate((el) => Number(el.style.opacity)), { timeout: 8000 }).toBeLessThan(0.08);
}
const hueGap = (a: number, b: number) => { const d = Math.abs(((a - b) % 360 + 360) % 360); return d > 180 ? 360 - d : d; };

test("every phase, for a circular photo, a square image, a transparent sprite and the mascot", async ({ page }, info) => {
  const shots = process.env.MURAGE_AURA_SHOTS ? join(process.env.MURAGE_AURA_SHOTS, info.project.name) : info.outputPath();
  mkdirSync(shots, { recursive: true });
  // routes first: the portrait is asked for on mount, and a miss is cached
  await routeAvatars(page);
  await page.goto(`${origin}/__aura`);
  await page.waitForFunction(() => (window as any).__ready === true);
  const canvas = page.locator("canvas[data-call-aura]");
  const hangUpColors: { avatar: string; phase: string; asked: string; shown: [number, number, number] }[] = [];
  for (const avatar of AVATARS) {
    await page.evaluate((avatar) => (window as any).__set({ avatar, phase: "listening" }), avatar);
    await avatarShown(page, avatar);
    if (avatar === "sprite") {
      // the sprite is shown whole, crisp, with the aura on its silhouette
      await expect(canvas).toHaveAttribute("data-aura-shape", "silhouette");
      const img = page.locator('img[data-avatar-silhouette="true"]');
      await expect(img).toBeVisible();
      await expect(img).toHaveCSS("border-radius", "0px");
      await expect(img).toHaveCSS("object-fit", "contain");
      await expect(img).toHaveCSS("image-rendering", "pixelated");
    } else if (avatar === "square") {
      await expect(canvas).toHaveAttribute("data-aura-shape", "square");
    } else {
      await expect(canvas).toHaveAttribute("data-aura-shape", "circle");
    }
    await expect(canvas).toHaveAttribute("data-aura-variant", avatar === "mascot" ? "soft" : "full");
    for (const phase of PHASES) {
      await ownerQuiet(page);
      await page.evaluate(({ phase }) => {
        (window as any).__botLevel = phase === "speaking" ? 0.75 : 0;
        (window as any).__set({ phase, heard: phase === "listening" ? "What's on the board" : "" });
      }, { phase });
      // the owner's turn is the owner talking, for the screenshot and the checks alike
      if (phase === "listening") await ownerTalks(page);
      await expect(canvas).toHaveAttribute("data-call-aura", phase);
      await expect(canvas).toHaveAttribute("data-aura-mode", phase === "muted" || phase === "held" ? "static" : "animated");
      if (phase === "speaking") await expect(page.getByTestId("read-along")).toBeVisible();
      // let the washes and rings settle into the phase
      await page.waitForTimeout(phase === "listening" ? 650 : 900);
      await page.screenshot({ path: join(shots, `${avatar}-${phase}.png`) });
      if (phase === "listening" || phase === "speaking") {
        // the ground tells the two sides apart for every avatar: the owner's
        // turn reads blue, the bot's turn reads warm (at least 90 degrees of
        // hue away), whatever hue the avatar itself has
        if (phase === "speaking") await ownerWashDown(page);
        const wash = page.locator(`[data-mood="${phase === "listening" ? "owner" : "bot"}"]`);
        await expect.poll(() => wash.evaluate((el) => Number(el.style.opacity)), { message: `${avatar} ${phase} wash up`, timeout: 5000 }).toBeGreaterThan(0.5);
        const ground = await shownColor(page, "[data-fixture-phase]", GROUND_AT);
        const moodHue = hue(ground);
        if (phase === "listening") expect(hueGap(moodHue, OWNER_HUE), `${avatar} listening ground ${ground.join(",")}; ${ground.where}`).toBeLessThan(30);
        else expect(hueGap(moodHue, OWNER_HUE), `${avatar} speaking ground ${ground.join(",")}; ${ground.where}`).toBeGreaterThanOrEqual(90);
        // the controls keep their true colours above the mood: the red Hang
        // up is the same red in both phases, in computed style and on screen
        const hangUp = page.locator("[data-call-hang-up]");
        const asked = await hangUp.evaluate((el) => getComputedStyle(el).backgroundColor);
        const shown = await shownColor(page, "[data-call-hang-up]");
        hangUpColors.push({ avatar, phase, asked, shown });
        const askedRgb = asked.match(/\d+(\.\d+)?/g)!.slice(0, 3).map(Number) as [number, number, number];
        for (let c = 0; c < 3; c += 1) expect(Math.abs(shown[c] - askedRgb[c]), `${avatar} ${phase} hang up shows ${shown.join(",")} for ${asked}; ${shown.where}`).toBeLessThanOrEqual(10);
      }
    }
  }
  expect(new Set(hangUpColors.map((entry) => entry.asked)).size, `hang up background across phases: ${JSON.stringify(hangUpColors)}`).toBe(1);
  // keyboard hints only where there is a keyboard: the phone project has a touch screen
  await expect(page.locator("[data-call-keyboard-hints]")).toHaveCount(info.project.name === "mobile" ? 0 : 1);
  // the aura never widens the page
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // the mood at its peak, on dark and on light: the owner's blue across the
  // whole ground, the bot's hue around the avatar, and the text still
  // readable over both (axe's contrast rule, on the frame the wash is up)
  await page.addScriptTag({ content: readFileSync(axeScriptPath, "utf8") });
  for (const skin of ["dark", "light"] as const) {
    await page.evaluate((skin) => (document.documentElement.dataset.skin = skin), skin);
    let listeningGround: [number, number, number] | null = null;
    for (const phase of ["listening", "speaking"] as const) {
      await ownerQuiet(page);
      await page.evaluate(({ phase }) => {
        (window as any).__botLevel = phase === "speaking" ? 0.85 : 0;
        (window as any).__set({ avatar: "circle", phase, heard: phase === "listening" ? "What's on the board today, and is anything due before Thursday" : "" });
      }, { phase });
      await avatarShown(page, "circle");
      // light's peak is 0.7 (MOOD_PEAK), so its wash tops out lower
      if (phase === "listening") await ownerTalks(page, skin === "dark" ? 0.5 : 0.3);
      else { await ownerWashDown(page); await page.waitForTimeout(600); }
      const wash = page.locator(`[data-mood="${phase === "listening" ? "owner" : "bot"}"]`);
      await expect.poll(() => wash.evaluate((el) => Number(el.style.opacity)), { message: `${skin} ${phase} wash opacity`, timeout: 5000 }).toBeGreaterThan(skin === "dark" ? 0.6 : 0.35);
      const ground = await shownColor(page, "[data-fixture-phase]", GROUND_AT);
      if (phase === "listening") {
        expect(hueGap(hue(ground), OWNER_HUE), `${skin} listening ground ${ground.join(",")}`).toBeLessThan(30);
        listeningGround = ground;
      } else if (skin === "dark") {
        expect(hueGap(hue(ground), OWNER_HUE), `${skin} speaking ground ${ground.join(",")}`).toBeGreaterThanOrEqual(90);
      } else {
        // light keeps a lighter touch (MOOD_PEAK.light) over a pale blue
        // ground, so at the very foot the hue need not flip (the flip is read
        // around the avatar); it must still move toward warm from where the
        // owner's turn left it. Measured 20 at 390 px, 90 at 1440.
        const warmth = ([r, , b]: [number, number, number]) => r - b;
        expect(warmth(ground) - warmth(listeningGround!), `${skin} speaking ground ${ground.join(",")} after listening ${listeningGround!.join(",")}`).toBeGreaterThanOrEqual(12);
      }
      await page.screenshot({ path: join(shots, `circle-${phase}-${skin}.png`) });
      const report = await page.evaluate(async () => (window as any).axe.run(document, { runOnly: ["color-contrast"] }));
      writeFileSync(join(shots, `axe-${phase}-${skin}.json`), JSON.stringify(report, null, 2));
      expect(report.violations.map((violation: { id: string }) => violation.id), `${skin} ${phase}`).toEqual([]);
    }
  }
  await ownerQuiet(page);
  await page.evaluate(() => (document.documentElement.dataset.skin = "dark"));
  // reduced motion: a static paint, told apart by opacity
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => (window as any).__set({ avatar: "circle", phase: "speaking" }));
  await expect(canvas).toHaveAttribute("data-aura-mode", "static");
  await page.evaluate(() => (window as any).__set({ phase: "muted" }));
  await expect(canvas).toHaveCSS("opacity", "0.45");
  await page.emulateMedia({ reducedMotion: "no-preference" });
});
