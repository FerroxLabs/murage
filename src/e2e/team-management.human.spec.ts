// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Team management the way the owner does it: from a team heading's menu in
// the sidebar and from a channel's details, rename a team, add and remove
// bots, change the lead, and delete the team. Runs the real app against a
// verification server with its own data dir (never ~/.murage, never 8799).
// Run: MURAGE_E2E_DATA_DIR=<scratch dir> npx playwright test -c src/e2e/team-management.config.ts
import { test, expect, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

interface Fixture { info: { url: string; dataDir: string }; close(): Promise<void> }
type Launcher = (environment: NodeJS.ProcessEnv, signal?: AbortSignal, options?: { instrumentationSource?: string }) => Promise<Fixture>;
let fixture: Fixture, vite: ViteDevServer, origin: string, owner: Record<string, string>;

const bot = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, threadId: `${id}-thread`, name, title: "", description: "", color: "green", notifications: false, unread: false, createdAt: 1,
  modelSelection: { instanceId: "verification", model: "sonnet" }, resumeCursors: {},
  tasks: [{ threadId: `${id}-thread`, title: "Work", createdAt: 1, resumeCursors: {} }],
  composio: false, computer: "off", browser: false, ...extra,
});
const bots = [
  bot("nova", "Nova", { chiefOfStaff: true, chiefScope: "workspace" }),
  bot("ava", "Ava", { section: "Operations", chiefOfStaff: true }),
  bot("ben", "Ben", { section: "Operations" }),
  bot("cal", "Cal"),
  bot("sid", "Sid", { section: "Sales", chiefOfStaff: true }),
  bot("sue", "Sue", { section: "Sales" }),
];
const groups = [
  { id: "ops-room", threadId: "ops-room-thread", name: "Operations", memberIds: ["ava", "ben"], defaultResponder: { kind: "member", botId: "ava" },
    bulletin: "", unread: false, createdAt: 1, section: "Operations", tasks: [{ threadId: "ops-room-thread", title: "Room", createdAt: 1 }],
    setupCompletedAt: 1, setupSkippedAt: null },
  { id: "sales-room", threadId: "sales-room-thread", name: "Pipeline", memberIds: ["sid", "sue"], defaultResponder: { kind: "member", botId: "sid" },
    bulletin: "", unread: false, createdAt: 1, section: "Sales", tasks: [{ threadId: "sales-room-thread", title: "Room", createdAt: 1 }],
    setupCompletedAt: 1, setupSkippedAt: null },
];

test.beforeAll(async () => {
  const { launchVerificationServer } = await import(new URL("../../scripts/control-murage.ts", import.meta.url).href) as { launchVerificationServer: Launcher };
  fixture = await launchVerificationServer(process.env, undefined, {
    instrumentationSource: `import {writeFileSync} from 'node:fs';import {join} from 'node:path';writeFileSync(join(process.env.MURAGE_DATA_DIR,'bots.json'),${JSON.stringify(JSON.stringify(bots))});writeFileSync(join(process.env.MURAGE_DATA_DIR,'groups.json'),${JSON.stringify(JSON.stringify(groups))});`,
  });
  try {
    const proof = await (await fetch(fixture.info.url + "/api/desktop-secret")).json() as { secret: string };
    owner = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
    const root = fileURLToPath(new URL("../../", import.meta.url));
    vite = await createServer({ configFile: false, root, envFile: false, cacheDir: join(fixture.info.dataDir, "teams-vite-cache"), resolve: { alias: { "@": join(root, "src") } },
      server: { host: "127.0.0.1", watch: null, hmr: false, proxy: { "/api": { target: fixture.info.url, ws: true } } }, plugins: [react(), tailwindcss()] });
    await vite.listen(0);
    const address = vite.httpServer!.address();
    if (!address || typeof address === "string") throw Error("Team fixture did not bind");
    origin = `http://127.0.0.1:${address.port}`;
  } catch (error) { await vite?.close(); await fixture.close(); throw error; }
});
test.afterAll(async () => { try { await vite?.close(); } finally { await fixture?.close(); } });

const stored = async () =>
  ((await (await fetch(fixture.info.url + "/api/bots?messages=0", { headers: owner })).json()) as { bots: Array<{ id: string; section?: string; chiefOfStaff?: boolean; hidden?: boolean }> }).bots;
const storedBot = async (id: string) => (await stored()).find((candidate) => candidate.id === id)!;
const storedGroups = async () =>
  ((await (await fetch(fixture.info.url + "/api/bots?messages=0", { headers: owner })).json()) as { groups: Array<{ id: string; name: string; section?: string; hidden?: boolean }> }).groups;

