import { describe, expect, it } from 'vitest';
import { decodeChunk } from '../live/decode';
import { SourceDelays } from '../live/delay';
import { FlashRing } from '../live/ring';
import { encodeChunk } from '../live/testing';
import { latLonToVector } from '../sun';
import { FLASH_STRIDE, FlashInstances, REBASE_MS } from './instances';

function push(ring: FlashRing, startSeconds: number, count: number, lat = 0, lon = 0) {
	const flashes = Array.from({ length: count }, (_, i) => ({ offsetMs: i, lat, lon }));
	ring.push(decodeChunk(encodeChunk(startSeconds, flashes).buffer));
}

function setup(ringCapacity: number, capacity: number, lookbackMs = 0) {
	const ring = new FlashRing(ringCapacity);
	const ranges: [number, number][] = [];
	const instances = new FlashInstances(ring, capacity, (start, count) => ranges.push([start, count]), lookbackMs);
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
		instances.sync(3000);
		expect(ranges).toEqual([[0, 3]]);
		instances.sync(3000);
		expect(ranges).toHaveLength(1);
		push(ring, 2, 2);
		instances.sync(3000);
		expect(ranges.slice(1)).toEqual([
			[3, 1],
			[0, 1],
		]);
		expect(instances.count).toBe(4);
		expect(times().sort()).toEqual([1001, 1002, 2000, 2001]);
	});

	it('keeps the newest flashes when more arrive than it holds', () => {
		const { ring, instances, times } = setup(16, 3);
		instances.sync(3000);
		push(ring, 1, 10);
		instances.sync(3000);
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

	it('follows the replay playhead when it holds fewer flashes than the ring', () => {
		const { ring, instances, times } = setup(16, 4, 2);
		push(ring, 1, 10);
		instances.sync(1000);
		expect(times()).toEqual([1000, 1001, 1002, 1003]);
		instances.sync(1005);
		expect(times().sort()).toEqual([1003, 1004, 1005, 1006]);
		instances.sync(1000);
		expect(times()).toEqual([1000, 1001, 1002, 1003]);
		instances.sync(1009);
		expect(times().sort()).toContain(1009);
	});

	it('reloads older flashes from the ring when the lookback grows', () => {
		const { ring, instances, times } = setup(16, 4, 2);
		push(ring, 1, 10);
		instances.sync(1008);
		expect(times().sort()).toEqual([1006, 1007, 1008, 1009]);
		instances.lookbackMs = 3;
		instances.sync(1008);
		expect(times().sort()).toEqual([1005, 1006, 1007, 1008]);
	});

	it('keeps the flashes closest to the playhead when the lookback holds more than fits', () => {
		const { ring, instances, times } = setup(16, 4, 60_000);
		push(ring, 1, 10);
		instances.sync(1008);
		expect(times().sort()).toEqual([1005, 1006, 1007, 1008]);
		instances.sync(1009);
		expect(times().sort()).toEqual([1006, 1007, 1008, 1009]);
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

	it('shows the same flashes for late and overlapping chunks as for the same data in order', () => {
		const flashes = Array.from({ length: 40 }, (_, i) => ({ offsetMs: i * 10, lat: i, lon: -i }));
		const late = [flashes.slice(0, 10), flashes.slice(25, 40), flashes.slice(10, 25).reverse()];
		const visible = (ringCapacity: number, capacity: number, chunks: (typeof flashes)[], playhead: number) => {
			const { ring, instances } = setup(ringCapacity, capacity, 50);
			for (const flashesInChunk of chunks) {
				instances.sync(playhead);
				ring.push(decodeChunk(encodeChunk(1, flashesInChunk).buffer));
			}
			instances.sync(playhead);
			const rows = Array.from({ length: instances.count }, (_, i) =>
				Array.from(instances.data.subarray(i * FLASH_STRIDE, (i + 1) * FLASH_STRIDE), (v) => v.toFixed(4)).join(),
			);
			return rows.sort();
		};
		for (const [ringCapacity, capacity, playhead] of [
			[64, 64, 1400],
			[64, 8, 1200],
			[32, 32, 1400],
		]) {
			expect(visible(ringCapacity, capacity, late, playhead)).toEqual(
				visible(ringCapacity, capacity, [flashes], playhead),
			);
		}
	});

	it('uploads only new observations when an immutable archive window moves forward', () => {
		const archive = new FlashRing(12);
		push(archive, 100, 12);
		const { ring, instances, ranges, times } = setup(4, 4, 1000);
		ring.replace(archive, 0, 4);
		instances.sync(100_000);
		const generation = ring.generation;
		const origin = instances.origin;
		ring.slide(archive, 1, 4);
		instances.sync(100_001);
		expect(ring.generation).toBe(generation);
		expect(instances.origin).toBe(origin);
		expect(ranges).toEqual([[0, 4], [0, 1]]);
		expect(times().sort()).toEqual([100_001, 100_002, 100_003, 100_004]);
		ring.slide(archive, 0, 4);
		instances.sync(100_000);
		expect(times().sort()).toEqual([100_000, 100_001, 100_002, 100_003]);
		expect(ring.generation).toBe(generation);
	});

	it('plays each source its delay after its event time', () => {
		const { ring, instances, times } = setup(16, 8, 10);
		const flashes = [0, 1, 2].map((source) => ({ offsetMs: 0, lat: 0, lon: 0, source }));
		ring.push(decodeChunk(encodeChunk(1, flashes).buffer));
		instances.sync(1005);
		expect(times()).toEqual([1000, 1000, 1000]);
		instances.sync(1505, new SourceDelays({ 'glm-east': 100, 'glm-west': 100, 'mtg-li': 500 }));
		expect(times().sort()).toEqual([1100, 1100, 1500]);
	});
});
