/** schema.org JSON-LD builders; each page passes its nodes to BaseLayout. */
export type JsonLd = Record<string, unknown>;

export const SITE_URL = 'https://scintille.app/';
const CONTEXT = 'https://schema.org';

const SOURCES = [
	{
		name: 'NOAA GOES Geostationary Lightning Mapper (GLM) L2 LCFA',
		url: 'https://www.goes-r.gov/spacesegment/glm.html',
		creditText: 'GLM data courtesy of NOAA',
	},
	{
		name: 'EUMETSAT MTG Lightning Imager (LI) Level 2',
		url: 'https://www.eumetsat.int/meteosat-third-generation',
		creditText: 'Contains modified EUMETSAT data',
	},
];

export function website(): JsonLd {
	return {
		'@context': CONTEXT,
		'@type': 'WebSite',
		name: 'Scintille',
		url: SITE_URL,
		description: 'Lightning across the planet, in near real time, on a globe seen from orbit.',
		inLanguage: 'en',
	};
}

/** The live flash feed: one hour of normalized flashes from GLM and LI, refreshed every 30 seconds. */
export function liveDataset(): JsonLd {
	return {
		'@context': CONTEXT,
		'@type': 'Dataset',
		name: 'Scintille live lightning flashes',
		description:
			'Lightning flashes detected from geostationary orbit by NOAA GOES GLM and EUMETSAT MTG LI, normalized to one schema (time, position, optical energy, area, duration, quality) and published as 30-second chunks covering the last hour.',
		url: SITE_URL,
		isAccessibleForFree: true,
		keywords: ['lightning', 'GOES GLM', 'MTG Lightning Imager', 'near real time'],
		spatialCoverage: {
			'@type': 'Place',
			name: 'Americas, Europe, Africa and the Atlantic Ocean (GOES-East, GOES-West and MTG fields of view)',
		},
		creator: { '@type': 'Organization', name: 'Scintille', url: SITE_URL },
		isBasedOn: SOURCES.map((s) => ({ '@type': 'Dataset', name: s.name, url: s.url })),
		creditText: SOURCES.map((s) => s.creditText).join('. '),
		distribution: [
			{
				'@type': 'DataDownload',
				encodingFormat: 'application/json',
				contentUrl: 'https://data.scintille.app/live/manifest.json',
			},
		],
	};
}

export interface Crumb {
	name: string;
	path: string;
}

export function breadcrumbs(crumbs: Crumb[]): JsonLd {
	return {
		'@context': CONTEXT,
		'@type': 'BreadcrumbList',
		itemListElement: crumbs.map((c, i) => ({
			'@type': 'ListItem',
			position: i + 1,
			name: c.name,
			item: new URL(c.path, SITE_URL).href,
		})),
	};
}

export interface StormArticle {
	headline: string;
	description: string;
	path: string;
	/** ISO 8601. */
	start: string;
	end: string;
	place: string;
	image?: string;
}

/** Storm pages (#88): an Article about the storm, with its time span and place. */
export function stormArticle(storm: StormArticle): JsonLd {
	const url = new URL(storm.path, SITE_URL).href;
	return {
		'@context': CONTEXT,
		'@type': 'Article',
		headline: storm.headline,
		description: storm.description,
		url,
		mainEntityOfPage: url,
		datePublished: storm.end,
		image: storm.image ? new URL(storm.image, SITE_URL).href : undefined,
		author: { '@type': 'Organization', name: 'Scintille', url: SITE_URL },
		about: {
			'@type': 'Event',
			name: storm.headline,
			startDate: storm.start,
			endDate: storm.end,
			location: { '@type': 'Place', name: storm.place },
		},
	};
}

/** Serializes for a `<script type="application/ld+json">`, safe against `</script>` in strings. */
export function serialize(nodes: JsonLd | JsonLd[]): string {
	return JSON.stringify(nodes).replace(/</g, '\\u003c');
}
