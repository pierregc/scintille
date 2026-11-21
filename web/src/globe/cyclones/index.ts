import {
	BufferAttribute, BufferGeometry, Color, CustomBlending, Group, InstancedBufferAttribute, InstancedBufferGeometry, LineSegments, Mesh,
	OneFactor, OneMinusSrcAlphaFactor, type PerspectiveCamera, PlaneGeometry, ShaderMaterial, Vector2, Vector3, Vector4,
} from 'three';
import { boundedBody } from '../clouds/response';
import { kmToWorld } from '../flight';
import { latLonToVector } from '../sun';
import { type Cyclone, type Cyclones, type CycloneSample, cycloneKind, parseCyclones, sampleCyclone, windKmh } from './track';

/** Tropical cyclones as a thin turning ring on their clouds (ADR 0040). Tuning ranges in brackets. */
export const CYCLONES = {
	path: 'cyclones/tracks.json',
	/** Height of the ring, km, on the cloud tops. */
	heightKm: 14,
	/** Ring radius when the advisory gives no gale radius, km. */
	defaultRadiusKm: 120,
	/** The ring never gets smaller than this on screen, px, so a storm shows from the whole globe [10 to 18]. */
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
	/** Share of the ring kept for a tropical depression, and for a position carried past the last fix [0.4 to 0.8]. */
	depression: 0.55,
	carried: 0.75,
	color: '#eef2f7',
	refreshMs: 30 * 60_000,
	/** The feed waits for the first clouds, this long at most, ms. */
	waitMs: 6000,
	maxBytes: 1 << 20,
	/** Cyclones drawn at once, strongest first. */
	max: 24,
} as const;

/** Radius of the ring in its quad; the arms fill the rest. */
const RING = 0.62;

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
	float arm = step(RING, r) * pow(1.0 - s, 1.4);
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

export async function loadCyclones(url: string, get: typeof fetch = fetch): Promise<Cyclones> {
	const response = await get(url);
	if (!response.ok) throw new Error(`cyclones: HTTP ${response.status}`);
	const bytes = await boundedBody(response, CYCLONES.maxBytes);
	return parseCyclones(JSON.parse(new TextDecoder().decode(bytes)));
}

/** Cyclones present at `time`, strongest first, `max` at most. */
export function cyclonesAt(feed: Cyclones | null, time: number, max: number = CYCLONES.max): CycloneView[] {
	const views: CycloneView[] = [];
	for (const cyclone of feed?.cyclones ?? []) {
		const sample = sampleCyclone(cyclone, time);
		if (sample) views.push({ cyclone, sample });
	}
	return views.sort((a, b) => (b.sample.windKt ?? 0) - (a.sample.windKt ?? 0)).slice(0, max);
}

/** Ring radius in world units: the gale radius, never under the smallest size on screen. */
export function ringRadius(r34Km: number | null, pxWorld: number, radius: number): number {
	return Math.max(kmToWorld(r34Km ?? CYCLONES.defaultRadiusKm, radius), CYCLONES.minRadiusPx * pxWorld);
}

/** The two lines of a name tag. */
export function tagText({ cyclone, sample }: CycloneView): [string, string] {
	const kind = cycloneKind(cyclone.basin, sample.windKt);
	return [cyclone.name, sample.windKt === null ? kind : `${kind} · ${windKmh(sample.windKt)} km/h`];
}

export interface CyclonesLayer {
	readonly group: Group;
	/** Cyclones shown now, for tools. */
	shown(): readonly CycloneView[];
	update(state: {
		/** Time the cyclones are placed at: the cloud layer's, or the scene's without clouds. */
		time: number;
		wallMs: number;
		camera: PerspectiveCamera;
		heightPx: number;
		sun: readonly [number, number, number];
		steady: boolean;
		/** The first clouds are in: the feed may load. */
		ready: boolean;
	}): void;
	dispose(): void;
}

export interface CyclonesOptions {
	radius?: number;
	baseUrl: string;
	/** Holder of the name tags; none, no names. */
	labels?: HTMLElement;
	load?: (url: string) => Promise<Cyclones>;
	onError?: (error: unknown) => void;
}

