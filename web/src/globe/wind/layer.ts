import {
	AdditiveBlending,
	type Camera,
	Color,
	Data3DTexture,
	LinearFilter,
	Matrix4,
	Mesh,
	NoBlending,
	OrthographicCamera,
	type PerspectiveCamera,
	PlaneGeometry,
	RedFormat,
	RepeatWrapping,
	RGFormat,
	Scene,
	ShaderMaterial,
	SphereGeometry,
	type Texture,
	Vector2,
	Vector3,
	type WebGLRenderer,
	WebGLRenderTarget,
} from 'three';
import { kmToWorld } from '../flight';
import { BAKE, bakeServes, bakeSize, type BakeView, bakeViewProjection } from './bake';
import { bakeFragmentShader, bakeVertexShader, windFragmentShader, windVertexShader } from './layer.glsl';
import { easeFade, fibreCellKm, fibreOctave, heightFade, WIND_FADE, WIND_LOOKS } from './look';
import { WIND_LOOK_LEVEL, type WindField, type WindLayer, type WindLayerOptions, type WindLook } from './types';

/** After the clouds (-1), which it lies over, and before the atmosphere (0), which hazes it. */
export const WIND_RENDER_ORDER = -0.5;

/** Seconds for the fibres to drift through one cycle. */
const DRIFT_PERIOD_S = 8;

export interface WindLayerSetup extends WindLayerOptions {
	/** Bake resolution as a share of the CSS viewport, read every frame; 0 turns the layer off. */
	bakeScale?: () => number;
}

interface Bake {
	view: BakeView;
	octave: { lo: number; blend: number; cell: number };
	at: number;
	key: string;
}

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

function show(record: Bake, matrix: Matrix4, eye: Vector3, octave: Vector2): void {
	matrix.copy(record.view.viewProjection);
	eye.copy(record.view.eye);
	octave.set(record.octave.lo, record.octave.cell);
}

function bakeTarget(): WebGLRenderTarget {
	return new WebGLRenderTarget(1, 1, { format: RGFormat, depthBuffer: false, generateMipmaps: false, minFilter: LinearFilter, magFilter: LinearFilter });
}

