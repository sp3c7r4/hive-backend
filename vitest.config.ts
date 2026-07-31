import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "src"),
			"@/app": path.resolve(__dirname, "app"),
		},
	},
	test: {
		globals: true,
		setupFiles: ["./tests/setup.ts"],
		testTimeout: 30_000,
		hookTimeout: 120_000,
		fileParallelism: false,
	},
});
