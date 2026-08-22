import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: false,
		environment: "node",
		// worker_threads instead of forked processes: the harness sandbox denies
		// piped-stdio child spawns (EPERM), and thread pools need no pipe.
		pool: "threads",
		testTimeout: 15000,
		include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
	},
});
