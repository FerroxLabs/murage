import { defineConfig,devices } from "@playwright/test";
import { evidenceDir } from "./evidence";
export default defineConfig({testDir:".",testMatch:"startup.human.spec.ts",workers:1,retries:0,timeout:30000,reporter:"list",outputDir:evidenceDir("startup"),use:{headless:true,screenshot:"only-on-failure",trace:"retain-on-failure"},projects:[{name:"desktop",use:{...devices["Desktop Chrome"],viewport:{width:1440,height:1000}}},{name:"narrow",use:{...devices["Desktop Chrome"],viewport:{width:390,height:844}}}]});
