import { describe, expect, it } from 'vitest';
import { SceneClock } from './clock';
import { applyDevReplay } from './dev-replay';

describe('applyDevReplay', () => {
	const clock = () => new SceneClock(() => Date.UTC(2027, 0, 1));

	it('replays from the given instant and speed', () => {
		const c = clock();
		applyDevReplay(c, '?replay=2026-07-15T18:30:00Z&speed=4');
		expect(c.mode).toBe('replay');
		expect(c.time()).toBe(Date.UTC(2026, 6, 15, 18, 30));
		expect(c.speed).toBe(4);
	});

	it('stays live without a valid instant', () => {
		for (const search of ['', '?replay=soon']) {
			const c = clock();
			applyDevReplay(c, search);
			expect(c.mode).toBe('live');
		}
	});

	it('falls back to real time on a bad speed', () => {
		const c = clock();
		applyDevReplay(c, '?replay=2026-07-15T18:30:00Z&speed=-2');
		expect(c.speed).toBe(1);
	});
});
