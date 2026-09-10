import { expect, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let fixture: { info: { url: string; dataDir: string }; close(): Promise<void> }, vite: ViteDevServer, origin: string, headers: Record<string, string>;
type Profile = { id: string; name: string; partitionId?: string };
const project = (profiles: Profile[]) => profiles.map(({ id, name }) => ({ id, name }));
const api = async (method: string, body?: unknown) => {
  const response = await fetch(fixture.info.url + "/api/config", { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  expect(response.status).toBe(200);
  return await response.json() as { browserProfiles: Profile[] };
};
const update = async (change: (profiles: Profile[]) => Profile[]) => {
  const current = (await api("GET")).browserProfiles;
  return api("PATCH", { browserProfiles: project(change(current)), expectedBrowserProfiles: project(current) });
};
test.beforeAll(async () => {
  const { launchVerificationServer } = await import(new URL("../../scripts/control-murage.ts", import.meta.url).href);
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const fs=await import('node:fs');const path=await import('node:path');const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');
    const config=JSON.parse(fs.readFileSync(file,'utf8'));config.features={browser:true};config.browserProfiles=[{id:'work',name:'Work',partitionId:'Work'}];fs.writeFileSync(file,JSON.stringify(config));
  ` });
  const proof = await (await fetch(fixture.info.url + "/api/desktop-secret")).json(); headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  try {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    vite = await createServer({ configFile: false, root, envFile: false, cacheDir: join(fixture.info.dataDir, "profiles-vite-cache"), resolve: { alias: { "@": join(root, "src") } },
      server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, proxy: { "/api": { target: fixture.info.url } } }, plugins: [react(), tailwindcss(), {
        name: "browser-profile-cas-fixture", resolveId(id) { if (id === "/__profiles.js") return "\0browser-profile-cas"; },
        load(id) { if (id !== "\0browser-profile-cas") return; return `
          import React from 'react';import {createRoot} from 'react-dom/client';import {StoreProvider} from '/src/state/store.tsx';import {BrowserProfilesRow} from '/src/components/SettingsModal.tsx';import '/src/styles.css';
          window.forgetCalls=0;window.muragebox={platform:'darwin',browser:{forgetProfile:async()=>{window.forgetCalls++}}};
          createRoot(document.getElementById('root')).render(React.createElement(StoreProvider,null,React.createElement(BrowserProfilesRow)));`; },
        configureServer(server) { server.middlewares.use((req, res, next) => { if (req.url !== "/__profiles") return next(); res.setHeader("content-type", "text/html"); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;background:var(--color-app);color:var(--color-ink)"><main id="root" style="max-width:620px;margin:24px auto;padding:16px"></main><script type="module" src="/__profiles.js"></script>'); }); },
      }] });
    await vite.listen(0); const address = vite.httpServer!.address(); if (!address || typeof address === "string") throw Error("No profile fixture port"); origin = `http://127.0.0.1:${address.port}`;
  } catch (error) { await vite?.close(); await fixture.close(); throw error; }
});
test.afterAll(async () => { try { await vite?.close(); } finally { await fixture?.close(); } });

for (const width of [390, 1440]) for (const skin of ["light", "dark"]) test(`stale profile rename/delete preserves newer list at ${width}px ${skin}`, async ({ page }, info) => {
  await update(profiles => profiles.map(profile => profile.id === "work" ? { ...profile, name: "Work" } : profile));
  await page.setViewportSize({ width, height: 1000 }); await page.goto(origin + "/__profiles");
  await page.evaluate(skin => document.documentElement.dataset.skin = skin, skin);
  await page.getByRole("button", { name: "Work", exact: true }).click();
  await page.getByRole("textbox", { name: "Profile name", exact: true }).fill("Stale name");
  const firstId = `extra-${width}-${skin}`;
  await update(profiles => [...profiles, { id: firstId, name: firstId }]);
  await expect(page.getByRole("button", { name: firstId, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Browser profiles changed elsewhere");
  expect((await api("GET")).browserProfiles.find(profile => profile.id === "work")?.name).toBe("Work");
  await page.getByRole("button", { name: "Refresh profiles", exact: true }).click(); await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Work", exact: true }).click();
  await page.getByRole("textbox", { name: "Profile name", exact: true }).fill("Reviewed Work");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("button", { name: "Reviewed Work", exact: true })).toBeVisible();
  const secondId = `later-${width}-${skin}`;
  page.once("dialog", async dialog => { await update(profiles => [...profiles, { id: secondId, name: secondId }]); await dialog.accept(); });
  const row = page.getByRole("button", { name: "Reviewed Work", exact: true }).locator("../..");
  await row.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Browser profiles changed elsewhere");
  const persisted = (await api("GET")).browserProfiles;
  expect(persisted.find(profile => profile.id === "work")).toMatchObject({ name: "Reviewed Work", partitionId: "Work" });
  expect(persisted.some(profile => profile.id === firstId)).toBe(true); expect(persisted.some(profile => profile.id === secondId)).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { forgetCalls: number }).forgetCalls)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`profile-conflict-${width}-${skin}.png`), fullPage: true });
});
