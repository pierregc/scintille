import {
	BufferAttribute, BufferGeometry, Color, CustomBlending, Group, InstancedBufferAttribute, InstancedBufferGeometry, LineSegments, Mesh,
	OneFactor, OneMinusSrcAlphaFactor, type PerspectiveCamera, PlaneGeometry, ShaderMaterial, Vector2, Vector3, Vector4,
} from 'three';
import { kmToWorld } from '../flight';
import { latLonToVector } from '../sun';
import { type Cyclone, type CycloneFeed, type CycloneSample, cycloneKind, parseCycloneFeed, sampleCyclone, windKmh } from './track';

/** Spike: tropical cyclones as a thin turning ring on their clouds. Tuning ranges in brackets. */
export const CYCLONES = {
	/** Height of the ring, km, on the cloud tops. */
	heightKm: 14,
	/** Ring radius when the advisory gives no gale radius, km. */
	defaultRadiusKm: 120,
	/** The ring never gets smaller than this on screen, px, so a storm shows from far [10 to 18]. */
	minRadiusPx: 13,
	/** Line width, px [1 to 1.6]. */
	linePx: 1.2,
	/** Soft dark edge under the line, at night and on sunlit clouds, where a pale line alone is lost [0.15 to 0.4, 0.5 to 0.8]. */
	shade: [0.28, 0.6],
	/** Half width of that edge, px [2 to 4]. */
	shadePx: 3,
	/** One turn of the arms, seconds; reduced motion holds them [40 to 120]. */
	periodS: 70,
	/** Past track kept behind the storm, hours. */
	trailH: 96,
	trailOpacity: 0.42,
	/** Share of the ring kept for a tropical depression [0.4 to 0.7]. */
	depression: 0.55,
	color: '#eef2f7',
	refreshMs: 30 * 60_000,
	maxBytes: 262_144,
} as const;

const RING = 0.62;
const MAX = 24;

const vertexShader = /* glsl */ `
attribute vec3 center;
attribute vec3 look;
uniform vec3 sun;
varying vec2 vUv;
varying float vSpin;
varying float vAlpha;
varying float vDay;
void main() {
	vec3 up = normalize(center);
	vec3 east = normalize(vec3(up.z, 0.0, -up.x));
	vec3 north = cross(up, east);
	vec3 local = center + (east * position.x + north * position.y) * look.x;
	vec4 world = modelMatrix * vec4(local, 1.0);
	gl_Position = projectionMatrix * viewMatrix * world;
	vUv = position.xy;
	vSpin = look.y;
	float facing = dot(up, normalize(cameraPosition - world.xyz));
	vAlpha = look.z * smoothstep(0.02, 0.2, facing);
	vDay = smoothstep(-0.05, 0.25, dot(up, sun));
}
`;

const fragmentShader = /* glsl */ `
uniform vec3 color;
uniform float linePx;
uniform vec2 shade;
uniform float shadePx;
uniform float turn;
uniform float arms;
varying vec2 vUv;
varying float vSpin;
varying float vAlpha;
varying float vDay;
const float RING = ${RING};
float stroke(float d, float px) {
	return 1.0 - smoothstep(px - 0.6, px + 0.6, d);
}
float soft(float d) {
	return exp(-d * d / (shadePx * shadePx));
}
void main() {
	float r = length(vUv);
	if (r > 1.0 || vAlpha <= 0.0) discard;
	float unit = max(fwidth(r), 1e-5);
	float d = abs(r - RING) / unit;
	// Two arms leave the ring and trail behind the rotation: counter clockwise in the north, clockwise in the south.
	float s = clamp((r - RING) / (1.0 - RING), 0.0, 1.0);
	float along = atan(vUv.y, vUv.x) - vSpin * (turn - 1.5 * s);
	float off = abs(mod(along + 1.57079633, 3.14159265) - 1.57079633) * r / unit;
	float arm = arms * step(RING, r) * pow(1.0 - s, 1.4);
	float line = max(stroke(d, linePx * 0.5), arm * stroke(off, linePx * 0.5));
	float dark = mix(shade.x, shade.y, vDay) * max(soft(d), arm * soft(off));
	gl_FragColor = vec4(color * line * vAlpha, max(line, dark) * vAlpha);
	#include <colorspace_fragment>
}
`;

const trailVertex = /* glsl */ `
attribute float age;
attribute float storm;
uniform vec4 hubs[MAX];
varying float vAge;
varying float vFacing;
varying vec3 vPoint;
varying vec4 vHub;
void main() {
	vec4 world = modelMatrix * vec4(position, 1.0);
	gl_Position = projectionMatrix * viewMatrix * world;
	vAge = age;
	vFacing = dot(normalize(position), normalize(cameraPosition - world.xyz));
	vPoint = position;
	vHub = hubs[int(storm)];
}
`;

