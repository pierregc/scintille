import { describe, expect, it } from 'vitest';
import { flashKind, flashTiming } from './channel';
import { FlashKind, isGround } from './kind';
import {
	cloudPulses,
	continuingCurrent,
	flashLife,
	flashProfile,
	flashProfileGlsl,
	flashStroke,
	flickerLength,
	glowDecay,
	glowLevel,
	glslFloat,
	MAX_LIFE,
	PROFILE,
	pulseGap,
	spread,
	strokeTrain,
	stutterLight,
} from './profile';
import { ribbonVertex } from './ribbon.glsl';

const seeds = Array.from({ length: 400 }, (_, i) => (i * 0.6180339887) % 1);
const GROUND = [FlashKind.CgMulti, FlashKind.CgSingle, FlashKind.CgPositive, FlashKind.BoltFromBlue];
const RADIUS = 8;
const timingOf = (kind: FlashKind, durationMs: number, seed: number) => flashTiming(kind, RADIUS, flickerLength(durationMs), seed);
const at = (wall: number, durationMs = 300, seed = 0.5, display = 0, sceneAge = wall, flicker = true, kind = FlashKind.IcTrunkFan) =>
	flashProfile(wall, sceneAge, display, durationMs, seed, flicker, kind, timingOf(kind, durationMs, seed));
/** The profile every millisecond of a flash's life. */
const samples = (kind: FlashKind, durationMs: number, seed: number, flicker = true) =>
	Array.from({ length: Math.round(flashLife(flickerLength(durationMs)) * 1000) + 1 }, (_, i) => at(i / 1000, durationMs, seed, 0, i / 1000, flicker, kind));
/** Local maxima above `level`, a plateau counted once. */
function peaks(values: number[], level: number): number {
	let n = 0;
	for (let i = 1; i < values.length - 1; i++) {
		if (values[i] > level && values[i] > values[i - 1] && values[i] >= values[i + 1]) n++;
	}
	return n;
}
const share = (values: boolean[]) => values.filter(Boolean).length / values.length;

