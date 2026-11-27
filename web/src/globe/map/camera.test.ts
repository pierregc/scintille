import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { kmToWorld, poseAt } from '../flight';
import { mapCamera } from './camera';

const view = (lat: number, lon: number, km: number, tilt = 0, heading = 0) => {
	const pose = poseAt(lat, lon, kmToWorld(km, 1), tilt, 1, heading);
	return mapCamera(pose.position, pose.quaternion, 1, 35, 900);
};

describe('mapCamera', () => {
	it('centres on the point under a camera looking straight down', () => {
		const camera = view(48.85, 2.35, 400);
		expect(camera?.lat).toBeCloseTo(48.85, 6);
		expect(camera?.lng).toBeCloseTo(2.35, 6);
		expect(camera?.pitch).toBeCloseTo(0, 4);
		expect(camera?.bearing).toBeCloseTo(0, 4);
		expect(camera?.roll).toBeCloseTo(0, 4);
	});

	it('gains one zoom level each time the range halves', () => {
		expect((view(10, 20, 200)?.zoom ?? 0) - (view(10, 20, 400)?.zoom ?? 0)).toBeCloseTo(1, 9);
	});

	it('shows 512 px per turn of the equator at zoom 0', () => {
		const range = (2 * Math.PI * (900 / 2 / Math.tan((35 * Math.PI) / 360))) / 512;
		expect(mapCamera(new Vector3(1 + range, 0, 0), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2), 1, 35, 900)?.zoom).toBeCloseTo(0, 9);
	});

	it('keeps the tilt and the heading of a camera orbiting a ground point', () => {
		const camera = view(-33.9, 151.2, 120, 60, 135);
		expect(camera?.lat).toBeCloseTo(-33.9, 6);
		expect(camera?.lng).toBeCloseTo(151.2, 6);
		expect(camera?.pitch).toBeCloseTo(60, 6);
		expect(camera?.bearing).toBeCloseTo(135, 6);
		expect(camera?.roll).toBeCloseTo(0, 6);
	});

	it('reports the turn about the line of sight', () => {
		const pose = poseAt(20, 30, 0.1, 50, 1, 40);
		pose.quaternion.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), (12 * Math.PI) / 180));
		expect(Math.abs(mapCamera(pose.position, pose.quaternion, 1, 35, 900)?.roll ?? 0)).toBeCloseTo(12, 6);
	});

	it('gives up when the screen centre looks past the globe', () => {
		const pose = poseAt(0, 0, kmToWorld(400, 1), 90, 1);
		expect(mapCamera(pose.position, pose.quaternion, 1, 35, 900)).toBeNull();
	});
});
