import { describe, expect, it } from 'vitest';
import {
	CHANNEL,
	channelGlsl,
	channelHash,
	CLOUD_TO_AIR_SHARE,
	cloudDrift,
	cloudDriftGlsl,
	CRAWLER,
	flashKind,
	flashLook,
	flashSeed,
	flashTiming,
	KIND,
	KIND_SHARES,
	leaderSeconds,
	spreadSeconds,
} from './channel';
import { FlashKind, isGround } from './kind';
import { flashProfileGlsl, flickerLength, PROFILE } from './profile';
import { glslAsJs } from './testing';

const seeds = Array.from({ length: 40_000 }, (_, i) => (i + 0.5) / 40_000);
/** A short, small flash: its kind comes from the seed alone. */
const kindOf = (seed: number) => flashKind(seed, 200, 300);
const kinds = seeds.map(kindOf);
const count = (kind: FlashKind) => kinds.filter((k) => k === kind).length;
const share = (kind: FlashKind) => count(kind) / seeds.length;
const radii = Array.from({ length: 17 }, (_, i) => 3 + i);

describe('channelHash', () => {
	it('is in [0, 1) and differs per draw', () => {
		const values = seeds.slice(0, 1000).map((s) => channelHash(s, 3));
		expect(values.every((v) => v >= 0 && v < 1)).toBe(true);
		expect(channelHash(0.3, 1)).not.toBe(channelHash(0.3, 2));
	});
});

