import { Matrix4, Quaternion, Vector3 } from 'three';
import { latLonToVector } from './sun';

const EARTH_RADIUS_KM = 6371;
const RIGHT = new Vector3(1, 0, 0);

/** Lowest camera height above the ground in every mode, the ISS altitude (ADR 0020). */
export const CAMERA_FLOOR_KM = 400;

export interface FlyToOptions {
	lat: number;
	lon: number;
	/** Camera height above the target point, km. Defaults to the current height. */
	altitude?: number;
	/** Angle from looking straight down, degrees; 0 keeps the whole globe framed. Above `FLIGHT.maxTiltDeg` the gaze rises over the target. */
	tilt?: number;
	/** Direction the camera faces, degrees clockwise from north. */
	heading?: number;
	/** Milliseconds; defaults to a length that grows with the distance travelled. */
	duration?: number;
}

/** A camera position as shared in links; heading defaults to north. */
export type CameraView = Required<Omit<FlyToOptions, 'duration' | 'heading'>> & { heading?: number };

/** Flight tuning, exposed for the cinematic presets (#83). */
export const FLIGHT = {
	minDurationMs: 1800,
	/** Extra milliseconds per radian travelled. */
	durationPerRadianMs: 1600,
	/** Extra height at mid-flight, as a fraction of the radius per radian travelled. */
	arcPerRadian: 0.45,
	/** Largest tilt of the camera orbiting its target. */
	maxTiltDeg: 80,
	/** How far the gaze rises above the target at the largest tilt (ADR 0032). */
	maxGazeDeg: 10,
};

/** Where the camera is and what it looks at. */
export interface CameraPose {
	position: Vector3;
	target: Vector3;
	quaternion: Quaternion;
	/** Radians the gaze is raised above the target, 0 when left out. */
	gaze?: number;
}

/**
 * Pose above (lat, lon): `altitude` world units above the surface point, `tilt` degrees from nadir,
 * facing `headingDeg` from north. A tilt past `FLIGHT.maxTiltDeg` keeps that orbit and raises the gaze.
 */
export function poseAt(lat: number, lon: number, altitude: number, tiltDeg: number, radius: number, headingDeg = 0): CameraPose {
	const normal = new Vector3(...latLonToVector(lat, lon));
	const north = headingTangent(normal, headingDeg);
	const total = Math.min(Math.max(tiltDeg, 0), FLIGHT.maxTiltDeg + FLIGHT.maxGazeDeg);
	const tilt = (Math.min(total, FLIGHT.maxTiltDeg) * Math.PI) / 180;
	const gaze = (total * Math.PI) / 180 - tilt;
	const surface = normal.clone().multiplyScalar(radius);
	const offset = normal
		.clone()
		.multiplyScalar(Math.cos(tilt))
		.addScaledVector(north, -Math.sin(tilt));
	const target = tilt > 0 ? surface : new Vector3();
	const position = surface.clone().addScaledVector(offset, altitude);
	const up = north.clone().multiplyScalar(Math.cos(tilt)).addScaledVector(normal, Math.sin(tilt));
	return { position, target, quaternion: raiseGaze(lookRotation(position, target, up), gaze), gaze };
}

/** Turns a camera orientation in place about its own horizontal axis: positive looks up. */
export function raiseGaze(quaternion: Quaternion, angle: number): Quaternion {
	return angle === 0 ? quaternion : quaternion.multiply(new Quaternion().setFromAxisAngle(RIGHT, angle));
}

/** Unit tangent pointing north; falls back to a fixed axis at the poles. */
export function northTangent(normal: Vector3): Vector3 {
	const y = new Vector3(0, 1, 0);
	const tangent = y.clone().addScaledVector(normal, -normal.dot(y));
	if (tangent.lengthSq() < 1e-10) return new Vector3(-1, 0, 0).cross(normal).normalize();
	return tangent.normalize();
}

/** Unit tangent `headingDeg` clockwise from north. */
export function headingTangent(normal: Vector3, headingDeg: number): Vector3 {
	const north = northTangent(normal);
	const angle = (headingDeg * Math.PI) / 180;
	return north.clone().multiplyScalar(Math.cos(angle)).addScaledVector(north.clone().cross(normal), Math.sin(angle));
}

/** Degrees clockwise from north of a tangent at `normal`, in [0, 360). */
export function headingOf(normal: Vector3, tangent: Vector3): number {
	const north = northTangent(normal);
	const deg = (Math.atan2(tangent.dot(north.clone().cross(normal)), tangent.dot(north)) * 180) / Math.PI;
	return (deg + 360) % 360;
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
 * the range rises in an arc. A raised gaze is eased on top of the look at the target.
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
	readonly #floor: number;
	readonly #fromLook: Quaternion;
	readonly #fromGaze: number;
	readonly #toGaze: number;

	constructor(from: CameraPose, to: CameraPose, radius: number, duration?: number) {
		this.#floor = radius + kmToWorld(CAMERA_FLOOR_KM, radius);
		this.#from = from;
		this.#to = to;
		this.#fromGaze = from.gaze ?? 0;
		this.#toGaze = to.gaze ?? 0;
		this.#fromLook = raiseGaze(from.quaternion.clone(), -this.#fromGaze);
		this.#fromDir = (from.target.lengthSq() > 0 ? from.target : from.position).clone().normalize();
		this.#toDir = (to.target.lengthSq() > 0 ? to.target : to.position).clone().normalize();
		this.#angle = this.#fromDir.angleTo(this.#toDir);
		this.#fromRange = from.position.distanceTo(from.target);
		this.#toRange = to.position.distanceTo(to.target);
		this.#arc = FLIGHT.arcPerRadian * radius * this.#angle;
		this.duration = duration ?? flightDuration(this.#angle);
		const axis = this.#fromDir.clone().cross(this.#toDir);
		this.#axis = axis.lengthSq() > 1e-12 ? axis.normalize() : northTangent(this.#fromDir).cross(this.#fromDir).normalize();
		this.#residual = this.#carried(1).invert().multiply(raiseGaze(to.quaternion.clone(), -this.#toGaze));
	}

	/** Start orientation rotated along the great circle by a fraction `e` of the trip. */
	#carried(e: number): Quaternion {
		return new Quaternion().setFromAxisAngle(this.#axis, this.#angle * e).multiply(this.#fromLook);
	}

	/** Pose at `elapsed` milliseconds into the flight. */
	at(elapsed: number): CameraPose {
		const t = this.duration > 0 ? Math.min(Math.max(elapsed / this.duration, 0), 1) : 1;
		const e = easeInOut(t);
		const look = this.#carried(e).multiply(new Quaternion().slerp(this.#residual, e));
		const anchor = slerpDirection(this.#fromDir, this.#toDir, this.#angle, e).multiplyScalar(
			lerp(this.#from.target.length(), this.#to.target.length(), e),
		);
		const back = new Vector3(0, 0, 1).applyQuaternion(look);
		const range = Math.max(lerp(this.#fromRange, this.#toRange, e) + this.#arc * Math.sin(Math.PI * t), rangeToHeight(anchor, back, this.#floor));
		const gaze = lerp(this.#fromGaze, this.#toGaze, e);
		return { position: anchor.clone().addScaledVector(back, range), target: anchor, quaternion: raiseGaze(look, gaze), gaze };
	}
}

/** Distance along `back` from `anchor` at which the camera reaches `distance` from the globe centre. */
function rangeToHeight(anchor: Vector3, back: Vector3, distance: number): number {
	const b = anchor.dot(back);
	return -b + Math.sqrt(Math.max(b * b - anchor.lengthSq() + distance * distance, 0));
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
