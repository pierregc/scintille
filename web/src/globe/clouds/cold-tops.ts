import { AdditiveBlending, Color, InstancedBufferAttribute, InstancedBufferGeometry, Mesh, PlaneGeometry, ShaderMaterial, Vector3 } from 'three';
import { CLOUD_ARCHIVE_RULES } from '../../contract/cloud-archive';
import { kmToWorld } from '../flight';
import { latLonToVector } from '../sun';
import { boundedBody } from './response';

/** Cold cloud tops where no lightning source sees: soft, slow glows, never flashes (ADR 0038). Tuning ranges in brackets. */
export const COLD_TOPS = {
	/** Height of the glows, km, near the tops they stand for [11 to 15]. */
	heightKm: 13,
	/** Glow radius of a fully cold cell, km: twice the spacing of the cells, so their lattice melts into one glow [60 to 100]. */
	radiusKm: 80,
	/** Opacity of one cell at night; neighbours overlap about four deep [0.08 to 0.16]. */
	opacity: 0.12,
	/** Share kept on the day side [0.3 to 0.6]. */
	dayLevel: 0.45,
	/** One slow breath, seconds; reduced motion holds it steady [5 to 9]. */
	periodS: 7,
	color: '#c9cdff',
	/** Files kept in memory: the two frames shown and their neighbours. */
	cached: 4,
} as const;

/** Rows of `[lat, lon, cold, min_bt_k]`, flattened; throws on anything else. */
export function parseColdTops(json: unknown): Float32Array {
	const tops = (json as { tops?: unknown } | null)?.tops;
	if (!Array.isArray(tops)) throw new Error('cold tops: missing rows');
	const out = new Float32Array(tops.length * 4);
	tops.forEach((row, i) => {
		if (!Array.isArray(row) || row.length !== 4 || !row.every((v) => typeof v === 'number' && Number.isFinite(v))) {
			throw new Error('cold tops: invalid row');
		}
		out.set(row as number[], i * 4);
	});
	return out;
}

export async function loadColdTops(url: string, get: typeof fetch = fetch): Promise<Float32Array> {
	const response = await get(url);
	if (!response.ok) throw new Error('cold tops unavailable');
	const bytes = await boundedBody(response, CLOUD_ARCHIVE_RULES.max_cold_tops_bytes);
	return parseColdTops(JSON.parse(new TextDecoder().decode(bytes)));
}

/** How much a cell glows, 0 to 1: its cold share, and how far under 215 K its coldest pixel is. */
export function glowStrength(cold: number, minBt: number): number {
	const depth = Math.min(Math.max((215 - minBt) / 20, 0), 1);
	return Math.sqrt(Math.min(Math.max(cold, 0), 1)) * (0.55 + 0.45 * depth);
}

/** Phase of a cell's breath, 0 to 1: smooth over the globe, so a storm breathes as one. */
export function breathPhase(lat: number, lon: number): number {
	const rad = Math.PI / 180;
	return 0.5 + 0.25 * Math.sin(lat * rad * 7) + 0.25 * Math.sin(lon * rad * 5);
}

const vertexShader = /* glsl */ `
attribute vec3 center;
attribute vec3 glow;
uniform float mixB;
uniform float time;
uniform float breathe;
uniform float radius;
uniform float opacity;
uniform float dayLevel;
uniform vec3 sun;
varying vec2 vUv;
varying float vAlpha;
void main() {
	vec3 up = normalize(center);
	vec3 east = normalize(vec3(up.z, 0.0, -up.x));
	vec3 north = cross(up, east);
	vec3 local = center + (east * position.x + north * position.y) * radius * (0.6 + 0.4 * glow.x);
	vec4 world = modelMatrix * vec4(local, 1.0);
	gl_Position = projectionMatrix * viewMatrix * world;
	vUv = position.xy;
	float facing = dot(up, normalize(cameraPosition - world.xyz));
	float day = smoothstep(-0.05, 0.25, dot(up, sun));
	float weight = glow.z < 0.5 ? 1.0 - mixB : mixB;
	float breath = mix(1.0, 0.7 + 0.3 * sin(6.28318531 * (time + glow.y)), breathe);
	vAlpha = opacity * glow.x * weight * breath * smoothstep(0.0, 0.25, facing) * mix(1.0, dayLevel, day);
}
`;

