import { describe, expect, it } from 'vitest';
import fixture from '../../../../fixtures/cyclones/tracks.json';
import { CYCLONES, cyclonesAt, loadCyclones, ringRadius, tagText } from './index';
import { parseCyclones } from './track';

const feed = parseCyclones(fixture);
const at = (iso: string) => Date.parse(iso);

describe('cyclones at a time', () => {
	it('lists the storms present, strongest first', () => {
		expect(cyclonesAt(feed, at('2026-07-15T12:00:00Z')).map((v) => v.cyclone.name)).toEqual(['Nida', 'Dolly']);
		expect(cyclonesAt(feed, at('2026-07-10T12:00:00Z')).map((v) => v.cyclone.name)).toEqual(['03E']);
		expect(cyclonesAt(feed, at('2026-07-12T12:00:00Z'))).toEqual([]);
		expect(cyclonesAt(null, 0)).toEqual([]);
	});

	it('keeps the strongest when there are too many', () => {
		expect(cyclonesAt(feed, at('2026-07-15T12:00:00Z'), 1).map((v) => v.cyclone.name)).toEqual(['Nida']);
	});

	it('shows an active storm past its last fix, not a finished one', () => {
		const later = cyclonesAt(feed, at('2026-07-15T17:00:00Z'));
		expect(later.map((v) => [v.cyclone.name, v.sample.carried])).toEqual([['Nida', true], ['Dolly', true]]);
		expect(cyclonesAt(feed, at('2026-07-11T03:00:00Z'))).toEqual([]);
	});
});

describe('name tag', () => {
	it('gives the name, the kind for the basin and the wind', () => {
		const [nida, dolly] = cyclonesAt(feed, at('2026-07-15T12:00:00Z'));
		expect(tagText(nida)).toEqual(['Nida', 'Typhoon · 220 km/h']);
		expect(tagText(dolly)).toEqual(['Dolly', 'Hurricane · 165 km/h']);
		expect(tagText(cyclonesAt(feed, at('2026-07-10T00:00:00Z'))[0])).toEqual(['03E', 'Tropical depression · 45 km/h']);
	});
});

describe('ring radius', () => {
	it('is the gale radius up close and a few pixels from far', () => {
		expect(ringRadius(637.1, 1e-6, 1)).toBeCloseTo(0.1, 6);
		expect(ringRadius(null, 1e-6, 1)).toBeCloseTo(CYCLONES.defaultRadiusKm / 6371, 6);
		expect(ringRadius(100, 0.01, 1)).toBeCloseTo(CYCLONES.minRadiusPx * 0.01, 6);
	});
});

describe('loading', () => {
	const respond = (body: string, status = 200) => () => Promise.resolve(new Response(body, { status }));

	it('parses the feed', async () => {
		const loaded = await loadCyclones('https://data.test/cyclones/tracks.json', respond(JSON.stringify(fixture)));
		expect(loaded.cyclones).toHaveLength(3);
	});

	it('fails on an HTTP error, a broken body or an oversized one', async () => {
		await expect(loadCyclones('u', respond('', 404))).rejects.toThrow('HTTP 404');
		await expect(loadCyclones('u', respond('{'))).rejects.toThrow();
		await expect(loadCyclones('u', respond(' '.repeat(CYCLONES.maxBytes + 1)))).rejects.toThrow('too large');
	});
});
