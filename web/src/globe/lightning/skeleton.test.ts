import { describe, expect, it } from 'vitest';
import { CHANNEL, channelHash, KIND } from './channel';
import { FlashKind } from './kind';
import { flickerLength, PROFILE } from './profile';
import { channelSkeleton, MAX_SEGMENTS, SEGMENT_FLOATS, SKELETON, type Skeleton } from './skeleton';

const seeds = Array.from({ length: 300 }, (_, i) => ((i + 1) * 0.6180339887) % 1);
/** Radius from 3 to 19 km and a duration from 60 ms to 1 s, varied over the seeds. */
const radius = (i: number) => 3 + ((i * 7) % 17);
const duration = (i: number) => 60 + ((i * 113) % 940);

type Vec = [number, number, number];
interface Segment {
	a: Vec;
	width: number;
	b: Vec;
	light: number;
	from: number;
	to: number;
	level: number;
	flag: number;
}

function segments(s: Skeleton): Segment[] {
	return Array.from({ length: s.count }, (_, k) => {
		const d = s.data.subarray(k * SEGMENT_FLOATS, (k + 1) * SEGMENT_FLOATS);
		return { a: [d[0], d[1], d[2]], width: d[3], b: [d[4], d[5], d[6]], light: d[7], from: d[8], to: d[9], level: d[10], flag: d[11] };
	});
}

