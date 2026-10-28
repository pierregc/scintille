import { describe, expect, it } from 'vitest';
import { decodeChunk } from '../live/decode';
import { FlashRing } from '../live/ring';
import { encodeChunk } from '../live/testing';
import { flashSeed } from './channel';
import { BUILDS_PER_FRAME, ChannelPool, SEGMENT_STRIDE } from './channel-pool';
import { FlashPlayback } from './playback';
import { MAX_SEGMENTS, SEGMENT_FLOATS } from './skeleton';

function setup(offsets: number[], capacity = 4) {
	const ring = new FlashRing(1024);
	ring.push(decodeChunk(encodeChunk(100, offsets.map((offsetMs, i) => ({ offsetMs, lat: 15 + (i % 40) * 0.5, lon: -40 + Math.floor(i / 40) }))).buffer));
	const ranges: [number, number][] = [];
	return { ring, ranges, pool: new ChannelPool(ring, capacity, (start, count) => ranges.push([start, count])) };
}

describe('ChannelPool', () => {
	it('builds one slot of segments per flickering flash, with its flash on every segment', () => {
		const { ring, pool, ranges } = setup([0, 650, 900, 1050]);
		pool.sync(101_000);
		expect(pool.flashes).toBe(2);
		expect(pool.count).toBe(2 * MAX_SEGMENTS);
		expect(ranges).toEqual([[0, MAX_SEGMENTS], [MAX_SEGMENTS, MAX_SEGMENTS]]);
		const flash = (slot: number, k: number) => pool.data.subarray((slot * MAX_SEGMENTS + k) * SEGMENT_STRIDE + SEGMENT_FLOATS, (slot * MAX_SEGMENTS + k + 1) * SEGMENT_STRIDE);
		const time = (slot: number) => Math.round(pool.origin + flash(slot, 0)[3] * 1000);
		expect([time(0), time(1)]).toEqual([100_900, 100_650]);
		expect(flash(0, MAX_SEGMENTS - 1)[7]).toBeCloseTo(flashSeed(100_900, ring.lat[2], ring.lon[2]), 6);
		const widths = Array.from({ length: MAX_SEGMENTS }, (_, k) => pool.data[k * SEGMENT_STRIDE + 3]);
		expect(widths.some((w) => w === 0)).toBe(true);
		expect(widths[0]).toBeGreaterThan(0);
	});

	it('keeps slots while flashes flicker, frees them after and builds nothing when disabled', () => {
		const { pool, ranges } = setup([0, 100]);
		pool.sync(100_150);
		pool.sync(100_200);
		expect(ranges).toHaveLength(2);
		pool.sync(100_420);
		expect(pool.flashes).toBe(1);
		pool.sync(100_200, undefined, undefined, false);
		expect(pool.count).toBe(0);
	});

	it('keeps the newest flashes when full and builds a few per frame', () => {
		const { pool } = setup(Array.from({ length: 40 }, (_, i) => i * 5), 32);
		pool.sync(100_220);
		expect(pool.flashes).toBe(BUILDS_PER_FRAME);
		pool.sync(100_220);
		expect(pool.flashes).toBe(32);
	});

	it('follows flashes in wall clock time while replaying fast', () => {
		const { pool } = setup([0, 20_000]);
		const playback = new FlashPlayback();
		playback.update(130_000, 60);
		pool.sync(130_000, playback);
		expect(pool.flashes).toBe(1);
	});

	it('gives one channel to a flash seen by two instruments', () => {
		const ring = new FlashRing(16);
		ring.push(decodeChunk(encodeChunk(100, [
			{ offsetMs: 0, lat: 15, lon: -40, source: 0 },
			{ offsetMs: 120, lat: 15.04, lon: -40.03, source: 2 },
			{ offsetMs: 150, lat: 15.04, lon: -40.03, source: 0 },
			{ offsetMs: 160, lat: 16, lon: -40, source: 2 },
		]).buffer));
		const pool = new ChannelPool(ring, 8);
		pool.sync(100_200);
		expect(pool.flashes).toBe(3);
	});
});

