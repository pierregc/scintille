import { describe, expect, it } from 'vitest';
import { breadcrumbs, liveDataset, serialize, stormArticle, website } from './jsonld';

describe('JSON-LD', () => {
	it('describes the site', () => {
		expect(website()).toMatchObject({ '@type': 'WebSite', name: 'Scintille', url: 'https://scintille.app/' });
	});

	it('describes the live dataset with its sources and credits', () => {
		const dataset = liveDataset();
		expect(dataset).toMatchObject({ '@type': 'Dataset', isAccessibleForFree: true });
		expect(String(dataset.description).length).toBeGreaterThan(50);
		expect(dataset.isBasedOn).toHaveLength(2);
		expect(dataset.creditText).toContain('NOAA');
		expect(dataset.creditText).toContain('EUMETSAT');
	});

	it('numbers breadcrumbs from 1 with absolute URLs', () => {
		const list = breadcrumbs([
			{ name: 'Home', path: '/' },
			{ name: 'Storms', path: '/storms/' },
		]);
		expect(list.itemListElement).toEqual([
			{ '@type': 'ListItem', position: 1, name: 'Home', item: 'https://scintille.app/' },
			{ '@type': 'ListItem', position: 2, name: 'Storms', item: 'https://scintille.app/storms/' },
		]);
	});

	it('describes a storm as an article about an event', () => {
		const article = stormArticle({
			headline: 'Storm over the Congo Basin',
			description: 'A night of lightning.',
			path: '/storms/2026-07-15-congo/',
			start: '2026-07-15T16:00:00Z',
			end: '2026-07-16T02:00:00Z',
			place: 'Congo Basin',
		});
		expect(article).toMatchObject({ '@type': 'Article', about: { '@type': 'Event', startDate: '2026-07-15T16:00:00Z' } });
	});

	it('cannot close the script tag', () => {
		expect(serialize({ name: '</script><script>alert(1)' })).not.toContain('</script>');
	});
});
