import { describe, expect, it } from 'vitest';
import { cloudTime, cycloneKind, parseCycloneFeed, sampleCyclone, windKmh } from './track';

const H = 3_600_000;
const T0 = Date.UTC(2026, 10, 17, 12);
const feed = (generatedAt: number) => parseCycloneFeed({
	generated_at: new Date(generatedAt).toISOString(),
	attribution: 'NOAA',
	cyclones: [{
		id: '20261115-04p', name: 'Xavier', basin: 'P', agency: 'JTWC',
		track: [
			[T0 / 1000, -9.3, -163.8, 124, 130, 250, 2.1],
			[(T0 + 6 * H) / 1000, -9.6, -163.8, 128, 128, 180, 5],
		],
	}],
});

describe('cyclone track', () => {
	it('places a cyclone between its fixes', () => {
		const sample = sampleCyclone(feed(T0 + 8 * H).cyclones[0], T0 + 3 * H);
		expect(sample?.lat).toBeCloseTo(-9.45, 2);
		expect(sample?.windKt).toBe(126);
		expect(sample).toMatchObject({ carried: false, fixTime: T0 });
	});

	it('is absent before the first fix', () => {
		expect(sampleCyclone(feed(T0 + 8 * H).cyclones[0], T0 - 1)).toBeNull();
	});

	it('carries an active cyclone along its heading, for 12 h at most', () => {
		const [cyclone] = feed(T0 + 8 * H).cyclones;
		const sample = sampleCyclone(cyclone, T0 + 12 * H);
		expect(sample?.carried).toBe(true);
		expect(sample?.lat).toBeCloseTo(-9.6 - (5 * 6 * 3.6) / 111.19, 2);
		expect(sample?.lon).toBeCloseTo(-163.8, 3);
		expect(sampleCyclone(cyclone, T0 + 19 * H)).toBeNull();
	});

	it('ends a finished cyclone at its last fix', () => {
		const [cyclone] = feed(T0 + 48 * H).cyclones;
		expect(sampleCyclone(cyclone, T0 + 6 * H)).not.toBeNull();
		expect(sampleCyclone(cyclone, T0 + 7 * H)).toBeNull();
	});

	it('rejects a malformed feed', () => {
		expect(() => parseCycloneFeed({ cyclones: [] })).toThrow();
		expect(() => parseCycloneFeed({ generated_at: '2026-11-21T00:00:00Z', cyclones: [{ id: 'x', name: 'X', basin: 'P', track: [[1, 2]] }] })).toThrow();
	});
});

describe('cloud time', () => {
	const frames = [T0, T0 + H, T0 + 2 * H];
	it('follows the scene inside the frames and stops at the newest', () => {
		expect(cloudTime(T0 + 1.5 * H, frames)).toBe(T0 + 1.5 * H);
		expect(cloudTime(T0 + 3 * H, frames)).toBe(T0 + 2 * H);
		expect(cloudTime(T0 + 3 * H, [])).toBe(T0 + 3 * H);
	});
});

describe('cyclone words', () => {
	it('names the storm by wind and basin', () => {
		expect(cycloneKind('P', 30)).toBe('Tropical depression');
		expect(cycloneKind('L', 50)).toBe('Tropical storm');
		expect(cycloneKind('L', 100)).toBe('Hurricane');
		expect(cycloneKind('W', 100)).toBe('Typhoon');
		expect(cycloneKind('S', 100)).toBe('Cyclone');
		expect(windKmh(128)).toBe(235);
	});
});
