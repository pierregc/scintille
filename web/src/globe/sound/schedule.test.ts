import { describe, expect, it } from 'vitest';
import { decodeChunk } from '../live/decode';
import { NO_DELAY, SourceDelays } from '../live/delay';
import { FlashRing } from '../live/ring';
import { encodeChunk, type FakeFlash } from '../live/testing';
import { flashSeed } from '../lightning/channel';
import { heroLot } from '../lightning/density';
import type { Vec3 } from '../sun';
import { CrackleScheduler, JITTER_S, type Listener, MAX_STEP_MS, MAX_VOICES, MIN_GAP_S, type Trigger } from './schedule';

const START_S = 1_000;
const VOICE_S = 0.33;

function ringWith(flashes: FakeFlash[]): FlashRing {
	const ring = new FlashRing(1 << 14);
	ring.push(decodeChunk(encodeChunk(START_S, flashes).buffer));
	return ring;
}

function listenerAt(position: Vec3): Listener {
	return {
		position,
		screen(p, out) {
			out[0] = Math.max(-1, Math.min(1, -p[2]));
			out[1] = Math.max(-1, Math.min(1, p[1]));
			return true;
		},
	};
}

/** Plays `seconds` of scene time at 60 frames per second, real time. */
function play(scheduler: CrackleScheduler, listener: Listener, seconds: number, from = START_S * 1000, delays = NO_DELAY, heroShare = 1) {
	const triggers: Trigger[] = [];
	let maxActive = 0;
	scheduler.skipTo(from);
	for (let f = 1; f <= seconds * 60; f++) {
		const audio = f / 60;
		const t = scheduler.update(from + audio * 1000, audio, listener, delays, heroShare);
		if (t) triggers.push(t);
		maxActive = Math.max(maxActive, scheduler.active(audio));
	}
	return { triggers, maxActive };
}

const storm = (perSecond: number, seconds: number, lat = 0, lon = 0): FakeFlash[] =>
	Array.from({ length: perSecond * seconds }, (_, i) => ({
		offsetMs: Math.floor((i * 1000) / perSecond),
		lat: lat + ((i * 7) % 11) - 5,
		lon: lon + ((i * 5) % 13) - 6,
	}));

describe('CrackleScheduler', () => {
	it('caps simultaneous voices with 100 flashes per second', () => {
		const ring = ringWith(storm(100, 60));
		const scheduler = new CrackleScheduler(ring, { voiceSeconds: VOICE_S, random: () => 0 });
		const { triggers, maxActive } = play(scheduler, listenerAt([1.3, 0, 0]), 60);
		expect(triggers.length).toBeGreaterThan(10);
		expect(maxActive).toBeLessThanOrEqual(MAX_VOICES);
		for (let i = 1; i < triggers.length; i++) expect(triggers[i].start - triggers[i - 1].start).toBeGreaterThanOrEqual(MIN_GAP_S - 1e-9);
		for (const t of triggers) {
			expect(t.voice).toBeLessThan(MAX_VOICES);
			expect(t.gain).toBeLessThanOrEqual(1);
		}
	});

	it('makes crackles louder and brighter when zooming in', () => {
		const flashes = [{ offsetMs: 500, lat: 0, lon: 0 }];
		const far = play(new CrackleScheduler(ringWith(flashes), { voiceSeconds: VOICE_S, random: () => 0 }), listenerAt([4, 0, 0]), 1);
		const near = play(new CrackleScheduler(ringWith(flashes), { voiceSeconds: VOICE_S, random: () => 0 }), listenerAt([1.05, 0, 0]), 1);
		expect(far.triggers).toHaveLength(1);
		expect(near.triggers).toHaveLength(1);
		expect(near.triggers[0].gain).toBeGreaterThan(far.triggers[0].gain * 3);
		expect(near.triggers[0].cutoff).toBeGreaterThan(far.triggers[0].cutoff);
	});

	it('ignores flashes behind the globe or off screen', () => {
		const back = ringWith([{ offsetMs: 500, lat: 0, lon: 180 }]);
		expect(play(new CrackleScheduler(back, { voiceSeconds: VOICE_S, random: () => 0 }), listenerAt([3, 0, 0]), 1).triggers).toHaveLength(0);
		const front = ringWith([{ offsetMs: 500, lat: 0, lon: 0 }]);
		const offScreen: Listener = { position: [3, 0, 0], screen: () => false };
		expect(play(new CrackleScheduler(front, { voiceSeconds: VOICE_S, random: () => 0 }), offScreen, 1).triggers).toHaveLength(0);
	});

	it('stays silent on seeks and while muted', () => {
		const ring = ringWith(storm(10, 600));
		const scheduler = new CrackleScheduler(ring, { voiceSeconds: VOICE_S, random: () => 0 });
		const listener = listenerAt([1.3, 0, 0]);
		const t0 = START_S * 1000;
		scheduler.skipTo(t0);
		expect(scheduler.update(t0 + MAX_STEP_MS + 1, 0, listener)).toBeNull();
		expect(scheduler.update(t0, 1, listener)).toBeNull();
		scheduler.skipTo(t0 + 200_000);
		expect(scheduler.update(t0 + 200_100, 2, listener)?.start).toBeGreaterThanOrEqual(2);
	});

	it('hears each source when its delay brings it to the playhead', () => {
		const delays = new SourceDelays({ 'glm-east': 2_000, 'glm-west': 2_000, 'mtg-li': 10_000 });
		const flashes = [0, 2].map((source) => ({ offsetMs: 500, lat: 0, lon: 0, source }));
		const at = (from: number) => {
			const scheduler = new CrackleScheduler(ringWith(flashes), { voiceSeconds: VOICE_S, random: () => 0 });
			return play(scheduler, listenerAt([1.3, 0, 0]), 1, START_S * 1000 + from, delays).triggers.length;
		};
		expect(at(0)).toBe(0);
		expect(at(2_000)).toBe(1);
		expect(at(5_000)).toBe(0);
		expect(at(10_000)).toBe(1);
	});

	it('voices only the sample drawn in full', () => {
		const ring = ringWith([{ offsetMs: 500, lat: 0, lon: 0 }]);
		const lot = heroLot(flashSeed(ring.time[0], ring.lat[0], ring.lon[0]), ring.intensity[0]);
		const crackles = (heroShare: number) =>
			play(new CrackleScheduler(ringWith([{ offsetMs: 500, lat: 0, lon: 0 }]), { voiceSeconds: VOICE_S, random: () => 0 }), listenerAt([1.3, 0, 0]), 1, undefined, undefined, heroShare).triggers.length;
		expect(crackles(lot * 0.9)).toBe(0);
		expect(crackles(Math.min(1, lot * 1.1))).toBe(1);
		expect(crackles(1)).toBe(1);
	});

	it('spreads crackles by a random gap and places them where the flash is on screen', () => {
		const ring = ringWith(storm(100, 10, 20, 0));
		const scheduler = new CrackleScheduler(ring, { voiceSeconds: VOICE_S, random: () => 1 });
		const { triggers } = play(scheduler, listenerAt([1.3, 0, 0]), 10);
		expect(triggers.length).toBeGreaterThan(5);
		for (let i = 1; i < triggers.length; i++) {
			expect(triggers[i].start - triggers[i - 1].start).toBeGreaterThanOrEqual(MIN_GAP_S + JITTER_S - 1e-9);
		}
		for (const t of triggers) expect(t.position[1]).toBeGreaterThan(0);
	});
});