describe('strokes', () => {
	it('are spaced like return strokes, 57 ms apart in geometric mean within 10 to 400 ms', () => {
		const gaps = seeds.flatMap((seed) => [1, 2, 3, 4, 5, 6].map((k) => pulseGap(seed, k)));
		const mean = Math.exp(gaps.reduce((s, g) => s + Math.log(g), 0) / gaps.length);
		expect(mean).toBeGreaterThan(0.053);
		expect(mean).toBeLessThan(0.061);
		expect(Math.min(...gaps)).toBeGreaterThanOrEqual(PROFILE.minGap);
		expect(Math.max(...gaps)).toBeLessThanOrEqual(PROFILE.maxGap);
	});

	it('fill the observed duration, so longer multi-stroke flashes flicker more', () => {
		const count = (ms: number) => seeds.reduce((n, seed) => n + strokeTrain(FlashKind.CgMulti, flickerLength(ms), seed, timingOf(FlashKind.CgMulti, ms, seed).leader).length, 0) / seeds.length;
		expect(count(60)).toBe(2);
		expect(count(300)).toBeGreaterThan(2.5);
		expect(count(800)).toBeGreaterThan(count(300) + 3);
		for (const seed of seeds) {
			const train = strokeTrain(FlashKind.CgMulti, 0.3, seed, 0.1);
			expect(train.length).toBeGreaterThanOrEqual(2);
			expect(train.at(-1)?.start).toBeLessThanOrEqual(0.3);
		}
	});

	it('decay within the bounds of their kind', () => {
		for (const seed of seeds) {
			const [first, ...later] = strokeTrain(FlashKind.CgMulti, 1, seed, 0.1);
			expect(first.tau).toBeGreaterThanOrEqual(PROFILE.firstTau[0]);
			expect(first.tau).toBeLessThanOrEqual(PROFILE.firstTau[1]);
			for (const s of later) {
				expect(s.tau).toBeGreaterThanOrEqual(PROFILE.minTau);
				expect(s.tau).toBeLessThanOrEqual(PROFILE.maxTau);
				expect(s.level).toBeGreaterThanOrEqual(PROFILE.minLevel);
				expect(s.level).toBeLessThanOrEqual(PROFILE.maxLevel);
			}
			for (const p of cloudPulses(0.5, seed, 0.015)) {
				expect(p.tau).toBeGreaterThanOrEqual(PROFILE.cloudTau[0]);
				expect(p.tau).toBeLessThanOrEqual(PROFILE.cloudTau[1]);
			}
		}
	});

	it('are never missed between two frames', () => {
		for (const kind of [FlashKind.CgMulti, FlashKind.IcTrunkFan]) {
			for (const seed of seeds.slice(0, 50)) {
				const { leader } = timingOf(kind, 500, seed);
				const pulses = isGround(kind) ? strokeTrain(kind, 0.5, seed, leader) : cloudPulses(0.5, seed, leader);
				for (const [k, p] of pulses.entries()) {
					const phase = (seed * 7) % PROFILE.shutter;
					const frames = [0, 1, 2].map((n) => at(p.start + phase + n * PROFILE.shutter, 500, seed, 0, p.start + phase + n * PROFILE.shutter, true, kind));
					expect(Math.max(...frames)).toBeGreaterThan(k === 0 ? 0.3 : 0.1);
				}
			}
		}
	});

	it('equal the loop of the profile when read one at a time, on 10,000 inputs', () => {
		let state = 0x2545f491;
		const next = () => {
			state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
			return state / 4294967296;
		};
		for (let i = 0; i < 10_000; i++) {
			const kind = GROUND[Math.floor(next() * 4)];
			const seed = next();
			const length = flickerLength(20 + next() * 2000);
			const { leader } = flashTiming(kind, 3 + next() * 16, length, seed);
			const wall = next() * (length + 0.2);
			const train = strokeTrain(kind, length, seed, leader);
			const index = train.findLastIndex((s) => s.start <= wall);
			const stroke = flashStroke(wall, length, seed, kind, leader);
			expect(stroke.index).toBe(index);
			expect(stroke.age).toBeCloseTo(index < 0 ? wall : wall - train[index].start, 9);
			const upcoming = train[index + 1];
			expect(stroke.next).toBeCloseTo(upcoming ? upcoming.start - wall : index < 0 ? leader - wall : Infinity, 9);
		}
	});
});

