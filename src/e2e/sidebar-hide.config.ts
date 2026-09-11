import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";
export default defineConfig({testDir:'.',testMatch:'sidebar-hide.human.spec.ts',workers:1,retries:0,timeout:30000,expect:{timeout:5000},reporter:'list',outputDir:evidenceDir("sidebar-hide"),use:{headless:true,trace:'retain-on-failure'}});
