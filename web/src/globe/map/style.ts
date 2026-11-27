import type { LayerSpecification, StyleSpecification } from 'maplibre-gl';

const HOST = 'https://tiles.openfreemap.org';
const INK = 'rgb(238 242 247)';
const LAND = '#0c1119';
const WATER = '#05070b';
const FONT = ['Noto Sans Regular'];

const name = ['coalesce', ['get', 'name:latin'], ['get', 'name']];

function label(id: string, filter: unknown[], minzoom: number, size: unknown, opacity: number, maxzoom = 24): LayerSpecification {
	return {
		id,
		type: 'symbol',
		source: 'openmaptiles',
		'source-layer': 'place',
		minzoom,
		maxzoom,
		filter,
		layout: { 'text-field': name, 'text-font': FONT, 'text-size': size, 'text-letter-spacing': 0.04, 'text-max-width': 8 },
		paint: { 'text-color': INK, 'text-opacity': opacity, 'text-halo-color': 'rgb(4 8 18 / 0.85)', 'text-halo-width': 1.2 },
	} as LayerSpecification;
}

function road(id: string, classes: string[], minzoom: number, width: unknown, opacity: number): LayerSpecification {
	return {
		id,
		type: 'line',
		source: 'openmaptiles',
		'source-layer': 'transportation',
		minzoom,
		filter: ['in', ['get', 'class'], ['literal', classes]],
		layout: { 'line-cap': 'round', 'line-join': 'round' },
		paint: { 'line-color': INK, 'line-opacity': opacity, 'line-width': width },
	} as LayerSpecification;
}

function border(id: string, levels: number[], minzoom: number, width: number, opacity: number, dash?: number[]): LayerSpecification {
	return {
		id,
		type: 'line',
		source: 'openmaptiles',
		'source-layer': 'boundary',
		minzoom,
		filter: ['all', ['in', ['get', 'admin_level'], ['literal', levels]], ['!=', ['get', 'maritime'], 1]],
		paint: { 'line-color': INK, 'line-opacity': opacity, 'line-width': width, ...(dash ? { 'line-dasharray': dash } : {}) },
	} as LayerSpecification;
}

/** Dark map on the OpenFreeMap public tiles (OpenMapTiles schema): water, borders, roads and place names only. */
export function darkStyle(): StyleSpecification {
	return {
		version: 8,
		projection: { type: 'vertical-perspective' },
		glyphs: `${HOST}/fonts/{fontstack}/{range}.pbf`,
		sources: { openmaptiles: { type: 'vector', url: `${HOST}/planet` } },
		layers: [
			{ id: 'land', type: 'background', paint: { 'background-color': LAND } },
			{ id: 'water', type: 'fill', source: 'openmaptiles', 'source-layer': 'water', paint: { 'fill-color': WATER } },
			{
				id: 'rivers',
				type: 'line',
				source: 'openmaptiles',
				'source-layer': 'waterway',
				minzoom: 8,
				paint: { 'line-color': WATER, 'line-width': 1.2 },
			},
			road('roads-minor', ['minor', 'tertiary', 'secondary'], 10, ['interpolate', ['linear'], ['zoom'], 10, 0.4, 14, 1.2], 0.1),
			road('roads-main', ['primary', 'trunk'], 7, ['interpolate', ['linear'], ['zoom'], 7, 0.4, 14, 1.6], 0.16),
			road('motorways', ['motorway'], 5, ['interpolate', ['linear'], ['zoom'], 5, 0.4, 14, 2], 0.24),
			border('municipalities', [7, 8], 9, 0.6, 0.22, [3, 3]),
			border('regions', [3, 4, 5, 6], 3, 0.6, 0.22),
			border('countries', [2], 0, 1, 0.45),
			label('villages', ['in', ['get', 'class'], ['literal', ['village', 'hamlet']]], 10, 11, 0.6),
			label('towns', ['==', ['get', 'class'], 'town'], 7, ['interpolate', ['linear'], ['zoom'], 7, 10, 12, 13], 0.75),
			label('cities', ['==', ['get', 'class'], 'city'], 3, ['interpolate', ['linear'], ['zoom'], 3, 10, 12, 16], 0.9),
			label('countries-names', ['==', ['get', 'class'], 'country'], 1, ['interpolate', ['linear'], ['zoom'], 1, 10, 5, 14], 0.7, 6),
		],
	};
}

/** No tile host: land and a 10 degree grid, to check the camera match offline. */
export function gridStyle(): StyleSpecification {
	const lines: number[][][] = [];
	for (let lon = -180; lon < 180; lon += 10) lines.push(Array.from({ length: 171 }, (_, i) => [lon, i - 85]));
	for (let lat = -80; lat <= 80; lat += 10) lines.push(Array.from({ length: 361 }, (_, i) => [i - 180, lat]));
	return {
		version: 8,
		projection: { type: 'vertical-perspective' },
		sources: { grid: { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: lines } } } },
		layers: [
			{ id: 'land', type: 'background', paint: { 'background-color': LAND } },
			{ id: 'grid', type: 'line', source: 'grid', paint: { 'line-color': INK, 'line-opacity': 0.3, 'line-width': 1 } },
		],
	};
}
