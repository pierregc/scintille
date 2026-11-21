import { AdditiveBlending, Color, Data3DTexture, FrontSide, LinearFilter, Mesh, NoColorSpace, RedFormat, RepeatWrapping, ShaderMaterial, SphereGeometry, TextureLoader, Vector3 } from 'three';
import { kmToWorld } from '../flight';

/** Spike: wind drawn as brushed fibres (line integral convolution of noise along the flow), not particles. */
export const WIND_LOOKS = {
	/** Whole field as a faint brushed veil. */
	silk: { level: '10m', scale: 40, heightKm: 16, calm: 3, full: 16, sparse: 0, soft: 3.2, gain: 0.12, day: 0.9, cellPx: 2.4, reach: 1.3, color: '#dfe8ff' },
	/** Only the jet streams, as high ribbons. */
	jet: { level: '250', scale: 120, heightKm: 22, calm: 28, full: 70, sparse: 0.3, soft: 2, gain: 0.6, day: 0.55, cellPx: 2.6, reach: 1.5, color: '#d9dcff' },
} as const;

export type WindLook = keyof typeof WIND_LOOKS;

const STEPS = 14;
const EARTH_RADIUS_KM = 6371;

const vertexShader = /* glsl */ `
varying vec3 vDir;
varying vec3 vWorld;
void main() {
	vDir = normalize(position);
	vec4 world = modelMatrix * vec4(position, 1.0);
	vWorld = world.xyz;
	gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const fragmentShader = /* glsl */ `
precision highp sampler3D;
uniform sampler2D windMap;
uniform sampler3D noiseMap;
uniform vec2 grid;
uniform float windScale;
uniform float cells;
uniform float calm;
uniform float full;
uniform float sparse;
uniform float soft;
uniform float reachScale;
uniform float gain;
uniform float time;
uniform float dayLevel;
uniform float near;
uniform vec3 sun;
uniform vec3 color;
varying vec3 vDir;
varying vec3 vWorld;

const int STEPS = ${STEPS};
const float PI = 3.14159265;

vec2 windAt(vec3 p) {
	float lon = atan(-p.z, p.x);
	float lat = asin(clamp(p.y, -1.0, 1.0));
	vec2 uv = vec2(fract(lon / (2.0 * PI)) + 0.5 / grid.x, (lat / PI + 0.5) * (grid.y - 1.0) / grid.y + 0.5 / grid.y);
	return (texture2D(windMap, uv).rg * 255.0 - 127.5) / 127.5 * windScale;
}

vec3 flowAt(vec3 p, out float speed) {
	vec2 w = windAt(p);
	speed = length(w);
	vec3 east = normalize(vec3(p.z, 0.0, -p.x) + vec3(1e-6, 0.0, 0.0));
	vec3 north = cross(p, east);
	return (east * w.x + north * w.y) / max(speed, 1e-3);
}

float grain(vec3 p, float lo, float blend) {
	float a = texture(noiseMap, p * lo / 64.0).r;
	float b = texture(noiseMap, p * lo * 2.0 / 64.0 + 0.37).r;
	return mix(a, b, blend);
}