async function open(page: Page, width: number, skin: "light" | "dark") {
  await page.setViewportSize({ width, height: 900 });
  // The What's new page would open over everything on a fresh install.
  await page.route("**/api/whats-new?*", (route) => route.fulfill({ json: { show: false } }));
  await page.addInitScript((value) => {
    localStorage.setItem("murage-skin", value);
    localStorage.setItem("murage-email-gate", "skipped");
    localStorage.setItem("murage-flux-invite-dismissed", "1");
  }, skin);
  await page.goto(origin);
  await page.evaluate((value) => (document.documentElement.dataset.skin = value), skin);
  if (width < 768) await page.getByRole("button", { name: "Open bot list", exact: true }).click();
}

const noSideScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

test("rename, members, lead and delete from the team heading menu (1440, light)", async ({ page }, testInfo) => {
  await open(page, 1440, "light");
  const menuButton = page.getByRole("button", { name: "Operations team options", exact: true });
  await expect(menuButton).toBeVisible();

  // Keyboard: open with ArrowDown, move, Escape gives focus back.
  await menuButton.focus();
  await page.keyboard.press("ArrowDown");
  const menu = page.getByRole("menu", { name: "Operations team options" });
  await expect(menu.getByRole("menuitem", { name: "Rename team" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "Manage members and lead" })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("team-menu-1440-light.png") });
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(menuButton).toBeFocused();

  // Rename.
  await page.keyboard.press("Enter");
  await menu.getByRole("menuitem", { name: "Rename team" }).click();
  const dialog = page.getByRole("dialog", { name: "Operations" });
  const nameField = dialog.getByRole("textbox", { name: "Team name" });
  await expect(nameField).toBeFocused();
  await nameField.fill("Pinned");
  await expect(dialog.getByText('"Pinned" is already a heading in the sidebar. Choose another name.')).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Save name" })).toBeDisabled();
  await nameField.fill("Ops Crew");
  await dialog.getByRole("button", { name: "Save name" }).click();
  const renamed = page.getByRole("dialog", { name: "Ops Crew" });
  await expect(renamed.getByRole("status")).toHaveText("Renamed to Ops Crew.");
  await expect(page.getByRole("button", { name: "Ops Crew team options", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Operations team options", exact: true })).toHaveCount(0);
  expect((await storedBot("ben")).section).toBe("Ops Crew");
  expect((await storedGroups()).find((group) => group.id === "ops-room")).toMatchObject({ name: "Ops Crew", section: "Ops Crew" });
  await page.screenshot({ path: testInfo.outputPath("team-renamed-1440-light.png") });

  // Members: add Cal, remove Ben, make Cal the lead.
  await renamed.getByRole("checkbox", { name: "Cal", exact: true }).click();
  await expect(renamed.getByRole("checkbox", { name: "Cal", exact: true })).toHaveAttribute("aria-checked", "true");
  await renamed.getByRole("checkbox", { name: "Ben", exact: true }).click();
  await expect(renamed.getByText("Leaves this team when you save")).toBeVisible();
  await renamed.getByRole("combobox", { name: "Team lead" }).selectOption({ label: "Cal" });
  await page.screenshot({ path: testInfo.outputPath("team-members-draft-1440-light.png") });
  await renamed.getByRole("button", { name: "Save members" }).click();
  await expect(renamed.getByRole("status")).toHaveText("Members saved.");
  expect(await storedBot("cal")).toMatchObject({ section: "Ops Crew", chiefOfStaff: true });
  expect(await storedBot("ava")).toMatchObject({ section: "Ops Crew", chiefOfStaff: false });
  expect((await storedBot("ben")).section ?? "").toBe("");
  await expect(renamed.getByRole("button", { name: "Save members" })).toBeDisabled();

  // Delete, keeping the bots. Asked inline; Cancel changes nothing.
  await renamed.getByRole("button", { name: "Delete team" }).click();
  await expect(renamed.getByRole("button", { name: "Cancel" })).toBeFocused();
  await expect(renamed.getByRole("radio", { name: "Keep them as bots without a team" })).toBeChecked();
  await expect(renamed.getByText("2 bots stay, as bots without a team. Cal stops leading.")).toBeVisible();
  await expect(renamed.getByText("Every conversation is kept.")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("team-delete-confirm-1440-light.png") });
  await renamed.getByRole("button", { name: "Cancel" }).click();
  await expect(renamed.getByRole("button", { name: "Delete team" })).toBeFocused();
  await renamed.getByRole("button", { name: "Delete team" }).click();
  await renamed.getByRole("button", { name: "Delete Ops Crew" }).click();
  await expect(renamed).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Ops Crew team options", exact: true })).toHaveCount(0);
  for (const id of ["ava", "cal", "ben"]) {
    const record = await storedBot(id);
    expect(record.section ?? "").toBe("");
    expect(record.hidden ?? false).toBe(false);
  }
  expect((await storedGroups()).find((group) => group.id === "ops-room")).toMatchObject({ name: "Ops Crew" });
  await noSideScroll(page);
  await page.screenshot({ path: testInfo.outputPath("team-deleted-1440-light.png") });
});

test("channel details open the team, and archive-on-delete at phone width (390, dark)", async ({ page }, testInfo) => {
  await open(page, 390, "dark");
  const menuButton = page.getByRole("button", { name: "Sales team options", exact: true });
  await expect(menuButton).toBeVisible();
  await menuButton.click();
  await page.getByRole("menuitem", { name: "Manage members and lead" }).click();
  const dialog = page.getByRole("dialog", { name: "Sales" });
  await expect(dialog.getByRole("checkbox").first()).toBeFocused();
  await expect(dialog.getByRole("combobox", { name: "Team lead" })).toHaveValue("sid");
  await noSideScroll(page);
  await page.screenshot({ path: testInfo.outputPath("team-members-390-dark.png") });

  // Lead change alone.
  await dialog.getByRole("combobox", { name: "Team lead" }).selectOption({ label: "Sue" });
  await dialog.getByRole("button", { name: "Save members" }).click();
  await expect(dialog.getByRole("status")).toHaveText("Members saved.");
  expect(await storedBot("sue")).toMatchObject({ chiefOfStaff: true });
  expect(await storedBot("sid")).toMatchObject({ chiefOfStaff: false });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // Archive the whole team from the confirm panel. Escape also closed the
  // phone's drawer, so open the bot list again.
  const reopen = page.getByRole("button", { name: "Open bot list", exact: true });
  if (await reopen.getAttribute("aria-expanded") === "false") await reopen.click();
  await page.getByRole("button", { name: "Sales team options", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete team" }).click();
  const confirm = page.getByRole("dialog", { name: "Sales" });
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await confirm.getByRole("radio", { name: "Archive them" }).check();
  await expect(confirm.getByText("2 bots are archived. You can restore them from Archived bots.")).toBeVisible();
  await expect(confirm.getByText("1 channel is archived.")).toBeVisible();
  await noSideScroll(page);
  await page.screenshot({ path: testInfo.outputPath("team-delete-archive-390-dark.png") });
  await confirm.getByRole("button", { name: "Delete Sales" }).click();
  await expect(confirm).toHaveCount(0);
  expect(await storedBot("sid")).toMatchObject({ hidden: true, chiefOfStaff: false });
  expect(await storedBot("sue")).toMatchObject({ hidden: true, chiefOfStaff: false });
  expect((await storedGroups()).find((group) => group.id === "sales-room")).toMatchObject({ hidden: true });
  expect(await storedBot("nova")).toMatchObject({ chiefOfStaff: true });
});

test("a channel's details lead to its team (820, light)", async ({ page }, testInfo) => {
  // A fresh team with a channel, made through the same routes the app uses.
  const filed = await fetch(fixture.info.url + "/api/sidebar-sections", { method: "POST", headers: { ...owner, "content-type": "application/json" }, body: JSON.stringify({ name: "Studio", botIds: ["ben"] }) });
  expect(filed.status).toBe(200);
  const room = await fetch(fixture.info.url + "/api/groups", { method: "POST", headers: { ...owner, "content-type": "application/json" }, body: JSON.stringify({ name: "Studio desk", memberIds: ["ben"], section: "Studio" }) });
  expect(room.status).toBe(201);
  const roomId = ((await room.json()) as { group: { id: string } }).group.id;
  await open(page, 820, "light");
  expect(roomId).toBeTruthy();
  await page.getByRole("complementary").getByText("Studio desk", { exact: true }).first().click();
  await page.getByRole("button", { name: "Details for Studio desk", exact: true }).click();
  const details = page.getByRole("dialog", { name: "Studio desk details" });
  await details.getByRole("button", { name: "Manage Studio team" }).click();
  const team = page.getByRole("dialog", { name: "Studio" });
  await expect(team.getByRole("checkbox", { name: "Ben", exact: true })).toHaveAttribute("aria-checked", "true");
  await page.screenshot({ path: testInfo.outputPath("team-from-channel-820-light.png") });
  await team.getByRole("button", { name: "Close team settings" }).click();
  await expect(team).toHaveCount(0);
});