describe('cloud-to-ground kinds', () => {
	it('come down as a dim leader, then strike at full light', () => {
		for (const kind of GROUND) {
			for (const seed of seeds) {
				const { leader } = timingOf(kind, 400, seed);
				for (let t = 0; t < leader; t += 0.002) expect(at(t, 400, seed, 0, t, true, kind)).toBeLessThanOrEqual(0.13);
				expect(at(leader + PROFILE.shutter, 400, seed, 0, leader + PROFILE.shutter, true, kind)).toBeGreaterThanOrEqual(0.55);
			}
		}
	});

	it('take their leader time within its bounds and half the flicker', () => {
		for (const seed of seeds) {
			for (const kind of [FlashKind.CgMulti, FlashKind.CgSingle, FlashKind.CgPositive]) {
				const { leader, spread: whole } = timingOf(kind, 400, seed);
				expect(leader).toBeGreaterThanOrEqual(0.05);
				expect(leader).toBeLessThanOrEqual(0.15);
				expect(whole).toBe(leader);
				expect(spread(leader, timingOf(kind, 400, seed), kind)).toBe(1);
			}
			const bolt = timingOf(FlashKind.BoltFromBlue, 600, seed).leader;
			expect(bolt).toBeGreaterThanOrEqual(0.15);
			expect(bolt).toBeLessThanOrEqual(0.25);
			for (const kind of GROUND) {
				for (const ms of [60, 100, 200]) expect(timingOf(kind, ms, seed).leader).toBeLessThanOrEqual(PROFILE.leaderShare * flickerLength(ms) + 1e-12);
			}
		}
		expect(spread(0, timingOf(FlashKind.CgMulti, 400, 0.3), FlashKind.CgMulti)).toBe(0);
	});

	it('strike once for single-stroke flashes, whatever their duration', () => {
		for (const ms of [60, 100, 200, 400, 800, 1500, 2000]) {
			for (const seed of seeds.slice(0, 100)) expect(peaks(samples(FlashKind.CgSingle, ms, seed), 0.3)).toBe(1);
		}
	});

	it('strike once in four positive flashes out of five, most of them holding a long continuing current', () => {
		const traces = seeds.map((seed) => samples(FlashKind.CgPositive, 500, seed));
		expect(share(traces.map((v) => peaks(v, 0.15) === 1))).toBeGreaterThan(0.76);
		expect(share(traces.map((v) => peaks(v, 0.15) === 1))).toBeLessThan(0.86);
		// A stroke alone passes through 0.2 to 0.35 within 25 ms: holding there 40 ms is a continuing current.
		const held = traces.map((v) => v.filter((x) => x >= 0.2 && x <= 0.35).length >= 40);
		expect(share(held)).toBeGreaterThan(0.7);
		expect(share(held)).toBeLessThan(0.8);
	});

	it('hold a continuing current in 35 to 45 % of multi-stroke flashes, never after the first stroke', () => {
		const currents = seeds.map((seed) => continuingCurrent(FlashKind.CgMulti, seed));
		expect(share(currents.map((c) => c !== null))).toBeGreaterThan(0.35);
		expect(share(currents.map((c) => c !== null))).toBeLessThan(0.45);
		for (const seed of seeds) {
			const { leader } = timingOf(FlashKind.CgMulti, 600, seed);
			const [first, second] = strokeTrain(FlashKind.CgMulti, 0.6, seed, leader);
			for (let t = first.start + 0.07; t < second.start; t += 0.002) expect(at(t, 600, seed, 0, t, true, FlashKind.CgMulti)).toBeLessThan(PROFILE.afterglow + 0.01);
			const current = continuingCurrent(FlashKind.CgMulti, seed);
			if (current) expect(current.stroke).toBeGreaterThanOrEqual(1);
		}
	});

	it('keep their channel dark between strokes unless a continuing current holds', () => {
		for (const seed of seeds.slice(0, 80)) {
			if (continuingCurrent(FlashKind.CgMulti, seed)) continue;
			const { leader } = timingOf(FlashKind.CgMulti, 600, seed);
			const train = strokeTrain(FlashKind.CgMulti, 0.6, seed, leader);
			for (const [k, s] of train.entries()) {
				const following = train[k + 1]?.start ?? 0.6;
				if (following - s.start > 0.08) expect(at(following - 0.005, 600, seed, 0, following - 0.005, true, FlashKind.CgMulti)).toBeLessThan(PROFILE.afterglow + 0.01);
			}
		}
	});
});

describe('in-cloud kinds', () => {
	it('carry no bright pulse in a quarter of flashes and exactly one in 45 %', () => {
		const traces = seeds.map((seed) => samples(FlashKind.IcTrunkFan, 400, seed));
		const dim = share(traces.map((v) => Math.max(...v) <= 0.5));
		const one = share(traces.map((v) => peaks(v, 0.5) === 1));
		expect(dim).toBeGreaterThan(0.2);
		expect(dim).toBeLessThan(0.3);
		expect(one).toBeGreaterThan(0.4);
		expect(one).toBeLessThan(0.5);
	});

	it('glow from the rise of their trunk to their fade', () => {
		for (const seed of seeds.slice(0, 80)) {
			const { leader } = timingOf(FlashKind.IcTrunkFan, 400, seed);
			for (let t = leader; t < 0.4; t += 0.005) expect(at(t, 400, seed)).toBeGreaterThanOrEqual(PROFILE.icGlow[0] - 1e-9);
			expect(at(0.4 + PROFILE.cloudFade + 0.05, 400, seed)).toBeLessThan(PROFILE.afterglow);
		}
	});

	it('stutter only over the last half of the flicker, at most 0.3 above the glow', () => {
		let stuttered = 0;
		for (const seed of seeds) {
			for (let t = 0; t < 0.6; t += 0.001) {
				const s = stutterLight(t, 0.5, seed);
				if (t < 0.25) expect(s).toBe(0);
				expect(s).toBeLessThanOrEqual(PROFILE.stutterLevel[1] + 1e-9);
				if (s > 0) stuttered++;
			}
			if (cloudPulses(0.5, seed, 0.015).length !== 1) continue;
			for (let t = 0.3; t < 0.5; t += 0.001) {
				const v = at(t, 500, seed);
				const pulse = cloudPulses(0.5, seed, timingOf(FlashKind.IcTrunkFan, 500, seed).leader).some((p) => t >= p.start && t < p.start + 0.15);
				if (!pulse) expect(v).toBeLessThanOrEqual(PROFILE.icGlow[1] + 1e-9);
			}
		}
		expect(stuttered).toBeGreaterThan(0);
		for (const seed of seeds) {
			for (let t = 0.25; t < 0.5; t += 0.002) expect(at(t, 500, seed)).toBeLessThanOrEqual(Math.max(PROFILE.icDimPeak[1], ...cloudPulses(0.5, seed, 0.02).map(() => 1)));
		}
	});

	it('let crawlers shine without flickering for their whole flicker', () => {
		for (const ms of [100, 600, 1000, 1500, 2000]) {
			const length = flickerLength(ms);
			for (const seed of seeds.slice(0, 100)) {
				const v = Array.from({ length: Math.round(length * 1000) }, (_, i) => at(i / 1000, ms, seed, 0, i / 1000, true, FlashKind.IcCrawler));
				expect(Math.max(...v)).toBeLessThanOrEqual(0.4);
				expect(share(v.map((x) => x >= 0.25))).toBeGreaterThanOrEqual(0.9);
			}
		}
	});
});

