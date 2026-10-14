import { describe, expect, it } from 'vitest';
import { channelHash } from './channel';

const seeds = Array.from({ length: 1000 }, (_, i) => (i + 0.5) / 1000);

describe('channelHash', () => {
	it('is in [0, 1) and differs per draw', () => {
		const values = seeds.map((s) => channelHash(s, 3));
		expect(values.every((v) => v >= 0 && v < 1)).toBe(true);
		expect(channelHash(0.3, 1)).not.toBe(channelHash(0.3, 2));
	});
});
