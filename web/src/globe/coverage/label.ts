import { type Camera, Ray, Raycaster, Sphere, Vector2, Vector3 } from 'three';

const RAD = 180 / Math.PI;
const TAP_SLOP_PX = 8;
const OFFSET_PX = 14;

/** Latitude and longitude under normalized device coordinates, or null off the globe. */
export function surfacePoint(ndc: Vector2, camera: Camera, radius: number): { lat: number; lon: number } | null {
	const raycaster = new Raycaster();
	raycaster.setFromCamera(ndc, camera);
	const hit = (raycaster.ray as Ray).intersectSphere(new Sphere(new Vector3(), radius), new Vector3());
	if (!hit) return null;
	hit.divideScalar(radius);
	return { lat: Math.asin(Math.max(-1, Math.min(1, hit.y))) * RAD, lon: Math.atan2(-hit.z, hit.x) * RAD };
}

export interface CoverageLabelOptions {
	canvas: HTMLCanvasElement;
	label: HTMLElement;
	camera: Camera;
	radius: number;
	/** What the label says at a point: the gap, storms from cold cloud tops, or nothing. */
	at(lat: number, lon: number): 'gap' | 'storms' | null;
}

/** Shows the coverage label on hover (mouse) or tap (touch) over a gap; returns the detach function. */
export function attachCoverageLabel({ canvas, label, camera, radius, at }: CoverageLabelOptions): () => void {
	let down: { x: number; y: number } | undefined;

	const kindUnder = (x: number, y: number) => {
		const rect = canvas.getBoundingClientRect();
		const ndc = new Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
		const point = surfacePoint(ndc, camera, radius);
		return point ? at(point.lat, point.lon) : null;
	};

	const show = (x: number, y: number, kind: 'gap' | 'storms') => {
		label.dataset.kind = kind;
		label.hidden = false;
		const width = label.offsetWidth;
		const height = label.offsetHeight;
		const left = Math.min(x + OFFSET_PX, window.innerWidth - width - 8);
		const top = Math.min(y + OFFSET_PX, window.innerHeight - height - 8);
		label.style.transform = `translate(${Math.max(8, left)}px, ${Math.max(8, top)}px)`;
	};

	const onMove = (event: PointerEvent) => {
		if (event.pointerType === 'touch' || event.buttons !== 0) return;
		const kind = kindUnder(event.clientX, event.clientY);
		if (kind) show(event.clientX, event.clientY, kind);
		else label.hidden = true;
	};
	const onDown = (event: PointerEvent) => {
		down = { x: event.clientX, y: event.clientY };
		if (event.pointerType === 'touch') label.hidden = true;
	};
	const onUp = (event: PointerEvent) => {
		const start = down;
		down = undefined;
		if (event.pointerType !== 'touch' || !start) return;
		if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > TAP_SLOP_PX) return;
		const kind = kindUnder(event.clientX, event.clientY);
		if (kind) show(event.clientX, event.clientY, kind);
	};
	// A touch pointer leaves right after every tap.
	const onLeave = (event: PointerEvent) => {
		if (event.pointerType !== 'touch') label.hidden = true;
	};

	canvas.addEventListener('pointermove', onMove);
	canvas.addEventListener('pointerdown', onDown);
	canvas.addEventListener('pointerup', onUp);
	canvas.addEventListener('pointerleave', onLeave);
	return () => {
		label.hidden = true;
		canvas.removeEventListener('pointermove', onMove);
		canvas.removeEventListener('pointerdown', onDown);
		canvas.removeEventListener('pointerup', onUp);
		canvas.removeEventListener('pointerleave', onLeave);
	};
}
