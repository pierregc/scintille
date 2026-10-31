import { describe, expect, it } from 'vitest';
import {
	CHANNEL,
	channelGlsl,
	channelHash,
	CLOUD_TO_AIR_SHARE,
	cloudDrift,
	CRAWLER,
	flashKind,
	flashSeed,
	KIND,
	KIND_SHARES,
	leaderSeconds,
	spreadSeconds,
} from './channel';
import { FlashKind, isGround } from './kind';
import { glslFloat, PROFILE } from './profile';

const seeds = Array.from({ length: 40_000 }, (_, i) => (i + 0.5) / 40_000);
/** A short, small flash: its kind comes from the seed alone. */
const kindOf = (seed: number) => flashKind(seed, 200, 300);
const kinds = seeds.map(kindOf);
const count = (kind: FlashKind) => kinds.filter((k) => k === kind).length;
const share = (kind: FlashKind) => count(kind) / seeds.length;
const radii = Array.from({ length: 17 }, (_, i) => 3 + i);

interface ChannelTwins {
	flashKind(seed: number, durationMs: number, radiusKm: number): FlashKind;
	leaderSeconds(kind: FlashKind, radiusKm: number, seed: number): number;
	spreadSeconds(kind: FlashKind, radiusKm: number, flicker: number, seed: number): number;
}

/** `channelGlsl` evaluated as JavaScript: its functions use only float arithmetic and these built-ins. */
function channelGlslAsJs(): ChannelTwins {
	const js = channelGlsl
		.replace(/^(?:float|int|bool) (\w+)\(([^)]*)\) \{/gm, (_, name: string, params: string) => `function ${name}(${params.replace(/\b(?:float|int) /g, '')}) {`)
		.replace(/\b(?:float|int|bool) (\w+) =/g, 'let $1 =');
	const builtins: Record<string, (...x: never[]) => unknown> = {
		fract: (x: number) => x - Math.floor(x),
		sin: Math.sin,
		mix: (a: number, b: number, t: number) => a + (b - a) * t,
		clamp: (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x)),
		min: Math.min,
		max: Math.max,
		vec2: (x: number, y: number) => [x, y],
		length: (v: number[]) => Math.hypot(...v),
	};
	return new Function(...Object.keys(builtins), `${js}\nreturn { flashKind, leaderSeconds, spreadSeconds };`)(...Object.values(builtins));
}

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

	it('runs the GLSL twins as the TypeScript functions', () => {
		const glsl = channelGlslAsJs();
		for (const seed of seeds.filter((_, i) => i % 40 === 0)) {
			for (const [durationMs, areaKm2] of [[200, 300], [700, 300], [200, 2000]]) {
				expect(glsl.flashKind(seed, durationMs, Math.sqrt(areaKm2 / Math.PI))).toBe(flashKind(seed, durationMs, areaKm2));
			}
			for (const radius of radii) {
				for (let kind = FlashKind.CgMulti; kind <= FlashKind.CloudToAir; kind++) {
					expect(glsl.leaderSeconds(kind, radius, seed)).toBeCloseTo(leaderSeconds(kind, radius, seed), 12);
					expect(glsl.spreadSeconds(kind, radius, 0.3, seed)).toBeCloseTo(spreadSeconds(kind, radius, 0.3, seed), 12);
				}
			}
		}
	});

	it('mirrors the shares, thresholds and speeds in the GLSL twin', () => {
		const literals = [...KIND_SHARES, KIND_SHARES[3] + CLOUD_TO_AIR_SHARE, CRAWLER.minDurationMs, CRAWLER.minAreaKm2, 1e5, 1.5e5, 2e5, 8e4];
		for (const x of literals) expect(channelGlsl).toContain(glslFloat(Number(x.toFixed(4))));
		for (const [lo, hi] of KIND.map((k) => k.leaderBounds)) expect(channelGlsl).toContain(`${glslFloat(lo)}, ${glslFloat(hi)});`);
		expect(channelGlsl).toContain('int flashKind(float seed, float durationMs, float radiusKm)');
		expect(channelGlsl).toContain('bool isGround(int kind)');
	});

	it('moves the light of in-cloud flashes across their footprint, symmetric around the position', () => {
		const seed = seeds.find((s) => kindOf(s) === FlashKind.IcTrunkFan) ?? 0;
		const [x0, y0] = cloudDrift(0, 0.4, 10, seed, FlashKind.IcTrunkFan);
		const [x1, y1] = cloudDrift(1, 0.4, 10, seed, FlashKind.IcTrunkFan);
		expect(Math.hypot(x0, y0)).toBeCloseTo(CHANNEL.drift * 10, 6);
		expect(x0 + x1).toBeCloseTo(0, 6);
		expect(y0 + y1).toBeCloseTo(0, 6);
		expect(cloudDrift(0.2, 0.4, 10, seed, FlashKind.IcCrawler)).toEqual(cloudDrift(0.2, 0.4, 10, seed, FlashKind.IcTrunkFan));
		for (const kind of [FlashKind.CgMulti, FlashKind.CgSingle, FlashKind.CgPositive, FlashKind.BoltFromBlue]) {
			expect(cloudDrift(0.2, 0.4, 10, seed, kind)).toEqual([0, 0]);
		}
	});
});
