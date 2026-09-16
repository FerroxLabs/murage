import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";
export default defineConfig({testDir:".",testMatch:"b32-procedure-history.human.spec.ts",workers:1,retries:0,timeout:90000,reporter:"list",outputDir:evidenceDir("b32-procedure-history"),use:{headless:true,trace:"retain-on-failure",screenshot:"only-on-failure"}});
