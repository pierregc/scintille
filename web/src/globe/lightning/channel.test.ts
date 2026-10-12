import { describe, expect, it } from 'vitest';
import { CHANNEL, channelHash, channelShape } from './channel';

const seeds = Array.from({ length: 1000 }, (_, i) => (i + 0.5) / 1000);

function shares(radiusKm: number): number[] {
	const counts = [0, 0, 0, 0];
	for (const seed of seeds) counts[channelShape(radiusKm, seed)]++;
	return counts.map((c) => c / seeds.length);
}

describe('channelShape', () => {
	it('gives small flashes I and zigzag, never branched', () => {
		const [i, zigzag, y, branched] = shares(CHANNEL.smallKm - 1);
		expect(i + zigzag).toBeGreaterThan(0.8);
		expect(y).toBeGreaterThan(0);
		expect(branched).toBe(0);
	});

	it('gives large flashes Y and branched, never I', () => {
		const [i, , y, branched] = shares(CHANNEL.largeKm + 5);
		expect(i).toBe(0);
		expect(y + branched).toBeGreaterThan(0.8);
	});

	it('mixes every shape at mid size', () => {
		expect(shares((CHANNEL.smallKm + CHANNEL.largeKm) / 2).every((s) => s > 0.05)).toBe(true);
	});
});

describe('channelHash', () => {
	it('is in [0, 1) and differs per draw', () => {
		const values = seeds.map((s) => channelHash(s, 3));
		expect(values.every((v) => v >= 0 && v < 1)).toBe(true);
		expect(channelHash(0.3, 1)).not.toBe(channelHash(0.3, 2));
	});
});