describe('flashProfile', () => {
	it('flickers in wall clock time whatever the replay speed', () => {
		for (const kind of [FlashKind.CgMulti, FlashKind.IcTrunkFan]) {
			for (const wall of [0.01, 0.05, 0.2, 0.6]) expect(at(wall, 300, 0.3, 0, wall * 600, true, kind)).toBe(at(wall, 300, 0.3, 0, wall, true, kind));
		}
	});

	it('lives about a second without afterglow, longer for long flashes', () => {
		expect(at(-0.01)).toBe(0);
		expect(at(0.9)).toBeGreaterThan(0);
		expect(at(flashLife(flickerLength(300)) + 0.01)).toBe(0);
		expect(flashLife(flickerLength(900))).toBeCloseTo(1.4, 6);
		expect(MAX_LIFE).toBe(PROFILE.maxFlicker + PROFILE.tail);
	});

	it('flickers a 1.5 s flash for 1.5 s', () => {
		expect(flickerLength(1500)).toBe(1.5);
		const last = seeds.map((seed) => strokeTrain(FlashKind.CgMulti, 1.5, seed, timingOf(FlashKind.CgMulti, 1500, seed).leader).at(-1)?.start ?? 0).sort((a, b) => a - b);
		expect(last.at(-1)).toBeLessThanOrEqual(1.5);
		expect(last[last.length >> 1]).toBeGreaterThan(1.2);
		for (const seed of seeds.slice(0, 50)) {
			expect(at(1.45, 1500, seed, 0, 1.45, true, FlashKind.IcCrawler)).toBeGreaterThanOrEqual(PROFILE.crawlerGlow[0]);
			expect(at(1.6, 1500, seed, 0, 1.6, true, FlashKind.IcCrawler)).toBeLessThan(PROFILE.afterglow);
		}
	});

	it('peaks bright then leaves a dim glow', () => {
		const seed = seeds.find((s) => cloudPulses(0.3, s, timingOf(FlashKind.IcTrunkFan, 300, s).leader).length > 0) ?? 0;
		const first = cloudPulses(0.3, seed, timingOf(FlashKind.IcTrunkFan, 300, seed).leader)[0].start;
		expect(at(first + PROFILE.shutter, 300, seed)).toBeGreaterThan(0.55);
		const glow = at(0.7, 300, seed);
		expect(glow).toBeGreaterThan(0.005);
		expect(glow).toBeLessThan(PROFILE.afterglow);
	});

	it('keeps an afterglow of minutes in scene time', () => {
		const display = 30 * 60;
		expect(at(10, 300, 0.5, display, 600)).toBeCloseTo(glowLevel(display) * glowDecay(600 / display), 6);
		expect(at(10, 300, 0.5, display, display + 1)).toBe(0);
		expect(at(0.004, 300, 0.5, display)).toBeCloseTo(at(0.004), 6);
	});

	it('gives reduced motion a single soft fade', () => {
		for (const kind of [FlashKind.CgMulti, FlashKind.IcTrunkFan, FlashKind.IcCrawler]) {
			expect(peaks(samples(kind, 700, 0.5, false), PROFILE.afterglow)).toBe(1);
			const v = Array.from({ length: 80 }, (_, i) => at(0.1 + i / 100, 700, 0.5, 0, 0.1 + i / 100, false, kind));
			expect(v.every((x, i) => i === 0 || x <= v[i - 1])).toBe(true);
		}
	});

	it('leaves about half of all flashes without flicker, with the shares of the kinds', () => {
		// Durations and areas log-normal like GLM flashes (median 240 ms and 291 km², 90th percentiles 626 ms and 965 km²).
		let state = 0x9e3779b9;
		const next = () => {
			state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
			return (state + 0.5) / 4294967296;
		};
		const normal = () => Math.sqrt(-2 * Math.log(next())) * Math.cos(2 * Math.PI * next());
		const calm = Array.from({ length: 4000 }, () => {
			const seed = next();
			const durationMs = 240 * Math.exp(0.748 * normal());
			const areaKm2 = 291 * Math.exp(0.935 * normal());
			const kind = flashKind(seed, durationMs, areaKm2);
			const length = flickerLength(durationMs);
			const { leader } = flashTiming(kind, Math.sqrt(areaKm2 / Math.PI), length, seed);
			if (kind === FlashKind.IcCrawler) return true;
			if (isGround(kind)) return strokeTrain(kind, length, seed, leader).length === 1;
			return cloudPulses(length, seed, leader).length === 1;
		});
		expect(share(calm)).toBeGreaterThan(0.45);
		expect(share(calm)).toBeLessThan(0.55);
	});
});

