import {defineConfig} from '@playwright/test';
import { evidenceDir } from "./evidence";
export default defineConfig({testDir:'.',testMatch:'selected-localization.human.spec.ts',workers:1,retries:0,timeout:30000,outputDir:evidenceDir("selected-localization"),use:{trace:'retain-on-failure'}});
