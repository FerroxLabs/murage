import { defineConfig, devices } from "@playwright/test";
export default defineConfig({testDir:".",testMatch:"threads.human.spec.ts",workers:1,retries:0,timeout:90000,expect:{timeout:10000},reporter:"list",outputDir:"../../.planning/thread-ui-evidence",use:{headless:true,trace:"retain-on-failure",screenshot:"only-on-failure"},projects:[
  {name:"desktop",use:{...devices["Desktop Chrome"],viewport:{width:1440,height:1000}}},
  {name:"narrow",use:{...devices["Desktop Chrome"],viewport:{width:390,height:844}}},
]});
