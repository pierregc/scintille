import { describe, expect, it } from 'vitest';
import { decodeChunk } from '../live/decode';
import { FlashRing } from '../live/ring';
import { encodeChunk } from '../live/testing';
import { latLonToVector } from '../sun';
import { FLASH_STRIDE, FlashInstances, REBASE_MS } from './instances';

function push(ring: FlashRing, startSeconds: number, count: number, lat = 0, lon = 0) {
	const flashes = Array.from({ length: count }, (_, i) => ({ offsetMs: i, lat, lon }));
	ring.push(decodeChunk(encodeChunk(startSeconds, flashes).buffer));
}

function setup(ringCapacity: number, capacity: number) {
	const ring = new FlashRing(ringCapacity);
	const ranges: [number, number][] = [];
	const instances = new FlashInstances(ring, capacity, (start, count) => ranges.push([start, count]));
	const times = () =>
		Array.from({ length: instances.count }, (_, i) =>
			Math.round(instances.origin + instances.data[i * FLASH_STRIDE + 3] * 1000),
		);
	return { ring, instances, ranges, times };
}

describe('FlashInstances', () => {
	it('stores direction, relative time, intensity, radius and duration', () => {
		const { ring, instances } = setup(8, 4);
		push(ring, 100, 1, 30, -60);
		instances.sync(100_000);
		const d = instances.data;
		const [x, y, z] = latLonToVector(30, -60);
		expect(d[0]).toBeCloseTo(x, 3);
		expect(d[1]).toBeCloseTo(y, 3);
		expect(d[2]).toBeCloseTo(z, 3);
		expect(d[3]).toBe(0);
		expect(d[4]).toBeCloseTo(1);
		expect(d[5]).toBeCloseTo(Math.sqrt(100 / Math.PI));
		expect(d[6]).toBe(250);
		expect(instances.origin).toBe(100_000);
	});

	it('uploads only new flashes, wrapping around the capacity', () => {
		const { ring, instances, ranges, times } = setup(16, 4);
		push(ring, 1, 3);
		instances.sync(1000);
		expect(ranges).toEqual([[0, 3]]);
		instances.sync(1000);
		expect(ranges).toHaveLength(1);
		push(ring, 2, 2);
		instances.sync(1000);
		expect(ranges.slice(1)).toEqual([
			[3, 1],
			[0, 1],
		]);
		expect(instances.count).toBe(4);
		expect(times().sort()).toEqual([1001, 1002, 2000, 2001]);
	});

	it('keeps the newest flashes when more arrive than it holds', () => {
		const { ring, instances, times } = setup(16, 3);
		instances.sync(1000);
		push(ring, 1, 10);
		instances.sync(1000);
		expect(times().sort()).toEqual([1007, 1008, 1009]);
	});

	it('copies only what the ring still has', () => {
		const { ring, instances, times } = setup(4, 8);
		instances.sync(1000);
		push(ring, 1, 6);
		instances.sync(1000);
		expect(instances.count).toBe(4);
		expect(times()).toEqual([1002, 1003, 1004, 1005]);
	});

	it('holds as many flashes as the ring by default', () => {
		const ring = new FlashRing(64);
		const instances = new FlashInstances(ring);
		push(ring, 1, 64);
		instances.sync(1000);
		expect(instances.capacity).toBe(64);
		expect(instances.count).toBe(64);
	});

	it('rebases times when the scene time moves far from the origin', () => {
		const { ring, instances, ranges } = setup(8, 8);
		push(ring, 1, 2);
		instances.sync(1000);
		const later = 1000 + REBASE_MS + 1;
		instances.sync(later);
		expect(instances.origin).toBe(later);
		expect(ranges.at(-1)).toEqual([0, 2]);
		expect(instances.data[3]).toBeCloseTo((1000 - later) / 1000, 2);
	});
});
