import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";
export default defineConfig({testDir:".",testMatch:"b33-memory-evolution-controls.human.spec.ts",workers:1,retries:0,timeout:90000,reporter:"list",outputDir:evidenceDir("b33-memory-evolution-controls"),use:{headless:true,trace:"retain-on-failure",screenshot:"only-on-failure"}});
