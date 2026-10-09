import { describe, expect, it } from 'vitest';
import { decodeChunk } from './decode';
import { FlashRing } from './ring';
import { encodeChunk } from './testing';

function chunk(startSeconds: number, count: number) {
	const flashes = Array.from({ length: count }, (_, i) => ({ offsetMs: i, lat: 0, lon: 0 }));
	return decodeChunk(encodeChunk(startSeconds, flashes).buffer);
}

describe('FlashRing', () => {
	it('stores absolute event times and scaled values', () => {
		const ring = new FlashRing(8);
		ring.push(decodeChunk(encodeChunk(100, [{ offsetMs: -250, lat: 12.5, lon: -45 }]).buffer));
		expect(ring.size).toBe(1);
		expect(ring.time[0]).toBe(99_750);
		expect(ring.lat[0]).toBeCloseTo(12.5, 2);
		expect(ring.lon[0]).toBeCloseTo(-45, 2);
		expect(ring.intensity[0]).toBeCloseTo(1);
		expect(ring.durationMs[0]).toBe(250);
	});

	it('wraps around and overwrites the oldest flashes', () => {
		const ring = new FlashRing(5);
		ring.push(chunk(1, 3));
		ring.push(chunk(2, 4));
		expect(ring.size).toBe(5);
		expect(ring.written).toBe(7);
		expect(ring.head).toBe(2);
		const times = Array.from({ length: ring.size }, (_, i) => ring.time[ring.slot(i)]);
		expect(times).toEqual([1002, 2000, 2001, 2002, 2003]);
	});

	it('keeps the newest flashes of a chunk larger than the ring', () => {
		const ring = new FlashRing(3);
		ring.push(chunk(1, 10));
		const times = Array.from({ length: ring.size }, (_, i) => ring.time[ring.slot(i)]);
		expect(times).toEqual([1007, 1008, 1009]);
		expect(ring.written).toBe(10);
	});

	it('orders slots before the ring is full', () => {
		const ring = new FlashRing(4);
		ring.push(chunk(1, 2));
		expect([ring.slot(0), ring.slot(1)]).toEqual([0, 1]);
	});
});
