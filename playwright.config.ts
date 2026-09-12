import { defineConfig, devices } from '@playwright/test';

// Phase 4E browser QA. Lives in its own workspace (tourney-web's npm tree is
// broken — the Arborist bug — so nothing here touches the app's package.json).
//
// Topology: a FRESH tourney-api on :8095 (never the developer's long-running
// :8090 binary) + a vite dev server on :4400 pointed at it. One worker,
// serial: the suites share one database and one API process, and the
// presentation spec deliberately restarts the API at the very end.
export default defineConfig({
	testDir: './specs',
	workers: 1,
	fullyParallel: false,
	timeout: 90_000,
	expect: { timeout: 10_000 },
	retries: 0,
	reporter: [['list']],
	globalSetup: './global-setup.ts',
	globalTeardown: './global-teardown.ts',
	use: {
		baseURL: 'http://localhost:4400',
		...devices['Desktop Chrome'],
		viewport: { width: 1280, height: 800 },
		storageState: '.auth/organizer.json',
		trace: 'retain-on-failure'
	},
	webServer: [
		{
			command: 'bash scripts/run-api.sh',
			url: 'http://localhost:8095/healthz',
			timeout: 180_000,
			reuseExistingServer: false,
			cwd: __dirname
		},
		{
			command: 'bash scripts/run-web.sh',
			url: 'http://localhost:4400',
			timeout: 180_000,
			reuseExistingServer: false,
			cwd: __dirname
		}
	]
});
