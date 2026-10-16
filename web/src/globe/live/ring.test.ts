import { describe, expect, it } from 'vitest';
import { decodeChunk } from './decode';
import { FlashRing } from './ring';
import { encodeChunk } from './testing';

function chunk(startSeconds: number, count: number) {
	const flashes = Array.from({ length: count }, (_, i) => ({ offsetMs: i, lat: 0, lon: 0 }));
	return decodeChunk(encodeChunk(startSeconds, flashes).buffer);
}

function offsets(startSeconds: number, values: number[]) {
	return decodeChunk(encodeChunk(startSeconds, values.map((offsetMs) => ({ offsetMs, lat: offsetMs / 100, lon: 0 }))).buffer);
}

const times = (ring: FlashRing) => Array.from({ length: ring.size }, (_, i) => ring.time[ring.slot(i)]);

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

	it('merges late and unsorted chunks in event time order', () => {
		const ring = new FlashRing(16);
		ring.push(offsets(10, [0, 5, 10]));
		ring.push(offsets(10, [7, 2, 12, -1]));
		expect(times(ring)).toEqual([9_999, 10_000, 10_002, 10_005, 10_007, 10_010, 10_012]);
		expect(Array.from({ length: ring.size }, (_, i) => Math.round(ring.lat[ring.slot(i)] * 100))).toEqual([
			-1, 0, 2, 5, 7, 10, 12,
		]);
	});

	it('keeps arrival order for equal times', () => {
		const ring = new FlashRing(8);
		ring.push(offsets(1, [0, 0]));
		ring.push(decodeChunk(encodeChunk(1, [{ offsetMs: 0, lat: 9, lon: 0 }]).buffer));
		expect(Math.round(ring.lat[ring.slot(2)])).toBe(9);
	});

	it('drops the oldest flashes by event time when a late chunk overflows it', () => {
		const ring = new FlashRing(4);
		ring.push(offsets(1, [10, 20, 30, 40]));
		ring.push(offsets(1, [5, 25]));
		expect(times(ring)).toEqual([1020, 1025, 1030, 1040]);
	});

	it('tells watchers the lowest index a push changed', () => {
		const ring = new FlashRing(16);
		const watcher = ring.watch();
		ring.push(offsets(1, [10, 20, 30]));
		expect(watcher.from).toBe(0);
		watcher.from = Infinity;
		ring.push(offsets(1, [40]));
		expect(watcher.from).toBe(3);
		ring.push(offsets(1, [15]));
		expect(watcher.from).toBe(1);
	});
});

it('keeps absolute indices and the actual size of a partial archive window', () => {
	const archive = new FlashRing(8);
	archive.push(chunk(100, 12));
	const ring = new FlashRing(4);
	const watcher = ring.watch();
	ring.replace(archive, 2, 2);
	const generation = ring.generation;
	expect(ring.written).toBe(8);
	expect(ring.size).toBe(2);
	expect(times(ring)).toEqual([100_006, 100_007]);
	watcher.from = Number.POSITIVE_INFINITY;
	ring.slide(archive, 3, 2);
	expect(watcher.from).toBe(8);
	expect(times(ring)).toEqual([100_007, 100_008]);
	expect(ring.generation).toBe(generation);
	ring.slide(archive, 2, 2);
	expect(watcher.from).toBe(6);
	expect(times(ring)).toEqual([100_006, 100_007]);
});

it('requires a replacement when the archive dataset changes', () => {
	const archive = new FlashRing(8);
	archive.push(chunk(100, 8));
	const ring = new FlashRing(4);
	ring.replace(archive, 0, 4);
	expect(() => ring.slide(new FlashRing(8), 0, 0)).toThrow('window source changed');
	expect(() => ring.slide(archive, 0, 0)).toThrow('window size changed');
	ring.clear();
	expect(() => ring.slide(archive, 0, 4)).toThrow('window source changed');
});
