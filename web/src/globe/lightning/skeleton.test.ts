import { describe, expect, it } from 'vitest';
import { FlashKind } from './kind';
import { channelSkeleton, MAX_SEGMENTS, SEGMENT_FLOATS, SKELETON, type Skeleton } from './skeleton';

const seeds = Array.from({ length: 300 }, (_, i) => ((i + 1) * 0.6180339887) % 1);

function segments(s: Skeleton) {
	return Array.from({ length: s.count }, (_, k) => {
		const d = s.data.subarray(k * SEGMENT_FLOATS, (k + 1) * SEGMENT_FLOATS);
		return { a: [d[0], d[1], d[2]], width: d[3], b: [d[4], d[5], d[6]], light: d[7], from: d[8], to: d[9], level: d[10], inCloud: d[11] };
	});
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const GROUND = FlashKind.CgMulti;
const CLOUD = FlashKind.IcTrunkFan;
const DURATION = 300;

describe('channelSkeleton', () => {
	it('is the same for the same seed and different across seeds', () => {
		expect(channelSkeleton(0.42, 10, GROUND, DURATION).data).toEqual(channelSkeleton(0.42, 10, GROUND, DURATION).data);
		expect(channelSkeleton(0.42, 10, CLOUD, DURATION).data).not.toEqual(channelSkeleton(0.43, 10, CLOUD, DURATION).data);
		expect(channelSkeleton(0.42, 10, FlashKind.CgSingle, DURATION).kind).toBe(FlashKind.CgSingle);
		expect(channelSkeleton(0.42, 10, CLOUD, 900).durationMs).toBe(900);
	});

	it('stays within its budget with sane widths, lights and arrivals', () => {
		for (const seed of seeds.slice(0, 80)) {
			for (const kind of [GROUND, CLOUD]) {
				const s = channelSkeleton(seed, 4 + seed * 20, kind, DURATION);
				expect(s.count).toBeGreaterThan(10);
				expect(s.count).toBeLessThanOrEqual(MAX_SEGMENTS);
				for (const g of segments(s)) {
					expect(g.width).toBeGreaterThanOrEqual(SKELETON.minWidth - 1e-6);
					expect(g.light).toBeGreaterThan(0);
					expect(g.light).toBeLessThanOrEqual(1);
					expect(g.from).toBeLessThanOrEqual(g.to);
					expect(g.to).toBeLessThanOrEqual(1 + 1e-6);
				}
			}
		}
	});

	it('drops cloud-to-ground kinds from inside the cloud to the ground, their branches ending in the air', () => {
		for (const seed of seeds.slice(0, 80)) {
			const kind = [FlashKind.CgMulti, FlashKind.CgSingle, FlashKind.CgPositive, FlashKind.BoltFromBlue][Math.floor(seed * 4)];
			const parts = segments(channelSkeleton(seed, 10, kind, DURATION));
			const heights = parts.flatMap((g) => [g.a[2], g.b[2]]);
			expect(Math.min(...heights)).toBeLessThan(0.05);
			expect(Math.min(...heights)).toBeGreaterThanOrEqual(0);
			expect(Math.max(...heights)).toBeGreaterThan(SKELETON.cloudBaseKm);
			for (const g of parts.filter((p) => p.level >= 2)) expect(Math.min(g.a[2], g.b[2])).toBeGreaterThan(0.1);
			expect(parts.some((g) => g.inCloud === 0)).toBe(true);
		}
	});

	it('keeps in-cloud kinds between the cloud heights', () => {
		for (const seed of seeds.slice(0, 80)) {
			const kind = [FlashKind.IcTrunkFan, FlashKind.IcCrawler, FlashKind.CloudToAir][Math.floor(seed * 3)];
			for (const g of segments(channelSkeleton(seed, 12, kind, DURATION))) {
				for (const z of [g.a[2], g.b[2]]) {
					expect(z).toBeGreaterThanOrEqual(SKELETON.cloudBottomKm);
					expect(z).toBeLessThanOrEqual(SKELETON.cloudTopKm);
				}
				expect(g.inCloud).toBe(1);
			}
		}
	});

	it('varies its silhouette, from lone filaments to wide networks', () => {
		const looks = (kind: FlashKind) => seeds.map((seed) => channelSkeleton(seed, 10, kind, DURATION));
		const share = (all: Skeleton[], look: string) => all.filter((s) => s.look === look).length / all.length;
		const ground = looks(GROUND);
		const cloud = looks(CLOUD);
		expect(share(ground, 'filament')).toBeGreaterThan(0.2);
		expect(share(ground, 'fork')).toBeGreaterThan(0.1);
		expect(share(ground, 'strikes')).toBeGreaterThan(0.04);
		expect(share(cloud, 'network')).toBeGreaterThan(0.4);
		const count = (all: Skeleton[], look: string) => mean(all.filter((s) => s.look === look).map((s) => s.count));
		expect(count(cloud, 'network')).toBeGreaterThan(count(cloud, 'filament') * 2);
	});

	it('draws irregular paths, not a regular zigzag', () => {
		for (const seed of seeds.slice(0, 40)) {
			const trunk = segments(channelSkeleton(seed, 10, CLOUD, DURATION)).filter((g) => g.level === 0);
			const lengths = trunk.map((g) => Math.hypot(g.b[0] - g.a[0], g.b[1] - g.a[1], g.b[2] - g.a[2]));
			const m = mean(lengths);
			const spread = Math.sqrt(mean(lengths.map((l) => (l - m) ** 2))) / m;
			expect(spread).toBeGreaterThan(0.2);
		}
	});

	it('thins and dims each level of branches below the main channel', () => {
		const all = seeds.slice(0, 60).flatMap((seed) => segments(channelSkeleton(seed, 10, seed < 0.5 ? GROUND : CLOUD, DURATION)));
		const level = (n: number) => all.filter((g) => g.level === n);
		expect(mean(level(0).map((g) => g.width))).toBeGreaterThan(mean(level(1).map((g) => g.width)));
		expect(mean(level(1).map((g) => g.width))).toBeGreaterThan(mean(level(2).map((g) => g.width)));
		expect(mean(level(0).map((g) => g.light))).toBeGreaterThan(mean(level(1).map((g) => g.light)));
	});
});