describe('flash kinds', () => {
	it('draws the seven looks in their shares from stable seeds', () => {
		const expected: [FlashKind, number][] = [
			[FlashKind.CgMulti, 0.19],
			[FlashKind.CgSingle, 0.07],
			[FlashKind.CgPositive, 0.03],
			[FlashKind.BoltFromBlue, 0.01],
			[FlashKind.CloudToAir, CLOUD_TO_AIR_SHARE],
			[FlashKind.IcTrunkFan, 0.67],
		];
		for (const [kind, p] of expected) {
			expect(share(kind)).toBeGreaterThan(p - 0.01);
			expect(share(kind)).toBeLessThan(p + 0.01);
		}
		expect(count(FlashKind.BoltFromBlue)).toBeGreaterThan(320);
		expect(count(FlashKind.BoltFromBlue)).toBeLessThan(480);
		expect(count(FlashKind.IcCrawler)).toBe(0);
		const ground = kinds.filter(isGround).length / seeds.length;
		expect(ground).toBeGreaterThan(KIND_SHARES[3] - 0.01);
		expect(ground).toBeLessThan(KIND_SHARES[3] + 0.01);
		expect(kindOf(0.42)).toBe(kindOf(0.42));
		expect(flashSeed(1_760_000_000_123, 12.5, -40.25)).toBe(flashSeed(1_760_000_000_123, 12.5, -40.25));
		expect(flashSeed(1_760_000_000_123, 12.5, -40.25)).not.toBe(flashSeed(1_760_000_000_124, 12.5, -40.25));
	});

	it('draws crawlers from the observed duration or area, never for cloud-to-ground seeds', () => {
		for (const seed of seeds.filter((_, i) => i % 40 === 0)) {
			const kind = kindOf(seed);
			const long = flashKind(seed, CRAWLER.minDurationMs, 300);
			const large = flashKind(seed, 200, CRAWLER.minAreaKm2);
			if (isGround(kind)) {
				expect(long).toBe(kind);
				expect(large).toBe(kind);
			} else {
				expect(long).toBe(FlashKind.IcCrawler);
				expect(large).toBe(FlashKind.IcCrawler);
			}
			expect(flashKind(seed, CRAWLER.minDurationMs - 1, CRAWLER.minAreaKm2 - 1)).toBe(kind);
		}
	});

	it('names every kind in the table', () => {
		expect(KIND).toHaveLength(7);
		for (const kind of [FlashKind.CgMulti, FlashKind.CgSingle, FlashKind.CgPositive, FlashKind.BoltFromBlue]) expect(isGround(kind)).toBe(true);
		for (const kind of [FlashKind.IcTrunkFan, FlashKind.IcCrawler, FlashKind.CloudToAir]) expect(isGround(kind)).toBe(false);
	});

	it('times leaders at the slow bound of their observed speed, within the bounds of the kind', () => {
		const leaders = seeds.slice(0, 1000).map((seed) => leaderSeconds(FlashKind.CgMulti, 6, seed));
		expect(Math.min(...leaders)).toBeGreaterThanOrEqual(0.05);
		expect(Math.max(...leaders)).toBeLessThanOrEqual(0.15);
		expect(Math.max(...leaders) - Math.min(...leaders)).toBeGreaterThan(0.03);
		for (const radius of radii) {
			const bolts = seeds.slice(0, 1000).map((seed) => leaderSeconds(FlashKind.BoltFromBlue, radius, seed));
			expect(Math.min(...bolts)).toBeGreaterThanOrEqual(0.15);
			expect(Math.max(...bolts)).toBeLessThanOrEqual(0.25);
			if (radius >= 12) expect(Math.max(...bolts) - Math.min(...bolts)).toBeGreaterThan(0.03);
		}
		for (const seed of seeds.slice(0, 200)) {
			const trunk = leaderSeconds(FlashKind.IcTrunkFan, 6, seed);
			expect(trunk).toBeGreaterThanOrEqual(0.01);
			expect(trunk).toBeLessThanOrEqual(0.02);
			expect(leaderSeconds(FlashKind.IcCrawler, 6, seed)).toBe(0);
		}
	});

	it('spreads fans within the flicker and crawlers over it', () => {
		for (const seed of seeds.slice(0, 1000)) {
			expect(spreadSeconds(FlashKind.IcTrunkFan, 6, 0.3, seed)).toBeLessThanOrEqual(0.24);
			expect(spreadSeconds(FlashKind.IcTrunkFan, 6, 0.3, seed)).toBeGreaterThan(0.1);
			expect(spreadSeconds(FlashKind.IcTrunkFan, 20, 0.3, seed)).toBeCloseTo(PROFILE.cloudSpread * 0.3, 6);
			expect(spreadSeconds(FlashKind.IcCrawler, 20, 0.3, seed)).toBeCloseTo(0.3, 6);
			expect(spreadSeconds(FlashKind.CgMulti, 6, 0.3, seed)).toBe(leaderSeconds(FlashKind.CgMulti, 6, seed));
		}
	});

	it('carries the kind and the timing of the skeleton to the shaders', () => {
		for (const seed of seeds.filter((_, i) => i % 400 === 0)) {
			for (const [durationMs, areaKm2] of [[200, 300], [700, 300], [200, 2000], [40, 20]]) {
				const radius = Math.max(3, Math.sqrt(areaKm2 / Math.PI));
				const kind = flashKind(seed, durationMs, areaKm2);
				const { leader, spread } = flashTiming(kind, radius, flickerLength(durationMs), seed);
				expect(flashLook(seed, durationMs, areaKm2, radius)).toEqual([kind, leader, spread]);
			}
		}
		// The shaders no longer draw the kind or the timing themselves: the float32 hash of the seed would differ (ADR 0033).
		expect(channelGlsl).not.toContain('flashKind');
		expect(channelGlsl).not.toContain('leaderSeconds');
		expect(channelGlsl).toContain('bool isGround(int kind)');
	});

	it('moves the light of in-cloud flashes across their footprint, symmetric around the position', () => {
		const seed = seeds.find((s) => kindOf(s) === FlashKind.IcTrunkFan) ?? 0;
		const drift = (age: number, kind: FlashKind) => cloudDrift(age, 10, seed, kind, flashTiming(kind, 10, 0.4, seed));
		const [x0, y0] = drift(0, FlashKind.IcTrunkFan);
		const [x1, y1] = drift(0.4, FlashKind.IcTrunkFan);
		expect(Math.hypot(x0, y0)).toBeCloseTo(CHANNEL.drift * 10, 6);
		expect(x0 + x1).toBeCloseTo(0, 6);
		expect(y0 + y1).toBeCloseTo(0, 6);
		// Crawlers walk at a steady pace, so their light moves by equal steps until their leaders stop.
		const crawl = flashTiming(FlashKind.IcCrawler, 10, 0.4, seed).spread;
		const [a, b, c] = [0.2, 0.4, 0.6].map((t) => drift(t * crawl, FlashKind.IcCrawler)[0]);
		expect(b - a).toBeCloseTo(c - b, 6);
		expect(drift(crawl, FlashKind.IcCrawler)).toEqual(drift(0.4, FlashKind.IcCrawler));
		for (const kind of [FlashKind.CgMulti, FlashKind.CgSingle, FlashKind.CgPositive, FlashKind.BoltFromBlue]) {
			expect(drift(0.2, kind)).toEqual([0, 0]);
		}
	});

	it('drifts in the GLSL twin as in the TypeScript, for every kind', () => {
		const glsl = glslAsJs<{ cloudDrift(age: number, radiusKm: number, seed: number, kind: FlashKind, timing: { x: number; y: number }): { x: number; y: number } }>(
			channelGlsl + flashProfileGlsl + cloudDriftGlsl,
			['cloudDrift'],
		);
		for (let i = 0; i < 4000; i++) {
			const kind = (i % 7) as FlashKind;
			const seed = seeds[(i * 7919) % seeds.length];
			const flicker = flickerLength(20 + ((i * 0.618) % 1) * 2500);
			const radius = 3 + ((i * 0.414) % 1) * 30;
			const age = ((i * 0.732) % 1) * (flicker + 0.3) - 0.02;
			const timing = flashTiming(kind, radius, flicker, seed);
			const [x, y] = cloudDrift(age, radius, seed, kind, timing);
			const twin = glsl.cloudDrift(age, radius, seed, kind, { x: timing.leader, y: timing.spread });
			expect(twin.x).toBeCloseTo(x, 9);
			expect(twin.y).toBeCloseTo(y, 9);
		}
	});
});
