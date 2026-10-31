import { PerspectiveCamera, Vector3 } from 'three';
import type { StormBounds, StormDetail } from '../../contract/types';
import { type FlyToOptions, kmToWorld, poseAt, worldToKm } from '../flight';
import { floorRange } from '../surface';
import { latLonToVector } from '../sun';
import { fitDistance } from '../viewport';

export const REPLAY_FRAME = { duration: 2800, tilt: 45, viewportFraction: 0.62 };

/** Look toward the horizon from the camera floor: horizon in the upper third, storm below the centre. */
export const GRAZE = { duration: 3200, tilt: 72, leadKm: 200 };

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
		return { lat, lon, altitude: worldToKm(fitDistance(1, fov, aspect) * 1.25 - 1, 1), tilt: 0, heading: 0, duration: REPLAY_FRAME.duration };
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
	let low = worldToKm(floorRange((REPLAY_FRAME.tilt * Math.PI) / 180, 1), 1);
	let high = worldToKm(fitDistance(1, fov, aspect) * 2, 1);
	for (let i = 0; i < 32; i++) {
		const mid = (low + high) / 2;
		if (fits(mid)) high = mid;
		else low = mid;
	}
	return { lat, lon, altitude: Math.max(high * 1.02, low), tilt: REPLAY_FRAME.tilt, heading: 0, duration: REPLAY_FRAME.duration };
}

/** Looks over the storm's position at `time` toward the horizon, along its motion. */
export function grazeStorm(detail: Pick<StormDetail, 'track' | 'bounds'>, time: number): Required<FlyToOptions> {
	const track = [...detail.track].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
	let index = 0;
	for (let i = 0; i < track.length; i++) if (Date.parse(track[i].time) <= time) index = i;
	const { lat, lon } = track[index] ?? stormCap(detail.bounds);
	const from = track[Math.max(index - 1, 0)];
	const to = track[Math.min(index + 1, track.length - 1)];
	const heading = from && to && from !== to ? bearing(from, to) : 0;
	const target = ahead({ lat, lon }, heading, GRAZE.leadKm);
	const tilt = (GRAZE.tilt * Math.PI) / 180;
	return { ...target, altitude: worldToKm(floorRange(tilt, 1), 1) + 1, tilt: GRAZE.tilt, heading, duration: GRAZE.duration };
}

/** Point `km` from (lat, lon) toward `headingDeg`. */
export function ahead({ lat, lon }: { lat: number; lon: number }, headingDeg: number, km: number): { lat: number; lon: number } {
	const rad = Math.PI / 180;
	const d = km / 6371;
	const b = headingDeg * rad;
	const lat2 = Math.asin(Math.sin(lat * rad) * Math.cos(d) + Math.cos(lat * rad) * Math.sin(d) * Math.cos(b));
	const lon2 = lon * rad + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat * rad), Math.cos(d) - Math.sin(lat * rad) * Math.sin(lat2));
	return { lat: lat2 / rad, lon: ((lon2 / rad + 540) % 360) - 180 };
}

/** Initial bearing from `a` to `b`, degrees clockwise from north. */
export function bearing(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
	const rad = Math.PI / 180;
	const y = Math.sin((b.lon - a.lon) * rad) * Math.cos(b.lat * rad);
	const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad) - Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lon - a.lon) * rad);
	return ((Math.atan2(y, x) / rad) + 360) % 360;
}
