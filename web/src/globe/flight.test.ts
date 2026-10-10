import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { parseDevFlights } from './dev-flight';
import { easeInOut, Flight, kmToWorld, northTangent, poseAt } from './flight';
import { latLonToVector } from './sun';

const R = 1;
const PARIS = { lat: 48.86, lon: 2.35 };
const SYDNEY = { lat: -33.87, lon: 151.21 };

function samples(flight: Flight, n = 200) {
	return Array.from({ length: n + 1 }, (_, i) => flight.at((flight.duration * i) / n));
}

describe('poseAt', () => {
	it('looks straight down from above the point, north up', () => {
		const pose = poseAt(PARIS.lat, PARIS.lon, 2, 0, R);
		const dir = new Vector3(...latLonToVector(PARIS.lat, PARIS.lon));
		expect(pose.position.clone().normalize().dot(dir)).toBeCloseTo(1, 6);
		expect(pose.position.length()).toBeCloseTo(3, 6);
		const forward = new Vector3(0, 0, -1).applyQuaternion(pose.quaternion);
		expect(forward.dot(dir)).toBeCloseTo(-1, 6);
		const up = new Vector3(0, 1, 0).applyQuaternion(pose.quaternion);
		expect(up.dot(northTangent(dir))).toBeCloseTo(1, 6);
	});

	it('tilts toward the horizon around the surface point', () => {
		const pose = poseAt(0, 0, 0.1, 60, R);
		expect(pose.target.length()).toBeCloseTo(R, 6);
		const forward = new Vector3(0, 0, -1).applyQuaternion(pose.quaternion);
		const toTarget = pose.target.clone().sub(pose.position).normalize();
		expect(forward.dot(toTarget)).toBeCloseTo(1, 6);
		expect(forward.dot(pose.target.clone().normalize())).toBeCloseTo(-Math.cos(Math.PI / 3), 6);
	});

	it('stays defined at the poles', () => {
		const pose = poseAt(90, 0, 1, 0, R);
		expect(Number.isFinite(pose.quaternion.x)).toBe(true);
		expect(pose.position.y).toBeCloseTo(2, 6);
	});
});

describe('Flight', () => {
	const from = poseAt(PARIS.lat, PARIS.lon, 2, 0, R);
	const to = poseAt(SYDNEY.lat, SYDNEY.lon, 2, 0, R);
	const flight = new Flight(from, to, R);

	it('starts and ends on the given poses', () => {
		expect(flight.at(0).position.distanceTo(from.position)).toBeLessThan(1e-6);
		expect(flight.at(flight.duration).position.distanceTo(to.position)).toBeLessThan(1e-6);
		expect(flight.at(flight.duration * 2).position.distanceTo(to.position)).toBeLessThan(1e-6);
	});

	it('always looks at its anchor and rises mid-flight', () => {
		for (const pose of samples(flight, 20)) {
			const forward = new Vector3(0, 0, -1).applyQuaternion(pose.quaternion);
			const toAnchor = pose.target.clone().sub(pose.position).normalize();
			expect(forward.dot(toAnchor)).toBeCloseTo(1, 5);
		}
		expect(flight.at(flight.duration / 2).position.length()).toBeGreaterThan(3.5);
	});

	it('follows the great circle', () => {
		const normal = from.position.clone().cross(to.position).normalize();
		for (const pose of samples(flight, 10)) expect(Math.abs(pose.position.clone().normalize().dot(normal))).toBeLessThan(1e-6);
	});

	it('moves smoothly, without a flip, even across a pole', () => {
		const polar = new Flight(poseAt(60, 0, 2, 0, R), poseAt(60, 180, 2, 0, R), R);
		for (const path of [flight, polar]) {
			const poses = samples(path);
			const turns = poses.slice(1).map((p, i) => p.quaternion.angleTo(poses[i].quaternion));
			const steps = poses.slice(1).map((p, i) => p.position.distanceTo(poses[i].position));
			const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
			// Cubic ease-in-out peaks at 3x the mean speed; a flip would be a single huge step.
			expect(Math.max(...turns)).toBeLessThan(3.5 * mean(turns));
			expect(Math.max(...steps)).toBeLessThan(3.5 * mean(steps));
		}
	});

	it('takes longer for longer trips', () => {
		const short = new Flight(from, poseAt(50, 5, 2, 0, R), R);
		expect(short.duration).toBeLessThan(flight.duration);
		expect(new Flight(from, to, R, 500).duration).toBe(500);
	});
});

describe('helpers', () => {
	it('eases in and out', () => {
		expect(easeInOut(0)).toBe(0);
		expect(easeInOut(0.5)).toBeCloseTo(0.5);
		expect(easeInOut(1)).toBe(1);
		expect(easeInOut(0.1)).toBeLessThan(0.1);
	});

	it('converts km to world units', () => {
		expect(kmToWorld(6371, 2)).toBe(2);
	});

	it('parses dev flight chains', () => {
		expect(parseDevFlights('?fly=48.86,2.35;-33.87,151.21,8000,30;bad')).toEqual([
			{ lat: 48.86, lon: 2.35, altitude: undefined, tilt: 0 },
			{ lat: -33.87, lon: 151.21, altitude: 8000, tilt: 30 },
		]);
		expect(parseDevFlights('')).toEqual([]);
	});
});
