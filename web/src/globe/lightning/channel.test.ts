import { describe, expect, it } from 'vitest';
import { CHANNEL, channelHash, cloudDrift, flashSeed, isGround } from './channel';

const seeds = Array.from({ length: 1000 }, (_, i) => (i + 0.5) / 1000);

describe('channelHash', () => {
	it('is in [0, 1) and differs per draw', () => {
		const values = seeds.map((s) => channelHash(s, 3));
		expect(values.every((v) => v >= 0 && v < 1)).toBe(true);
		expect(channelHash(0.3, 1)).not.toBe(channelHash(0.3, 2));
	});
});

describe('flash looks', () => {
	it('draws about a quarter of cloud-to-ground looks from stable seeds', () => {
		const share = seeds.filter(isGround).length / seeds.length;
		expect(share).toBeGreaterThan(CHANNEL.groundShare - 0.05);
		expect(share).toBeLessThan(CHANNEL.groundShare + 0.05);
		expect(flashSeed(1_760_000_000_123, 12.5, -40.25)).toBe(flashSeed(1_760_000_000_123, 12.5, -40.25));
		expect(flashSeed(1_760_000_000_123, 12.5, -40.25)).not.toBe(flashSeed(1_760_000_000_124, 12.5, -40.25));
	});

	it('moves the light of in-cloud flashes across their footprint, symmetric around the position', () => {
		const seed = seeds.find((s) => !isGround(s)) ?? 0;
		const groundSeed = seeds.find(isGround) ?? 0;
		const [x0, y0] = cloudDrift(0, 0.4, 10, seed);
		const [x1, y1] = cloudDrift(1, 0.4, 10, seed);
		expect(Math.hypot(x0, y0)).toBeCloseTo(CHANNEL.drift * 10, 6);
		expect(x0 + x1).toBeCloseTo(0, 6);
		expect(y0 + y1).toBeCloseTo(0, 6);
		expect(cloudDrift(0.2, 0.4, 10, groundSeed)).toEqual([0, 0]);
	});
});
