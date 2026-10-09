import { NoColorSpace, RepeatWrapping, type Texture, TextureLoader } from 'three';
import { liveBaseUrl } from '../live';

/** One cloud opacity map (equirectangular, red channel: 0 clear, 1 opaque) and its observation time. */
export interface CloudFrame {
	texture: Texture;
	/** Observation time in UTC milliseconds, for the HUD. */
	time: number;
}

/** GMGSI frame at the instant of the lightning fixtures; served by `fixtures/serve.py`. */
export const CLOUD_FIXTURE = {
	path: 'clouds/gmgsi_20260715T180000Z.webp',
	time: Date.UTC(2026, 6, 15, 18),
} as const;

export function cloudFixtureUrl(baseUrl: string = liveBaseUrl()): string {
	return new URL(CLOUD_FIXTURE.path, baseUrl).href;
}

export async function loadCloudFrame(url: string, time: number, loader = new TextureLoader()): Promise<CloudFrame> {
	const texture = await loader.loadAsync(url);
	texture.colorSpace = NoColorSpace;
	texture.wrapS = RepeatWrapping;
	return { texture, time };
}
