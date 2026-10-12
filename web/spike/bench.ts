import {
	AdditiveBlending,
	BufferAttribute,
	Color,
	CustomBlending,
	InstancedBufferAttribute,
	InstancedBufferGeometry,
	MaxEquation,
	Mesh,
	MeshBasicMaterial,
	OneFactor,
	PerspectiveCamera,
	Scene,
	ShaderMaterial,
	SphereGeometry,
	Vector3,
	WebGLRenderer,
} from 'three';
import { lookRotation, northTangent } from '../src/globe/flight';
import { CHANNEL, channelGlsl } from '../src/globe/lightning/channel';
import { intensityGlsl } from '../src/globe/lightning/intensity';
import { lightningFragmentShader, lightningVertexShader } from '../src/globe/lightning/lightning.glsl';
import { flashProfileGlsl, glslFloat as f, PROFILE } from '../src/globe/lightning/profile';
import { latLonToVector } from '../src/globe/sun';

const EARTH_KM = 6371;
const RADIUS = 1;
const KM = RADIUS / EARTH_KM;
const CENTER = { lat: 15, lon: -40 };

/** Per vertex: branch, segment, end (0 or 1), side (-1 or 1). */
function ribbonGeometry(branches: number, segments: number): InstancedBufferGeometry {
	const rib: number[] = [];
	const index: number[] = [];
	for (let b = 0; b <= branches; b++) {
		for (let s = 0; s < segments; s++) {
			const v = rib.length / 4;
			rib.push(b, s, 0, -1, b, s, 0, 1, b, s, 1, -1, b, s, 1, 1);
			index.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
		}
	}
	const g = new InstancedBufferGeometry();
	g.setAttribute('position', new BufferAttribute(new Float32Array(rib.length / 4 * 3), 3));
	g.setAttribute('rib', new BufferAttribute(new Float32Array(rib), 4));
	g.setIndex(index);
	return g;
}

