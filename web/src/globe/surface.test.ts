import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { FLIGHT, kmToWorld, poseAt, worldToKm } from './flight';
import { SURFACE, maxTilt, panSurface, surfaceFromPose, surfacePose, tiltSurface, zoomSurface } from './surface';

const R = 1;
const view = () => {
	const pose = poseAt(30, 10, kmToWorld(400, R), 40, R);
	return surfaceFromPose(pose.position, pose.quaternion, pose.target);
};
const height = (position: Vector3) => worldToKm(position.length() - R, R);

describe('surface view', () => {
	it('round trips a fly-to pose', () => {
		const pose = poseAt(30, 10, kmToWorld(400, R), 40, R);
		const back = surfacePose(surfaceFromPose(pose.position, pose.quaternion, pose.target), R);
		expect(back.position.distanceTo(pose.position)).toBeLessThan(1e-9);
		expect(back.quaternion.angleTo(pose.quaternion)).toBeLessThan(1e-6);
	});

	it('keeps the heading of a straight down camera', () => {
		const pose = poseAt(30, 10, 2, 0, R);
		const down = surfaceFromPose(pose.position, pose.quaternion, pose.target.clone().copy(pose.position).setLength(R));
		expect(down.tilt).toBeCloseTo(0, 9);
		expect(surfacePose(down, R).quaternion.angleTo(pose.quaternion)).toBeLessThan(1e-6);
	});

	it.each([kmToWorld(20, R), kmToWorld(100, R), 0.5, 3])('never tilts below the minimum height at range %s', (range) => {
		const tilt = maxTilt(range, R);
		expect(tilt).toBeLessThanOrEqual((FLIGHT.maxTiltDeg * Math.PI) / 180 + 1e-12);
		const { position } = surfacePose({ ...view(), range, tilt }, R);
		expect(height(position)).toBeGreaterThan(SURFACE.minHeightKm - 1e-6);
	});

	it('tilts toward the horizon when dragging up, within limits', () => {
		const start = view();
		expect(tiltSurface(start, 0, -10, R).tilt).toBeGreaterThan(start.tilt);
		expect(tiltSurface(start, 0, -1e5, R).tilt).toBeCloseTo(maxTilt(start.range, R), 9);
		expect(tiltSurface(start, 0, 1e5, R).tilt).toBe(0);
	});

	it('moves the ground with the pointer', () => {
		const start = view();
		const right = start.heading.clone().cross(start.normal);
		const moved = panSurface(start, 100, 0, R, 35, 800);
		expect(moved.normal.clone().sub(start.normal).dot(right)).toBeLessThan(0);
		expect(moved.heading.dot(moved.normal)).toBeCloseTo(0, 9);
		expect(moved.range).toBe(start.range);
	});

	it('zooms in no closer than the minimum range and lowers the tilt to stay clear', () => {
		const start = { ...view(), tilt: maxTilt(view().range, R) };
		const close = zoomSurface(start, -1e5, R);
		expect(worldToKm(close.range, R)).toBeCloseTo(SURFACE.minRangeKm, 6);
		expect(height(surfacePose(close, R).position)).toBeGreaterThan(SURFACE.minHeightKm - 1e-6);
	});
});
