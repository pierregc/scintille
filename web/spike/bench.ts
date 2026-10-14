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
import { ribbonGeometry } from '../src/globe/lightning/ribbon';
import { ribbonVertex, ribbonFragment } from '../src/globe/lightning/ribbon.glsl';
import { lightningFragmentShader, lightningVertexShader } from '../src/globe/lightning/lightning.glsl';
import { lightningFragmentShader as flatFragment, lightningVertexShader as flatVertex } from './baseline';
import { latLonToVector } from '../src/globe/sun';

const EARTH_KM = 6371;
const RADIUS = 1;
const KM = RADIUS / EARTH_KM;
const CENTER = { lat: 15, lon: -40 };

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
	base.setAttribute('channelSeed', new InstancedBufferAttribute(Float32Array.from({ length: fl.count }, (_, i) => (i * 0.61803398875) % 1), 1));
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
	mode: 'none' | 'flat' | 'ribbon' ;
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
		const fragment = c.mode === 'flat' ? flatFragment : lightningFragmentShader;
		// The 3D modes keep the production glow but draw the channel themselves.
		const m = new ShaderMaterial({
			vertexShader: c.mode === 'flat' ? flatVertex : lightningVertexShader,
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
	if (c.mode === 'ribbon') {
		const segments = c.segments ?? 16;
		// Only flashes in their flicker phase need a channel: draw the first `active` instances.
		const active: Flashes = { flash: fl.flash.slice(0, c.active * 4), shape: fl.shape.slice(0, c.active * 3), count: c.active };
		const passes = [0];
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
	const q = gl.createQuery();
	if (!q) return null;
	gl.beginQuery(timer.TIME_ELAPSED_EXT, q);
	draw();
	gl.endQuery(timer.TIME_ELAPSED_EXT);
	sync();
	let available = false;
	for (let i = 0; i < 200; i++) {
		if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
			available = true;
			break;
		}
		await new Promise((r) => setTimeout(r, 5));
	}
	const ns: unknown = available ? gl.getQueryParameter(q, gl.QUERY_RESULT) : null;
	gl.deleteQuery(q);
	return gl.getParameter(timer.GPU_DISJOINT_EXT) || typeof ns !== 'number' ? null : ns / 1e6;
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
