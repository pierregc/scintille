import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { CAMERA_FLOOR_KM, type CameraPose, FLIGHT, kmToWorld, poseAt, worldToKm } from './flight';
import { floorRange, lookedAt, panSurface, surfaceFromPose, surfacePose, type SurfaceView, tiltSurface, zoomSurface } from './surface';

const R = 1;
const DEG = Math.PI / 180;
const MAX_TILT = FLIGHT.maxTiltDeg * DEG;
const MAX_GAZE = FLIGHT.maxGazeDeg * DEG;
const view = (km = 800, tiltDeg = 40) => {
	const pose = poseAt(30, 10, kmToWorld(km, R), tiltDeg, R);
	if (tiltDeg === 0) pose.target.copy(pose.position).setLength(R);
	return surfaceFromPose(pose);
};
const height = (position: Vector3) => worldToKm(position.length() - R, R);
const forwardOf = (pose: CameraPose) => new Vector3(0, 0, -1).applyQuaternion(pose.quaternion);
const rightOf = (pose: CameraPose) => new Vector3(1, 0, 0).applyQuaternion(pose.quaternion);
const upOf = (pose: CameraPose) => new Vector3(0, 1, 0).applyQuaternion(pose.quaternion);
/** Drags in steps of `step` pixels, as pointer moves do. */
const drag = (start: SurfaceView, dy: number, step = 10) => {
	let current = start;
	for (let moved = 0; Math.abs(moved) < Math.abs(dy); moved += Math.sign(dy) * step) current = tiltSurface(current, 0, Math.sign(dy) * step);
	return current;
};
const same = (a: CameraPose, b: CameraPose) => {
	expect(a.position.distanceTo(b.position)).toBeLessThan(1e-9);
	expect(a.quaternion.angleTo(b.quaternion)).toBeLessThan(1e-6);
};
/** Where `point` lands on a 35° camera at `pose`, in normalized device coordinates. */
const project = (pose: CameraPose, point: Vector3) => {
	const camera = new PerspectiveCamera(35, 16 / 9, 1e-5, 100);
	camera.position.copy(pose.position);
	camera.quaternion.copy(pose.quaternion);
	camera.updateMatrixWorld();
	return point.clone().project(camera);
};
/** Starting views of ADR 0020 and the Horizon view, all at the floor. */
const STARTS = {
	iss: { km: 400, tilt: 1 },
	window: { km: 740, tilt: 60 },
	horizon: { km: worldToKm(floorRange(72 * DEG, R), R) + 1, tilt: 72 },
};

