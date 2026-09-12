import { wipeE2EData } from './global-setup';

export default async function globalTeardown(): Promise<void> {
	try {
		wipeE2EData();
	} catch {
		// Teardown must never mask test results; leftovers are wiped on the
		// next run's setup anyway.
	}
}
