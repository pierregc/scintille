import { describe, expect, it } from 'vitest';
import fixture from '../../../../fixtures/cyclones/tracks.json';
import { SCHEMA_VERSION } from '../../contract/types';
import { CARRY_MS, cloudTime, cycloneKind, parseCyclones, sampleCyclone, windKmh } from './track';

const H = 3_600_000;
const T0 = Date.UTC(2026, 10, 17, 12);
const iso = (time: number) => new Date(time).toISOString();
const feed = (active: boolean) => parseCyclones({
	schema_version: SCHEMA_VERSION,
	generated_at: iso(T0 + 9 * H),
	attribution: 'NOAA',
	source_cycle: iso(T0 + 6 * H),
	cyclones: [{
		id: '20261115-04p', number: '04P', name: 'Xavier', basin: 'P', agency: 'JTWC', active,
		track: [
			{ time: iso(T0), lat: -9.3, lon: -163.8, wind_kt: 124, r34_km: 130, heading: 250, speed_ms: 2.1 },
			{ time: iso(T0 + 6 * H), lat: -9.6, lon: -163.8, wind_kt: 128, r34_km: 128, heading: 180, speed_ms: 5 },
		],
	}],
});

describe('cyclone feed', () => {
	it('reads the fixture', () => {
		const cyclones = parseCyclones(fixture);
		expect(cyclones.cyclones.map((c) => [c.name, c.basin, c.active, c.fixes.length])).toEqual([
			['03E', 'E', false, 5],
			['Dolly', 'L', true, 8],
			['Nida', 'W', true, 6],
		]);
		expect(cyclones.sourceCycle).toBe(Date.UTC(2026, 6, 15, 12));
	});

	it('rejects another major version or a broken envelope', () => {
		expect(() => parseCyclones({ ...fixture, schema_version: '9.0.0' })).toThrow();
		expect(() => parseCyclones({ ...fixture, cyclones: null })).toThrow();
		expect(() => parseCyclones(null)).toThrow();
	});

	it('drops malformed storms and fixes, keeps the rest', () => {
		const [dolly] = fixture.cyclones.filter((c) => c.name === 'Dolly');
		const broken = { ...dolly, track: [{ ...dolly.track[0], lat: 'x' }, dolly.track[1]] };
		const cyclones = parseCyclones({ ...fixture, cyclones: [broken, { ...dolly, basin: 'Z' }, { ...dolly, track: [] }] });
		expect(cyclones.cyclones.map((c) => c.fixes.length)).toEqual([1]);
	});
});

describe('cyclone position', () => {
	it('lies between the fixes around the time', () => {
		const sample = sampleCyclone(feed(true).cyclones[0], T0 + 3 * H);
		expect(sample?.lat).toBeCloseTo(-9.45, 2);
		expect(sample?.windKt).toBe(126);
		expect(sample).toMatchObject({ carried: false, fixTime: T0 });
	});

	it('is unknown before the first fix', () => {
		expect(sampleCyclone(feed(true).cyclones[0], T0 - 1)).toBeNull();
	});

	it('is carried along the last heading while the storm is active, 12 h at most', () => {
		const [cyclone] = feed(true).cyclones;
		const sample = sampleCyclone(cyclone, T0 + 12 * H);
		expect(sample).toMatchObject({ carried: true, fixTime: T0 + 6 * H, windKt: 128 });
		expect(sample?.lat).toBeCloseTo(-9.6 - (5 * 6 * 3.6) / 111.19, 2);
		expect(sample?.lon).toBeCloseTo(-163.8, 3);
		expect(sampleCyclone(cyclone, T0 + 6 * H + CARRY_MS)).not.toBeNull();
		expect(sampleCyclone(cyclone, T0 + 6 * H + CARRY_MS + 1)).toBeNull();
	});

	it('ends at the last fix once the storm is over', () => {
		const [cyclone] = feed(false).cyclones;
		expect(sampleCyclone(cyclone, T0 + 6 * H)).toMatchObject({ carried: false });
		expect(sampleCyclone(cyclone, T0 + 6 * H + 1)).toBeNull();
	});

	it('never joins fixes more than a day apart', () => {
		const [cyclone] = feed(true).cyclones;
		const apart = { ...cyclone, fixes: [cyclone.fixes[0], { ...cyclone.fixes[1], time: T0 + 30 * H }] };
		expect(sampleCyclone(apart, T0 + 3 * H)).toBeNull();
	});

	it('crosses the antimeridian the short way', () => {
		const [cyclone] = feed(true).cyclones;
		const fixes = [{ ...cyclone.fixes[0], lat: 10, lon: 179 }, { ...cyclone.fixes[1], lat: 10, lon: -179 }];
		expect(Math.abs(sampleCyclone({ ...cyclone, fixes }, T0 + 3 * H)?.lon ?? 0)).toBeCloseTo(180, 1);
	});
});

describe('cloud time', () => {
	const frames = [T0, T0 + H, T0 + 2 * H];
	it('follows the scene inside the frames and stops at the newest', () => {
		expect(cloudTime(T0 + 1.5 * H, frames)).toBe(T0 + 1.5 * H);
		expect(cloudTime(T0 + 3 * H, frames)).toBe(T0 + 2 * H);
		expect(cloudTime(T0 - H, frames)).toBe(T0);
		expect(cloudTime(T0 + 3 * H, [])).toBe(T0 + 3 * H);
	});
});

describe('cyclone words', () => {
	it('names the storm by wind and basin', () => {
		expect(cycloneKind('P', null)).toBe('Tropical cyclone');
		expect(cycloneKind('P', 30)).toBe('Tropical depression');
		expect(cycloneKind('L', 50)).toBe('Tropical storm');
		expect(cycloneKind('L', 100)).toBe('Hurricane');
		expect(cycloneKind('W', 100)).toBe('Typhoon');
		expect(cycloneKind('S', 100)).toBe('Cyclone');
		expect(windKmh(128)).toBe(235);
	});
});