describe('surface view', () => {
	it.each([40, 80, 85, 90])('round trips a fly-to pose at a tilt of %s degrees', (tilt) => {
		const pose = poseAt(30, 10, kmToWorld(1500, R), tilt, R);
		const surface = surfaceFromPose(pose);
		expect(surface.tilt + surface.gaze).toBeCloseTo(tilt * DEG, 9);
		same(surfacePose(surface, R), pose);
	});

	it('keeps the heading of a straight down camera', () => {
		const pose = poseAt(30, 10, 2, 0, R);
		const down = surfaceFromPose({ ...pose, target: pose.position.clone().setLength(R) });
		expect(down.tilt).toBeCloseTo(0, 9);
		expect(surfacePose(down, R).quaternion.angleTo(pose.quaternion)).toBeLessThan(1e-6);
	});

	it.each([kmToWorld(400, R), kmToWorld(740, R), 0.5, 3])('never goes under the floor at range %s, whatever the tilt and gaze', (range) => {
		for (let tilt = 0; tilt <= MAX_TILT + 1e-9; tilt += MAX_TILT / 16) {
			for (const gaze of [0, MAX_GAZE / 2, MAX_GAZE]) {
				expect(height(surfacePose({ ...view(), range, tilt, gaze }, R).position)).toBeGreaterThan(CAMERA_FLOOR_KM - 1e-6);
			}
		}
	});

	it('slides back along the floor instead of stopping the tilt', () => {
		const start = view(400, 0);
		for (let tilt = 0; tilt <= MAX_TILT; tilt += MAX_TILT / 16) {
			const pose = surfacePose({ ...start, tilt }, R);
			expect(height(pose.position)).toBeCloseTo(CAMERA_FLOOR_KM, 6);
			expect(pose.target.distanceTo(surfacePose(start, R).target)).toBe(0);
		}
		const raised = drag(start, -1000);
		expect(raised.tilt).toBeCloseTo(MAX_TILT, 12);
		expect(raised.gaze).toBeCloseTo(MAX_GAZE, 12);
		expect(raised.range).toBe(start.range);
	});

	it('raises the gaze in place past the largest orbit tilt, without roll', () => {
		const orbit = surfacePose({ ...view(400), tilt: MAX_TILT, gaze: 0 }, R);
		const raised = surfacePose({ ...view(400), tilt: MAX_TILT, gaze: MAX_GAZE }, R);
		expect(raised.position.distanceTo(orbit.position)).toBe(0);
		expect(forwardOf(raised).angleTo(forwardOf(orbit))).toBeCloseTo(MAX_GAZE, 9);
		expect(rightOf(raised).distanceTo(rightOf(orbit))).toBeLessThan(1e-9);
		expect(forwardOf(raised).dot(raised.position.clone().normalize())).toBeGreaterThan(forwardOf(orbit).dot(orbit.position.clone().normalize()));
	});

	it('keeps the horizon level and the target on screen at every tilt', () => {
		const start = view(400, 0);
		for (let pixels = 0; pixels <= 320; pixels += 10) {
			const surface = drag(start, -pixels);
			const pose = surfacePose(surface, R);
			expect(Math.abs(rightOf(pose).dot(pose.position.clone().normalize()))).toBeLessThan(1e-9);
			expect(upOf(pose).dot(pose.position.clone().normalize())).toBeGreaterThan(-1e-9);
			const target = project(pose, pose.target);
			expect(target.z).toBeLessThan(1);
			expect(Math.abs(target.x)).toBeLessThan(1e-9);
			expect(target.y).toBeGreaterThan(-1);
			expect(target.y).toBeLessThanOrEqual(1e-9);
		}
	});

	it('puts the horizon in the lower third at the floor at 90 degrees', () => {
		const pose = surfacePose({ ...view(400), tilt: MAX_TILT, gaze: MAX_GAZE }, R);
		const eye = pose.position;
		const off = Math.acos(R / eye.length());
		const horizon = eye.clone().normalize().multiplyScalar(Math.cos(off) * R).addScaledVector(forwardOf(pose).projectOnPlane(eye).normalize(), Math.sin(off) * R);
		const fromTop = (1 - project(pose, horizon).y) / 2;
		expect(fromTop).toBeGreaterThan(2 / 3);
		expect(fromTop).toBeLessThan(0.75);
	});

	it('is continuous where the orbit hands over to the gaze', () => {
		const below = poseAt(30, 10, kmToWorld(400, R), FLIGHT.maxTiltDeg - 1e-4, R);
		const above = poseAt(30, 10, kmToWorld(400, R), FLIGHT.maxTiltDeg + 1e-4, R);
		const lifted = (pose: CameraPose) => surfacePose(surfaceFromPose(pose), R);
		expect(lifted(below).position.distanceTo(lifted(above).position)).toBeLessThan(1e-5);
		expect(lifted(below).quaternion.angleTo(lifted(above).quaternion)).toBeLessThan(1e-5);
	});

	it.each(Object.entries(STARTS))('comes back to the %s view after a drag to 90 degrees and back', (_, { km, tilt }) => {
		const start = view(km, tilt);
		const pixels = Math.round((90 - tilt) * DEG / 0.005 / 10) * 10 - 10;
		const raised = drag(start, -pixels);
		expect((raised.tilt + raised.gaze) / DEG).toBeGreaterThan(85);
		same(surfacePose(drag(raised, pixels), R), surfacePose(start, R));
	});

	it('lowers the gaze before the tilt when dragging down', () => {
		const start = { ...view(), tilt: 40 * DEG, gaze: 5 * DEG };
		const lower = tiltSurface(start, 0, 10);
		expect(lower.tilt).toBe(start.tilt);
		expect(lower.gaze).toBeCloseTo(start.gaze - 0.05, 12);
		const down = tiltSurface(start, 0, 1e5);
		expect([down.tilt, down.gaze]).toEqual([0, 0]);
		const up = tiltSurface(start, 0, -10);
		expect(up.tilt).toBeCloseTo(start.tilt + 0.05, 12);
		expect(up.gaze).toBe(start.gaze);
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
		const start = { ...view(), range: kmToWorld(5000, R), tilt: deg * DEG };
		const close = zoomSurface(start, -1e5, R);
		expect(close.range).toBeCloseTo(floorRange(start.tilt, R), 12);
		expect(close.tilt).toBeCloseTo(start.tilt, 12);
		expect(height(surfacePose(close, R).position)).toBeCloseTo(CAMERA_FLOOR_KM, 6);
	});

	it('zooms from where the camera is when it slid back along the floor', () => {
		const slid = { ...view(400, 0), tilt: MAX_TILT, gaze: MAX_GAZE };
		expect(zoomSurface(slid, -100, R).range).toBe(slid.range);
		const out = zoomSurface(slid, 100, R);
		expect(out.range).toBeCloseTo(floorRange(MAX_TILT, R) * Math.exp(100 * 0.002), 12);
		expect(out.gaze).toBe(slid.gaze);
	});

	it('puts the window pose of ADR 0020 at the floor', () => {
		expect(worldToKm(floorRange(Math.PI / 3, R), R)).toBeCloseTo(740, -1);
		expect(worldToKm(floorRange(0, R), R)).toBeCloseTo(CAMERA_FLOOR_KM, 9);
	});
});

