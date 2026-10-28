import { afterEach, describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { atmosphereParameters } from '../atmosphere';
import { cloudShellRadius } from '../clouds';
import { createGlobeControls } from '../controls';
import { CLOUD_TOP_KM } from '../lightning';
import { CAMERA_FLOOR_KM, kmToWorld, worldToKm } from '../flight';
import { clipPlanes } from '../orbit';
import { latLonToVector } from '../sun';
import { framingFixtures, scatterDegrees, TRACK_STEP_MS, trackAt } from '../../../scripts/framing-fixtures';
import { stormSource } from '../archive/storm';
import { parseCatalogPage } from './catalog';
import { frameStorm, GRAZE, grazeStorm, REPLAY_FRAME } from './framing';
import cases from './framing-cases.json';
import { trackGeometry } from './track';
import { decodeChunk, CHUNK_SCALES } from '../live/decode';
import { gunzipSync } from 'node:zlib';

it('keeps five explicitly synthetic reproducible cases with desktop and portrait poses', () => {
	expect(cases).toHaveLength(5);
	for (const item of cases) {
		for (const aspect of [16 / 9, 9 / 16]) {
			const view = frameStorm(item.bounds, 35, aspect);
			expect(view.duration).toBeLessThan(4000);
			expect(view.tilt).toBeLessThanOrEqual(REPLAY_FRAME.tilt);
			expect(view.altitude).toBeGreaterThanOrEqual(400);
		}
	}
});

describe('Preview calibration extracts', () => {
	it('uses the production loader and contains flashes along the declared track', async () => {
		const files = framingFixtures();
		const fetchFn: typeof fetch = async (input) => {
			const body = files.get(new URL(String(input)).pathname.slice(1));
			return body ? new Response(new Uint8Array(body)) : new Response('', { status: 404 });
		};
		for (const item of cases.slice(1)) {
			const { detail, source } = await stormSource('https://fixture.test/', item.slug, new AbortController().signal, fetchFn);
			const chunks = await source.load(new AbortController().signal);
			expect(chunks[0].count).toBe(detail.replay.flash_count);
			expect(detail.storm.level_rule).toBe('synthetic-fixture-only');
			expect(detail.storm.label).toContain('Synthetic');
			const geometry = trackGeometry(detail.track, 1);
			expect(geometry.times).toHaveLength(4);
			const file = files.get(detail.replay.chunks[0].path);
			if (!file) throw new Error('missing fixture');
			const raw = new Uint8Array(gunzipSync(file));
			const decoded = decodeChunk(raw.buffer);
			expect(decoded.count).toBeGreaterThanOrEqual(400);
			const { west, east, south, north } = item.bounds;
			const width = east >= west ? east - west : east + 360 - west;
			const reach = 4 * scatterDegrees(item.bounds) + 0.01;
			const perMinute = new Map<number, number>();
			for (let i = 0; i < decoded.count; i++) {
				const offset = decoded.columns.event_offset_ms[i];
				if (i > 0) expect(offset).toBeGreaterThanOrEqual(decoded.columns.event_offset_ms[i - 1]);
				perMinute.set(Math.floor(offset / 60_000), (perMinute.get(Math.floor(offset / 60_000)) ?? 0) + 1);
				const lat = decoded.columns.lat[i] * CHUNK_SCALES.lat;
				const lon = decoded.columns.lon[i] * CHUNK_SCALES.lon;
				expect(lat).toBeGreaterThanOrEqual(south - 0.01);
				expect(lat).toBeLessThanOrEqual(north + 0.01);
				expect((((lon - west + 0.01) % 360) + 360) % 360).toBeLessThanOrEqual(width + 0.02);
				const [cLat, cLon] = trackAt(item.points, offset);
				expect(Math.abs(lat - cLat)).toBeLessThan(reach);
				expect(Math.abs((((lon - cLon + 540) % 360) - 180))).toBeLessThan(reach);
			}
			expect(perMinute.size).toBeGreaterThan(40);
			expect(detail.storm.peak_rate).toBe(Math.max(...perMinute.values()));
			expect(detail.track.reduce((sum, point) => sum + point.flash_count, 0)).toBe(decoded.count);
		}
		const page = files.get('storms/index/0.json');
		expect(parseCatalogPage(JSON.parse(new TextDecoder().decode(page)), 0).storms).toHaveLength(5);
	});
});

function cameraRig(aspect: number, reducedMotion = false) {
	vi.stubGlobal('window', { matchMedia: () => ({ matches: reducedMotion }) });
	const listeners = new Map<string, ((event: unknown) => void)[]>();
	const doc = { addEventListener() {}, removeEventListener() {} };
	const element = {
		addEventListener: (type: string, listener: (event: unknown) => void) =>
			listeners.set(type, [...(listeners.get(type) ?? []), listener]),
		removeEventListener() {}, style: {}, clientHeight: 810,
		getRootNode: () => doc, ownerDocument: doc, setPointerCapture() {}, releasePointerCapture() {},
	};
	let time = 0;
	const camera = new PerspectiveCamera(35, aspect, 1e-5, 100);
	const controls = createGlobeControls(camera, element as unknown as HTMLElement, 1, { now: () => time });
	controls.resize();
	return { camera, controls,
		step: (ms: number) => { time += ms; controls.update(time); },
		fire: (type: string) => {
			for (const listener of listeners.get(type) ?? []) listener({ pointerId: 1, pointerType: 'mouse', button: 2,
				clientX: 0, clientY: 0, deltaY: 0, deltaMode: 0, preventDefault() {} });
		},
	};
}

describe('calibration poses after real control limits', () => {
	afterEach(() => vi.unstubAllGlobals());

	it.each(cases.flatMap((item) => [16 / 9, 9 / 16].map((aspect) => ({ ...item, aspect }))))(
		'keeps the full $slug extent and trajectory inside the safe viewport at aspect $aspect', async (item) => {
			const rig = cameraRig(item.aspect);
			try {
				const destination = frameStorm(item.bounds, 35, item.aspect);
				const flight = rig.controls.flyTo(destination);
				let arrived = false;
				void flight.then(() => { arrived = true; });
				rig.step(destination.duration - 1);
				await Promise.resolve();
				expect(arrived).toBe(false);
				rig.step(1);
				await expect(flight).resolves.toBe(true);
				const settled = rig.camera.position.clone();
				rig.step(16);
				expect(rig.camera.position.distanceTo(settled)).toBeLessThan(1e-6);
				expect(rig.controls.view().altitude).toBeCloseTo(destination.altitude, 3);
				expect(rig.controls.view().tilt).toBeCloseTo(destination.tilt, 3);
				const { near, far } = clipPlanes(rig.camera.position.length(), 1, [cloudShellRadius(1), 1 + kmToWorld(CLOUD_TOP_KM, 1), atmosphereParameters(1).atmosphereRadius]);
				rig.camera.near = near;
				rig.camera.far = far;
				rig.camera.updateProjectionMatrix();
				rig.camera.updateMatrixWorld();
				const check = (point: Vector3) => {
					const projected = point.clone().project(rig.camera);
					expect(projected.z).toBeGreaterThan(-1);
					expect(projected.z).toBeLessThan(1);
					expect(Math.max(Math.abs(projected.x), Math.abs(projected.y))).toBeLessThan(REPLAY_FRAME.viewportFraction + 0.02);
				};
				const { west, east, south, north } = item.bounds;
				const width = east >= west ? east - west : east + 360 - west;
				for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) {
					check(new Vector3(...latLonToVector(south + (north - south) * i / 10, west + width * j / 10)));
				}
				const track = trackGeometry(item.points.map(([lat, lon], i) => ({ lat, lon,
					time: new Date(Date.parse(item.start) + i * TRACK_STEP_MS).toISOString(), flash_count: 3, area_km2: 1 })), 1 + kmToWorld(20, 1));
				for (const vertices of [track.positions, track.observations]) {
					for (let i = 0; i < vertices.length; i += 3) check(new Vector3().fromArray(vertices, i));
				}
			} finally { rig.controls.dispose(); }
		},
	);

	it.each(cases.flatMap((item) => [16 / 9, 9 / 16].map((aspect) => ({ ...item, aspect }))))(
		'dives from the globe to the $slug frame, its horizon view and back above the floor at aspect $aspect', async (item) => {
			const rig = cameraRig(item.aspect);
			const shells = [cloudShellRadius(1), 1 + kmToWorld(CLOUD_TOP_KM, 1), atmosphereParameters(1).atmosphereRadius];
			const track = item.points.map(([lat, lon], i) => ({ lat, lon, time: new Date(Date.parse(item.start) + i * TRACK_STEP_MS).toISOString(), flash_count: 3, area_km2: 1 }));
			const graze = grazeStorm({ track, bounds: item.bounds }, Date.parse(item.start) + TRACK_STEP_MS * 1.5);
			const frame = frameStorm(item.bounds, 35, item.aspect);
			try {
				for (const destination of [frame, graze, frame]) {
					const flight = rig.controls.flyTo(destination);
					for (let t = 0; t <= destination.duration; t += 16) {
						rig.step(16);
						const height = worldToKm(rig.camera.position.length() - 1, 1);
						expect(height).toBeGreaterThan(CAMERA_FLOOR_KM - 1e-3);
						const { near } = clipPlanes(rig.camera.position.length(), 1, shells);
						expect(worldToKm(near, 1)).toBeLessThan(height - CLOUD_TOP_KM);
					}
					await expect(flight).resolves.toBe(true);
				}
				const back = rig.controls.flyTo({ ...graze, duration: 0 });
				rig.step(0);
				await expect(back).resolves.toBe(true);
				const view = rig.controls.view();
				expect(view.tilt).toBeCloseTo(GRAZE.tilt, 3);
				expect(Math.abs((((view.heading ?? 0) - graze.heading + 540) % 360) - 180)).toBeLessThan(1e-3);
				expect(worldToKm(rig.camera.position.length() - 1, 1)).toBeLessThan(CAMERA_FLOOR_KM + 2);
				rig.camera.updateMatrixWorld();
				const horizon = Math.acos(1 / rig.camera.position.length());
				const forward = new Vector3(0, 0, -1).applyQuaternion(rig.camera.quaternion);
				const below = Math.asin(-forward.dot(rig.camera.position.clone().normalize()));
				expect(below - horizon).toBeLessThan((35 / 2) * Math.PI / 180);
			} finally { rig.controls.dispose(); }
		},
	);

	it.each(['pointerdown', 'wheel'])('interrupts a calibration flight with %s', async (event) => {
		const rig = cameraRig(16 / 9);
		try {
			const flight = rig.controls.flyTo(frameStorm(cases[3].bounds, 35, 16 / 9));
			rig.step(1400);
			rig.fire(event);
			await expect(flight).resolves.toBe(false);
			rig.step(2800);
			expect(rig.controls.view().lon).not.toBeCloseTo(-180, 1);
		} finally { rig.controls.dispose(); }
	});

	it.each([16 / 9, 9 / 16])('arrives on the first update with reduced motion at aspect %s', async (aspect) => {
		const rig = cameraRig(aspect, true);
		try {
			const destination = frameStorm(cases[1].bounds, 35, aspect);
			const flight = rig.controls.flyTo(destination);
			rig.step(0);
			await expect(flight).resolves.toBe(true);
			expect(rig.controls.view().altitude).toBeCloseTo(destination.altitude, 3);
		} finally { rig.controls.dispose(); }
	});
});
