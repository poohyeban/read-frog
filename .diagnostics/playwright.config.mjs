import { defineConfig } from "@playwright/test"
export default defineConfig({testDir:".",testMatch:"runtime.spec.mjs",timeout:150000,expect:{timeout:15000},workers:1,outputDir:"../test-results",reporter:[["list"]]})
