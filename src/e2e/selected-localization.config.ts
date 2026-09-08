import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'.',testMatch:'selected-localization.human.spec.ts',workers:1,retries:0,timeout:30000,outputDir:'../../.planning/selected-localization-results',use:{trace:'retain-on-failure'}});