void main() {
	vec3 p0 = normalize(vDir);
	float octave = log2(cells);
	float lo = exp2(floor(octave));
	float blend = fract(octave);
	float cell = 1.0 / (lo * mix(1.0, 2.0, blend));

	float speed0;
	vec3 dir0 = flowAt(p0, speed0);
	float strength = smoothstep(calm, full, speed0);
	if (strength <= 0.0) discard;

	float reach = 0.35 + 0.65 * strength;
	float h = cell * 0.9 * reach * reachScale;
	float phase = texture(noiseMap, p0 * lo / 64.0 / 12.0 + 0.11).r * 3.0;

	float t1 = fract(time + phase);
	float t2 = fract(t1 + 0.5);
	float w1 = 1.0 - abs(2.0 * t1 - 1.0);
	float w2 = 1.0 - w1;
	vec3 drift = dir0 * (cell * 12.0 * strength);
	vec3 d1 = drift * (t1 - 0.5);
	vec3 d2 = drift * (t2 - 0.5) + 0.5;

	float sum = 0.0;
	float weight = 0.0;
	for (int side = 0; side < 2; side++) {
		float sign = side == 0 ? 1.0 : -1.0;
		vec3 p = p0;
		vec3 dir = dir0;
		for (int i = 0; i < STEPS; i++) {
			p = normalize(p + dir * (sign * h));
			float s = (float(i) + 1.0) / float(STEPS);
			float speed;
			if (i % 2 == 1) dir = flowAt(p, speed);
			float k = 0.5 + 0.5 * cos(PI * s);
			sum += (grain(p - d1, lo, blend) * w1 + grain(p - d2, lo, blend) * w2) * k;
			weight += k;
		}
	}
	float lic = 0.5 + (sum / max(weight, 1e-3) - 0.5) / sqrt(w1 * w1 + w2 * w2);
	float spread = 0.5 / sqrt(float(STEPS));
	float fibre = smoothstep(0.5 + spread * (sparse * 2.2 - 0.3 * soft), 0.5 + spread * (sparse * 2.2 + 0.7 * soft), lic);

	vec3 view = normalize(cameraPosition - vWorld);
	float facing = smoothstep(0.1, 0.5, dot(p0, view));
	float day = smoothstep(-0.1, 0.25, dot(p0, sun));
	float alpha = gain * near * fibre * strength * facing * mix(1.0, dayLevel, day);
	gl_FragColor = vec4(color * alpha, alpha);
	#include <colorspace_fragment>
}
`;

function noiseTexture(size = 64): Data3DTexture {
	const data = new Uint8Array(size ** 3);
	let seed = 0x2545f491;
	for (let i = 0; i < data.length; i++) {
		seed ^= seed << 13;
		seed ^= seed >>> 17;
		seed ^= seed << 5;
		data[i] = seed & 255;
	}
	const texture = new Data3DTexture(data, size, size, size);
	texture.format = RedFormat;
	texture.minFilter = texture.magFilter = LinearFilter;
	texture.wrapS = texture.wrapT = texture.wrapR = RepeatWrapping;
	texture.needsUpdate = true;
	return texture;
}

export interface Wind {
	readonly mesh: Mesh;
	update(state: { kmPerPx: number; wallMs: number; sun: readonly [number, number, number]; steady: boolean }): void;
	dispose(): void;
}

export function windLookFromSearch(search: string): WindLook | null {
	const value = new URLSearchParams(search).get('wind');
	return value && value in WIND_LOOKS ? (value as WindLook) : null;
}

export function createWind(look: WindLook, radius = 1, baseUrl = '/_wind/'): Wind {
	const preset: Record<string, string | number> = { ...WIND_LOOKS[look] };
	for (const [key, value] of new URLSearchParams(location.search)) {
		if (key.startsWith('wind.') && key.slice(5) in preset) preset[key.slice(5)] = Number.isNaN(Number(value)) ? value : Number(value);
	}
	const n = (key: string) => Number(preset[key]);
	const geometry = new SphereGeometry(radius + kmToWorld(n('heightKm'), radius), 128, 64);
	const noise = noiseTexture();
	const material = new ShaderMaterial({
		vertexShader,
		fragmentShader,
		uniforms: {
			windMap: { value: null },
			noiseMap: { value: noise },
			grid: { value: [720, 361] },
			windScale: { value: n('scale') },
			cells: { value: 256 },
			calm: { value: n('calm') },
			full: { value: n('full') },
			sparse: { value: n('sparse') },
			soft: { value: n('soft') },
			reachScale: { value: n('reach') },
			gain: { value: n('gain') },
			time: { value: 0 },
			dayLevel: { value: n('day') },
			near: { value: 1 },
			sun: { value: new Vector3(1, 0, 0) },
			color: { value: new Color(String(preset.color)) },
		},
		blending: AdditiveBlending,
		premultipliedAlpha: true,
		transparent: true,
		depthWrite: false,
		side: FrontSide,
	});
	const mesh = new Mesh(geometry, material);
	mesh.renderOrder = 0.3;
	mesh.visible = false;
	const map = new TextureLoader().load(`${baseUrl}${String(preset.level)}.png`, () => {
		mesh.visible = true;
	});
	map.colorSpace = NoColorSpace;
	map.minFilter = map.magFilter = LinearFilter;
	map.generateMipmaps = false;
	map.wrapS = RepeatWrapping;
	material.uniforms.windMap.value = map;

	return {
		mesh,
		update({ kmPerPx, wallMs, sun, steady }) {
			const u = material.uniforms;
			const cellKm = Math.min(Math.max(kmPerPx * n('cellPx'), 1.5), 60);
			u.cells.value = EARTH_RADIUS_KM / cellKm;
			u.time.value = steady ? 0 : (wallMs / 1000 / 8) % 4096;
			u.near.value = 0.3 + 0.7 * Math.min(Math.max((kmPerPx - 1.5) / 6.5, 0), 1);
			u.sun.value.set(...sun);
		},
		dispose() {
			geometry.dispose();
			material.dispose();
			noise.dispose();
			map.dispose();
		},
	};
}