/** Wind as brushed fibres: baked offscreen from the camera's view, drawn on a shell over the clouds. */
export function createWindLayer({ radius, cloudOpacity, bakeScale = () => 1 }: WindLayerSetup): WindLayer {
	const noise = noiseTexture();
	const targets = [bakeTarget(), bakeTarget()];
	const bakes: (Bake | null)[] = [null, null];
	let newest = 0;

	// Shared by the bake and the screen pass: the hourly pair and the look's speeds.
	const field = {
		windA: { value: null as Texture | null },
		windB: { value: null as Texture | null },
		windScale: { value: new Vector2(1, 1) },
		windCalm: { value: 0 },
		windFull: { value: 1 },
	};
	const bakeUniforms = {
		...field,
		inverseViewProjection: { value: new Matrix4() },
		eye: { value: new Vector3() },
		shellRadius: { value: radius },
		windPair: { value: 0 },
		noiseMap: { value: noise },
		octave: { value: new Vector3() },
		reach: { value: 1 },
	};
	const bakeMaterial = new ShaderMaterial({
		vertexShader: bakeVertexShader,
		fragmentShader: bakeFragmentShader,
		uniforms: bakeUniforms,
		blending: NoBlending,
		depthTest: false,
		depthWrite: false,
	});
	const quad = new PlaneGeometry(2, 2);
	const bakeMesh = new Mesh(quad, bakeMaterial);
	bakeMesh.frustumCulled = false;
	const bakeScene = new Scene();
	bakeScene.add(bakeMesh);
	const bakeCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

	const u = {
		...field,
		windMix: { value: 0 },
		windBakeNew: { value: targets[0].texture },
		windBakeOld: { value: targets[1].texture },
		windMatrixNew: { value: new Matrix4() },
		windMatrixOld: { value: new Matrix4() },
		windEyeNew: { value: new Vector3() },
		windEyeOld: { value: new Vector3() },
		windOctaveNew: { value: new Vector2() },
		windOctaveOld: { value: new Vector2() },
		windBakeShare: { value: 0 },
		windOldShown: { value: 0 },
		windNoise: { value: noise },
		windShell: { value: radius },
		windTime: { value: 0 },
		windDrift: { value: 1 },
		windSparse: { value: 0 },
		windSoft: { value: 1 },
		windGain: { value: 0 },
		windDayLevel: { value: 1 },
		windCloudVeil: { value: 0 },
		windOpacity: { value: 0 },
		windSun: { value: new Vector3(1, 0, 0) },
		windColor: { value: new Color() },
	};
	const geometry = new SphereGeometry(1, 128, 64);
	const material = new ShaderMaterial({
		vertexShader: windVertexShader,
		fragmentShader: windFragmentShader,
		uniforms: { ...cloudOpacity.uniforms, ...u },
		// The blurred cover reads the frames only, not the finer tiles near the camera.
		defines: Object.fromEntries(Object.entries(cloudOpacity.defines).filter(([name]) => name !== 'DETAIL')),
		blending: AdditiveBlending,
		premultipliedAlpha: true,
		transparent: true,
		depthWrite: false,
	});
	const mesh = new Mesh(geometry, material);
	mesh.renderOrder = WIND_RENDER_ORDER;
	mesh.visible = false;

	// The camera of the last frame drawn: the bake reprojects from it.
	const seen = { projection: new Matrix4(), worldInverse: new Matrix4(), eye: new Vector3(), valid: false };
	mesh.onBeforeRender = (_renderer, _scene, camera: Camera) => {
		if (!(camera as PerspectiveCamera).isPerspectiveCamera) return;
		seen.projection.copy(camera.projectionMatrix);
		seen.worldInverse.copy(camera.matrixWorldInverse);
		seen.eye.setFromMatrixPosition(camera.matrixWorld);
		seen.valid = true;
	};

	let look: WindLook | null = null;
	let a: WindField | null = null;
	let b: WindField | null = null;
	let mix = 0;
	let stormFade = 1;
	let lastWall = Number.NaN;
	const css = new Vector2();
	const screen = { inverseViewProjection: new Matrix4(), eye: new Vector3(), kmPerPx: 1 };

	// A bake under way, drawn a band per frame into the slot not shown.
	let pending: (Bake & { slot: number; band: number; bands: number; swap: boolean }) | null = null;

	const forget = () => {
		bakes[0] = bakes[1] = null;
		pending = null;
	};

	const ready = () =>
		look !== null && a !== null && b !== null && a.level === WIND_LOOK_LEVEL[look] && b.level === a.level;

	const bake = (renderer: WebGLRenderer, kmPerPx: number, wallMs: number, scale: number) => {
		if (!look || !a || !b) return;
		const size = bakeSize(css.x, css.y, scale, renderer.capabilities.maxTextureSize);
		const key = `${look}|${a.texture.id}|${b.texture.id}|${size.width}x${size.height}`;
		if (pending && pending.key !== key) pending = null;
		if (!pending) {
			const last = bakes[newest];
			if (last?.key === key) {
				screen.inverseViewProjection.multiplyMatrices(seen.projection, seen.worldInverse).invert();
				screen.eye.copy(seen.eye);
				screen.kmPerPx = kmPerPx;
				// The previous crossfade ends first: its older bake is about to be overwritten.
				if (bakeServes(last.view, screen, u.windShell.value) || wallMs - last.at < BAKE.fadeMs) return;
			}
			const slot = last ? 1 - newest : newest;
			bakes[slot] = null;
			const target = targets[slot];
			if (target.width !== size.width || target.height !== size.height) target.setSize(size.width, size.height);
			const view: BakeView = { viewProjection: bakeViewProjection(seen.projection, seen.worldInverse), eye: seen.eye.clone(), kmPerPx };
			const octave = fibreOctave(fibreCellKm(kmPerPx, kmPerPx / size.scale, WIND_LOOKS[look].cellPx));
			const bands = Math.ceil((size.width * size.height) / BAKE.bandTexels);
			pending = { slot, view, octave, key, at: 0, band: 0, bands, swap: last !== null && last.key !== key };
		}

		const job = pending;
		const target = targets[job.slot];
		const rows = Math.ceil(target.height / job.bands);
		target.scissor.set(0, job.band * rows, target.width, rows);
		target.scissorTest = true;
		bakeUniforms.inverseViewProjection.value.copy(job.view.viewProjection).invert();
		bakeUniforms.eye.value.copy(job.view.eye);
		bakeUniforms.shellRadius.value = u.windShell.value;
		bakeUniforms.windPair.value = a.texture === b.texture ? 0 : 1;
		bakeUniforms.octave.value.set(job.octave.lo, job.octave.blend, job.octave.cell);
		bakeUniforms.reach.value = WIND_LOOKS[look].reach;
		const previous = renderer.getRenderTarget();
		renderer.setRenderTarget(target);
		renderer.render(bakeScene, bakeCamera);
		renderer.setRenderTarget(previous);
		target.scissorTest = false;
		if (++job.band < job.bands) return;
		// A new pair or size shows at once, the first bake fades in, a moved view crossfades.
		bakes[job.slot] = { view: job.view, octave: job.octave, key, at: job.swap ? wallMs - BAKE.fadeMs : wallMs };
		newest = job.slot;
		pending = null;
	};

	const showBakes = (wallMs: number) => {
		const fresh = bakes[newest];
		const old = bakes[1 - newest];
		u.windBakeShare.value = fresh ? Math.min(1, Math.max(0, (wallMs - fresh.at) / BAKE.fadeMs)) : 0;
		u.windOldShown.value = old && old.key === fresh?.key && u.windBakeShare.value < 1 ? 1 : 0;
		u.windBakeNew.value = targets[newest].texture;
		u.windBakeOld.value = targets[1 - newest].texture;
		if (fresh) show(fresh, u.windMatrixNew.value, u.windEyeNew.value, u.windOctaveNew.value);
		if (old) show(old, u.windMatrixOld.value, u.windEyeOld.value, u.windOctaveOld.value);
	};

	return {
		object: mesh,
		setLook(next) {
			if (next === look) return;
			look = next;
			forget();
			if (!look) return;
			const params = WIND_LOOKS[look];
			u.windShell.value = radius + kmToWorld(params.heightKm, radius);
			mesh.scale.setScalar(u.windShell.value);
			u.windSparse.value = params.sparse;
			u.windSoft.value = params.soft;
			u.windGain.value = params.gain;
			u.windDayLevel.value = params.day;
			u.windCloudVeil.value = params.cloudVeil;
			u.windColor.value.set(params.color);
			field.windCalm.value = params.calm;
			field.windFull.value = params.full;
			const veiled = params.cloudVeil > 0;
			if (veiled !== 'CLOUD_VEIL' in material.defines) {
				if (veiled) material.defines.CLOUD_VEIL = '';
				else delete material.defines.CLOUD_VEIL;
				material.needsUpdate = true;
			}
		},
		setFields(nextA, nextB, nextMix) {
			if (!nextA) forget();
			a = nextA;
			b = nextA ? (nextB ?? nextA) : null;
			mix = b && b.texture !== a?.texture ? Math.min(1, Math.max(0, nextMix)) : 0;
		},
		update({ renderer, kmPerPx, wallMs, sun, steady, stormView }) {
			const dt = Number.isFinite(lastWall) ? wallMs - lastWall : 0;
			lastWall = wallMs;
			stormFade = easeFade(stormFade, stormView ? 0 : 1, dt, WIND_FADE.stormMs);
			const scale = bakeScale();
			const opacity = stormFade * heightFade(kmPerPx);
			mesh.visible = ready() && scale > 0 && opacity > 0;
			if (!mesh.visible) {
				seen.valid = false;
				return;
			}
			renderer.getSize(css);
			field.windA.value = a?.texture ?? null;
			field.windB.value = b?.texture ?? null;
			field.windScale.value.set(a?.scaleMs ?? 1, b?.scaleMs ?? 1);
			u.windMix.value = mix;
			if (seen.valid) bake(renderer, kmPerPx, wallMs, scale);
			showBakes(wallMs);
			u.windOpacity.value = opacity;
			u.windSun.value.set(...sun);
			u.windDrift.value = steady ? 0 : 1;
			u.windTime.value = (wallMs / 1000 / DRIFT_PERIOD_S) % 4096;
		},
		dispose() {
			geometry.dispose();
			material.dispose();
			quad.dispose();
			bakeMaterial.dispose();
			for (const target of targets) target.dispose();
			noise.dispose();
		},
	};
}
