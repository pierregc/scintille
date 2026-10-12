import { CanvasTexture, LinearFilter, NoColorSpace } from 'three';
import type { CoverageMap, LiveManifest, Source } from '../../contract/types';
import { downSources, drawGaps, type Gap, gapAt, parseCoverage } from './map';

export { type Gap, gapAt } from './map';

export interface CoverageOptions {
	/** Live feed root; the map is at `<baseUrl>/live/coverage.geojson`. Must be absolute. */
	baseUrl: string;
	/** Mask width in pixels; the height is half. */
	width?: number;
	fetch?: typeof fetch;
	onError?: (error: unknown) => void;
	/** Canvas for the mask; a new DOM canvas by default. */
	canvas?: HTMLCanvasElement;
}

/** Areas without lightning data: the static no coverage area and the footprints of down sources. */
export interface Coverage {
	/** Equirectangular mask, red 1 in a gap; empty until the map is loaded. */
	readonly texture: CanvasTexture;
	/** Takes the source states of a new manifest; also retries loading the map if it failed. */
	setManifest(manifest: Pick<LiveManifest, 'sources'>): void;
	/** The gap at a point, or null where flashes can show (or the map is not loaded). */
	at(lat: number, lon: number): Gap | null;
	/** Resolves once the current load attempt is over. */
	ready(): Promise<void>;
	/** Whether the first load attempt is over, loaded or failed. */
	readonly settled: boolean;
	dispose(): void;
}

export function createCoverage({
	baseUrl,
	width = 2048,
	fetch: get = (i, o) => fetch(i, o),
	onError = () => {},
	canvas = document.createElement('canvas'),
}: CoverageOptions): Coverage {
	const url = new URL('live/coverage.geojson', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).href;
	canvas.width = width;
	canvas.height = width / 2;
	const ctx = canvas.getContext('2d');
	const texture = new CanvasTexture(canvas);
	texture.colorSpace = NoColorSpace;
	texture.minFilter = LinearFilter;
	texture.generateMipmaps = false;

	let map: CoverageMap | null = null;
	let down = new Set<Source>();
	let loading: Promise<void> | undefined;
	let disposed = false;
	let settled = false;

	const redraw = () => {
		if (!map || !ctx || disposed) return;
		drawGaps(ctx, map, down, canvas.width, canvas.height);
		texture.needsUpdate = true;
	};

	const load = () => {
		loading ??= (async () => {
			try {
				const response = await get(url);
				if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
				map = parseCoverage(await response.json());
				redraw();
			} catch (error) {
				if (!disposed) onError(error);
			} finally {
				settled = true;
				if (!map) loading = undefined;
			}
		})();
		return loading;
	};
	void load();

	return {
		texture,
		setManifest(manifest) {
			const next = downSources(manifest);
			const changed = next.size !== down.size || [...next].some((s) => !down.has(s));
			down = next;
			if (!map) void load();
			else if (changed) redraw();
		},
		at: (lat, lon) => (map ? gapAt(map, down, lat, lon) : null),
		ready: () => loading ?? Promise.resolve(),
		get settled() {
			return settled;
		},
		dispose() {
			disposed = true;
			texture.dispose();
		},
	};
}