describe('afterglow', () => {
	it('decays exponentially to exactly zero at the end of the window', () => {
		expect(glowDecay(0)).toBeCloseTo(1, 6);
		expect(glowDecay(1)).toBeCloseTo(0, 6);
	});

	it('keeps the total light comparable across long windows', () => {
		const total = (minutes: number) => glowLevel(minutes * 60) * minutes;
		expect(glowLevel(60)).toBe(PROFILE.afterglow);
		expect(glowLevel(1800)).toBeCloseTo(glowLevel(300) / 6, 6);
		expect(total(30) / total(5)).toBeCloseTo(1, 6);
	});
});

describe('GLSL twins', () => {
	it('print float literals', () => {
		expect(glslFloat(1)).toBe('1.0');
		expect(glslFloat(0.04)).toBe('0.04');
	});

	it('carry the bounds of the profile', () => {
		const P = PROFILE;
		const profile = [
			P.maxFlicker, P.pulseGap, P.positiveGap, P.minGap, P.maxGap, P.fit, ...P.firstTau, P.minTau, P.maxTau, ...P.cloudTau, P.leaderLevel,
			P.positiveSingle, P.boltStrokes[0], P.boltStrokes[0] + P.boltStrokes[1], ...P.currentShare, ...P.currentLevel, ...P.currentDuration,
			...P.singleActivity, ...P.icGlow, P.icPulses[0], P.icPulses[0] + P.icPulses[1], ...P.icDimPeak, ...P.icLevel, P.icGap, P.icFirstBy,
			P.stutterBin, P.stutterShare, ...P.stutterLevel, ...P.crawlerGlow, P.cloudFade,
		];
		for (const x of profile) expect(flashProfileGlsl).toContain(glslFloat(x));
		for (const x of [P.leaderLevel, P.strokeSweep, P.dart, P.dartLevel, P.crawlerTip]) expect(ribbonVertex).toContain(glslFloat(x));
		expect(flashProfileGlsl).toContain('float flashProfile(float wallAge, float sceneAge, float display, float durationMs, float seed, float flicker, int kind, float radiusKm)');
		expect(flashProfileGlsl).toContain('vec3 flashStroke(float wallAge, float len, float seed, int kind, float leader)');
		expect(flashProfileGlsl).toContain('float spread(float age, vec2 timing, int kind)');
	});
});