const trailFragment = /* glsl */ `
uniform vec3 color;
uniform float opacity;
varying float vAge;
varying float vFacing;
varying vec3 vPoint;
varying vec4 vHub;
void main() {
	// The track stops at the ring.
	float outside = smoothstep(1.0, 1.15, distance(vPoint, vHub.xyz) / vHub.w);
	float a = opacity * (1.0 - vAge) * outside * smoothstep(0.02, 0.2, vFacing);
	if (a <= 0.0) discard;
	gl_FragColor = vec4(color * a, a);
	#include <colorspace_fragment>
}
`;

export interface CycloneView {
	cyclone: Cyclone;
	sample: CycloneSample;
}

export interface CyclonesLayer {
	readonly group: Group;
	/** Cyclones shown now, for tools. */
	shown(): readonly CycloneView[];
	update(state: { time: number; wallMs: number; camera: PerspectiveCamera; heightPx: number; sun: readonly [number, number, number]; steady: boolean }): void;
	dispose(): void;
}

export interface CyclonesOptions {
	radius?: number;
	baseUrl: string;
	/** Holder of the name tags; none, no names. */
	labels?: HTMLElement;
	/** `ring` drops the arms. */
	look?: 'spiral' | 'ring';
	get?: typeof fetch;
	onError?: (error: unknown) => void;
}