const ribbonVertex = (segments: number) => /* glsl */ `
attribute vec4 rib;
attribute vec4 flash;
attribute vec3 flashShape;
uniform float time;
uniform float duration;
uniform float flicker;
uniform float radius;
uniform float kmToWorld;
uniform float vertical;
uniform vec2 viewport;
uniform float widthPx;
uniform float halo;
varying vec2 vLocal;
varying float vLength;
varying float vLight;

${flashProfileGlsl}
${intensityGlsl}
${channelGlsl}
const float S = ${f(segments)};

// Random walk in km, east north up: cloud to ground drops from the cloud base, intra cloud spreads at altitude.
vec3 walk(float b, float i, float seed, float ground, float L) {
	float heading = channelHash(seed, 1.0) * 6.2831853;
	vec3 dir = ground > 0.5
		? normalize(vec3(cos(heading) * 0.25, sin(heading) * 0.25, -1.0))
		: vec3(cos(heading), sin(heading), 0.0);
	float len = ground > 0.5 ? 7.0 * vertical : L * 2.0;
	vec3 p = ground > 0.5 ? vec3(0.0, 0.0, 7.0 * vertical) : vec3(-dir.xy * L, 9.0 * vertical);
	float stepLen = len / S;
	if (b > 0.5) {
		float origin = floor(S * (0.15 + 0.6 * channelHash(seed, 10.0 + b)));
		for (float j = 0.0; j < S; j++) {
			if (j >= origin) break;
			p += dir * stepLen + (vec3(channelHash(seed, 100.0 + j), channelHash(seed, 200.0 + j), channelHash(seed, 300.0 + j)) - 0.5) * stepLen * vec3(1.6, 1.6, ground > 0.5 ? 0.6 : 0.4 * vertical);
		}
		float turn = (channelHash(seed, 20.0 + b) - 0.5) * 2.4;
		dir = ground > 0.5
			? normalize(vec3(dir.x + cos(heading + turn) * 0.8, dir.y + sin(heading + turn) * 0.8, dir.z))
			: vec3(cos(heading + turn), sin(heading + turn), 0.0);
		stepLen *= 0.25 + 0.35 * channelHash(seed, 30.0 + b);
	}
	for (float j = 0.0; j < S; j++) {
		if (j >= i) break;
		float k = b * 1000.0 + j;
		p += dir * stepLen + (vec3(channelHash(seed, 100.0 + k), channelHash(seed, 200.0 + k), channelHash(seed, 300.0 + k)) - 0.5) * stepLen * vec3(1.6, 1.6, ground > 0.5 ? 0.6 : 0.4 * vertical);
	}
	if (ground > 0.5) p.z = max(p.z, 0.0);
	return p;
}

void main() {
	vec3 normal = normalize(flash.xyz);
	vec3 base = normal * radius;
	float seed = fract(sin(dot(flash.xyz, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
	float age = time - flash.w;
	float facing = dot(normal, normalize(cameraPosition - base));
	float brightness = flashProfile(age, duration, flashShape.z, seed, flicker) * intensityBrightness(flashShape.x) * smoothstep(-0.05, 0.05, facing);
	float fade = 1.0 - smoothstep(0.0, clamp(flashShape.z / 1000.0, ${f(CHANNEL.fade)}, ${f(PROFILE.maxFlicker)}) + ${f(CHANNEL.fade)}, age);
	float branchLevel = rib.x > 0.5 ? exp(-age / ${f(CHANNEL.branchTau)}) * 0.7 : 1.0;
	float light = brightness * fade * branchLevel;
	if (light < 0.002) {
		gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
		return;
	}
	float ground = step(channelHash(seed, 2.0), 0.3);
	float L = flashShape.y * ${f(CHANNEL.lengthScale)};
	vec3 east = abs(normal.y) > 0.999 ? vec3(1.0, 0.0, 0.0) : normalize(cross(vec3(0.0, 1.0, 0.0), normal));
	vec3 north = cross(normal, east);
	float distance = length(cameraPosition - base);
	float pixel = 2.0 * distance / (projectionMatrix[1][1] * viewport.y);
	float scale = max(kmToWorld, ${f(CHANNEL.minPixels)} * pixel / L);
	vec3 a = walk(rib.x, rib.y, seed, ground, L);
	vec3 b = walk(rib.x, rib.y + 1.0, seed, ground, L);
	mat3 frame = mat3(east, north, normal) * scale;
	vec4 ca = projectionMatrix * viewMatrix * vec4(base + frame * a, 1.0);
	vec4 cb = projectionMatrix * viewMatrix * vec4(base + frame * b, 1.0);
	vec2 sa = ca.xy / ca.w * viewport;
	vec2 sb = cb.xy / cb.w * viewport;
	vec2 t = sb - sa;
	t = dot(t, t) > 1e-8 ? normalize(t) : vec2(1.0, 0.0);
	vec4 c = rib.z > 0.5 ? cb : ca;
	float taper = rib.x > 0.5 ? 1.0 - 0.7 * (rib.y + rib.z) / S : 1.0;
	float w = (halo > 0.5 ? widthPx * 8.0 : widthPx) * max(taper, 0.5);
	float along = rib.z > 0.5 ? 1.0 : -1.0;
	c.xy += (vec2(-t.y, t.x) * rib.w + t * along) * w / viewport * c.w;
	gl_Position = c;
	vLength = length(sb - sa) / w;
	vLocal = vec2(rib.z > 0.5 ? vLength + 1.0 : -1.0, rib.w);
	vLight = light * taper;
}
`;

const ribbonFragment = /* glsl */ `
uniform vec3 color;
uniform float exposure;
uniform float halo;
varying vec2 vLocal;
varying float vLength;
varying float vLight;
void main() {
	vec2 d = vec2(vLocal.x - clamp(vLocal.x, 0.0, vLength), vLocal.y);
	float x2 = min(dot(d, d), 1.0);
	float light = halo > 0.5 ? 0.3 * exp(-x2 * 5.0) * (1.0 - x2) : exp(-x2 * 3.0) * (1.0 - x2);
	gl_FragColor = vec4(color * exposure * vLight * light, 1.0);
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}
`;

interface Flashes {
	flash: Float32Array;
	shape: Float32Array;
	count: number;
}

