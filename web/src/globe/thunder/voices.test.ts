import { describe, expect, it } from 'vitest';
import { STEAL_RATIO, VoicePool } from './voices';

describe('VoicePool', () => {
	it('fills free slots, then drops quiet voices', () => {
		const pool = new VoicePool(2);
		expect(pool.claim(0, 5, 0.2)).toEqual({ slot: 0, replaced: false });
		expect(pool.claim(0, 5, 0.3)).toEqual({ slot: 1, replaced: false });
		expect(pool.claim(1, 6, 0.3)).toBeNull();
		expect(pool.active(1)).toBe(2);
	});

	it('steals the quietest voice for a much louder one', () => {
		const pool = new VoicePool(2);
		pool.claim(0, 5, 0.1);
		pool.claim(0, 5, 0.3);
		expect(pool.claim(1, 6, 0.1 * STEAL_RATIO)).toEqual({ slot: 0, replaced: true });
	});

	it('reuses slots once their voice has ended', () => {
		const pool = new VoicePool(1);
		pool.claim(0, 5, 0.5);
		expect(pool.claim(5, 10, 0.01)).toEqual({ slot: 0, replaced: false });
		pool.reset();
		expect(pool.active(6)).toBe(0);
	});

	it('rejects bad sizes', () => {
		expect(() => new VoicePool(0)).toThrow(RangeError);
	});
});