export function createCyclones({ radius = 1, baseUrl, labels, load = (url) => loadCyclones(url), onError = () => {} }: CyclonesOptions): CyclonesLayer {
	const quad = new PlaneGeometry(2, 2);
	const geometry = new InstancedBufferGeometry();
	geometry.index = quad.index;
	geometry.setAttribute('position', quad.getAttribute('position'));
	const centers = new InstancedBufferAttribute(new Float32Array(CYCLONES.max * 3), 3);
	const looks = new InstancedBufferAttribute(new Float32Array(CYCLONES.max * 3), 3);
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
		},
		...blend,
	});
	const rings = new Mesh(geometry, material);
	rings.frustumCulled = false;
	rings.renderOrder = 0.3;

	const hubs = Array.from({ length: CYCLONES.max }, () => new Vector4(0, 0, 0, 1));
	const trailGeometry = new BufferGeometry();
	const trailMaterial = new ShaderMaterial({
		vertexShader: trailVertex,
		fragmentShader: trailFragment,
		defines: { MAX: CYCLONES.max },
		uniforms: { color: { value: color }, opacity: { value: CYCLONES.trailOpacity }, hubs: { value: hubs } },
		...blend,
	});
	const trails = new LineSegments(trailGeometry, trailMaterial);
	trails.frustumCulled = false;
	trails.renderOrder = 0.3;

	const group = new Group();
	group.add(trails, rings);
	group.visible = false;

	const shell = radius + kmToWorld(CYCLONES.heightKm, radius);
	const url = new URL(CYCLONES.path, baseUrl).href;
	const created = performance.now();
	let feed: Cyclones | null = null;
	let views: CycloneView[] = [];
	let trailKey = '';
	let timer: ReturnType<typeof setInterval> | undefined;
	let disposed = false;
	const tags = new Map<string, HTMLElement>();
	const point = new Vector3();
	const normal = new Vector3();
	const toCamera = new Vector3();
	const screen = new Vector3();
	const past = new Vector3();

	const refresh = () => {
		load(url).then((next) => { if (!disposed) feed = next; }, onError);
	};

	const buildTrails = (time: number) => {
		const positions: number[] = [];
		const ages: number[] = [];
		const storms: number[] = [];
		const span = CYCLONES.trailH * 3_600_000;
		views.forEach(({ cyclone, sample }, storm) => {
			const push = (lat: number, lon: number, at: number) => {
				const [x, y, z] = latLonToVector(lat, lon);
				positions.push(x * shell, y * shell, z * shell);
				ages.push(Math.min(Math.max((time - at) / span, 0), 1));
				storms.push(storm);
			};
			const fixes = cyclone.fixes.filter((fix) => fix.time <= time && fix.time >= time - span);
			fixes.forEach((fix, i) => {
				const next = fixes[i + 1];
				push(fix.lat, fix.lon, fix.time);
				if (next) push(next.lat, next.lon, next.time);
				else push(sample.lat, sample.lon, time);
			});
		});
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
		update({ time, wallMs, camera, heightPx, sun, steady, ready }) {
			if (disposed) return;
			if (!timer && (ready || performance.now() - created > CYCLONES.waitMs)) {
				refresh();
				timer = setInterval(refresh, CYCLONES.refreshMs);
			}
			views = cyclonesAt(feed, time);
			const live = new Set(views.map((view) => view.cyclone.id));
			for (const [id, element] of tags) {
				if (!live.has(id)) { element.remove(); tags.delete(id); }
			}
			const worldPerPx = (2 * Math.tan((camera.fov * Math.PI) / 360)) / heightPx;
			const widthPx = heightPx * camera.aspect;
			views.forEach((view, i) => {
				const { cyclone, sample } = view;
				const [x, y, z] = latLonToVector(sample.lat, sample.lon);
				normal.set(x, y, z);
				point.copy(normal).multiplyScalar(shell);
				const pxWorld = toCamera.copy(camera.position).sub(point).length() * worldPerPx;
				const ring = ringRadius(sample.r34Km, pxWorld, radius);
				const weak = sample.windKt !== null && sample.windKt < 34;
				centers.setXYZ(i, point.x, point.y, point.z);
				looks.setXYZ(i, ring / RING, sample.lat >= 0 ? 1 : -1, (sample.carried ? CYCLONES.carried : 1) * (weak ? CYCLONES.depression : 1));
				hubs[i].set(point.x, point.y, point.z, ring);

				const element = tag(cyclone);
				if (!element) return;
				screen.copy(point).project(camera);
				const visible = toCamera.normalize().dot(normal) > 0.12 && Math.abs(screen.x) < 1 && Math.abs(screen.y) < 1 && screen.z < 1;
				element.hidden = !visible;
				if (!visible) return;
				// The name sits on the side the storm is heading to, away from its track.
				const from = cyclone.fixes.findLast((fix) => fix.time <= time - 6 * 3_600_000) ?? cyclone.fixes[0];
				const [fx, fy, fz] = latLonToVector(from.lat, from.lon);
				const side = past.set(fx, fy, fz).multiplyScalar(shell).project(camera).x > screen.x ? -1 : 1;
				const left = ((screen.x + 1) / 2) * widthPx + side * (ring / RING / pxWorld + 6);
				const top = ((1 - screen.y) / 2) * heightPx;
				element.style.transform = `translate(${left.toFixed(1)}px, ${top.toFixed(1)}px) translate(${side < 0 ? '-100%' : '0'}, -50%)`;
				element.style.textAlign = side < 0 ? 'right' : 'left';
				element.style.setProperty('--day', Math.min(Math.max((x * sun[0] + y * sun[1] + z * sun[2] + 0.05) / 0.3, 0), 1).toFixed(2));
				element.style.opacity = weak ? '0.7' : '1';
				const [name, detail] = tagText(view);
				if (element.children[0].textContent !== name) element.children[0].textContent = name;
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
