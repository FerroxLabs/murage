import { defineConfig } from '@playwright/test';
import { evidenceDir } from "./evidence";
export default defineConfig({ testDir: '.', testMatch: 'spend-pause.human.spec.ts', workers: 1, retries: 0, timeout: 60000, reporter: 'list', outputDir: evidenceDir('spend-pause'), use: { headless: true, viewport: {width: 1440, height: 1100}, trace: 'retain-on-failure', launchOptions: process.env.GAP_SPEND_BROWSER ? {executablePath: process.env.GAP_SPEND_BROWSER, env: {...process.env, LD_LIBRARY_PATH: process.env.GAP_SPEND_BROWSER_LIB ?? ""}} : {} } });
