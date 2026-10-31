import {
	AddEquation,
	AdditiveBlending,
	BufferAttribute,
	Color,
	CustomBlending,
	MaxEquation,
	OneFactor,
	OneMinusSrcColorFactor,
	DynamicDrawUsage,
	HalfFloatType,
	InstancedBufferGeometry,
	InstancedInterleavedBuffer,
	InterleavedBufferAttribute,
	Mesh,
	OrthographicCamera,
	Points,
	Scene,
	ShaderMaterial,
	type Camera,
	RedFormat,
	type Texture,
	Vector2,
	Vector3,
	Vector4,
	WebGLRenderTarget,
	type WebGLRenderer,
} from 'three';
import { type Clouds, cloudShellRadius } from '../clouds';
import { browserStorage, type PreferenceStorage } from '../clouds/preference';
import { sunDirection } from '../sun';
import { lookedAt } from '../surface';
import { type FlashRing, NO_DELAY, type SourceDelays } from '../live';
import { assertDisplayMinutes, displayMs, readDisplayMinutes, writeDisplayMinutes } from './display';
import { CHANNEL, flashSeed } from './channel';
import { ChannelPool, POOL_FLASHES, SEGMENT_STRIDE } from './channel-pool';
import { DENSITY, followShare, heroLot, heroShare, heroTarget } from './density';
import { segmentGeometry } from './ribbon';
import { ribbonFragment, ribbonVertex } from './ribbon.glsl';
import { FLASH_STRIDE, FlashInstances } from './instances';
import { lightMapFragmentShader, lightMapVertexShader } from './light-map.glsl';
import { lightningFragmentShader, lightningVertexShader } from './lightning.glsl';
import { FlashPlayback } from './playback';
import { flickerLength, MAX_LIFE, PROFILE } from './profile';
import { PHONE, viewScale, ZOOM } from './zoom';

export { DISPLAY_MINUTES } from './display';
export { FlashInstances } from './instances';

const EARTH_RADIUS_KM = 6371;
export const CLOUD_TOP_KM = 12;

export interface LightningOptions {
	radius?: number;
	/** Flashes kept on the GPU around the playhead; defaults to the ring's capacity. */
	capacity?: number;
	/** Where the display duration persists; null keeps it in memory only. */
	storage?: PreferenceStorage | null;
	/** Equirectangular flash light map width, for clouds lit from inside; 0 disables it. */
	lightMapWidth?: number;
	/** Opacity of the cloud layer (`Clouds.opacity`), which hides or veils channels; without it they are veiled as if in a cloud. */
	clouds?: Clouds['opacity'];
	/** Phone screen: sizes as on a 1080 CSS px tall view and dimmer glows near the floor (`PHONE`). */
	phone?: boolean;
}

/** Glow of recent flashes over an equirectangular window: centre longitude and latitude, half extents, radians. */
export interface FlashLight {
	map: Texture;
	window: Vector4;
}

/**
 * Sampling of a storm view this frame: `alive` flashes within their flicker or fade, `drawn` those of them in
 * the sample, `load` the estimate of `alive` the share is sized by (`aliveLoad`), the applied `share` of the
 * lots and its `target`, and `channels` holding a slot in the pool.
 */
export interface LightningStats {
	alive: number;
	drawn: number;
	load: number;
	share: number;
	target: number;
	channels: number;
}

export interface Lightning {
	mesh: Mesh;
	/**
	 * Uploads new flashes and sets the scene time (UTC ms) flashes are aged against, each source `delays`
	 * behind; `speed` is the replay speed, which flickers never follow and which sizes the sample of flashes
	 * a storm view draws in full (`DENSITY`).
	 */
	setTime(utcMs: number, delays?: SourceDelays, speed?: number): void;
	/** Share of the lots drawn in full this frame, 1 for every flash; the sound follows it. */
	readonly heroShare: number;
	readonly stats: LightningStats;
	/** Afterglow chosen for the globe overview, minutes of scene time. */
	readonly displayMinutes: number;
	/** Changes the afterglow, from the data already loaded, and remembers the choice. */
	setDisplayMinutes(minutes: number): void;
	/** A storm view shows each flash alone, whatever the afterglow chosen. */
	stormView: boolean;
	/** Km per CSS px at the camera height; channels are only built when they can be seen. */
	viewKmPerPx: number;
	/** Null when disabled. */
	light: FlashLight | null;
	/** Redraws the light map around what `camera` looks at; call once per frame before the main render. */
	renderLightMap(renderer: WebGLRenderer, camera: Camera): void;
	dispose(): void;
}

