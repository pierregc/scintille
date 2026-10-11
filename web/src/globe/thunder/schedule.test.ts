import { describe, expect, it } from 'vitest';
import { decodeChunk } from '../live/decode';
import { FlashRing } from '../live/ring';
import { encodeChunk, type FakeFlash } from '../live/testing';
import type { Vec3 } from '../sun';
import { type Listener, MAX_STEP_MS, MAX_VOICES, MIN_GAP_S, ThunderScheduler, type Trigger } from './schedule';

const START_S = 1_000;
const VOICE_S = 4.5;

function ringWith(flashes: FakeFlash[]): FlashRing {
	const ring = new FlashRing(1 << 14);
	ring.push(decodeChunk(encodeChunk(START_S, flashes).buffer));
	return ring;
}

function listenerAt(position: Vec3): Listener {
	return { position, screenX: (p) => Math.max(-1, Math.min(1, -p[2])) };
}

/** Plays `seconds` of scene time at 60 frames per second, real time. */
function play(scheduler: ThunderScheduler, listener: Listener, seconds: number, from = START_S * 1000) {
	const triggers: Trigger[] = [];
	let maxActive = 0;
	scheduler.skipTo(from);
	for (let f = 1; f <= seconds * 60; f++) {
		const audio = f / 60;
		const t = scheduler.update(from + audio * 1000, audio, listener);
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

describe('ThunderScheduler', () => {
	it('caps simultaneous voices with 100 flashes per second', () => {
		const ring = ringWith(storm(100, 60));
		const scheduler = new ThunderScheduler(ring, { voiceSeconds: VOICE_S });
		const { triggers, maxActive } = play(scheduler, listenerAt([1.3, 0, 0]), 60);
		expect(triggers.length).toBeGreaterThan(10);
		expect(maxActive).toBeLessThanOrEqual(MAX_VOICES);
		for (let i = 1; i < triggers.length; i++) {
			expect(triggers[i].start - triggers[i].delay - (triggers[i - 1].start - triggers[i - 1].delay)).toBeGreaterThanOrEqual(
				MIN_GAP_S - 1e-9,
			);
		}
		for (const t of triggers) {
			expect(t.voice).toBeLessThan(MAX_VOICES);
			expect(t.gain).toBeLessThanOrEqual(1);
		}
	});

	it('makes thunder closer and louder when zooming in', () => {
		const flashes = [{ offsetMs: 500, lat: 0, lon: 0 }];
		const far = play(new ThunderScheduler(ringWith(flashes), { voiceSeconds: VOICE_S }), listenerAt([4, 0, 0]), 1);
		const near = play(new ThunderScheduler(ringWith(flashes), { voiceSeconds: VOICE_S }), listenerAt([1.05, 0, 0]), 1);
		expect(far.triggers).toHaveLength(1);
		expect(near.triggers).toHaveLength(1);
		expect(near.triggers[0].gain).toBeGreaterThan(far.triggers[0].gain * 3);
		expect(near.triggers[0].delay).toBeLessThan(far.triggers[0].delay);
	});

	it('ignores flashes behind the globe or off screen', () => {
		const back = ringWith([{ offsetMs: 500, lat: 0, lon: 180 }]);
		expect(play(new ThunderScheduler(back, { voiceSeconds: VOICE_S }), listenerAt([3, 0, 0]), 1).triggers).toHaveLength(0);
		const front = ringWith([{ offsetMs: 500, lat: 0, lon: 0 }]);
		const offScreen: Listener = { position: [3, 0, 0], screenX: () => null };
		expect(play(new ThunderScheduler(front, { voiceSeconds: VOICE_S }), offScreen, 1).triggers).toHaveLength(0);
	});

	it('stays silent on seeks and while muted', () => {
		const ring = ringWith(storm(10, 600));
		const scheduler = new ThunderScheduler(ring, { voiceSeconds: VOICE_S });
		const listener = listenerAt([1.3, 0, 0]);
		const t0 = START_S * 1000;
		scheduler.skipTo(t0);
		expect(scheduler.update(t0 + MAX_STEP_MS + 1, 0, listener)).toBeNull();
		expect(scheduler.update(t0, 1, listener)).toBeNull();
		scheduler.skipTo(t0 + 200_000);
		expect(scheduler.update(t0 + 200_100, 2, listener)?.start).toBeGreaterThanOrEqual(2);
	});
});
