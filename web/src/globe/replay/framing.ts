import { PerspectiveCamera, Vector3 } from 'three';
import type { StormBounds } from '../../contract/types';
import { type FlyToOptions, kmToWorld, poseAt, worldToKm } from '../flight';
import { latLonToVector } from '../sun';
import { fitDistance } from '../viewport';

export const REPLAY_FRAME = { duration: 2800, tilt: 20, viewportFraction: 0.62, minAltitudeKm: 300 };

/** A spherical cap enclosing the full geographic box, including wrapped longitude intervals. */
export function stormCap(bounds: StormBounds): { lat: number; lon: number; angle: number } {
	const { west, east, south, north } = bounds;
	if (![west, east, south, north].every(Number.isFinite) ||
		west < -180 || west > 180 || east < -180 || east > 180 || south < -90 || north > 90 || south > north) {
		throw new Error('invalid storm geographic bounds');
	}
	const width = east >= west ? east - west : east + 360 - west;
	const lat = (south + north) / 2;
	const lon = ((west + width / 2 + 540) % 360) - 180;
	const rad = Math.PI / 180;
	const a = Math.sin(lat * rad);
	const b = Math.cos(lat * rad) * Math.cos(width * rad / 2);
	const candidates = [south * rad, north * rad];
	for (const x of [Math.atan2(a, b) - Math.PI, Math.atan2(a, b) + Math.PI]) {
		if (x >= south * rad && x <= north * rad) candidates.push(x);
	}
	const cosine = Math.min(...candidates.map((x) => a * Math.sin(x) + b * Math.cos(x)));
	return { lat, lon, angle: Math.acos(Math.max(-1, Math.min(1, cosine))) };
}

/** Fit the geographic box inside a central safe area, falling back to the whole globe for wide extents. */
export function frameStorm(bounds: StormBounds, fov: number, aspect: number): Required<FlyToOptions> {
	const { lat, lon, angle } = stormCap(bounds);
	if (angle > Math.PI / 3) {
		return { lat, lon, altitude: worldToKm(fitDistance(1, fov, aspect) * 1.25 - 1, 1), tilt: 0, duration: REPLAY_FRAME.duration };
	}
	const { west, east, south, north } = bounds;
	const width = east >= west ? east - west : east + 360 - west;
	const points = [new Vector3(...latLonToVector(lat, lon))];
	for (let i = 0; i <= 24; i++) {
		const f = i / 24;
		for (const [a, b] of [[south, west + width * f], [north, west + width * f], [south + (north - south) * f, west], [south + (north - south) * f, west + width]]) {
			points.push(new Vector3(...latLonToVector(a, b)));
		}
	}
	const camera = new PerspectiveCamera(fov, aspect, 1e-5, 1000);
	const fits = (altitude: number) => {
		const pose = poseAt(lat, lon, kmToWorld(altitude, 1), REPLAY_FRAME.tilt, 1);
		camera.position.copy(pose.position);
		camera.quaternion.copy(pose.quaternion);
		camera.updateMatrixWorld();
		return points.every((point) => {
			const p = point.clone().project(camera);
			return p.z > -1 && p.z < 1 && Math.max(Math.abs(p.x), Math.abs(p.y)) < REPLAY_FRAME.viewportFraction;
		});
	};
	let low = REPLAY_FRAME.minAltitudeKm;
	let high = worldToKm(fitDistance(1, fov, aspect) * 2, 1);
	for (let i = 0; i < 32; i++) {
		const mid = (low + high) / 2;
		if (fits(mid)) high = mid;
		else low = mid;
	}
	return { lat, lon, altitude: high * 1.02, tilt: REPLAY_FRAME.tilt, duration: REPLAY_FRAME.duration };
}