/** A uniform shape of its own, so V8 keeps `value` a double in place instead of boxing it every frame. */
class NumberUniform {
	value = 0.5;
}

/** Seconds for the channel halo to fade in or out when the channel count crosses its budget. */
const HALO_FADE = 0.25;

/** Beyond this zoom, km per CSS px, even the largest flash has no readable channel. */
const CHANNEL_VIEW_KM_PER_PX = (CHANNEL.lengthScale * 25) / 6;

/** A storm view shows at most this many flashes at once, the newest; older ones fade within `BUDGET_FADE` wall clock seconds. */
export const STORM_VIEW_FLASHES = 500;
const BUDGET_FADE = 0.15;

/**
 * Overlapping flashes add up on the globe. A storm view shows a minute of flashes at once at 60×:
 * glows screen-blend, so they never pile up into white and still show on sunlit clouds, and the
 * cloud light keeps the brightest flash at each point.
 */
function blendFlashes(material: ShaderMaterial, mode: 'add' | 'max' | 'screen'): void {
	material.blending = mode === 'add' ? AdditiveBlending : CustomBlending;
	material.blendEquation = mode === 'max' ? MaxEquation : AddEquation;
	material.blendSrc = OneFactor;
	material.blendDst = mode === 'screen' ? OneMinusSrcColorFactor : OneFactor;
}

