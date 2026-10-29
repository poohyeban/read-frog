import { defineConfig, mergeConfig } from "vitest/config"
import base from "./vitest.config.ts"

export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: ["benchmarks/**/*.perf.{ts,tsx}"],
      pool: "forks",
      maxWorkers: 1,
      execArgv: ["--expose-gc"],
      testTimeout: 180_000,
    },
  }),
)
