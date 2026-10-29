import { describe, expect, it } from 'vitest';
import { approximateLocation } from './location';

describe('approximate IP location', () => {
	it('returns a rounded city location without time zone or postal code', () => {
		const geo = { city: 'Lyon', region: 'Auvergne-Rhône-Alpes', country: 'FR', latitude: '45.74846', longitude: '4.84671', timezone: 'Europe/Paris', postalCode: '69007' };
		expect(approximateLocation(geo)).toEqual({ status: 'approximate', source: 'ip', lat: 45.7, lon: 4.8, city: 'Lyon', region: 'Auvergne-Rhône-Alpes', country_code: 'FR' });
	});

	it('is unavailable with a country alone, missing or impossible coordinates', () => {
		for (const geo of [undefined, null, {}, { country: 'FR', latitude: '46.2', longitude: '2.2' }, { city: 'Lyon', country: 'FR' },
			{ city: 'Lyon', latitude: 'x', longitude: '4.8' }, { city: 'Lyon', latitude: '95', longitude: '4.8' }, { city: 'Null Island', latitude: '0', longitude: '0' }]) {
			expect(approximateLocation(geo)).toEqual({ status: 'unavailable', source: 'ip' });
		}
	});

	it('drops unknown and Tor country codes', () => {
		expect(approximateLocation({ city: 'X', country: 'T1', latitude: '1', longitude: '1' })).toMatchObject({ country_code: null, region: null });
	});
});
