import { NoColorSpace, RepeatWrapping, type Texture, TextureLoader } from 'three';
import { boundedBody } from './response';
import { CLOUD_ARCHIVE_RULES } from '../../contract/cloud-archive';

/** One cloud opacity map (equirectangular, red channel: 0 clear, 1 opaque) and its observation time. */
export interface CloudFrame {
	texture: Texture;
	/** Observation time in UTC milliseconds, for the HUD. */
	time: number;
}

export async function loadCloudFrame(url: string, time: number, loader = new TextureLoader(), signal?: AbortSignal): Promise<CloudFrame> {
	const response = await fetch(url, { signal });
	if (!response.ok) throw new Error('cloud texture unavailable');
	const bytes = await boundedBody(response, CLOUD_ARCHIVE_RULES.max_frame_bytes);
	signal?.throwIfAborted();
	const objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/webp' }));
	let texture: Texture;
	try { texture = await loader.loadAsync(objectUrl); }
	finally { URL.revokeObjectURL(objectUrl); }
	if (signal?.aborted) { texture.dispose(); signal.throwIfAborted(); }
	texture.colorSpace = NoColorSpace;
	texture.wrapS = RepeatWrapping;
	return { texture, time };
}
