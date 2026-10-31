import type { StormDetail } from '../../contract/types';
import { CONTRACT_MAJOR } from '../live/decode';
import { loadArchiveChunks, type ArchiveSource } from './index';
import { boundedBody } from '../clouds/response';
import { stormCap } from '../replay/framing';

export const REPLAY_LIMITS = { metadataBytes: 256 * 1024, flashes: 1_000_000, storedBytes: 64 * 1024 * 1024 };
/** The `storms/chunks/` lifecycle rule; chunks are written after the storm starts, so never deleted before this. */
export const REPLAY_RETENTION_DAYS = 60;

export class ReplayExpiredError extends Error {
	constructor() { super('storm replay expired'); }
}

/** Where a replay's data starts: the earliest flash its chunks hold, which may be after the catalog's `t_start`. */
export function replayStart(detail: StormDetail): number {
	let earliest = Infinity;
	for (const chunk of detail.replay.chunks) {
		if (chunk.flash_count === 0) continue;
		const time = Date.parse(chunk.event_min ?? chunk.start);
		if (time < earliest) earliest = time;
	}
	return Number.isFinite(earliest) ? earliest : Date.parse(detail.storm.t_start);
}

/** Fetches metadata once; its replay paths resolve against the public data root. */
export async function stormSource(
	baseUrl: string,
	slug: string,
	signal: AbortSignal,
	fetchFn: typeof fetch = fetch,
	now?: number,
): Promise<{ detail: StormDetail; source: ArchiveSource }> {
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error('invalid storm slug');
	const root = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
	const url = new URL(`storms/${slug}.json`, root);
	const response = await fetchFn(url.href, { signal });
	if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
	const detail = JSON.parse(new TextDecoder().decode(await boundedBody(response, REPLAY_LIMITS.metadataBytes))) as StormDetail;
	const start = Date.parse(detail.storm?.t_start);
	const end = Date.parse(detail.storm?.t_end);
	if (Number(String(detail.schema_version).split('.')[0]) !== CONTRACT_MAJOR ||
		detail.storm?.slug !== slug || !Number.isFinite(start) || !Number.isFinite(end) || end < start ||
		!Array.isArray(detail.replay?.chunks) || !Number.isSafeInteger(detail.replay.flash_count) || detail.replay.flash_count < 0) {
		throw new Error('invalid storm replay metadata');
	}
	stormCap(detail.bounds ?? {} as StormDetail['bounds']);
	if (!Array.isArray(detail.track)) throw new Error('invalid storm track');
	if (detail.replay.flash_count > REPLAY_LIMITS.flashes) throw new Error('storm replay is too large');
	let storedBytes = 0;
	let flashes = 0;
	for (const ref of detail.replay.chunks) {
		if (!/^storms\/chunks\/[a-f0-9]{64}\.bin\.gz$/.test(ref.path) || !Number.isSafeInteger(ref.flash_count) || ref.flash_count < 0 ||
			!Number.isSafeInteger(ref.size_bytes) || ref.size_bytes < 1 ||
			!Number.isFinite(Date.parse(ref.start)) || !Number.isFinite(Date.parse(ref.end)) || Date.parse(ref.end) <= Date.parse(ref.start)) {
			throw new Error('invalid storm replay chunk');
		}
		storedBytes += ref.size_bytes;
		flashes += ref.flash_count;
	}
	if (storedBytes > REPLAY_LIMITS.storedBytes) throw new Error('storm replay is too large');
	if (flashes !== detail.replay.flash_count) throw new Error('invalid storm replay count');
	return {
		detail,
		source: {
			start: replayStart(detail),
			end,
			async load(abort) {
				let chunks;
				try {
					chunks = await loadArchiveChunks(root, detail.replay.chunks, abort, fetchFn);
				} catch (error) {
					if (!abort.aborted && now !== undefined && now - start > REPLAY_RETENTION_DAYS * 86_400_000) throw new ReplayExpiredError();
					throw error;
				}
				if (chunks.reduce((count, chunk) => count + chunk.count, 0) !== detail.replay.flash_count) {
					throw new Error('storm replay count mismatch');
				}
				return chunks;
			},
		},
	};
}
