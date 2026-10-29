import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { LiveManifest, SourceState } from '../../contract/types';
import { LiveClient } from '../live/client';
import { FlashRing } from '../live/ring';
import { FakeFeed, FakeVisibility } from '../live/testing';
import { createCoverage } from '.';

const FIXTURES = new URL('../../../../fixtures/live/', import.meta.url);

/** Serves the fixture coverage map next to a manifest whose GLM West state can change. */
class OutageFeed extends FakeFeed {
	west: SourceState = 'live';
	coverage = '';

	override manifest(): LiveManifest {
		const status = (source: 'glm-east' | 'glm-west', state: SourceState) => ({
			source,
			state,
			last_event_time: null,
			last_ingest_time: null,
		});
		return { ...super.manifest(), sources: [status('glm-east', 'live'), status('glm-west', this.west)] };
	}

	/** `fetch` plus the coverage map. */
	serve: typeof fetch = async (input, init) => {
		if (!String(input).endsWith('/live/coverage.geojson')) return this.fetch(input, init);
		this.requests.push(String(input));
		return this.failing ? new Response('down', { status: 503 }) : new Response(this.coverage);
	};
}

class FakeCanvas {
	width = 0;
	height = 0;
	getContext() {
		return { fillStyle: '', beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, clearRect() {}, fill() {} };
	}
}

async function outageFeed(): Promise<OutageFeed> {
	const feed = new OutageFeed();
	feed.coverage = await readFile(new URL('coverage.geojson', FIXTURES), 'utf8');
	return feed;
}

describe('createCoverage', () => {
	it('marks only the no coverage area, whatever the source states', async () => {
		const feed = await outageFeed();
		await feed.publish(1_784_138_400, 30, 2);
		const coverage = createCoverage({
			baseUrl: 'https://data.example/',
			fetch: feed.serve,
			canvas: new FakeCanvas() as unknown as HTMLCanvasElement,
		});
		feed.west = 'offline';
		const client = new LiveClient({
			baseUrl: 'https://data.example/',
			ring: new FlashRing(100),
			fetch: feed.serve,
			visibility: new FakeVisibility(),
			pollIntervalMs: 1e9,
			onManifest: () => coverage.retry(),
		});
		client.start();
		await client.idle();
		await coverage.ready();
		expect(coverage.at(20, -160)).toBe(false);
		expect(coverage.at(30, 100)).toBe(true);
		client.stop();
	});

	it('retries the map on the next manifest after a failed load', async () => {
		const feed = await outageFeed();
		feed.failing = true;
		const errors: unknown[] = [];
		const coverage = createCoverage({
			baseUrl: 'https://data.example',
			fetch: feed.serve,
			canvas: new FakeCanvas() as unknown as HTMLCanvasElement,
			onError: (error) => errors.push(error),
		});
		await coverage.ready();
		expect(errors).toHaveLength(1);
		expect(coverage.at(30, 100)).toBe(false);

		feed.failing = false;
		coverage.retry();
		await coverage.ready();
		expect(coverage.at(30, 100)).toBe(true);
	});
});
