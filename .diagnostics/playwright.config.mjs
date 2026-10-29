import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: ".",
  testMatch: ["no-receiver.spec.mjs", "subtitles.spec.mjs"],
  timeout: 180_000,
  expect: { timeout: 15_000 },
  workers: 1,
  outputDir: "./artifacts/test-results",
  reporter: [["list"], ["html", { outputFolder: ".diagnostics/artifacts/report", open: "never" }]],
})