/** Runs of segments written one after the other, each starting where the last ended, at one level. */
function runs(parts: Segment[]): Segment[][] {
	const out: Segment[][] = [];
	for (const g of parts) {
		const last = out.at(-1)?.at(-1);
		if (last && last.level === g.level && Math.hypot(last.b[0] - g.a[0], last.b[1] - g.a[1], last.b[2] - g.a[2]) < 1e-5) out.at(-1)?.push(g);
		else out.push([g]);
	}
	return out;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const horizontal = (a: Vec, b: Vec) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const fromVertical = (a: Vec, b: Vec) => (Math.atan2(horizontal(a, b), Math.abs(b[2] - a[2])) * 180) / Math.PI;
const turn = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
const share = (xs: boolean[]) => xs.filter(Boolean).length / xs.length;

const GROUND = [FlashKind.CgMulti, FlashKind.CgSingle, FlashKind.CgPositive, FlashKind.BoltFromBlue];
const ALL = [...GROUND, FlashKind.IcTrunkFan, FlashKind.IcCrawler, FlashKind.CloudToAir];
const build = (kind: FlashKind) => seeds.map((seed, i) => ({ seed, r: radius(i), ms: duration(i), parts: segments(channelSkeleton(seed, radius(i), kind, duration(i))) }));
const built = new Map(ALL.map((kind) => [kind, build(kind)]));
const flashes = (kind: FlashKind) => built.get(kind) ?? [];

/** Whether a segment of a cloud-to-ground channel belongs to its in-cloud stem, run before the drop starts. */
const inStem = (g: Segment) => g.level === 0 && g.from < SKELETON.stemArrival - 1e-6;

/** Least and most a cloud-to-ground kind's heights are drawn up by: `cgHeightScale`, less where its stem would rise over `maxOriginKm`. */
function heightScale(kind: FlashKind): [number, number] {
	const k = KIND[kind];
	const scale = (stemTop: number) => Math.min(SKELETON.cgHeightScale, SKELETON.maxOriginKm / stemTop);
	return [scale(Math.max(k.originKm[1], k.topKm[1])), scale(Math.max(k.originKm[0], k.topKm[0]))];
}

/** Least and most drawn height of a cloud-to-ground kind's drop top: its origin (a bolt from the blue's exit) scaled with its stem. */
function topRange(kind: FlashKind): [number, number] {
	const k = KIND[kind];
	const scaled = (z: number, stemTop: number) => z * Math.min(SKELETON.cgHeightScale, SKELETON.maxOriginKm / stemTop);
	// A bolt from the blue's stem tops at its climb, the others' at their origin.
	if (kind === FlashKind.BoltFromBlue) return [scaled(k.originKm[0], k.topKm[1]), scaled(k.originKm[1], k.topKm[0])];
	return [scaled(k.originKm[0], k.originKm[0]), scaled(k.originKm[1], k.originKm[1])];
}

/** The drop of a cloud-to-ground channel: its main path after the stem, from its top to its strike. */
function drop(parts: Segment[]) {
	const main = parts.filter((g) => g.level === 0 && !inStem(g));
	return { top: main[0].a, strike: main[main.length - 1].b, last: main[main.length - 1] };
}

describe('channelSkeleton', () => {
	it('is the same for the same seed and different across seeds', () => {
		expect(channelSkeleton(0.42, 10, FlashKind.CgMulti, 200).data).toEqual(channelSkeleton(0.42, 10, FlashKind.CgMulti, 200).data);
		expect(channelSkeleton(0.42, 10, FlashKind.IcTrunkFan, 200).data).not.toEqual(channelSkeleton(0.43, 10, FlashKind.IcTrunkFan, 200).data);
		expect(channelSkeleton(0.42, 10, FlashKind.CgSingle, 200).kind).toBe(FlashKind.CgSingle);
		expect(channelSkeleton(0.42, 10, FlashKind.IcTrunkFan, 900).durationMs).toBe(900);
	});

	it('stays within its budget with sane widths, lights and arrivals', () => {
		for (const kind of ALL) {
			for (const { parts } of flashes(kind)) {
				// Crawlers, deep in the cloud, are drawn in segments as long as the cloud spreads them wide.
				expect(parts.length).toBeGreaterThan(kind === FlashKind.IcCrawler ? 3 : 10);
				expect(parts.length).toBeLessThanOrEqual(MAX_SEGMENTS);
				// One check per flash: an expect per segment is too slow for CI runners.
				const sane = (g: Segment) => g.width >= SKELETON.minWidth - 1e-6 && g.light > 0 && g.light <= 1 && g.from >= 0 && g.from <= g.to + 1e-6 && g.to <= 1 + 1e-6;
				expect(parts.find((g) => !sane(g))).toBeUndefined();
			}
		}
	});

	it('drops cloud-to-ground kinds from their origin to a strike inside the footprint', () => {
		for (const kind of GROUND) {
			const k = KIND[kind];
			const [low, high] = topRange(kind);
			for (const { r, parts } of flashes(kind)) {
				const { top, strike, last } = drop(parts);
				expect(Math.min(...parts.flatMap((g) => [g.a[2], g.b[2]]))).toBe(0);
				expect(strike[2]).toBe(0);
				expect(last.to).toBeCloseTo(1, 6);
				expect(top[2]).toBeGreaterThanOrEqual(low - 1e-4);
				expect(top[2]).toBeLessThanOrEqual(high + 1e-4);
				expect(Math.hypot(strike[0], strike[1])).toBeLessThanOrEqual(Math.max(r, k.reachKm) + 1e-4);
				// The stem runs in the cloud whatever its height; under the cloud base the rest is in clear air.
				const stem = parts.filter(inStem);
				expect(stem.length).toBeGreaterThan(0);
				for (const g of stem) expect(g.flag).toBe(1);
				for (const g of parts) if (!inStem(g) && Math.max(g.a[2], g.b[2]) <= SKELETON.cloudBaseKm) expect(g.flag).toBe(0);
				// The stem is run first, and the drop leaves from its end.
				for (const g of stem) expect(g.to).toBeLessThanOrEqual(SKELETON.stemArrival + 1e-6);
				expect(Math.max(...stem.map((g) => g.to))).toBeCloseTo(SKELETON.stemArrival, 6);
				expect(horizontal(stem[stem.length - 1].b, top)).toBeLessThan(1e-5);
				expect(parts.some((g) => g.flag === 2)).toBe(false);
			}
		}
	});

	it('keeps negative drops within 30 degrees of the vertical for most flashes and 45 for nearly all, 2 to 8 km sideways', () => {
		for (const kind of [FlashKind.CgMulti, FlashKind.CgSingle]) {
			const drops = flashes(kind).map(({ parts }) => drop(parts));
			const tilts = drops.map(({ top, strike }) => fromVertical(top, strike));
			expect(share(tilts.map((t) => t <= 45))).toBeGreaterThanOrEqual(0.95);
			expect(share(tilts.map((t) => t <= 30))).toBeGreaterThanOrEqual(0.75);
			const sideways = drops.map(({ top, strike }) => horizontal(top, strike));
			expect(share(sideways.map((d) => d >= KIND[kind].strikeKm[0] - 1e-4 && d <= KIND[kind].strikeKm[1] + 1e-4))).toBeGreaterThanOrEqual(0.95);
		}
	});

	it('strikes positive flashes 0.6 to 1 r from the position', () => {
		const [inner, outer] = KIND[FlashKind.CgPositive].strikeR;
		const ring = flashes(FlashKind.CgPositive).map(({ r, parts }) => {
			const { strike } = drop(parts);
			const d = Math.hypot(strike[0], strike[1]) / Math.max(3, r);
			return d >= inner - 1e-4 && d <= outer + 1e-4;
		});
		expect(share(ring)).toBeGreaterThanOrEqual(0.95);
	});

	it('branches cloud-to-ground drops on both sides, below 5 km (drawn up with the drop), ending in the air', () => {
		const sides: boolean[] = [];
		for (const { parts } of flashes(FlashKind.CgMulti)) {
			const { top, strike } = drop(parts);
			const course = [strike[0] - top[0], strike[1] - top[1]];
			for (const branch of runs(parts).filter((run) => run[0].level === 1)) {
				const a = branch[0].a;
				const b = branch[branch.length - 1].b;
				expect(a[2]).toBeLessThanOrEqual(SKELETON.branchFromKm[1] * heightScale(FlashKind.CgMulti)[1] + 1e-4);
				expect(Math.min(...branch.map((g) => g.b[2]))).toBeGreaterThanOrEqual(0.2 - 1e-6);
				expect(b[2]).toBeLessThan(a[2]);
				sides.push(course[0] * (b[1] - a[1]) - course[1] * (b[0] - a[0]) > 0);
			}
		}
		expect(sides.length).toBeGreaterThan(900);
		expect(share(sides)).toBeGreaterThanOrEqual(0.3);
		expect(share(sides.map((s) => !s))).toBeGreaterThanOrEqual(0.3);
	});

	it('gives 35 to 45 % of multi-stroke flashes a second ground contact, and no other kind', () => {
		const second = flashes(FlashKind.CgMulti).map(({ parts }) => parts.some((g) => g.level === 4));
		expect(share(second)).toBeGreaterThanOrEqual(0.35);
		expect(share(second)).toBeLessThanOrEqual(0.45);
		for (const { r, parts } of flashes(FlashKind.CgMulti)) {
			const contact = parts.filter((g) => g.level === 4);
			if (!contact.length) continue;
			const foot = contact[contact.length - 1].b;
			expect(foot[2]).toBe(0);
			expect(contact[0].a[2]).toBeGreaterThanOrEqual(SKELETON.secondFromKm[0] * heightScale(FlashKind.CgMulti)[0] - 1e-4);
			expect(contact[0].a[2]).toBeLessThanOrEqual(SKELETON.secondFromKm[1] * heightScale(FlashKind.CgMulti)[1] + 1e-4);
			expect(Math.hypot(foot[0], foot[1])).toBeLessThanOrEqual(r + 1e-4);
			expect(horizontal(foot, drop(parts).strike)).toBeLessThanOrEqual(SKELETON.secondAwayKm[1] + 1e-4);
		}
		for (const kind of ALL.filter((k) => k !== FlashKind.CgMulti)) for (const { parts } of flashes(kind)) expect(parts.some((g) => g.level === 4)).toBe(false);
	});

	it('runs every second ground contact down to the ground, even in small footprints', () => {
		let contacts = 0;
		for (let i = 0; i < 3000; i++) {
			const contact = segments(channelSkeleton(((i + 1) * 0.7548776662) % 1, 3 + (i % 3), FlashKind.CgMulti, 60 + ((i * 113) % 940))).filter((g) => g.level === 4);
			if (!contact.length) continue;
			contacts++;
			expect(contact[contact.length - 1].b[2]).toBe(0);
		}
		expect(contacts).toBeGreaterThan(1000);
	});

	it('climbs an oblique in-cloud trunk before the fans spread, within the footprint and their speed', () => {
		for (const kind of [FlashKind.IcTrunkFan, FlashKind.CloudToAir]) {
			const k = KIND[kind];
			for (const { r, ms, parts } of flashes(kind)) {
				const trunk = parts.filter((g) => g.flag === 2);
				expect(trunk.length).toBeGreaterThan(0);
				expect(trunk.every((g) => g.level === 0)).toBe(true);
				const foot = trunk[0].a;
				const top = trunk[trunk.length - 1].b;
				expect(top[2] - foot[2]).toBeGreaterThanOrEqual(SKELETON.trunkClimbKm[0] - 1e-6);
				expect(top[2] - foot[2]).toBeLessThanOrEqual(SKELETON.trunkClimbKm[1] + 1e-6);
				expect(top[2]).toBeGreaterThanOrEqual(k.topKm[0] - 1e-6);
				expect(top[2]).toBeLessThanOrEqual(k.topKm[1] + 1e-6);
				expect(fromVertical(foot, top)).toBeGreaterThanOrEqual(k.inclinationDeg[0][0] - 1e-3);
				expect(fromVertical(foot, top)).toBeLessThanOrEqual(k.inclinationDeg[0][1] + 1e-3);
				const fans = parts.filter((g) => g.flag === 1);
				const lastTrunk = Math.max(...trunk.map((g) => g.to));
				expect(lastTrunk).toBeLessThanOrEqual(0.2);
				expect(Math.min(...fans.map((g) => g.from))).toBeGreaterThanOrEqual(lastTrunk - 1e-6);
				const reach = Math.min(CHANNEL.lengthScale * r, (k.spreadSpeed * PROFILE.cloudSpread * flickerLength(ms)) / 1000);
				for (const g of fans) for (const p of [g.a, g.b]) expect(horizontal(top, p)).toBeLessThanOrEqual(reach + 1e-4);
				for (const g of fans) for (const p of [g.a, g.b]) expect(p[2]).toBeGreaterThanOrEqual(SKELETON.fanKm[0] - 1e-6);
				expect(Math.max(...parts.map((g) => g.to))).toBeCloseTo(1, 6);
			}
		}
		expect(flashes(FlashKind.CloudToAir).every(({ parts }) => parts.some((g) => g.flag === 0))).toBe(true);
		expect(flashes(FlashKind.IcTrunkFan).some(({ parts }) => parts.some((g) => g.flag === 0))).toBe(false);
	});

	it('lets cloud-to-air channels end beyond the fan or just over the cloud top', () => {
		for (const { parts } of flashes(FlashKind.CloudToAir)) {
			for (const g of parts) expect(Math.max(g.a[2], g.b[2])).toBeLessThanOrEqual(SKELETON.cloudTopKm + SKELETON.airAboveTopKm + 1e-6);
			// The last leader leaves the first fan's tip in clear air, 1 to 3 km farther out from the trunk top.
			const top = parts.filter((g) => g.flag === 2).at(-1)?.b ?? parts[0].a;
			const end = parts[parts.length - 1];
			expect(end.flag).toBe(0);
			expect(end.level).toBe(0);
			const out = Math.atan2(end.b[1] - top[1], end.b[0] - top[0]);
			const tip = parts.find((g) => {
				const beyond = horizontal(top, end.b) - horizontal(top, g.b);
				return g.flag === 0 && turn(Math.atan2(g.b[1] - top[1], g.b[0] - top[0]), out) < 1e-3 && beyond >= SKELETON.airBeyondKm[0] - 1e-3 && beyond <= SKELETON.airBeyondKm[1] + 1e-3;
			});
			expect(tip).toBeDefined();
		}
	});

	it('runs crawlers along the cloud base without a trunk, across the footprint', () => {
		for (const { r, parts } of flashes(FlashKind.IcCrawler)) {
			expect(parts.some((g) => g.flag !== 1)).toBe(false);
			for (const g of parts) {
				for (const z of [g.a[2], g.b[2]]) {
					expect(z).toBeGreaterThanOrEqual(SKELETON.crawlerKm[0] - 1e-6);
					expect(z).toBeLessThanOrEqual(SKELETON.crawlerKm[1] + 1e-6);
				}
			}
			const start = parts[0].a;
			expect(Math.max(...parts.map((g) => horizontal(start, g.b)))).toBeGreaterThanOrEqual(0.7 * r);
			expect(Math.max(...parts.map((g) => horizontal(start, g.b)))).toBeLessThanOrEqual(1.6 * r);
		}
	});

	it('sends the first leader along the heading the light drifts on', () => {
		for (const kind of ALL) {
			const ground = GROUND.includes(kind);
			for (const { seed, parts } of flashes(kind)) {
				const first = ground ? parts.filter((g) => g.level === 0 && g.to <= SKELETON.stemArrival + 1e-6) : runs(parts.filter((g) => g.flag !== 2))[0];
				const a = first[0].a;
				const b = first[first.length - 1].b;
				expect(turn(Math.atan2(b[1] - a[1], b[0] - a[0]), channelHash(seed, 1) * 2 * Math.PI)).toBeLessThanOrEqual(0.9);
			}
		}
	});

	it('draws cloud-to-ground heights up by at most 1.5, under the cloud top, and no other kind', () => {
		expect(SKELETON.cgHeightScale).toBeLessThanOrEqual(1.5);
		for (const kind of GROUND) for (const { parts } of flashes(kind)) expect(Math.max(...parts.flatMap((g) => [g.a[2], g.b[2]]))).toBeLessThanOrEqual(SKELETON.cloudTopKm + 1e-4);
		for (const kind of [FlashKind.IcTrunkFan, FlashKind.IcCrawler]) for (const { parts } of flashes(kind)) expect(Math.max(...parts.flatMap((g) => [g.a[2], g.b[2]]))).toBeLessThanOrEqual(SKELETON.cloudTopKm + 1e-6);
	});

	it('drops mostly straight, turning about 16 degrees from one segment to the next', () => {
		const turns: number[] = [];
		const steep: number[] = [];
		for (const { parts } of flashes(FlashKind.CgMulti)) {
			const main = parts.filter((g) => g.level === 0 && !inStem(g));
			main.forEach((g, i) => {
				const d: Vec = [g.b[0] - g.a[0], g.b[1] - g.a[1], g.b[2] - g.a[2]];
				steep.push(90 - fromVertical(g.a, g.b));
				if (!i) return;
				const p = main[i - 1];
				const e: Vec = [p.b[0] - p.a[0], p.b[1] - p.a[1], p.b[2] - p.a[2]];
				const c = (d[0] * e[0] + d[1] * e[1] + d[2] * e[2]) / (Math.hypot(...d) * Math.hypot(...e));
				turns.push((Math.acos(Math.min(1, Math.max(-1, c))) * 180) / Math.PI);
			});
		}
		expect(mean(turns)).toBeGreaterThanOrEqual(12);
		expect(mean(turns)).toBeLessThanOrEqual(20);
		steep.sort((a, b) => a - b);
		expect(steep[Math.floor(steep.length / 2)]).toBeGreaterThanOrEqual(55);
	});

	it('draws ground channels and in-cloud trunks mostly steeper than 60 degrees on screen at the 45 degree framing', () => {
		// Length seen at a 45° tilt: heights by sin 45°, horizontal runs by the mean of 1 and cos 45° over the headings.
		const steepShare = (parts: Segment[]) => {
			let all = 0;
			let steep = 0;
			for (const g of parts) {
				const v = Math.abs(g.b[2] - g.a[2]) * Math.SQRT1_2;
				const h = (horizontal(g.a, g.b) * (1 + Math.SQRT1_2)) / 2;
				all += Math.hypot(v, h);
				if (Math.atan2(v, h) > Math.PI / 3) steep += Math.hypot(v, h);
			}
			return steep / all;
		};
		const ground = [FlashKind.CgMulti, FlashKind.CgSingle].flatMap((kind) => flashes(kind).flatMap(({ parts }) => parts));
		const trunks = flashes(FlashKind.IcTrunkFan).flatMap(({ parts }) => parts.filter((g) => g.flag === 2));
		expect(steepShare(ground)).toBeGreaterThanOrEqual(0.4);
		expect(steepShare(trunks)).toBeGreaterThanOrEqual(0.45);
	});

	it('varies its silhouette, from lone filaments to wide networks', () => {
		const looks = (kind: FlashKind) => seeds.map((seed) => channelSkeleton(seed, 10, kind, 300));
		const shareOf = (all: Skeleton[], look: string) => all.filter((s) => s.look === look).length / all.length;
		const cloud = looks(FlashKind.IcTrunkFan);
		expect(shareOf(cloud, 'filament')).toBeGreaterThan(0.12);
		expect(shareOf(cloud, 'branching')).toBeGreaterThan(0.2);
		expect(shareOf(cloud, 'network')).toBeGreaterThan(0.4);
		expect(shareOf(looks(FlashKind.CgSingle), 'filament')).toBe(1);
		expect(shareOf(looks(FlashKind.CgMulti), 'branching')).toBe(1);
		const count = (all: Skeleton[], look: string) => mean(all.filter((s) => s.look === look).map((s) => s.count));
		expect(count(cloud, 'network')).toBeGreaterThan(count(cloud, 'filament') * 1.5);
	});

	it('draws irregular paths, not a regular zigzag', () => {
		for (const kind of [FlashKind.IcTrunkFan, FlashKind.CgMulti]) {
			for (const seed of seeds.slice(0, 40)) {
				const trunk = segments(channelSkeleton(seed, 10, kind, 300)).filter((g) => g.level === 0);
				const lengths = trunk.map((g) => Math.hypot(g.b[0] - g.a[0], g.b[1] - g.a[1], g.b[2] - g.a[2]));
				const m = mean(lengths);
				const spread = Math.sqrt(mean(lengths.map((l) => (l - m) ** 2))) / m;
				expect(spread).toBeGreaterThan(0.2);
			}
		}
	});

	it('thins and dims each level of branches below the main channel', () => {
		const all = seeds.slice(0, 60).flatMap((seed) => segments(channelSkeleton(seed, 10, seed < 0.5 ? FlashKind.CgMulti : FlashKind.IcTrunkFan, 300)));
		const level = (n: number) => all.filter((g) => g.level === n);
		expect(mean(level(0).map((g) => g.width))).toBeGreaterThan(mean(level(1).map((g) => g.width)));
		expect(mean(level(1).map((g) => g.width))).toBeGreaterThan(mean(level(2).map((g) => g.width)));
		expect(mean(level(0).map((g) => g.light))).toBeGreaterThan(mean(level(1).map((g) => g.light)));
	});
});
