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
import { calmShare, DENSITY, fieldLevel, flashLot, followShare, heroShare, heroTarget } from './density';
import { segmentGeometry } from './ribbon';
import { ribbonFragment, ribbonVertex } from './ribbon.glsl';
import { FLASH_STRIDE, FlashInstances } from './instances';
import { channelLightFragmentShader, channelLightVertexShader, lightMapFragmentShader, lightMapVertexShader } from './light-map.glsl';
import { lightningFragmentShader, lightningVertexShader } from './lightning.glsl';
import { FlashPlayback } from './playback';
import { flickerLength, MAX_LIFE, PROFILE } from './profile';
import { maxBlendShare, PHONE, viewScale, ZOOM } from './zoom';

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

/**
 * Glow of recent flashes over an equirectangular window: centre longitude and latitude, half extents, radians.
 * A finer map covers the ground around the view, read by its `share` (0 from afar).
 */
export interface FlashLight {
	map: Texture;
	window: Vector4;
	fine: { map: Texture; window: Vector4; share: { value: number } };
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
	/** Km per CSS px at the camera height; gates channel builds and, in a storm view, the glow blend (max below `ZOOM.floorKmPerPx`). */
	viewKmPerPx: number;
	/** Whether the cloud light shows; without it the glow keeps `ZOOM.glowLevel` near the floor. */
	cloudLit: boolean;
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

/** Seconds for the channel halo to fade in or out when the channel count crosses its budget, and for the half sprite of the flashes outside the sample when the cloud light comes or goes. */
const HALO_FADE = 0.25;

/** Beyond this zoom, km per CSS px, even the largest flash has no readable channel. */
const CHANNEL_VIEW_KM_PER_PX = (CHANNEL.lengthScale * 25) / 6;

/** A storm view shows the newest this many flashes while every flash is drawn in full (share 1), older ones fading within `BUDGET_FADE` wall clock seconds; otherwise it caps only the points outside the sample (`pointBudgetFrom`). */
export const STORM_VIEW_FLASHES = 500;
const BUDGET_FADE = 0.15;

/**
 * Overlapping flashes add up on the globe. A storm view shows a minute of flashes at once at 60×:
 * near the floor the brightest glow sets each pixel, so a cell never piles up into white; from
 * `ZOOM.floorKmPerPx` glows screen-blend, so points still accumulate softly and show on sunlit
 * clouds, and in between a screen-blended twin fades in under them (`maxBlendShare`). The cloud
 * light keeps the brightest flash at each point.
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
	geometry.setAttribute('flashLook', new InterleavedBufferAttribute(buffer, 3, 8));
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
	const pointBudgetFrom = new NumberUniform();
	pointBudgetFrom.value = -1e6;
	const viewKm = new NumberUniform();
	viewKm.value = 1e3;
	const field = new NumberUniform();
	field.value = 1;
	const calm = new NumberUniform();
	calm.value = 0;
	const scale = new NumberUniform();
	scale.value = 1;
	const nearGlowLevel = new NumberUniform();
	const phoneLevel = phone ? PHONE.nearLevel : 1;
	let cloudLit = false;
	const applyCloudLit = (lit: boolean) => {
		cloudLit = lit && lightMapWidth > 0;
		nearGlowLevel.value = (cloudLit ? ZOOM.nearGlowLevel : ZOOM.glowLevel) * phoneLevel;
	};
	applyCloudLit(true);
	const screenWeight = new NumberUniform();
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
			nearGlowLevel,
			glowLevel: { value: ZOOM.glowLevel * phoneLevel },
			blendWeight: { value: 1 },
			flicker: { value: 1 },
			haloStrength: { value: 1 },
			heroShare: sample,
			lightMapOff,
			pointBudgetFrom,
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
	for (const [name, offset] of [['segA', 0], ['segB', 4], ['segC', 8], ['flash', 12], ['flashShape', 16], ['flashLook', 20]] as const) {
		channelGeometry.setAttribute(name, new InterleavedBufferAttribute(channelBuffer, name === 'flashLook' ? 3 : 4, offset));
	}
	channelGeometry.instanceCount = 0;
	const poolShift = new NumberUniform();
	const pixelRatio = { value: 1 };
	// Channel cores add to what is behind them, so they stay visible over a lit cloud; halos and the light the clouds scatter keep the brightest.
	const ribbon = (halo: number) =>
		new ShaderMaterial({
			vertexShader: ribbonVertex,
			fragmentShader: ribbonFragment,
			uniforms: {
				...material.uniforms,
				poolShift,
				pixelRatio,
				viewport: { value: viewport },
				targetSize: { value: targetSize },
				halo: { value: halo },
				color: { value: new Color(['#eef2ff', '#c4cdff', '#dfe6ff'][halo]) },
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
	const targetSize = new Vector2(1, 1);
	const channelMaterial = ribbon(0);
	const haloMaterial = ribbon(1);
	const scatterMaterial = ribbon(2);
	const channelMesh = new Mesh(channelGeometry, channelMaterial);
	channelMesh.frustumCulled = false;
	channelMesh.onBeforeRender = (renderer) => {
		renderer.getSize(viewport);
		viewport.multiplyScalar(0.5 / viewScale(viewport.y, phone));
		pixelRatio.value = renderer.getPixelRatio();
		const target = renderer.getRenderTarget();
		if (target) targetSize.set(target.width, target.height);
		else renderer.getDrawingBufferSize(targetSize);
	};
	const haloMesh = new Mesh(channelGeometry, haloMaterial);
	haloMesh.frustumCulled = false;
	haloMesh.renderOrder = 2;
	channelMesh.renderOrder = 3;
	haloMesh.onBeforeRender = channelMesh.onBeforeRender;
	// Only where the clouds are drawn in relief, and outside the bloom: it is soft already.
	const scatterMesh = new Mesh(channelGeometry, scatterMaterial);
	scatterMesh.frustumCulled = false;
	scatterMesh.renderOrder = 1.5;
	scatterMesh.visible = 'VOLUME' in cloudDefines;
	scatterMesh.onBeforeRender = channelMesh.onBeforeRender;

	const lightMap = lightMapWidth > 0
		? createLightMap(geometry, material, { budgetFrom: lightBudgetFrom, fieldLevel: field, calm, viewKmPerPx: viewKm, poolShift }, channelGeometry, lightMapWidth, phone ? lightMapWidth / 2 : lightMapWidth, radius, LIGHT_WINDOW.nearLevel * (phone ? PHONE.nearLevel : 1))
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
	// Drawn just before the max-blended glow while a storm view crosses from max to screen blending.
	const screenMaterial = new ShaderMaterial({
		vertexShader: lightningVertexShader,
		fragmentShader: lightningFragmentShader,
		uniforms: { ...material.uniforms, blendWeight: screenWeight },
		defines: cloudDefines,
		transparent: true,
		depthWrite: false,
	});
	blendFlashes(screenMaterial, 'screen');
	const screenMesh = new Mesh(geometry, screenMaterial);
	screenMesh.frustumCulled = false;
	screenMesh.renderOrder = 0.5;
	screenMesh.visible = false;
	mesh.add(channelMesh, haloMesh, screenMesh, scatterMesh);
	haloMesh.layers = mesh.layers;
	channelMesh.layers = mesh.layers;
	screenMesh.layers = mesh.layers;
	const size = new Vector2();
	mesh.onBeforeRender = (renderer) => {
		const height = renderer.getSize(size).y;
		material.uniforms.viewportHeight.value = height;
		scale.value = viewScale(height, phone);
	};
	screenMesh.onBeforeRender = mesh.onBeforeRender;

	const applyDisplay = () => {
		const ms = displayMs(shownMinutes());
		instances.lookbackMs = ms;
		material.uniforms.duration.value = ms / 1000;
	};
	let share = 1;
	let load = 0;
	let target = Infinity;
	let sampled = false;
	let straddled = false;
	let lastTime = Number.NaN;
	let lastDelays = NO_DELAY;
	let lightDrawn = false;
	let lastWall = Number.NaN;
	let viewKmPerPx = 0;
	let blend: 'add' | 'max' | 'screen' = 'add';
	const applyBlend = () => {
		const maxShare = stormView ? maxBlendShare(viewKmPerPx * scale.value) : 0;
		const mode = !stormView ? 'add' : maxShare > 0 ? 'max' : 'screen';
		if (mode !== blend) {
			blend = mode;
			blendFlashes(material, mode);
		}
		// Max over a screen sum weighted by 1 - share: pure max at 1, pure screen at 0, a lone glow on the dark unchanged between.
		screenMesh.visible = mode === 'max' && maxShare < 1;
		screenWeight.value = 1 - maxShare;
	};

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
			const step = first ? HALO_FADE : Math.min(dt, HALO_FADE);
			// At replay speed a storm view would show thousands of flashes at once: a seeded sample of them is drawn in full, every flash lights the cloud.
			target = stormView ? heroTarget(playback.speed) : Infinity;
			load = stormView ? aliveLoad(ring, utcMs, playback.span(DENSITY.aliveWindow, utcMs), DENSITY.aliveWindow) : 0;
			// While the alive window holds flashes from before a speed change, and on the frame it leaves them, the load tracks the flashes alive frame by frame: so does the share.
			const straddling = playback.straddles(DENSITY.aliveWindow, utcMs);
			share = followShare(share, heroShare(target, load), dt, playback.jumped || straddling || straddled || stormView !== sampled);
			straddled = straddling;
			// The cloud light of the other flashes is exposed down with the load and calms as the sample thins.
			field.value = stormView ? followShare(field.value, fieldLevel(load), dt, playback.jumped || straddling || stormView !== sampled) : 1;
			calm.value = stormView ? calmShare(share) : 0;
			sampled = stormView;
			sample.value = share;
			// The sample is the budget: the cap on the newest flashes binds every flash while all are drawn, and only the points outside the sample otherwise.
			const from = stormView ? budgetStart(ring, utcMs, STORM_VIEW_FLASHES) : Number.NEGATIVE_INFINITY;
			const fromS = Number.isFinite(from) ? (from - instances.origin) / 1000 : -1e6;
			budgetFrom.value = share === 1 ? fromS : -1e6;
			pointBudgetFrom.value = share === 1 ? -1e6 : fromS;
			const lightFrom = stormView ? budgetStart(ring, utcMs, DENSITY.lightMapCeiling) : Number.NEGATIVE_INFINITY;
			lightBudgetFrom.value = Number.isFinite(lightFrom) ? (lightFrom - instances.origin) / 1000 : -1e6;
			budgetFade.value = BUDGET_FADE * playback.speed;
			// Without a cloud light last frame (no light map on this tier, clouds hidden or without a frame), flashes outside the sample ease to half a sprite.
			const off = lightDrawn ? 0 : 1;
			lightMapOff.value = off > lightMapOff.value ? Math.min(off, lightMapOff.value + step / HALO_FADE) : Math.max(off, lightMapOff.value - step / HALO_FADE);
			lightDrawn = false;
			channels.sync(utcMs, playback, delays, viewKmPerPx * scale.value < CHANNEL_VIEW_KM_PER_PX, share);
			channelGeometry.instanceCount = channels.count;
			poolShift.value = Number.isFinite(channels.origin) ? (channels.origin - instances.origin) / 1000 : 0;
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
			viewKm.value = kmPerPx * scale.value;
			applyBlend();
		},
		get cloudLit() {
			return cloudLit;
		},
		set cloudLit(lit) {
			applyCloudLit(lit);
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
			applyBlend();
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
			scatterMaterial.dispose();
			screenMaterial.dispose();
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
	/** Splat radius over the observed radius: the patch ends at the footprint near the floor, wider from afar; and the splat floor far away, km. */
	nearSplat: 1.3,
	farSplat: 3,
	farSpreadKm: 150,
	/** Cloud light level near the floor, so channels still read over the lit cloud. */
	nearLevel: 0.35,
	/** Smallest splat radius, texels of the map. */
	minSplatTexels: 2,
	/** The fine map around the view: half height over the camera height, at least `fineMinKm`, centred on the ground at this screen height (NDC), where oblique views magnify it. */
	fineScale: 0.8,
	fineMinKm: 250,
	fineScreenY: -0.3,
	/** Its smallest splat radius, texels: its window is snapped to its texels, so small splats hold still. */
	fineMinSplatTexels: 1.5,
	/** Camera heights, km, over which its splats widen from the footprint to the wide map's, and over which it hands over to the wide map. */
	fineWiden: [2000, 6500],
	fineFade: [5000, 6500],
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
		if (share >= 1 || flashLot(flashSeed(ring.time[s], ring.lat[s], ring.lon[s]), ring.intensity[s], ring.durationMs[s], ring.areaKm2[s]) < share) drawn++;
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


/**
 * Fine light map window: a square of ground around `target` (radians) for a camera `heightKm` up, its centre
 * snapped to the texels of a map `size` wide so a moving view does not resample the splats.
 */
export function fineWindow(target: { lat: number; lon: number }, heightKm: number, size: number, out = new Vector4()): Vector4 {
	const halfLat = Math.min(Math.PI / 4, Math.max(LIGHT_WINDOW.fineMinKm, LIGHT_WINDOW.fineScale * heightKm) / EARTH_RADIUS_KM);
	const stepLat = (2 * halfLat) / size;
	const limit = Math.PI / 2 - halfLat;
	const lat = Math.min(Math.max(Math.round(target.lat / stepLat) * stepLat, -limit), limit);
	const halfLon = Math.min(Math.PI, halfLat / Math.max(Math.cos(lat), 0.05));
	const stepLon = (2 * halfLon) / size;
	return out.set(Math.round(target.lon / stepLon) * stepLon, lat, halfLon, halfLat);
}

/** How far the fine map's splats have widened to the wide map's (0 to 1) and its share of the light read (1 to 0), for a camera `heightKm` up. */
export function fineShare(heightKm: number): { widen: number; share: number } {
	const ramp = ([from, to]: readonly [number, number]) => Math.min(1, Math.max(0, (heightKm - from) / (to - from)));
	const widen = ramp(LIGHT_WINDOW.fineWiden);
	const fade = ramp(LIGHT_WINDOW.fineFade);
	return { widen: widen * widen, share: 1 - fade * fade * (3 - 2 * fade) };
}

type LightUniforms = { budgetFrom: NumberUniform; fieldLevel: NumberUniform; calm: NumberUniform; viewKmPerPx: NumberUniform; poolShift: NumberUniform };

/**
 * Renders the flashes into two glow maps, wrapped at the antimeridian: a wide equirectangular window around
 * what the camera looks at, and a fine square one around the ground near the view.
 */
function createLightMap(flashGeometry: InstancedBufferGeometry, flashes: ShaderMaterial, { budgetFrom, fieldLevel, calm, viewKmPerPx, poolShift }: LightUniforms, channels: InstancedBufferGeometry, width: number, fineWidth: number, radius: number, nearLevel: number) {
	const geometry = new InstancedBufferGeometry();
	geometry.setAttribute('position', new BufferAttribute(new Float32Array(3), 3));
	geometry.setAttribute('flash', flashGeometry.getAttribute('flash'));
	geometry.setAttribute('flashShape', flashGeometry.getAttribute('flashShape'));
	geometry.setAttribute('flashLook', flashGeometry.getAttribute('flashLook'));
	const { time, duration, flicker, speed, pivot, pivotSpeed, budgetFade, heroShare } = flashes.uniforms;
	const camera = new OrthographicCamera();
	const shared = { time, duration, flicker, speed, pivot, pivotSpeed, budgetFrom, budgetFade, heroShare, viewKmPerPx };
	// The wide map draws the flashes near its antimeridian twice; the fine one also draws the channels of the flashes drawn in full.
	const level = (w: number, h: number, fine: boolean) => {
		const target = new WebGLRenderTarget(w, h, { type: HalfFloatType, format: RedFormat, depthBuffer: false });
		const uniforms = {
			window: { value: new Vector4(0, 0, Math.PI, Math.PI / 2) },
			splat: { value: LIGHT_WINDOW.farSplat as number },
			level: { value: 1 },
			spreadKm: { value: LIGHT_WINDOW.farSpreadKm as number },
			minSplatKm: { value: 0 },
			mapSize: { value: new Vector2(w, h) },
		};
		const scene = new Scene();
		const materials = (fine ? [0] : [0, 1]).map(
			(wrap) =>
				new ShaderMaterial({
					vertexShader: lightMapVertexShader,
					fragmentShader: lightMapFragmentShader,
					uniforms: { ...shared, fieldLevel, calm, ...uniforms, wrap: { value: wrap }, channelGlow: { value: fine ? 1 : 0 } },
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
		if (fine) {
			// Over the footprints, keeping the brightest: tubes overlap at every joint of a path.
			const material = new ShaderMaterial({
				vertexShader: channelLightVertexShader,
				fragmentShader: channelLightFragmentShader,
				uniforms: { ...shared, poolShift, ...uniforms },
				blending: CustomBlending,
				blendEquation: MaxEquation,
				blendSrc: OneFactor,
				blendDst: OneFactor,
				depthTest: false,
				depthWrite: false,
			});
			const tubes = new Mesh(channels, material);
			tubes.frustumCulled = false;
			tubes.renderOrder = 1;
			scene.add(tubes);
			materials.push(material);
		}
		return { target, uniforms, scene, materials };
	};
	const wide = level(width, width / 2, false);
	const fine = level(fineWidth, fineWidth, true);
	const fineOn = { value: 0 };
	const clearColor = new Color();
	const eye = new Vector3();
	const forward = new Vector3();
	const point = new Vector3();
	const aim = { lat: 0, lon: 0 };
	const aimAt = (direction: Vector3) => {
		lookedAt(eye, direction, radius, point);
		aim.lat = Math.asin(Math.min(1, Math.max(-1, point.y / radius)));
		aim.lon = Math.atan2(-point.z, point.x);
		return aim;
	};
	return {
		light: { map: wide.target.texture, window: wide.uniforms.window.value, fine: { map: fine.target.texture, window: fine.uniforms.window.value, share: fineOn } },
		render(renderer: WebGLRenderer, view: Camera) {
			view.getWorldPosition(eye);
			view.getWorldDirection(forward);
			const heightKm = (Math.max(0, eye.length() - radius) / radius) * EARTH_RADIUS_KM;
			const bounds = lightWindow(aimAt(forward), heightKm, wide.uniforms.window.value);
			const whole = bounds.w / (Math.PI / 2);
			wide.uniforms.splat.value = LIGHT_WINDOW.nearSplat + (LIGHT_WINDOW.farSplat - LIGHT_WINDOW.nearSplat) * whole;
			wide.uniforms.level.value = nearLevel + (1 - nearLevel) * whole;
			wide.uniforms.spreadKm.value = LIGHT_WINDOW.farSpreadKm * whole * whole;
			wide.uniforms.minSplatKm.value = (LIGHT_WINDOW.minSplatTexels * 2 * bounds.w * EARTH_RADIUS_KM) / (width / 2);
			// The fine map draws each flash at its footprint near the ground and widens to the wide map's splats before handing over.
			const { widen, share } = fineShare(heightKm);
			fineOn.value = share;
			if (share > 0) {
				forward.set(0, LIGHT_WINDOW.fineScreenY, 0.5).unproject(view).sub(eye).normalize();
				const square = fineWindow(aimAt(forward), heightKm, fineWidth, fine.uniforms.window.value);
				fine.uniforms.splat.value = LIGHT_WINDOW.nearSplat + (wide.uniforms.splat.value - LIGHT_WINDOW.nearSplat) * widen;
				fine.uniforms.level.value = nearLevel + (wide.uniforms.level.value - nearLevel) * widen;
				fine.uniforms.spreadKm.value = wide.uniforms.spreadKm.value * widen;
				fine.uniforms.minSplatKm.value = (LIGHT_WINDOW.fineMinSplatTexels * 2 * square.w * EARTH_RADIUS_KM) / fineWidth;
			}
			const previous = renderer.getRenderTarget();
			renderer.getClearColor(clearColor);
			const clearAlpha = renderer.getClearAlpha();
			renderer.setClearColor(0x000000, 0);
			geometry.instanceCount = flashGeometry.instanceCount;
			for (const map of share > 0 ? [wide, fine] : [wide]) {
				renderer.setRenderTarget(map.target);
				renderer.clear(true, false, false);
				if (geometry.instanceCount > 0) renderer.render(map.scene, camera);
			}
			renderer.setClearColor(clearColor, clearAlpha);
			renderer.setRenderTarget(previous);
		},
		dispose() {
			geometry.dispose();
			for (const map of [wide, fine]) {
				map.target.dispose();
				map.materials.forEach((m) => m.dispose());
			}
		},
	};
}