export function createCyclones({ radius = 1, baseUrl, labels, look = 'spiral', get = (...args) => fetch(...args), onError = () => {} }: CyclonesOptions): CyclonesLayer {
	const quad = new PlaneGeometry(2, 2);
	const geometry = new InstancedBufferGeometry();
	geometry.index = quad.index;
	geometry.setAttribute('position', quad.getAttribute('position'));
	const centers = new InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
	const looks = new InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
	geometry.setAttribute('center', centers);
	geometry.setAttribute('look', looks);
	geometry.instanceCount = 0;
	const blend = { blending: CustomBlending, blendSrc: OneFactor, blendDst: OneMinusSrcAlphaFactor, transparent: true, depthWrite: false } as const;
	const color = new Color(CYCLONES.color);
	const material = new ShaderMaterial({
		vertexShader,
		fragmentShader,
		uniforms: {
			color: { value: color },
			linePx: { value: CYCLONES.linePx },
			shade: { value: new Vector2(...CYCLONES.shade) },
			shadePx: { value: CYCLONES.shadePx },
			sun: { value: new Vector3(1, 0, 0) },
			turn: { value: 0 },
			arms: { value: look === 'ring' ? 0 : 1 },
		},
		...blend,
	});
	const rings = new Mesh(geometry, material);
	rings.frustumCulled = false;
	rings.renderOrder = 0.3;

	const trailGeometry = new BufferGeometry();
	const hubs = Array.from({ length: MAX }, () => new Vector4(0, 0, 0, 1));
	const trailMaterial = new ShaderMaterial({
		vertexShader: trailVertex,
		fragmentShader: trailFragment,
		defines: { MAX },
		uniforms: { color: { value: color }, opacity: { value: CYCLONES.trailOpacity }, hubs: { value: hubs } },
		...blend,
	});
	const trails = new LineSegments(trailGeometry, trailMaterial);
	trails.frustumCulled = false;
	trails.renderOrder = 0.3;

	const group = new Group();
	group.add(trails, rings);

	const shell = radius + kmToWorld(CYCLONES.heightKm, radius);
	let feed: CycloneFeed | null = null;
	let views: CycloneView[] = [];
	let trailKey = '';
	let disposed = false;
	const tags = new Map<string, HTMLElement>();
	const point = new Vector3();
	const toCamera = new Vector3();
	const past = new Vector3();

	const load = () => {
		get(new URL('cyclones/tracks.json', baseUrl).href)
			.then(async (response) => {
				if (!response.ok) throw new Error('cyclones unavailable');
				const text = await response.text();
				if (text.length > CYCLONES.maxBytes) throw new Error('cyclones: feed too large');
				feed = parseCycloneFeed(JSON.parse(text));
			})
			.catch(onError);
	};
	load();
	const timer = setInterval(load, CYCLONES.refreshMs);

	const buildTrails = (time: number) => {
		const positions: number[] = [];
		const ages: number[] = [];
		const storms: number[] = [];
		const span = CYCLONES.trailH * 3600;
		const t = time / 1000;
		const push = (lat: number, lon: number, at: number) => {
			const [x, y, z] = latLonToVector(lat, lon);
			positions.push(x * shell, y * shell, z * shell);
			ages.push(Math.min(Math.max((t - at) / span, 0), 1));
			storms.push(storm);
		};
		let storm = -1;
		for (const { cyclone, sample } of views) {
			storm++;
			const fixes = cyclone.track.filter((fix) => fix[0] <= t && fix[0] >= t - span);
			for (let i = 0; i < fixes.length; i++) {
				const next = fixes[i + 1];
				push(fixes[i][1], fixes[i][2], fixes[i][0]);
				if (next) push(next[1], next[2], next[0]);
				else push(sample.lat, sample.lon, t);
			}
		}
		trailGeometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
		trailGeometry.setAttribute('age', new BufferAttribute(new Float32Array(ages), 1));
		trailGeometry.setAttribute('storm', new BufferAttribute(new Float32Array(storms), 1));
	};

	const tag = (cyclone: Cyclone) => {
		let element = tags.get(cyclone.id);
		if (!element && labels) {
			element = document.createElement('p');
			element.className = 'cyclone';
			element.append(document.createElement('b'), document.createElement('span'));
			labels.append(element);
			tags.set(cyclone.id, element);
		}
		return element;
	};

	return {
		group,
		shown: () => views,
		update({ time, wallMs, camera, heightPx, sun, steady }) {
			if (disposed) return;
			views = [];
			for (const cyclone of feed?.cyclones ?? []) {
				const sample = sampleCyclone(cyclone, time);
				if (sample && views.length < MAX) views.push({ cyclone, sample });
			}
			const live = new Set(views.map((view) => view.cyclone.id));
			for (const [id, element] of tags) {
				if (!live.has(id)) { element.remove(); tags.delete(id); }
			}
			const worldPerPx = (2 * Math.tan((camera.fov * Math.PI) / 360)) / heightPx;
			views.forEach(({ cyclone, sample }, i) => {
				const [x, y, z] = latLonToVector(sample.lat, sample.lon);
				point.set(x * shell, y * shell, z * shell);
				const distance = toCamera.copy(camera.position).sub(point).length();
				const pxWorld = distance * worldPerPx;
				const ring = Math.max(kmToWorld(sample.r34Km ?? CYCLONES.defaultRadiusKm, radius), CYCLONES.minRadiusPx * pxWorld);
				centers.setXYZ(i, point.x, point.y, point.z);
				const weak = sample.windKt !== null && sample.windKt < 34;
				looks.setXYZ(i, ring / RING, sample.lat >= 0 ? 1 : -1, (sample.carried ? 0.75 : 1) * (weak ? CYCLONES.depression : 1));
				hubs[i].set(point.x, point.y, point.z, ring);

				const element = tag(cyclone);
				if (!element) return;
				const facing = toCamera.normalize().dot(point.clone().normalize());
				const screen = point.clone().project(camera);
				const visible = facing > 0.12 && Math.abs(screen.x) < 1 && Math.abs(screen.y) < 1 && screen.z < 1;
				element.hidden = !visible;
				if (!visible) return;
				const widthPx = heightPx * camera.aspect;
				// The name sits on the side the storm is heading to, away from its track.
				const from = cyclone.track.findLast((fix) => fix[0] * 1000 <= time - 6 * 3_600_000) ?? cyclone.track[0];
				const [fx, fy, fz] = latLonToVector(from[1], from[2]);
				const side = past.set(fx * shell, fy * shell, fz * shell).project(camera).x > screen.x ? -1 : 1;
				const left = ((screen.x + 1) / 2) * widthPx + side * (ring / RING / pxWorld + 6);
				const top = ((1 - screen.y) / 2) * heightPx;
				element.style.transform = `translate(${left.toFixed(1)}px, ${top.toFixed(1)}px) translate(${side < 0 ? '-100%' : '0'}, -50%)`;
				element.style.textAlign = side < 0 ? 'right' : 'left';
				const day = Math.min(Math.max((x * sun[0] + y * sun[1] + z * sun[2] + 0.05) / 0.3, 0), 1);
				element.style.setProperty('--day', day.toFixed(2));
				element.style.opacity = weak ? '0.7' : '1';
				const kind = cycloneKind(cyclone.basin, sample.windKt);
				const detail = sample.windKt === null ? kind : `${kind} · ${windKmh(sample.windKt)} km/h`;
				if (element.children[0].textContent !== cyclone.name) element.children[0].textContent = cyclone.name;
				if (element.children[1].textContent !== detail) element.children[1].textContent = detail;
			});
			geometry.instanceCount = views.length;
			centers.needsUpdate = true;
			looks.needsUpdate = true;
			material.uniforms.sun.value.set(...sun);
			material.uniforms.turn.value = steady ? 0 : ((wallMs / 1000 / CYCLONES.periodS) % 1) * Math.PI * 2;
			const key = `${views.map((view) => view.cyclone.id).join()}@${Math.round(time / 600_000)}`;
			if (key !== trailKey) {
				trailKey = key;
				buildTrails(time);
			}
			group.visible = views.length > 0;
		},
		dispose() {
			disposed = true;
			clearInterval(timer);
			for (const element of tags.values()) element.remove();
			tags.clear();
			geometry.dispose();
			quad.dispose();
			material.dispose();
			trailGeometry.dispose();
			trailMaterial.dispose();
		},
	};
}
