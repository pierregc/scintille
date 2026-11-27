import { Map as MapLibreMap, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { type PerspectiveCamera, Vector2 } from 'three';
import { surfacePoint } from '../coverage/label';
import { mapCamera } from './camera';
import { darkStyle, gridStyle } from './style';

export interface MapLayer {
	/** Moves the map to the scene camera and draws it; false while it has nothing to show or the view looks past the globe. */
	sync(camera: PerspectiveCamera, heightPx: number): boolean;
	/** Largest gap in CSS pixels between where the map and the scene put the same ground points. */
	mismatch(camera: PerspectiveCamera, radius: number): number;
	readonly map: MapLibreMap;
	dispose(): void;
}

interface Options {
	container: HTMLElement;
	radius: number;
	/** Offline grid instead of the tile host. */
	grid: boolean;
	onError(error: unknown): void;
}

/** MapLibre keeps its centre within the Web Mercator latitudes. */
const MAX_LATITUDE = 85;

export function createMapLayer({ container, radius, grid, onError }: Options): MapLayer {
	setWorkerUrl(workerUrl);
	const map = new MapLibreMap({
		container,
		style: grid ? gridStyle() : darkStyle(),
		interactive: false,
		maxPitch: 180,
		fadeDuration: 0,
		renderWorldCopies: false,
		attributionControl: { compact: false },
	});
	// Shown once the host has answered with a first tile, so a slow or dead host leaves the globe as it was.
	let ready = grid;
	map.on('data', (event) => {
		if ('tile' in event && event.tile) ready = true;
	});
	map.on('error', (event) => onError(event.error));

	return {
		map,
		sync(camera, heightPx) {
			container.hidden = !ready;
			const view = mapCamera(camera.position, camera.quaternion, radius, camera.fov, heightPx);
			if (!view || Math.abs(view.lat) > MAX_LATITUDE) container.hidden = true;
			if (container.hidden || !view) return false;
			if (map.getVerticalFieldOfView() !== camera.fov) map.setVerticalFieldOfView(camera.fov);
			map.jumpTo({ center: [view.lng, view.lat], zoom: view.zoom, pitch: view.pitch, bearing: view.bearing, roll: view.roll });
			map.redraw();
			return true;
		},
		mismatch(camera, radius) {
			const { clientWidth: width, clientHeight: height } = container;
			let worst = 0;
			for (let y = -0.9; y <= 0.9; y += 0.3) {
				for (let x = -0.9; x <= 0.9; x += 0.3) {
					const ground = surfacePoint(new Vector2(x, y), camera, radius);
					if (!ground) continue;
					const shown = map.project([ground.lon, ground.lat]);
					worst = Math.max(worst, Math.hypot(shown.x - ((x + 1) / 2) * width, shown.y - ((1 - y) / 2) * height));
				}
			}
			return worst;
		},
		dispose() {
			map.remove();
		},
	};
}
