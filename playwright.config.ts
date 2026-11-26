import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests",
	testMatch: "*.spec.ts",
	timeout: 60_000,
	// Each test launches its own Kalem.
	workers: 1,
	reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
	outputDir: "test-results",
});
