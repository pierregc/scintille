import { Matrix4, Quaternion, Vector3 } from 'three';
import { latLonToVector } from './sun';

const EARTH_RADIUS_KM = 6371;

export interface FlyToOptions {
	lat: number;
	lon: number;
	/** Camera height above the target point, km. Defaults to the current height. */
	altitude?: number;
	/** Angle from looking straight down, degrees; 0 keeps the whole globe framed. */
	tilt?: number;
	/** Milliseconds; defaults to a length that grows with the distance travelled. */
	duration?: number;
}

/** Flight tuning, exposed for the cinematic presets (#83). */
export const FLIGHT = {
	minDurationMs: 1800,
	/** Extra milliseconds per radian travelled. */
	durationPerRadianMs: 1600,
	/** Extra height at mid-flight, as a fraction of the radius per radian travelled. */
	arcPerRadian: 0.45,
	maxTiltDeg: 75,
};

/** Where the camera is and what it looks at. */
export interface CameraPose {
	position: Vector3;
	target: Vector3;
	quaternion: Quaternion;
}

/** Pose above (lat, lon): `altitude` world units above the surface point, `tilt` degrees from nadir, north up. */
export function poseAt(lat: number, lon: number, altitude: number, tiltDeg: number, radius: number): CameraPose {
	const normal = new Vector3(...latLonToVector(lat, lon));
	const north = northTangent(normal);
	const tilt = (Math.min(Math.max(tiltDeg, 0), FLIGHT.maxTiltDeg) * Math.PI) / 180;
	const surface = normal.clone().multiplyScalar(radius);
	const offset = normal
		.clone()
		.multiplyScalar(Math.cos(tilt))
		.addScaledVector(north, -Math.sin(tilt));
	const target = tilt > 0 ? surface : new Vector3();
	const position = surface.clone().addScaledVector(offset, altitude);
	const up = north.clone().multiplyScalar(Math.cos(tilt)).addScaledVector(normal, Math.sin(tilt));
	return { position, target, quaternion: lookRotation(position, target, up) };
}

/** Unit tangent pointing north; falls back to a fixed axis at the poles. */
export function northTangent(normal: Vector3): Vector3 {
	const y = new Vector3(0, 1, 0);
	const tangent = y.clone().addScaledVector(normal, -normal.dot(y));
	if (tangent.lengthSq() < 1e-10) return new Vector3(-1, 0, 0).cross(normal).normalize();
	return tangent.normalize();
}

export function lookRotation(eye: Vector3, target: Vector3, up: Vector3): Quaternion {
	return new Quaternion().setFromRotationMatrix(new Matrix4().lookAt(eye, target, up));
}

export function easeInOut(t: number): number {
	const x = Math.min(Math.max(t, 0), 1);
	return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

/** Angle in radians between two directions from the globe center. */
export function arcAngle(a: Vector3, b: Vector3): number {
	return a.clone().normalize().angleTo(b.clone().normalize());
}

export function flightDuration(angle: number): number {
	return FLIGHT.minDurationMs + FLIGHT.durationPerRadianMs * angle;
}

/**
 * A flight between two poses along the great circle. The start orientation is carried along the
 * circle and the remaining roll and tilt are slerped in, so the camera never flips near a pole;
 * the range rises in an arc.
 */
export class Flight {
	readonly duration: number;
	readonly #from: CameraPose;
	readonly #to: CameraPose;
	readonly #fromDir: Vector3;
	readonly #toDir: Vector3;
	readonly #angle: number;
	readonly #fromRange: number;
	readonly #toRange: number;
	readonly #arc: number;
	readonly #axis: Vector3;
	readonly #residual: Quaternion;

	constructor(from: CameraPose, to: CameraPose, radius: number, duration?: number) {
		this.#from = from;
		this.#to = to;
		this.#fromDir = (from.target.lengthSq() > 0 ? from.target : from.position).clone().normalize();
		this.#toDir = (to.target.lengthSq() > 0 ? to.target : to.position).clone().normalize();
		this.#angle = this.#fromDir.angleTo(this.#toDir);
		this.#fromRange = from.position.distanceTo(from.target);
		this.#toRange = to.position.distanceTo(to.target);
		this.#arc = FLIGHT.arcPerRadian * radius * this.#angle;
		this.duration = duration ?? flightDuration(this.#angle);
		const axis = this.#fromDir.clone().cross(this.#toDir);
		this.#axis = axis.lengthSq() > 1e-12 ? axis.normalize() : northTangent(this.#fromDir).cross(this.#fromDir).normalize();
		this.#residual = this.#carried(1).invert().multiply(to.quaternion);
	}

	/** Start orientation rotated along the great circle by a fraction `e` of the trip. */
	#carried(e: number): Quaternion {
		return new Quaternion().setFromAxisAngle(this.#axis, this.#angle * e).multiply(this.#from.quaternion);
	}

	/** Pose at `elapsed` milliseconds into the flight. */
	at(elapsed: number): CameraPose {
		const t = this.duration > 0 ? Math.min(Math.max(elapsed / this.duration, 0), 1) : 1;
		const e = easeInOut(t);
		const quaternion = this.#carried(e).multiply(new Quaternion().slerp(this.#residual, e));
		const anchor = slerpDirection(this.#fromDir, this.#toDir, this.#angle, e).multiplyScalar(
			lerp(this.#from.target.length(), this.#to.target.length(), e),
		);
		const range = lerp(this.#fromRange, this.#toRange, e) + this.#arc * Math.sin(Math.PI * t);
		const back = new Vector3(0, 0, 1).applyQuaternion(quaternion);
		return { position: anchor.clone().addScaledVector(back, range), target: anchor, quaternion };
	}
}

function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

function slerpDirection(a: Vector3, b: Vector3, angle: number, t: number): Vector3 {
	if (angle < 1e-6) return a.clone();
	const s = Math.sin(angle);
	if (s < 1e-4) {
		const axis = northTangent(a).cross(a).normalize();
		return a.clone().applyAxisAngle(axis, t * angle);
	}
	return a
		.clone()
		.multiplyScalar(Math.sin((1 - t) * angle) / s)
		.addScaledVector(b, Math.sin(t * angle) / s)
		.normalize();
}

export function kmToWorld(km: number, radius: number): number {
	return (km / EARTH_RADIUS_KM) * radius;
}

export function worldToKm(world: number, radius: number): number {
	return (world / radius) * EARTH_RADIUS_KM;
}
