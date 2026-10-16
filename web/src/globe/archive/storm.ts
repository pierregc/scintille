import type { StormDetail } from '../../contract/types';
import { CONTRACT_MAJOR } from '../live/decode';
import { loadArchiveChunks, type ArchiveSource } from './index';

/** Fetches metadata once; its replay paths resolve against the public data root. */
export async function stormSource(
	baseUrl: string,
	slug: string,
	signal: AbortSignal,
	fetchFn: typeof fetch = fetch,
): Promise<{ detail: StormDetail; source: ArchiveSource }> {
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error('invalid storm slug');
	const root = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
	const url = new URL(`storms/${slug}.json`, root);
	const response = await fetchFn(url.href, { signal });
	if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
	const detail = await response.json() as StormDetail;
	const start = Date.parse(detail.storm?.t_start);
	const end = Date.parse(detail.storm?.t_end);
	if (Number(String(detail.schema_version).split('.')[0]) !== CONTRACT_MAJOR ||
		detail.storm?.slug !== slug || !Number.isFinite(start) || !Number.isFinite(end) || end < start ||
		!Array.isArray(detail.replay?.chunks) || !Number.isSafeInteger(detail.replay.flash_count) || detail.replay.flash_count < 0) {
		throw new Error('invalid storm replay metadata');
	}
	for (const ref of detail.replay.chunks) {
		if (typeof ref.path !== 'string' || !Number.isSafeInteger(ref.flash_count) || ref.flash_count < 0 ||
			!Number.isFinite(Date.parse(ref.start)) || !Number.isFinite(Date.parse(ref.end))) {
			throw new Error('invalid storm replay chunk');
		}
	}
	return {
		detail,
		source: {
			start,
			end,
			async load(abort) {
				const chunks = await loadArchiveChunks(root, detail.replay.chunks, abort, fetchFn);
				if (chunks.reduce((count, chunk) => count + chunk.count, 0) !== detail.replay.flash_count) {
					throw new Error('storm replay count mismatch');
				}
				return chunks;
			},
		},
	};
}
