import { BufferGeometry, Color, Float32BufferAttribute, Group, LineLoop, ShaderMaterial, Vector2, Vector3 } from 'three';
import { kmToWorld } from '../flight';
import { trackColor } from '../replay/track';
import { latLonToVector } from '../sun';
import type { Footprint } from './subject';

/** Light line over a 1 px dark shadow, so it reads over sunlit clouds and the night side alike. */
export const FOOTPRINT = { opacity: 0.6, shadow: 0.4, fadeMs: 500, heightKm: 20, discSegments: 96, dashes: 48 };

const EARTH_KM = 6371;

const vertexShader = /* glsl */ `
	attribute float lineDistance;
	uniform vec2 uOffset;
	uniform vec2 uViewport;
	varying float vDistance;
	void main() {
		vDistance = lineDistance;
		vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
		clip.xy += uOffset * 2.0 / uViewport * clip.w;
		gl_Position = clip;
	}
`;

const fragmentShader = /* glsl */ `
	uniform vec3 uColor;
	uniform float uOpacity;
	uniform vec2 uDash;
	varying float vDistance;
	void main() {
		if (uDash.y > 0.0 && mod(vDistance, uDash.y) > uDash.x) discard;
		gl_FragColor = vec4(uColor, uOpacity);
		#include <colorspace_fragment>
	}
`;

function outlineMaterial(color: string, offset: Vector2, viewport: Vector2, dash: number): ShaderMaterial {
	return new ShaderMaterial({
		vertexShader,
		fragmentShader,
		transparent: true,
		depthWrite: false,
		uniforms: {
			uColor: { value: new Color(color) },
			uOpacity: { value: 0 },
			uOffset: { value: offset },
			uViewport: { value: viewport },
			uDash: { value: new Vector2(dash, dash * 2) },
		},
	});
}

/** Points of a footprint ring on a sphere of `radius`; hull longitudes may run past ±180. */
export function footprintRing(footprint: Footprint, radius: number): Vector3[] {
	if (footprint.kind === 'hull') {
		const ring = footprint.ring;
		const last = ring.at(-1);
		const open = last && ring.length > 1 && ring[0][0] === last[0] && ring[0][1] === last[1] ? ring.slice(0, -1) : ring;
		return open.map(([lon, lat]) => new Vector3(...latLonToVector(lat, lon)).multiplyScalar(radius));
	}
	const centre = new Vector3(...latLonToVector(footprint.lat, footprint.lon));
	const north = new Vector3(0, 1, 0).projectOnPlane(centre);
	if (north.lengthSq() < 1e-10) north.set(1, 0, 0);
	north.normalize();
	const east = north.clone().cross(centre);
	const angle = footprint.radiusKm / EARTH_KM;
	const points: Vector3[] = [];
	for (let i = 0; i < FOOTPRINT.discSegments; i++) {
		const a = (i / FOOTPRINT.discSegments) * 2 * Math.PI;
		const tangent = north.clone().multiplyScalar(Math.cos(a)).addScaledVector(east, Math.sin(a));
		points.push(centre.clone().multiplyScalar(Math.cos(angle)).addScaledVector(tangent, Math.sin(angle)).multiplyScalar(radius));
	}
	return points;
}

function key(footprint: Footprint | null): string {
	if (!footprint) return '';
	if (footprint.kind === 'disc') return `d${footprint.lat},${footprint.lon},${footprint.radiusKm}`;
	return `h${footprint.ring.map((p) => p.join(',')).join(';')}`;
}

interface Outline {
	group: Group;
	geometry: BufferGeometry;
	light: ShaderMaterial;
	shadow: ShaderMaterial;
	start: number;
	leaving: number | null;
}

/**
 * Thin outline of the selected storm's footprint at the scene time: solid for an observed hull,
 * dashed for a circle of the observed area. Changes fade in and out.
 */
export class FootprintLayer {
	readonly group = new Group();
	/** CSS size of the view, for the shadow offset. */
	readonly viewport = new Vector2(1, 1);
	#key = '';
	#outlines: Outline[] = [];

	constructor(readonly radius = 1) {}

	/** Outlines drawn, fading ones included. */
	get size(): number { return this.#outlines.length; }

	set(footprint: Footprint | null, level: number, now: number): void {
		const next = key(footprint);
		if (next === this.#key) return;
		this.#key = next;
		for (const outline of this.#outlines) outline.leaving ??= now;
		if (!footprint) return;
		const points = footprintRing(footprint, this.radius + kmToWorld(FOOTPRINT.heightKm, this.radius));
		const distances = [0];
		for (let i = 1; i <= points.length; i++) distances.push(distances[i - 1] + points[i - 1].distanceTo(points[i % points.length]));
		const geometry = new BufferGeometry()
			.setAttribute('position', new Float32BufferAttribute(points.flatMap((p) => p.toArray()), 3))
			.setAttribute('lineDistance', new Float32BufferAttribute(distances.slice(0, -1), 1));
		const dash = footprint.kind === 'disc' ? (distances.at(-1) ?? 0) / FOOTPRINT.dashes / 2 : 0;
		const light = outlineMaterial(trackColor(level), new Vector2(0, 0), this.viewport, dash);
		const shadow = outlineMaterial('#000000', new Vector2(0, -1), this.viewport, dash);
		const group = new Group();
		for (const material of [shadow, light]) group.add(new LineLoop(geometry, material));
		this.group.add(group);
		this.#outlines.push({ group, geometry, light, shadow, start: now, leaving: null });
	}

	update(now: number): void {
		this.#outlines = this.#outlines.filter((outline) => {
			const fadeIn = Math.min(Math.max((now - outline.start) / FOOTPRINT.fadeMs, 0), 1);
			const fadeOut = outline.leaving === null ? 1 : 1 - Math.min(Math.max((now - outline.leaving) / FOOTPRINT.fadeMs, 0), 1);
			const fade = Math.min(fadeIn, fadeOut);
			outline.light.uniforms.uOpacity.value = FOOTPRINT.opacity * fade;
			outline.shadow.uniforms.uOpacity.value = FOOTPRINT.shadow * fade;
			if (fadeOut > 0) return true;
			this.#release(outline);
			return false;
		});
	}

	#release(outline: Outline): void {
		outline.group.removeFromParent();
		outline.geometry.dispose();
		outline.light.dispose();
		outline.shadow.dispose();
	}

	clear(): void {
		for (const outline of this.#outlines) this.#release(outline);
		this.#outlines = [];
		this.#key = '';
	}

	dispose(): void {
		this.clear();
		this.group.removeFromParent();
	}
}
