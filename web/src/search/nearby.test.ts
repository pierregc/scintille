import { describe, expect, it } from 'vitest';
import { type Candidate, nearbyKey, parseNearbyQuery, rankNearby, rankOf } from './nearby';

const NOW = Date.parse('2026-10-29T18:00:00Z') / 1000;
const H = 3600;
const query = (text: string) => parseNearbyQuery(new URLSearchParams(text));
const lyon = { lat: 45.8, lon: 4.8, hours: 72, km: 200, limit: 4 };
const storm = (slug: string, changes: Partial<Candidate> = {}): Candidate => ({
	slug, t_start: NOW - 3 * H, t_end: NOW - 2 * H, score: 100, path: [[45.8, 5.5]], radius_km: 10, ...changes,
});

describe('nearby query', () => {
	it('applies defaults and rounds the point', () => {
		expect(query('lat=45.7640&lon=4.8357')).toEqual({ ok: true, value: lyon });
		expect(nearbyKey(lyon)).toBe('lat=45.8&lon=4.8&hours=72&km=200&limit=4');
	});

	it('refuses missing, malformed and excessive values instead of clamping them', () => {
		for (const text of ['lon=4.8', 'lat=45.8', 'lat=91&lon=0', 'lat=0&lon=180.5', 'lat=1e1&lon=0', 'lat=0&lon=0&hours=169',
			'lat=0&lon=0&hours=0', 'lat=0&lon=0&km=501', 'lat=0&lon=0&km=9', 'lat=0&lon=0&limit=9', 'lat=0&lon=0&hours=2.5', 'lat=0&lon=0&km=-10']) {
			expect(query(text).ok, text).toBe(false);
		}
		const result = query('lat=x&lon=0&km=900');
		expect(result.ok ? [] : result.errors).toEqual(['lat must be a number from -90 to 90', 'km must be an integer from 10 to 500']);
		expect(query('lat=0&lon=0&hours=168&km=500&limit=8').ok).toBe(true);
	});
});

describe('nearby ranking', () => {
	it('keeps storms whose interval meets the window and whose path comes within reach', () => {
		const storms = [
			storm('recent-near'),
			storm('old', { t_start: NOW - 80 * H, t_end: NOW - 73 * H }),
			storm('overlaps-start', { t_start: NOW - 80 * H, t_end: NOW - 71 * H }),
			storm('far', { path: [[48.9, 2.3]] }),
			storm('future', { t_start: NOW + H, t_end: NOW + 2 * H }),
			storm('ongoing', { t_end: NOW }),
		];
		expect(rankNearby(storms, lyon, NOW).map((m) => m.candidate.slug).sort()).toEqual(['ongoing', 'overlaps-start', 'recent-near']);
	});

	it('measures to a moving storm path crossing a border, not its centroid', () => {
		const crossing = storm('rhone-to-piedmont', { path: [[45.0, 4.0], [45.3, 6.5], [45.1, 9.0]], radius_km: 0 });
		const [match] = rankNearby([crossing], { ...lyon, lat: 45.5, lon: 6.5, km: 50 }, NOW);
		expect(match.distance_km).toBe(20);
	});

	it('balances interest, recency and distance', () => {
		expect(rankOf(200, 0, 0) - rankOf(100, 0, 0)).toBeCloseTo(1);
		expect(rankOf(100, 24, 0)).toBeCloseTo(rankOf(100, 0, 100));
		const exceptionalOld = storm('exceptional-old', { score: 450, t_end: NOW - 60 * H, t_start: NOW - 62 * H });
		const intenseOld = storm('intense-old', { score: 120, t_end: NOW - 70 * H, t_start: NOW - 71 * H });
		const strongNew = storm('strong-new', { score: 25, t_end: NOW - H });
		expect(rankNearby([intenseOld, strongNew, exceptionalOld], lyon, NOW).map((m) => m.candidate.slug))
			.toEqual(['exceptional-old', 'strong-new', 'intense-old']);
	});

	it('breaks ties by distance, end time, then slug, whatever the input order', () => {
		const a = storm('b-storm');
		const b = storm('a-storm');
		const c = storm('later', { t_end: NOW - 2 * H + 1, score: 100 * 2 ** (1 / (24 * 3600)) });
		const orders = [[a, b, c], [c, b, a], [b, c, a]].map((list) => rankNearby(list, lyon, NOW).map((m) => m.candidate.slug));
		expect(orders[0]).toEqual(['later', 'a-storm', 'b-storm']);
		expect(new Set(orders.map(String)).size).toBe(1);
	});

	it('lists a storm once even when several tiles return it', () => {
		expect(rankNearby([storm('twice'), storm('twice')], lyon, NOW)).toHaveLength(1);
	});
});
