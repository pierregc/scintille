import { NoColorSpace, RepeatWrapping, type Texture, TextureLoader } from 'three';
import { boundedBody } from './response';

/** One cloud opacity map (equirectangular, red channel: 0 clear, 1 opaque) and its observation time. */
export interface CloudFrame {
	texture: Texture;
	/** Observation time in UTC milliseconds, for the HUD. */
	time: number;
}

export async function loadCloudFrame(url: string, time: number, loader = new TextureLoader(), signal?: AbortSignal): Promise<CloudFrame> {
	let texture: Texture;
	if (signal) {
		const response = await fetch(url, { signal });
		if (!response.ok) throw new Error('cloud texture unavailable');
		const blob = new Blob([await boundedBody(response, 16 * 1024 * 1024)]);
		const objectUrl = URL.createObjectURL(blob);
		try { texture = await loader.loadAsync(objectUrl); }
		finally { URL.revokeObjectURL(objectUrl); }
		if (signal.aborted) { texture.dispose(); signal.throwIfAborted(); }
	} else texture = await loader.loadAsync(url);
	texture.colorSpace = NoColorSpace;
	texture.wrapS = RepeatWrapping;
	return { texture, time };
}
