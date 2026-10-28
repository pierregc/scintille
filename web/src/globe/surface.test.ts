import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { CAMERA_FLOOR_KM, FLIGHT, kmToWorld, poseAt, worldToKm } from './flight';
import { floorRange, maxTilt, panSurface, surfaceFromPose, surfacePose, tiltSurface, zoomSurface } from './surface';

const R = 1;
const view = () => {
	const pose = poseAt(30, 10, kmToWorld(800, R), 40, R);
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

	it.each([kmToWorld(400, R), kmToWorld(740, R), 0.5, 3])('never tilts below the floor at range %s', (range) => {
		const tilt = maxTilt(range, R);
		expect(tilt).toBeLessThanOrEqual((FLIGHT.maxTiltDeg * Math.PI) / 180 + 1e-12);
		const { position } = surfacePose({ ...view(), range, tilt }, R);
		expect(height(position)).toBeGreaterThan(CAMERA_FLOOR_KM - 1e-6);
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

	it.each([0, 40, 60, 80])('zooms in down to the floor and keeps a tilt of %s degrees', (deg) => {
		const start = { ...view(), range: kmToWorld(5000, R), tilt: (deg * Math.PI) / 180 };
		const close = zoomSurface(start, -1e5, R);
		expect(close.range).toBeCloseTo(floorRange(start.tilt, R), 12);
		expect(close.tilt).toBeCloseTo(start.tilt, 12);
		expect(height(surfacePose(close, R).position)).toBeCloseTo(CAMERA_FLOOR_KM, 6);
	});

	it('puts the window pose of ADR 0020 at the floor', () => {
		expect(worldToKm(floorRange(Math.PI / 3, R), R)).toBeCloseTo(740, -1);
		expect(worldToKm(floorRange(0, R), R)).toBeCloseTo(CAMERA_FLOOR_KM, 9);
	});
});