describe('lookedAt', () => {
	const groundKm = (pose: CameraPose) => worldToKm(pose.position.clone().normalize().angleTo(lookedAt(pose.position, forwardOf(pose), R)), R);

	it('is the screen centre on the ground up to the largest orbit tilt', () => {
		for (const tilt of [1, 20, 60, 80]) {
			const pose = poseAt(30, 10, kmToWorld(1500, R), tilt, R);
			expect(lookedAt(pose.position, forwardOf(pose), R).distanceTo(pose.target.clone().normalize())).toBeLessThan(1e-9);
		}
		const globe = poseAt(30, 10, 2, 0, R);
		expect(lookedAt(globe.position, forwardOf(globe), R).distanceTo(globe.position.clone().normalize())).toBeLessThan(1e-9);
	});

	it('stays at the 80 degree point as the gaze passes the horizon', () => {
		const at80 = groundKm(poseAt(30, 10, floorRange(MAX_TILT, R), 80, R));
		expect(at80).toBeCloseTo(1342, -1);
		for (let tilt = 80; tilt <= 90; tilt += 0.25) {
			expect(groundKm(poseAt(30, 10, floorRange(MAX_TILT, R), tilt, R))).toBeCloseTo(at80, 6);
		}
	});

	it.each([400, 2000, 20000])('moves without a jump from straight down to nearly straight up at %s km', (km) => {
		const eye = new Vector3(0, R + kmToWorld(km, R), 0);
		let previous = 0;
		for (let deg = 0; deg < 179; deg += 0.02) {
			const forward = new Vector3(Math.sin(deg * DEG), -Math.cos(deg * DEG), 0);
			const ground = worldToKm(eye.clone().normalize().angleTo(lookedAt(eye, forward, R)), R);
			expect(ground).toBeGreaterThanOrEqual(previous - 1e-9);
			expect(ground - previous).toBeLessThan(50);
			previous = ground;
		}
	});
});
