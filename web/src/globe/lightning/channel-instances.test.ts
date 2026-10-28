import { describe, expect, it } from 'vitest';
import { decodeChunk } from '../live/decode';
import { SourceDelays } from '../live/delay';
import { FlashRing } from '../live/ring';
import { encodeChunk } from '../live/testing';
import { CHANNEL_STRIDE, ChannelInstances } from './channel-instances';
import { FlashPlayback } from './playback';

function setup(offsets: number[], capacity = 8) {
	const ring = new FlashRing(32);
	ring.push(decodeChunk(encodeChunk(100, offsets.map((offsetMs) => ({ offsetMs, lat: 15, lon: -40 }))).buffer));
	return { ring, channels: new ChannelInstances(ring, capacity) };
}

describe('ChannelInstances', () => {
	it('excludes future flashes and afterglows, retaining the fade after flicker', () => {
		const { channels } = setup([0, 650, 900, 1050]);
		channels.sync(101_000, 100_000);
		expect(channels.count).toBe(2);
		expect(channels.data[3]).toBeCloseTo(0.65);
		expect(channels.data[CHANNEL_STRIDE + 3]).toBeCloseTo(0.9);
	});

	it('keeps the newest channels within the budget and supports replay seeks', () => {
		const { channels } = setup([0, 50, 100, 150], 2);
		channels.sync(100_200, 100_000);
		expect(channels.count).toBe(2);
		expect([channels.data[3], channels.data[CHANNEL_STRIDE + 3]].sort()).toEqual([
			expect.closeTo(0.1), expect.closeTo(0.15),
		]);
		channels.sync(100_050, 100_000);
		expect(channels.count).toBe(2);
		expect(channels.data[3]).toBe(0);
	});

	it('preserves shapes through rebases and gives collocated flashes different seeds', () => {
		const { channels } = setup([0, 50]);
		channels.sync(100_100, 100_000);
		const seeds = [channels.data[7], channels.data[CHANNEL_STRIDE + 7]];
		expect(seeds[0]).not.toBe(seeds[1]);
		channels.sync(100_100, 101_000);
		expect([channels.data[7], channels.data[CHANNEL_STRIDE + 7]]).toEqual(seeds);
	});

	it('selects by source play time, including a late chunk inserted into the ring', () => {
		const { ring, channels } = setup([600]);
		ring.push(decodeChunk(encodeChunk(100, [{ offsetMs: 0, source: 2, lat: 15, lon: -40 }]).buffer));
		const delays = new SourceDelays({ 'glm-east': 0, 'glm-west': 0, 'mtg-li': 800 });
		channels.sync(100_900, 100_000, undefined, delays);
		expect(channels.count).toBe(2);
		expect(channels.data[3]).toBeCloseTo(0.8);
		expect(channels.data[CHANNEL_STRIDE + 3]).toBeCloseTo(0.6);
		channels.sync(101_100, 100_000, undefined, delays);
		expect(channels.count).toBe(1);
	});

	it('keeps a channel for its flicker in wall clock time at any replay speed', () => {
		const { channels } = setup([0, 20_000, 30_000]);
		const playback = new FlashPlayback();
		playback.update(130_000, 60);
		channels.sync(130_000, 100_000, playback);
		expect(channels.count).toBe(2);
		expect(channels.data[3]).toBeCloseTo(20);
		playback.update(130_000, 600);
		channels.sync(130_000, 100_000, playback);
		expect(channels.count).toBe(2);
		channels.sync(400_000, 100_000, playback);
		expect(channels.count).toBe(0);
	});
});
