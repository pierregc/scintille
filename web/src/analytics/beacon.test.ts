import { describe, expect, it } from 'vitest';
import { beaconConfig } from './beacon';

describe('beaconConfig', () => {
	it('is off without a token', () => {
		expect(beaconConfig(undefined)).toBeNull();
		expect(beaconConfig('')).toBeNull();
		expect(beaconConfig('  ')).toBeNull();
	});

	it('rejects anything but a 32-character hex token', () => {
		expect(beaconConfig('abc')).toBeNull();
		expect(beaconConfig('"}<script>alert(1)</script>{"0123456789abcdef')).toBeNull();
	});

	it('serializes a valid token', () => {
		const token = 'aB'.repeat(16);
		expect(beaconConfig(` ${token} `)).toBe(`{"token":"${token}"}`);
	});
});
