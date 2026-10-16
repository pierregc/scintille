/** Texture tiers published under `live/clouds/<tier>/` (docs/data-contract.md). */
export type CloudTier = '2k' | '4k';

export interface CloudTexture {
	path: string;
	width: number;
	height: number;
	size_bytes: number;
}

export interface CloudFrameRef {
	time: string;
	published_at: string;
	product: string;
	reference: string;
	textures: Partial<Record<CloudTier, CloudTexture>>;
}

export interface CloudManifest {
	generated_at: string;
	window_seconds: number;
	attribution: string;
	/** Oldest first. */
	frames: CloudFrameRef[];
}

/** A frame to load: its observation time (UTC ms) and texture URL for one tier. */
export interface CloudFrameSource {
	time: number;
	url: string;
}

export class CloudManifestError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** Checks the fields the client relies on; throws `CloudManifestError` otherwise. */
export function parseCloudManifest(json: unknown): CloudManifest {
	if (!isRecord(json) || !Array.isArray(json.frames) || typeof json.attribution !== 'string') {
		throw new CloudManifestError('cloud manifest: missing frames or attribution');
	}
	for (const frame of json.frames as unknown[]) {
		if (!isRecord(frame) || Number.isNaN(Date.parse(String(frame.time))) || !isRecord(frame.textures)) {
			throw new CloudManifestError('cloud manifest: invalid frame');
		}
	}
	return json as unknown as CloudManifest;
}

/** The newest `count` frames that have `tier`, oldest first, with absolute texture URLs. */
export function frameSources(
	manifest: Pick<CloudManifest, 'frames'>,
	tier: CloudTier,
	manifestUrl: string,
	count: number,
): CloudFrameSource[] {
	const sources = manifest.frames
		.filter((f) => typeof f.textures[tier]?.path === 'string')
		.map((f) => ({ time: Date.parse(f.time), url: new URL(f.textures[tier]?.path ?? '', manifestUrl).href }))
		.sort((a, b) => a.time - b.time);
	return sources.slice(Math.max(0, sources.length - count));
}