/** All flashes of the ring in one instanced draw call, aged on the GPU. */
export function createLightning(
	ring: FlashRing,
	{ radius = 1, capacity = ring.capacity, storage = browserStorage(), lightMapWidth = 1024, clouds, phone = false }: LightningOptions = {},
): Lightning {
	let displayMinutes = readDisplayMinutes(storage);
	let stormView = false;
	const shownMinutes = () => (stormView ? 0 : displayMinutes);
	const playback = new FlashPlayback();
	const geometry = new InstancedBufferGeometry();
	geometry.setAttribute(
		'position',
		new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3),
	);
	geometry.setIndex([0, 1, 2, 0, 2, 3]);

	const instances = new FlashInstances(
		ring,
		capacity,
		(start, count) => {
			buffer.addUpdateRange(start * FLASH_STRIDE, count * FLASH_STRIDE);
			buffer.needsUpdate = true;
		},
		displayMs(displayMinutes),
	);
	const buffer = new InstancedInterleavedBuffer(instances.data, FLASH_STRIDE).setUsage(DynamicDrawUsage);
	geometry.setAttribute('flash', new InterleavedBufferAttribute(buffer, 4, 0));
	geometry.setAttribute('flashShape', new InterleavedBufferAttribute(buffer, 4, 4));
	geometry.instanceCount = 0;

	const time = new NumberUniform();
	const speed = new NumberUniform();
	const pivot = new NumberUniform();
	const pivotSpeed = new NumberUniform();
	const budgetFrom = new NumberUniform();
	const budgetFade = new NumberUniform();
	const lightBudgetFrom = new NumberUniform();
	lightBudgetFrom.value = -1e6;
	const sample = new NumberUniform();
	sample.value = 1;
	const lightMapOff = new NumberUniform();
	lightMapOff.value = 1;
	const scale = new NumberUniform();
	scale.value = 1;
	const cloudDefines = clouds ? { ...clouds.defines, CLOUDS: '' } : {};
	const material = new ShaderMaterial({
		vertexShader: lightningVertexShader,
		fragmentShader: lightningFragmentShader,
		uniforms: {
			time,
			speed,
			pivot,
			pivotSpeed,
			budgetFrom,
			budgetFade,
			duration: { value: displayMs(displayMinutes) / 1000 },
			radius: { value: radius },
			lift: { value: CLOUD_TOP_KM / EARTH_RADIUS_KM },
			kmToWorld: { value: radius / EARTH_RADIUS_KM },
			viewportHeight: { value: 1 },
			viewScale: scale,
			nearGlowLevel: { value: ZOOM.nearGlowLevel * (phone ? PHONE.nearLevel : 1) },
			flicker: { value: 1 },
			haloStrength: { value: 1 },
			heroShare: sample,
			lightMapOff,
			sunDirection: { value: new Vector3(1, 0, 0) },
			exposure: { value: 1.6 },
			color: { value: new Color('#e4ebff') },
			cloudShell: { value: cloudShellRadius(radius) },
			...clouds?.uniforms,
		},
		defines: cloudDefines,
		blending: AdditiveBlending,
		transparent: true,
		depthWrite: false,
	});

	const channels = new ChannelPool(ring, POOL_FLASHES, (start, count) => {
		channelBuffer.addUpdateRange(start * SEGMENT_STRIDE, count * SEGMENT_STRIDE);
		channelBuffer.needsUpdate = true;
	});
	const channelBuffer = new InstancedInterleavedBuffer(channels.data, SEGMENT_STRIDE).setUsage(DynamicDrawUsage);
	const channelGeometry = segmentGeometry();
	for (const [name, offset] of [['segA', 0], ['segB', 4], ['segC', 8], ['flash', 12], ['flashShape', 16]] as const) {
		channelGeometry.setAttribute(name, new InterleavedBufferAttribute(channelBuffer, 4, offset));
	}
	channelGeometry.instanceCount = 0;
	const poolShift = new NumberUniform();
	// Channel cores add to what is behind them, so they stay visible over a lit cloud; halos keep the brightest.
	const ribbon = (halo: number) =>
		new ShaderMaterial({
			vertexShader: ribbonVertex,
			fragmentShader: ribbonFragment,
			uniforms: {
				...material.uniforms,
				poolShift,
				viewport: { value: viewport },
				halo: { value: halo },
				color: { value: new Color(halo ? '#c4cdff' : '#eef2ff') },
			},
			defines: { ...cloudDefines },
			transparent: true,
			depthWrite: false,
			blending: halo ? CustomBlending : AdditiveBlending,
			blendEquation: MaxEquation,
			blendSrc: OneFactor,
			blendDst: OneFactor,
		});
	const viewport = new Vector2(1, 1);
	const channelMaterial = ribbon(0);
	const haloMaterial = ribbon(1);
	const channelMesh = new Mesh(channelGeometry, channelMaterial);
	channelMesh.frustumCulled = false;
	channelMesh.onBeforeRender = (renderer) => {
		renderer.getSize(viewport);
		viewport.multiplyScalar(0.5 / viewScale(viewport.y, phone));
	};
	const haloMesh = new Mesh(channelGeometry, haloMaterial);
	haloMesh.frustumCulled = false;
	haloMesh.renderOrder = 2;
	channelMesh.renderOrder = 3;
	haloMesh.onBeforeRender = channelMesh.onBeforeRender;

	const lightMap = lightMapWidth > 0
		? createLightMap(geometry, material, lightBudgetFrom, lightMapWidth, radius, LIGHT_WINDOW.nearLevel * (phone ? PHONE.nearLevel : 1))
		: null;

	const reducedMotion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : undefined;
	const applyMotion = () => {
		material.uniforms.flicker.value = reducedMotion?.matches ? 0 : 1;
	};
	applyMotion();
	reducedMotion?.addEventListener('change', applyMotion);

	const mesh = new Mesh(geometry, material);
	mesh.frustumCulled = false;
	mesh.renderOrder = 1;
	mesh.add(channelMesh, haloMesh);
	haloMesh.layers = mesh.layers;
	channelMesh.layers = mesh.layers;
	const size = new Vector2();
	mesh.onBeforeRender = (renderer) => {
		const height = renderer.getSize(size).y;
		material.uniforms.viewportHeight.value = height;
		scale.value = viewScale(height, phone);
	};

	const applyDisplay = () => {
		const ms = displayMs(shownMinutes());
		instances.lookbackMs = ms;
		material.uniforms.duration.value = ms / 1000;
	};
	let share = 1;
	let load = 0;
	let target = Infinity;
	let sampled = false;
	let lastTime = Number.NaN;
	let lastDelays = NO_DELAY;
	let lightDrawn = false;
	let lastWall = Number.NaN;
	let viewKmPerPx = 0;

	return {
		mesh,
		setTime(utcMs, delays, replaySpeed = 1) {
			playback.update(utcMs, replaySpeed);
			lastTime = utcMs;
			lastDelays = delays ?? NO_DELAY;
			material.uniforms.sunDirection.value.set(...sunDirection(new Date(utcMs)));
			instances.lookbackMs = Math.max(displayMs(shownMinutes()), playback.span(MAX_LIFE, utcMs));
			instances.sync(utcMs, delays);
			geometry.instanceCount = instances.count;
			time.value = (utcMs - instances.origin) / 1000;
			speed.value = playback.speed;
			pivot.value = Number.isFinite(playback.pivot) ? (playback.pivot - instances.origin) / 1000 : -1e9;
			pivotSpeed.value = playback.pivotSpeed;
			const now = performance.now();
			const first = !Number.isFinite(lastWall);
			const dt = first ? 0 : (now - lastWall) / 1000;
			lastWall = now;
			// At replay speed a storm view would show thousands of flashes at once: a seeded sample of them is drawn in full, every flash lights the cloud.
			target = stormView ? heroTarget(playback.speed) : Infinity;
			load = stormView ? aliveLoad(ring, utcMs, playback.span(DENSITY.aliveWindow, utcMs), DENSITY.aliveWindow) : 0;
			share = followShare(share, heroShare(target, load), dt, playback.jumped || stormView !== sampled);
			sampled = stormView;
			sample.value = share;
			// The sample is the budget: the cap on the newest flashes binds only while every flash is drawn.
			const from = stormView && share === 1 ? budgetStart(ring, utcMs, STORM_VIEW_FLASHES) : Number.NEGATIVE_INFINITY;
			budgetFrom.value = Number.isFinite(from) ? (from - instances.origin) / 1000 : -1e6;
			const lightFrom = stormView ? budgetStart(ring, utcMs, DENSITY.lightMapCeiling) : Number.NEGATIVE_INFINITY;
			lightBudgetFrom.value = Number.isFinite(lightFrom) ? (lightFrom - instances.origin) / 1000 : -1e6;
			budgetFade.value = BUDGET_FADE * playback.speed;
			// Without a cloud light last frame (no light map on this tier, clouds hidden or without a frame), flashes outside the sample keep half a sprite.
			lightMapOff.value = lightDrawn ? 0 : 1;
			lightDrawn = false;
			channels.sync(utcMs, playback, delays, viewKmPerPx * scale.value < CHANNEL_VIEW_KM_PER_PX, share);
			channelGeometry.instanceCount = channels.count;
			poolShift.value = Number.isFinite(channels.origin) ? (channels.origin - instances.origin) / 1000 : 0;
			const step = first ? HALO_FADE : Math.min(dt, HALO_FADE);
			const haloTarget = channels.flashes <= CHANNEL.haloCapacity ? 1 : 0;
			const halo = material.uniforms.haloStrength;
			if (haloTarget > halo.value) halo.value = Math.min(1, halo.value + step / HALO_FADE);
			else if (haloTarget < halo.value) halo.value = Math.max(0, halo.value - step / HALO_FADE);
			haloMesh.visible = halo.value > 0;
		},
		get heroShare() {
			return share;
		},
		get stats() {
			const { alive, drawn } = Number.isFinite(lastTime) ? sampleCount(ring, lastTime, playback, lastDelays, share) : { alive: 0, drawn: 0 };
			return { alive, drawn, load, share, target, channels: channels.flashes };
		},
		get viewKmPerPx() {
			return viewKmPerPx;
		},
		set viewKmPerPx(kmPerPx) {
			viewKmPerPx = kmPerPx;
		},
		get displayMinutes() {
			return displayMinutes;
		},
		setDisplayMinutes(minutes) {
			assertDisplayMinutes(minutes);
			displayMinutes = minutes;
			applyDisplay();
			writeDisplayMinutes(storage, minutes);
		},
		get stormView() {
			return stormView;
		},
		set stormView(on) {
			if (on === stormView) return;
			stormView = on;
			applyDisplay();
			blendFlashes(material, on ? 'screen' : 'add');
			lightMap?.blend(on);
		},
		light: lightMap?.light ?? null,
		renderLightMap(renderer, camera) {
			lightMap?.render(renderer, camera);
			lightDrawn = lightMap !== null;
		},
		dispose() {
			lightMap?.dispose();
			reducedMotion?.removeEventListener('change', applyMotion);
			haloMaterial.dispose();
			channelGeometry.dispose();
			channelMaterial.dispose();
			geometry.dispose();
			material.dispose();
		},
	};
}

