import { BufferGeometry, Float32BufferAttribute, Group, LineBasicMaterial, LineSegments, Points, PointsMaterial, Vector3 } from 'three';
import type { StormDetail, StormTrackPoint } from '../../contract/types';
import { kmToWorld } from '../flight';
import { latLonToVector } from '../sun';

/** Centroid observations can be an hour apart; larger gaps remain disconnected. */
export const TRACK_MAX_GAP_MS = 2 * 3_600_000;
const COLORS = ['#9faab8', '#a9b9c7', '#b0c9de', '#c3d6eb', '#ddd8ec'];

interface TrackGeometry {
	positions: number[];
	observations: number[];
	times: number[];
	ends: number[];
}

/** Great-circle connectors are explanatory paths, revealed only when both endpoints were observed. */
export function trackGeometry(track: readonly StormTrackPoint[], radius: number): TrackGeometry {
	const positions: number[] = [];
	const observations: number[] = [];
	const times: number[] = [];
	const ends: number[] = [];
	let previous: { point: Vector3; time: number } | undefined;
	const ordered = [...track].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
	for (const sample of ordered) {
		const time = Date.parse(sample.time);
		if (!Number.isFinite(time) || !Number.isFinite(sample.lat) || !Number.isFinite(sample.lon) ||
			Math.abs(sample.lat) > 90 || Math.abs(sample.lon) > 180) { previous = undefined; continue; }
		const point = new Vector3(...latLonToVector(sample.lat, sample.lon));
		observations.push(...point.clone().multiplyScalar(radius).toArray());
		if (previous) {
			const from = previous.point;
			const angle = from.angleTo(point);
			if (time > previous.time && time - previous.time <= TRACK_MAX_GAP_MS && angle < Math.PI / 2) {
				const steps = Math.max(1, Math.ceil(angle / (Math.PI / 180)));
				const sin = Math.sin(angle);
				const at = (t: number) => angle < 1e-6 ? point.clone() : from.clone()
					.multiplyScalar(Math.sin((1 - t) * angle) / sin).addScaledVector(point, Math.sin(t * angle) / sin).normalize();
				for (let i = 0; i < steps; i++) {
					positions.push(...at(i / steps).multiplyScalar(radius).toArray(), ...at((i + 1) / steps).multiplyScalar(radius).toArray());
				}
			}
		}
		times.push(time);
		ends.push(positions.length / 3);
		previous = { point, time };
	}
	return { positions, observations, times, ends };
}

export function trackCaption(detail: StormDetail): string {
	return `Observed track · ${detail.storm.level_name} electrical activity (whole storm)`;
}

function observedCount(times: readonly number[], time: number): number {
	let lo = 0, hi = times.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (times[mid] <= time) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

export class StormTrack {
	readonly group = new Group();
	readonly #line = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ transparent: true, opacity: 0.4, depthWrite: false }));
	readonly #points = new Points(new BufferGeometry(), new PointsMaterial({ size: 3, sizeAttenuation: false, transparent: true, opacity: 0.65, depthWrite: false }));
	#selected: StormDetail | null = null;
	#times: number[] = [];
	#ends: number[] = [];

	constructor(readonly radius = 1) {
		this.group.add(this.#line, this.#points);
		this.group.visible = false;
	}

	setStorm(detail: StormDetail | null): void {
		if (detail === this.#selected) return;
		this.#selected = detail;
		this.#line.geometry.dispose();
		this.#points.geometry.dispose();
		const geometry = trackGeometry(detail?.track ?? [], this.radius + kmToWorld(20, this.radius));
		this.#times = geometry.times;
		this.#ends = geometry.ends;
		this.#line.geometry = new BufferGeometry().setAttribute('position', new Float32BufferAttribute(geometry.positions, 3));
		this.#points.geometry = new BufferGeometry().setAttribute('position', new Float32BufferAttribute(geometry.observations, 3));
		const color = COLORS[(detail?.storm.level ?? 0) - 1] ?? '#9faab8';
		this.#line.material.color.set(color);
		this.#points.material.color.set(color);
		this.setTime(-Infinity);
	}

	setTime(time: number): void {
		const count = observedCount(this.#times, time);
		this.#line.geometry.setDrawRange(0, this.#ends[count - 1] ?? 0);
		this.#points.geometry.setDrawRange(0, count);
		this.group.visible = count > 0;
	}

	dispose(): void {
		this.#line.geometry.dispose();
		this.#points.geometry.dispose();
		this.#line.material.dispose();
		this.#points.material.dispose();
		this.group.removeFromParent();
		this.group.clear();
		this.#selected = null;
		this.#times = [];
		this.#ends = [];
	}
}
