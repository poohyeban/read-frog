import { defineConfig } from "@playwright/test"
export default defineConfig({
  testDir: ".",
  testMatch: "loader-156.spec.mjs",
  timeout: 240000,
  expect: { timeout: 15000 },
  workers: 1,
  outputDir: ".diagnostics/artifacts/test-results",
  reporter: [["list"]],
})
