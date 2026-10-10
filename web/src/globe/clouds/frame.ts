import { NoColorSpace, RepeatWrapping, type Texture, TextureLoader } from 'three';

/** One cloud opacity map (equirectangular, red channel: 0 clear, 1 opaque) and its observation time. */
export interface CloudFrame {
	texture: Texture;
	/** Observation time in UTC milliseconds, for the HUD. */
	time: number;
}

export async function loadCloudFrame(url: string, time: number, loader = new TextureLoader()): Promise<CloudFrame> {
	const texture = await loader.loadAsync(url);
	texture.colorSpace = NoColorSpace;
	texture.wrapS = RepeatWrapping;
	return { texture, time };
}
