import { expect, it, vi } from 'vitest';
import { SearchRequests } from './search-client';

function deferred<T>() {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>(done => { resolve = done; });
	return { promise, resolve };
}
const result = { storms: [], schema_version: '2.5.0', query: { words: [], start: null, end: null, region: null, level: null }, generation: 'a'.repeat(64), current_generation: 'a'.repeat(64), published_at: '2026-10-18T00:00:00Z', catalog_checked_at: '2026-10-18T00:00:00Z', next_cursor: null, exhausted: true };

it('ignores a delayed response after another query even when fetch ignores abort', async () => {
	const a = deferred<Response>(), b = deferred<Response>();
	const fetchFn = vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
	const requests = new SearchRequests(fetchFn);
	const first = requests.load(new URLSearchParams('q=france'));
	const second = requests.load(new URLSearchParams('q=brazil'));
	b.resolve(Response.json(result)); expect(await second).toEqual(result);
	a.resolve(Response.json(result)); expect(await first).toBeNull();
	expect(fetchFn.mock.calls[0][1].signal.aborted).toBe(true);
});
it('cancels a pending response on close without a replay transition', async () => {
	const pending = deferred<Response>();
	const requests = new SearchRequests(vi.fn().mockReturnValue(pending.promise));
	const loading = requests.load(new URLSearchParams()); requests.cancel();
	pending.resolve(Response.json(result)); expect(await loading).toBeNull();
});
it('never retries errors automatically and bounds decoded response bytes', async () => {
	const fetchFn = vi.fn().mockResolvedValue(Response.json({ error: 'Catalog updated. Restart this search.' }, { status: 410 }));
	const requests = new SearchRequests(fetchFn);
	await expect(requests.load(new URLSearchParams())).rejects.toThrow('Restart');
	expect(fetchFn).toHaveBeenCalledOnce();
	const oversized = new SearchRequests(vi.fn().mockResolvedValue(new Response('x'.repeat(65537))));
	await expect(oversized.load(new URLSearchParams())).rejects.toThrow('too large');
});
