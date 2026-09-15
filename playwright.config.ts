import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests drive the built app in Electron. `pnpm run test:e2e` builds it first;
 * the tests start it from the project, so they run the code in `.vite/`.
 */
export default defineConfig({
	testDir: './e2e',
	timeout: 60_000,
	expect: { timeout: 10_000 },
	// Each test starts its own app, and several at once compete for the same machine.
	workers: 1,
	reporter: process.env.CI ? 'github' : 'list',
	use: { trace: 'retain-on-failure' }
});
