import { LiveClient, type LiveClientOptions } from './client';
import { FlashRing } from './ring';

export { FlashRing, type RingWatcher } from './ring';
export { LiveClient } from './client';
export { LIVE_DELAY_MS, LIVE_DELAYS, NO_DELAY, SourceDelays } from './delay';

/** Feed root: `PUBLIC_LIVE_BASE_URL`, else the fixture server in dev and R2 in production. */
export function liveBaseUrl(): string {
	const configured: unknown = import.meta.env.PUBLIC_LIVE_BASE_URL;
	if (typeof configured === 'string' && configured !== '') return new URL(configured, location.href).href;
	return import.meta.env.DEV ? 'http://localhost:8787/' : 'https://data.scintille.app/';
}

export interface LiveFeed {
	ring: FlashRing;
	client: LiveClient;
	stop(): void;
}

/** Starts polling the live feed into a new ring buffer. */
export function startLiveFeed(options: Partial<LiveClientOptions> = {}): LiveFeed {
	const ring = options.ring ?? new FlashRing();
	const client = new LiveClient({
		baseUrl: liveBaseUrl(),
		onError: (error) => console.warn('live feed:', error),
		...options,
		ring,
	});
	client.start();
	return { ring, client, stop: () => client.stop() };
}