export const LIGHT_WINDOW = {
	/** Half height of the window over the camera height. */
	heightScale: 3,
	/** Splat radius over the observed radius, near and far, and the splat floor far away, km. */
	nearSplat: 2,
	farSplat: 3,
	farSpreadKm: 150,
	/** Cloud light level near the floor, so channels still read over the lit cloud. */
	nearLevel: 0.45,
} as const;

/** Ring index (oldest = 0) after the last flash played by `time`. */
function playedBy(ring: FlashRing, time: number): number {
	let lo = 0;
	let hi = ring.size;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (ring.time[ring.slot(mid)] <= time) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** Scene time (UTC ms) of the `count`-th newest flash played by `now`, or -Infinity when fewer have played. */
export function budgetStart(ring: FlashRing, now: number, count: number): number {
	const lo = playedBy(ring, now);
	return lo > count ? ring.time[ring.slot(lo - count)] : Number.NEGATIVE_INFINITY;
}

/** Flashes played within the `spanMs` of scene time up to `now`. */
export function aliveCount(ring: FlashRing, now: number, spanMs: number): number {
	return playedBy(ring, now) - playedBy(ring, now - spanMs);
}

/**
 * Flashes within their flicker or fade at once, estimated from those played within the `spanMs` of scene
 * time up to `now`, which cover `seconds` of wall clock time: each counts for its flicker and fade over
 * those seconds, so a storm of long flashes keeps more lit than one of short ones at the same rate.
 */
export function aliveLoad(ring: FlashRing, now: number, spanMs: number, seconds: number): number {
	const to = playedBy(ring, now);
	let life = 0;
	for (let i = playedBy(ring, now - spanMs); i < to; i++) life += flickerLength(ring.durationMs[ring.slot(i)]) + CHANNEL.fade;
	return life / seconds;
}

/** Flashes within their flicker or fade at `now`, each source `delays` behind, and those of them whose lot is under `share`. */
export function sampleCount(ring: FlashRing, now: number, playback: FlashPlayback, delays: SourceDelays, share: number): { alive: number; drawn: number } {
	const to = playedBy(ring, now - delays.min);
	let alive = 0;
	let drawn = 0;
	for (let i = playedBy(ring, now - playback.span(PROFILE.maxFlicker + CHANNEL.fade, now) - delays.max); i < to; i++) {
		const s = ring.slot(i);
		const at = ring.time[s] + delays.ms[ring.source[s]];
		if (at > now || playback.age(at, now) >= flickerLength(ring.durationMs[s]) + CHANNEL.fade) continue;
		alive++;
		if (share >= 1 || heroLot(flashSeed(ring.time[s], ring.lat[s], ring.lon[s]), ring.intensity[s]) < share) drawn++;
	}
	return { alive, drawn };
}

/** Light map window around `target` (radians) for a camera `heightKm` above the ground: centre longitude and latitude, half extents. */
export function lightWindow(target: { lat: number; lon: number }, heightKm: number, out = new Vector4()): Vector4 {
	const halfLat = Math.min(Math.PI / 2, (LIGHT_WINDOW.heightScale * heightKm) / EARTH_RADIUS_KM);
	const lat = Math.min(Math.max(target.lat, -Math.PI / 2 + halfLat), Math.PI / 2 - halfLat);
	// Wide enough at the poleward edge too, up to the whole circle at a pole.
	const halfLon = Math.min(Math.PI, (2 * halfLat) / Math.max(Math.cos(Math.abs(lat) + halfLat), 1e-3));
	return out.set(target.lon, lat, halfLon, halfLat);
}


/** Renders the flashes into an equirectangular glow map around what the camera looks at, wrapped at the antimeridian. */
function createLightMap(flashGeometry: InstancedBufferGeometry, flashes: ShaderMaterial, budgetFrom: NumberUniform, width: number, radius: number, nearLevel: number) {
	const target = new WebGLRenderTarget(width, width / 2, { type: HalfFloatType, format: RedFormat, depthBuffer: false });
	const geometry = new InstancedBufferGeometry();
	geometry.setAttribute('position', new BufferAttribute(new Float32Array(3), 3));
	geometry.setAttribute('flash', flashGeometry.getAttribute('flash'));
	geometry.setAttribute('flashShape', flashGeometry.getAttribute('flashShape'));
	const { time, duration, flicker, speed, pivot, pivotSpeed, budgetFade } = flashes.uniforms;
	const bounds = new Vector4(0, 0, Math.PI, Math.PI / 2);
	const splat = { value: LIGHT_WINDOW.farSplat as number };
	const level = { value: 1 };
	const spread = { value: LIGHT_WINDOW.farSpreadKm as number };
	const minSplat = { value: 0 };
	const scene = new Scene();
	const camera = new OrthographicCamera();
	const materials = [0, 1].map(
		(wrap) =>
			new ShaderMaterial({
				vertexShader: lightMapVertexShader,
				fragmentShader: lightMapFragmentShader,
				uniforms: {
					time,
					duration,
					flicker,
					speed,
					pivot,
					pivotSpeed,
					budgetFrom,
					budgetFade,
					window: { value: bounds },
					splat,
					level,
					spreadKm: spread,
					minSplatKm: minSplat,
					wrap: { value: wrap },
					mapSize: { value: new Vector2(width, width / 2) },
				},
				blending: AdditiveBlending,
				depthTest: false,
				depthWrite: false,
			}),
	);
	for (const material of materials) {
		const points = new Points(geometry, material);
		points.frustumCulled = false;
		scene.add(points);
	}
	const clearColor = new Color();
	const eye = new Vector3();
	const forward = new Vector3();
	const point = new Vector3();
	const aim = { lat: 0, lon: 0 };
	return {
		target,
		light: { map: target.texture, window: bounds },
		blend(alone: boolean) {
			for (const material of materials) blendFlashes(material, alone ? 'max' : 'add');
		},
		render(renderer: WebGLRenderer, view: Camera) {
			view.getWorldPosition(eye);
			view.getWorldDirection(forward);
			const height = Math.max(0, eye.length() - radius);
			lookedAt(eye, forward, radius, point);
			aim.lat = Math.asin(Math.min(1, Math.max(-1, point.y)));
			aim.lon = Math.atan2(-point.z, point.x);
			lightWindow(aim, (height / radius) * EARTH_RADIUS_KM, bounds);
			const whole = bounds.w / (Math.PI / 2);
			splat.value = LIGHT_WINDOW.nearSplat + (LIGHT_WINDOW.farSplat - LIGHT_WINDOW.nearSplat) * whole;
			level.value = nearLevel + (1 - nearLevel) * whole;
			spread.value = LIGHT_WINDOW.farSpreadKm * whole * whole;
			minSplat.value = (4 * bounds.w * EARTH_RADIUS_KM) / (width / 2);
			const previous = renderer.getRenderTarget();
			renderer.getClearColor(clearColor);
			const clearAlpha = renderer.getClearAlpha();
			renderer.setRenderTarget(target);
			renderer.setClearColor(0x000000, 0);
			renderer.clear(true, false, false);
			geometry.instanceCount = flashGeometry.instanceCount;
			if (geometry.instanceCount > 0) renderer.render(scene, camera);
			renderer.setClearColor(clearColor, clearAlpha);
			renderer.setRenderTarget(previous);
		},
		dispose() {
			target.dispose();
			geometry.dispose();
			materials.forEach((m) => m.dispose());
		},
	};
}