const fragmentShader = /* glsl */ `
uniform vec3 color;
varying vec2 vUv;
varying float vAlpha;
void main() {
	float r2 = dot(vUv, vUv);
	if (r2 > 1.0 || vAlpha <= 0.0) discard;
	float k = 1.0 - r2;
	gl_FragColor = vec4(color, vAlpha * k * k);
	#include <colorspace_fragment>
}
`;

export interface ColdTopsLayer {
	readonly mesh: Mesh;
	/** Shows the frames' cells, crossfaded. */
	update(state: {
		frames: { a: string | null; b: string | null; mix: number } | null;
		wallMs: number;
		sun: readonly [number, number, number];
		steady: boolean;
	}): void;
	dispose(): void;
}

export interface ColdTopsOptions {
	radius?: number;
	load?: (url: string) => Promise<Float32Array>;
	onError?: (error: unknown) => void;
}

export function createColdTops({ radius = 1, load = (url) => loadColdTops(url), onError = () => {} }: ColdTopsOptions = {}): ColdTopsLayer {
	const quad = new PlaneGeometry(2, 2);
	const geometry = new InstancedBufferGeometry();
	geometry.index = quad.index;
	geometry.setAttribute('position', quad.getAttribute('position'));
	const material = new ShaderMaterial({
		vertexShader,
		fragmentShader,
		uniforms: {
			mixB: { value: 0 },
			time: { value: 0 },
			breathe: { value: 1 },
			radius: { value: kmToWorld(COLD_TOPS.radiusKm, radius) },
			opacity: { value: COLD_TOPS.opacity },
			dayLevel: { value: COLD_TOPS.dayLevel },
			sun: { value: new Vector3(1, 0, 0) },
			color: { value: new Color(COLD_TOPS.color) },
		},
		blending: AdditiveBlending,
		transparent: true,
		depthWrite: false,
	});
	const mesh = new Mesh(geometry, material);
	mesh.frustumCulled = false;
	mesh.renderOrder = 0.25;
	mesh.visible = false;

	const files = new Map<string, Float32Array | null>();
	const pending = new Set<string>();
	let wanted: (string | null)[] = [];
	let built = '';
	let disposed = false;
	const shell = radius + kmToWorld(COLD_TOPS.heightKm, radius);

	const fetchFile = (url: string) => {
		if (files.has(url) || pending.has(url)) return;
		pending.add(url);
		load(url)
			.then((rows) => { files.set(url, rows); }, (error: unknown) => { files.set(url, null); onError(error); })
			.finally(() => {
				pending.delete(url);
				for (const key of files.keys()) {
					if (files.size <= COLD_TOPS.cached) break;
					if (!wanted.includes(key)) files.delete(key);
				}
			});
	};

	const build = (sets: (Float32Array | null)[]) => {
		const count = sets.reduce((n, rows) => n + (rows ? rows.length / 4 : 0), 0);
		const center = new Float32Array(count * 3);
		const glow = new Float32Array(count * 3);
		let i = 0;
		sets.forEach((rows, frame) => {
			if (!rows) return;
			for (let r = 0; r < rows.length; r += 4, i++) {
				const [x, y, z] = latLonToVector(rows[r], rows[r + 1]);
				center.set([x * shell, y * shell, z * shell], i * 3);
				glow.set([glowStrength(rows[r + 2], rows[r + 3]), breathPhase(rows[r], rows[r + 1]), frame], i * 3);
			}
		});
		geometry.setAttribute('center', new InstancedBufferAttribute(center, 3));
		geometry.setAttribute('glow', new InstancedBufferAttribute(glow, 3));
		geometry.instanceCount = count;
	};

	return {
		mesh,
		update({ frames, wallMs, sun, steady }) {
			if (disposed) return;
			const urls = frames ? [frames.a, frames.b === frames.a ? null : frames.b] : [];
			wanted = urls;
			for (const url of urls) if (url) fetchFile(url);
			const sets = urls.map((url) => (url ? (files.get(url) ?? null) : null));
			const key = urls.map((url, i) => (url && sets[i] ? url : '')).join('|');
			if (key !== built) {
				built = key;
				build(sets);
			}
			const u = material.uniforms;
			u.mixB.value = frames && frames.b !== frames.a ? frames.mix : 0;
			u.time.value = wallMs / 1000 / COLD_TOPS.periodS;
			u.breathe.value = steady ? 0 : 1;
			u.sun.value.set(...sun);
			mesh.visible = key.replace(/\|/g, '') !== '';
		},
		dispose() {
			disposed = true;
			geometry.dispose();
			quad.dispose();
			material.dispose();
		},
	};
}
