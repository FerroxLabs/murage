import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";
export default defineConfig({testDir:".",testMatch:"backup-settings.human.spec.ts",workers:1,retries:0,timeout:90000,expect:{timeout:7000},outputDir:evidenceDir("backup-settings"),reporter:"list",use:{headless:true,trace:"retain-on-failure"}});