function rand(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

/** `active` flashes in their flicker phase, `glowing` ones in the afterglow, around the storm center. */
function makeFlashes(active: number, glowing: number, time: number, display: number, spreadDeg: number): Flashes {
	const r = rand(7);
	const count = active + glowing;
	const flash = new Float32Array(count * 4);
	const shape = new Float32Array(count * 3);
	for (let i = 0; i < count; i++) {
		const lat = CENTER.lat + (r() - 0.5) * spreadDeg;
		const lon = CENTER.lon + (r() - 0.5) * spreadDeg;
		const v = latLonToVector(lat, lon);
		flash.set([v[0], v[1], v[2], i < active ? time - r() * 0.12 : time - 1 - r() * (display - 2)], i * 4);
		shape.set([r(), 3 + r() * r() * 15, 150 + r() * 400], i * 3);
	}
	return { flash, shape, count };
}

function flashGeometry(base: InstancedBufferGeometry, fl: Flashes): InstancedBufferGeometry {
	base.setAttribute('flash', new InstancedBufferAttribute(fl.flash, 4));
	base.setAttribute('flashShape', new InstancedBufferAttribute(fl.shape, 3));
	base.instanceCount = fl.count;
	return base;
}

function quad(): InstancedBufferGeometry {
	const g = new InstancedBufferGeometry();
	g.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
	g.setIndex([0, 1, 2, 0, 2, 3]);
	return g;
}

export interface Case {
	/** flat: production shader; ribbon: 3D channel over the production glow; halo: ribbon plus a wide glow along it. */
	mode: 'none' | 'flat' | 'ribbon' | 'halo';
	active: number;
	glowing: number;
	altitudeKm: number;
	tilt: number;
	width: number;
	height: number;
	segments?: number;
	branches?: number;
	vertical?: number;
	frames?: number;
}

const TIME = 1000;
const DISPLAY = 1800;

function pose(camera: PerspectiveCamera, altitudeKm: number, tiltDeg: number) {
	const normal = new Vector3(...latLonToVector(CENTER.lat, CENTER.lon));
	const north = northTangent(normal);
	const tilt = (tiltDeg * Math.PI) / 180;
	const surface = normal.clone().multiplyScalar(RADIUS);
	const offset = normal.clone().multiplyScalar(Math.cos(tilt)).addScaledVector(north, -Math.sin(tilt));
	const target = tilt > 0 ? surface : new Vector3();
	camera.position.copy(surface).addScaledVector(offset, altitudeKm * KM);
	const up = north.clone().multiplyScalar(Math.cos(tilt)).addScaledVector(normal, Math.sin(tilt));
	camera.quaternion.copy(lookRotation(camera.position, target, up));
	camera.near = Math.max(1e-5, altitudeKm * KM * 0.2);
	camera.far = 10;
	camera.updateProjectionMatrix();
}

const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
document.body.appendChild(renderer.domElement);
const gl = renderer.getContext() as WebGL2RenderingContext;
const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');

function build(c: Case) {
	const scene = new Scene();
	scene.add(new Mesh(new SphereGeometry(RADIUS, 256, 128), new MeshBasicMaterial({ color: '#0d1426' })));
	const fl = makeFlashes(c.active, c.glowing, TIME, DISPLAY, c.altitudeKm > 5000 ? 30 : 6);
	const common = {
		time: { value: TIME },
		duration: { value: DISPLAY },
		flicker: { value: 1 },
		radius: { value: RADIUS },
		kmToWorld: { value: KM },
		exposure: { value: 1.6 },
		color: { value: new Color('#e4ebff') },
	};
	const disposables: { dispose(): void }[] = [];
	if (c.mode !== 'none') {
		let fragment = lightningFragmentShader;
		// The 3D modes keep the production glow but draw the channel themselves.
		if (c.mode !== 'flat') fragment = fragment.replace('if (vChannel > 0.001)', 'if (false)');
		const m = new ShaderMaterial({
			vertexShader: lightningVertexShader,
			fragmentShader: fragment,
			uniforms: {
				...common,
				lift: { value: 12 / EARTH_KM },
				glowScale: { value: 4 },
				minPixels: { value: 5 },
				viewportHeight: { value: c.height },
			},
			blending: AdditiveBlending,
			transparent: true,
			depthWrite: false,
		});
		const g = flashGeometry(quad(), fl);
		const mesh = new Mesh(g, m);
		mesh.frustumCulled = false;
		mesh.renderOrder = 1;
		scene.add(mesh);
		disposables.push(g, m);
	}
	if (c.mode === 'ribbon' || c.mode === 'halo') {
		const segments = c.segments ?? 16;
		// Only flashes in their flicker phase need a channel: draw the first `active` instances.
		const active: Flashes = { flash: fl.flash.slice(0, c.active * 4), shape: fl.shape.slice(0, c.active * 3), count: c.active };
		const passes = c.mode === 'halo' ? [1, 0] : [0];
		for (const halo of passes) {
			const g = flashGeometry(ribbonGeometry(c.branches ?? 3, segments), active);
			const m = new ShaderMaterial({
				vertexShader: ribbonVertex(segments),
				fragmentShader: ribbonFragment,
				uniforms: {
					...common,
					vertical: { value: c.vertical ?? 1 },
					viewport: { value: [c.width / 2, c.height / 2] },
					widthPx: { value: 1.6 },
					halo: { value: halo },
				},
				transparent: true,
				depthWrite: false,
				blending: CustomBlending,
				blendEquation: MaxEquation,
				blendSrc: OneFactor,
				blendDst: OneFactor,
			});
			const mesh = new Mesh(g, m);
			mesh.frustumCulled = false;
			mesh.renderOrder = 2 + (1 - halo);
			scene.add(mesh);
			disposables.push(g, m);
		}
	}
	const camera = new PerspectiveCamera(45, c.width / c.height);
	pose(camera, c.altitudeKm, c.tilt);
	return { scene, camera, dispose: () => disposables.forEach((d) => d.dispose()) };
}

const pixel = new Uint8Array(4);
const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);

