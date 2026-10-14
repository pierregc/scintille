import { describe, expect, it, vi } from 'vitest';
import fixture from '../../../fixtures/storms/2026-07-15-orlando.json';
import type { StormDetail } from '../contract/types';
import { REPLAY_FIXTURE_SLUG, runDevStorm } from './dev-storm';

describe('fixture replay entry', () => {
	it('loads only the explicit fixture and positions the camera for inspection', async () => {
		const openStorm = vi.fn().mockResolvedValue(fixture as StormDetail);
		const flyTo = vi.fn().mockResolvedValue(true);
		expect(await runDevStorm({ openStorm }, flyTo, `?storm=${REPLAY_FIXTURE_SLUG}&speed=30`, 'https://preview.test/_replay-fixtures/')).toBe(true);
		expect(openStorm).toHaveBeenCalledWith('https://preview.test/_replay-fixtures/', REPLAY_FIXTURE_SLUG, 30);
		expect(flyTo).toHaveBeenCalledWith({ lat: 28.5, lon: -81.3, altitude: 2000, duration: 0 });
	});

	it('does not fetch without the fixture query and does not fly after a cancelled load', async () => {
		const openStorm = vi.fn().mockResolvedValue(null);
		const flyTo = vi.fn();
		for (const search of ['', '?storm=another-storm']) {
			expect(await runDevStorm({ openStorm }, flyTo, search, 'https://preview.test/')).toBe(false);
		}
		expect(openStorm).not.toHaveBeenCalled();
		expect(await runDevStorm({ openStorm }, flyTo, `?storm=${REPLAY_FIXTURE_SLUG}&speed=NaN`, 'https://preview.test/')).toBe(false);
		expect(openStorm).toHaveBeenCalledWith('https://preview.test/', REPLAY_FIXTURE_SLUG, 1);
		expect(flyTo).not.toHaveBeenCalled();
	});
});
