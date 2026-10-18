import type { StormSearchResponse } from '../contract/types';
import { boundedBody } from '../globe/clouds/response';
import { parseRecord } from './search-store';

export class SearchRequests {
	#revision = 0;
	#request?: AbortController;
	constructor(readonly fetchFn: typeof fetch = fetch) {}
	cancel() { this.#revision++; this.#request?.abort(); this.#request = undefined; }
	async load(params: URLSearchParams): Promise<StormSearchResponse | null> {
		this.cancel();
		const revision = this.#revision;
		const controller = new AbortController(); this.#request = controller;
		try {
			const response = await this.fetchFn(`/api/storms/search?${params}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
			const value: unknown = JSON.parse(new TextDecoder().decode(await boundedBody(response, 65536)));
			if (!response.ok) throw new Error(typeof value === 'object' && value && 'error' in value ? String(value.error) : 'The storm catalog is unavailable. Try Refresh.');
			const result = value as StormSearchResponse;
			if (!result || !Array.isArray(result.storms) || result.storms.length > 20 || typeof result.exhausted !== 'boolean' ||
				!Number.isFinite(Date.parse(result.catalog_checked_at)) || !Number.isFinite(Date.parse(result.published_at)) ||
				!result.query || !/^[a-f0-9]{64}$/.test(result.generation) || !/^[a-f0-9]{64}$/.test(result.current_generation) ||
				!(result.next_cursor === null || (typeof result.next_cursor === 'string' && result.next_cursor.length <= 1024)) ||
				result.exhausted === Boolean(result.next_cursor)) throw new Error('The storm catalog returned invalid data.');
			result.storms.forEach(parseRecord);
			return revision === this.#revision && !controller.signal.aborted ? result : null;
		} catch (error) {
			if (revision !== this.#revision || controller.signal.aborted) return null;
			throw error;
		}
	}
}