async function gpuMs(draw: () => void): Promise<number | null> {
	if (!timer) return null;
	const q = gl.createQuery()!;
	gl.beginQuery(timer.TIME_ELAPSED_EXT, q);
	draw();
	gl.endQuery(timer.TIME_ELAPSED_EXT);
	sync();
	for (let i = 0; i < 200; i++) {
		if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
		await new Promise((r) => setTimeout(r, 5));
	}
	const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
	gl.deleteQuery(q);
	return gl.getParameter(timer.GPU_DISJOINT_EXT) ? null : ns / 1e6;
}

/** Median wall time of a synced frame, and GPU time when the timer query exists. */
async function measure(c: Case) {
	renderer.setSize(c.width, c.height, false);
	const { scene, camera, dispose } = build(c);
	const draw = () => renderer.render(scene, camera);
	for (let i = 0; i < 5; i++) draw();
	sync();
	const wall: number[] = [];
	for (let i = 0; i < (c.frames ?? 40); i++) {
		const t = performance.now();
		draw();
		sync();
		wall.push(performance.now() - t);
	}
	const gpu: number[] = [];
	for (let i = 0; i < 10; i++) {
		const ms = await gpuMs(draw);
		if (ms !== null) gpu.push(ms);
	}
	dispose();
	const median = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : null);
	return { wallMs: median(wall), gpuMs: median(gpu) };
}

/** CPU cost of generating channel polylines in JS instead of the vertex shader. */
function cpuGenerate(flashes: number, branches: number, segments: number) {
	const out = new Float32Array(flashes * (branches + 1) * (segments + 1) * 3);
	const r = rand(3);
	const t = performance.now();
	let o = 0;
	for (let n = 0; n < flashes; n++) {
		const heading = r() * Math.PI * 2;
		for (let b = 0; b <= branches; b++) {
			let x = 0;
			let y = 0;
			let z = 7;
			const dx = Math.cos(heading + (b ? r() - 0.5 : 0));
			const dy = Math.sin(heading + (b ? r() - 0.5 : 0));
			for (let s = 0; s <= segments; s++) {
				out[o++] = x;
				out[o++] = y;
				out[o++] = z;
				x += dx * 0.5 + (r() - 0.5) * 0.8;
				y += dy * 0.5 + (r() - 0.5) * 0.8;
				z -= 0.4 + (r() - 0.5) * 0.3;
			}
		}
	}
	return { msPerThousand: ((performance.now() - t) / flashes) * 1000, bytesPerFlash: out.byteLength / flashes };
}

async function shot(c: Case): Promise<string> {
	renderer.setSize(c.width, c.height, false);
	const { scene, camera, dispose } = build(c);
	renderer.render(scene, camera);
	const url = renderer.domElement.toDataURL('image/png');
	dispose();
	return url;
}

const info = gl.getExtension('WEBGL_debug_renderer_info');
Object.assign(globalThis, {
	bench: {
		measure,
		shot,
		cpuGenerate,
		gpu: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
		timer: !!timer,
	},
});
