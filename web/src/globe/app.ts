import { Matrix4, PerspectiveCamera, Scene, type ShaderMaterial, Vector2, Vector3, WebGLRenderer } from 'three';
import { BUILD } from '../version';
import { SceneData } from './archive';
import { FlashDays } from './archive/days';
import { atmosphereParameters, createAtmosphere } from './atmosphere';
import { SceneClock } from './clock';
import { cloudShellRadius, type Clouds, createClouds } from './clouds';
import { ArchiveCloudFeed } from './clouds/archive';
import { createCloudDetail } from './clouds/detail';
import type { StyleBounds } from './clouds/bounds';
import { createCloudVolume, type CloudVolume } from './clouds/volume';
import { attachDevClouds } from './clouds/dev';
import { CloudFeed, LIVE_CLOUD_FRAMES } from './clouds/feed';
import { CloudPlayback } from './clouds/playback';
import { createGlobeControls, type GlobeControls } from './controls';
import { createCoverage } from './coverage';
import { attachCoverageLabel, surfacePoint } from './coverage/label';
import { runDevFlights } from './dev-flight';
import { applyDevReplay } from './dev-replay';
import { isReplayFixture } from './dev-storm';
import { createEarth, surfaceRoot, texturesRoot } from './earth';
import { StormFocus } from './focus';
import { ActiveFeed, pickCell } from './focus/active';
import { kmToWorld, worldToKm } from './flight';
import { CLOUD_TOP_KM, createLightning, type Lightning } from './lightning';
import { bloomStrength } from './lightning/zoom';
import { type FlashRing, LateFlashes, type LiveClient, type LiveClientOptions, LIVE_DELAYS, liveBaseUrl, NO_DELAY, type SourceDelays, startLiveFeed } from './live';
import { type FeedStatus, feedStatus } from './live/freshness';
import { clipPlanes } from './orbit';
import { BLOOM, createPostProcessing, type PostProcessing } from './post';
import { createRenderHandle, type RenderHandle } from './render/mode';
import type { RenderParams } from './render/params';
import { FpsMonitor, guessTier, isPhone, lowerTier, PRESETS, surfaceBudgetMb, tierFromSearch } from './quality';
import { observedTime } from './scene-time';
import { createStarfield } from './starfield';
import { latLonToVector, sunDirection } from './sun';
import { SURFACE_MODES, SurfaceDetail, surfaceFromSearch } from './detail';
import { StormReplay } from './replay';
import { StormTrack } from './replay/track';
import { ReplayNavigation } from './replay/navigation';
import { readFrameCheckpoint, type FrameCheckpoint } from './replay/checkpoint';
import { frameStorm } from './replay/framing';
import { createSound, type Sound } from './sound';
import { cappedPixelRatio } from './viewport';
import { CONTEXT_ATTRIBUTES } from './webgl';
import { CLOUD_ARCHIVE_RULES } from '../contract/cloud-archive';

function deviceHints(context: WebGL2RenderingContext) {
	const debug = context.getExtension('WEBGL_debug_renderer_info');
	const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
	return {
		gpu: debug ? String(context.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : undefined,
		screenMin: Math.min(screen.width, screen.height),
		coarsePointer: matchMedia('(pointer: coarse)').matches,
		memoryGb: memory,
	};
}

export interface GlobeApp {
	readonly flyTo: GlobeControls['flyTo'];
	readonly clock: SceneClock;
	readonly data: SceneData;
	readonly replay: StormReplay;
	/** The storm the scene is about, in replay or picked on the live globe, and its following. */
	readonly focus: StormFocus;
	shareUrl(): string;
	readonly clouds: Clouds;
	readonly cloudFeed: CloudFeed;
	cloudStatus(): { settled: boolean; attribution: string | null };
	readonly sound: Sound;
	readonly lightning: Pick<Lightning, 'displayMinutes' | 'setDisplayMinutes' | 'stormView'>;
	/** Freshness of the live feed now. */
	feedStatus(): FeedStatus;
	/** Time of the newest flashes drawn, for the selected storm's sources if any: ages are measured from it. */
	observedTime(): number;
	/** Whether observations are loaded for this time; false means unknown, not an empty sky. */
	hasData(time: number): boolean;
	/** Earliest loaded observation window (UTC ms), or null. */
	dataStart(): number | null;
	/** UTC midnight of the first day travel in time can show, once the archive index is known. */
	archiveStart(): number | null;
	/** Internals for tools and the HUD flash counter. */
	readonly debug: { ring: FlashRing; client: LiveClient; delays(): SourceDelays; late: LateFlashes; quality(): string };
	/** Set in render mode only. */
	readonly render?: RenderHandle;
	/** Surface detail prototypes (#125), in development and PR previews only. */
	readonly surface?: SurfaceDetail;
	/** Clouds in relief (ADR 0028), in development and PR previews only. */
	readonly cloudVolume?: { detail: boolean; coverage(): { width: number; height: number; values: Float32Array }; styleCheck(): StyleBounds };
	dispose(): void;
}

const RADIUS = 1;
const EARTH_RADIUS_KM = 6371;
const FOV = 35;
const SHELLS = [
	cloudShellRadius(RADIUS),
	RADIUS + kmToWorld(CLOUD_TOP_KM, RADIUS),
	atmosphereParameters(RADIUS).atmosphereRadius,
];

export interface GlobeAppOptions {
	/** Offline rendering: fixed size and view, frames drawn on demand. */
	render?: RenderParams;
	/** Label shown over areas without lightning data. */
	coverageLabel?: HTMLElement;
}

export function createGlobeApp(
	canvas: HTMLCanvasElement,
	context: WebGL2RenderingContext,
	{ render: renderParams, coverageLabel }: GlobeAppOptions = {},
): GlobeApp {
	const renderer = new WebGLRenderer({ canvas, context, ...CONTEXT_ATTRIBUTES });
	const scene = new Scene();
	const camera = new PerspectiveCamera(FOV, 1, 0.1, 100);
	const controls = createGlobeControls(camera, canvas, RADIUS);

	const hints = deviceHints(context);
	const phone = isPhone(hints);
	let tier = renderParams?.quality ?? tierFromSearch(location.search) ?? guessTier(hints);
	const preset = PRESETS[tier];
	canvas.dataset.quality = tier;
	const fps = new FpsMonitor();

	const clock = new SceneClock();
	if (import.meta.env.DEV) applyDevReplay(clock, location.search);
	const earth = createEarth(renderer, RADIUS, preset.textures);
	scene.add(earth.mesh);
	// Development and PR previews can switch to the base textures or the #125 prototypes to compare.
	const compareSurface = import.meta.env.DEV || BUILD.pr !== null;
	const surfaceBytes = renderParams ? 0 : surfaceBudgetMb(tier, phone) * 1e6;
	const surface = surfaceBytes > 0
		? new SurfaceDetail({
				renderer,
				earth: earth.material,
				root: texturesRoot(),
				surfaceRoot: surfaceRoot(),
				radius: RADIUS,
				baseTexelKm: (40075 / Number.parseInt(preset.textures, 10)) / 1024,
				anisotropy: Math.min(8, renderer.capabilities.getMaxAnisotropy()),
				pixelRatio: () => renderer.getPixelRatio(),
				maxBytes: surfaceBytes,
				...(compareSurface ? surfaceFromSearch(location.search) : { mode: 'tiles', texelPixels: 2 }),
			})
		: undefined;
	if (surface) earth.mesh.add(surface.vectors.group);
	const cycleSurface = (event: KeyboardEvent) => {
		if (!surface || !compareSurface || event.key !== 'S' || !event.shiftKey) return;
		surface.mode = SURFACE_MODES[(SURFACE_MODES.indexOf(surface.mode) + 1) % SURFACE_MODES.length];
		console.info('surface:', surface.mode);
	};
	window.addEventListener('keydown', cycleSurface);
	const atmosphere = createAtmosphere(RADIUS);
	earth.mesh.add(atmosphere.mesh);
	const cloudDetail = preset.cloudDetail && !renderParams ? createCloudDetail(renderer) : undefined;
	const clouds = createClouds(renderer.capabilities.getMaxAnisotropy(), {
		radius: RADIUS,
		bicubic: preset.cloudBicubic,
		maxFrames: LIVE_CLOUD_FRAMES,
		detail: cloudDetail,
	});
	const cloudInverse = new Matrix4();
	earth.mesh.add(clouds.mesh);
	// Clouds in relief near the ground (ADR 0028); phones keep the flat layer until a real phone is measured.
	const compareClouds = import.meta.env.DEV || BUILD.pr !== null;
	const cloudMode = compareClouds ? new URLSearchParams(location.search).get('clouds') : null;
	const volumeScale = renderParams || phone || cloudMode === 'flat' ? 0 : preset.cloudVolume;
	const heightDetail = volumeScale > 0 && cloudDetail
		? createCloudDetail(renderer, { levels: CLOUD_ARCHIVE_RULES.detail_height_levels, prefix: 'height', slots: 16 })
		: undefined;
	const volume: CloudVolume | undefined = heightDetail
		? createCloudVolume({ opacity: clouds.opacity, heights: heightDetail.uniforms, scale: volumeScale, maxSamples: preset.cloudSamples, detail: cloudMode !== 'columns' })
		: undefined;
	if (volume) {
		scene.add(volume.mesh);
		Object.assign(clouds.opacity.uniforms, volume.uniforms);
		clouds.opacity.defines.VOLUME = '';
		clouds.useVolume(volume.uniforms);
		const air = atmosphere.mesh.material as ShaderMaterial;
		Object.assign(air.uniforms, volume.hazeUniforms);
		air.defines = { ...air.defines, CLOUD_HAZE: '' };
		air.needsUpdate = true;
		Object.assign(earth.material.uniforms, volume.uniforms);
		earth.material.defines.CLOUD_SHADOW = '';
		earth.material.needsUpdate = true;
	}
	const sunVector = new Vector3();
	const cycleClouds = (event: KeyboardEvent) => {
		if (!volume || !compareClouds || event.key !== 'C' || !event.shiftKey) return;
		volume.detail = !volume.detail;
		console.info('clouds:', volume.detail ? 'volume' : 'columns');
	};
	window.addEventListener('keydown', cycleClouds);
	const cloudFeed = new CloudFeed({
		baseUrl: liveBaseUrl(),
		tier: preset.clouds,
		onFrame: (frame) => {
			if (clock.mode !== 'replay' || renderParams) clouds.setFrame(frame);
			else frame.texture.dispose();
		},
		onError: (error) => console.warn('clouds:', error),
	});
	const fixtureReplay = (import.meta.env.DEV || BUILD.pr !== null) &&
		isReplayFixture(new URLSearchParams(location.search).get('storm'));
	const replayBase = fixtureReplay && !import.meta.env.DEV
		? new URL('/_replay-fixtures/', location.href).href : liveBaseUrl();
	const cloudArchive = new ArchiveCloudFeed({
		now: () => clock.wallTime(),
		baseUrl: replayBase,
		tier: preset.clouds,
		clouds,
	});
	const cloudPlayback = new CloudPlayback(clouds, cloudFeed, cloudArchive);
	const detachCloudMode = clock.on('mode', () => {
		if (!renderParams) cloudPlayback.update(clock.mode, clock.time());
	});
	const detachDevClouds = import.meta.env.DEV ? attachDevClouds(clouds, window) : undefined;
	const stars = createStarfield();
	scene.add(stars.points);

	const coverage = createCoverage({ baseUrl: liveBaseUrl(), onError: (error) => console.warn('coverage:', error) });
	earth.setCoverage(coverage.texture);
	const detachCoverageLabel = coverageLabel
		? attachCoverageLabel({ canvas, label: coverageLabel, camera, radius: RADIUS, at: coverage.at })
		: undefined;

	const late = new LateFlashes(LIVE_DELAYS, clock.wallTime());
	const feedOptions: Partial<LiveClientOptions> = {
		now: () => clock.wallTime(),
		onManifest: () => coverage.retry(),
		onChunk: (chunk, ref) => late.add(chunk, Date.parse(ref.start), clock.wallTime()),
	};
	const live = startLiveFeed(feedOptions);
	const flashDays = new FlashDays({ baseUrl: liveBaseUrl(), now: () => clock.wallTime() });
	const data = new SceneData(clock, live, (ring) => {
		late.since = clock.wallTime();
		return startLiveFeed({ ...feedOptions, ring });
	}, renderParams ? undefined : flashDays);
	const replay = new StormReplay(data, clock, controls, replayBase, () => ({ fov: camera.fov, aspect: camera.aspect }));
	const track = new StormTrack(RADIUS);
	scene.add(track.group);
	const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
	const activeFeed = renderParams ? null : new ActiveFeed({
		baseUrl: liveBaseUrl(),
		now: () => clock.wallTime(),
		onError: (error) => console.warn('active storms:', error),
	});
	const playbackDelays = () => (clock.mode === 'live' ? LIVE_DELAYS : NO_DELAY);
	const focus = new StormFocus({
		clock,
		replay,
		feed: activeFeed,
		controls,
		track,
		view: () => ({ fov: camera.fov, aspect: camera.aspect }),
		observedTime: (sources) => observedTime(clock.time(), playbackDelays(), sources),
		reducedMotion: () => reducedMotion.matches,
	});
	scene.add(focus.footprint.group);
	const lightning = createLightning(live.ring, {
		radius: RADIUS,
		capacity: preset.maxFlashes ?? live.ring.capacity,
		lightMapWidth: preset.cloudLight ? 1024 : 0,
		clouds: clouds.opacity,
		phone,
	});
	scene.add(lightning.mesh);
	clouds.setFlashLight(lightning.light);
	const sound = createSound(live.ring, camera, RADIUS);
	let post: PostProcessing | undefined = preset.postProcessing
		? createPostProcessing(renderer, scene, camera, [lightning.mesh])
		: undefined;
	let dprQuery: MediaQueryList | undefined;

	/** Applies what can change at runtime; textures and flash capacity stay as loaded. */
	const downgrade = () => {
		const next = lowerTier(tier);
		if (next === tier) return;
		tier = next;
		canvas.dataset.quality = tier;
		if (!PRESETS[tier].cloudLight) clouds.setFlashLight(null);
		if (surface) surface.tiles.maxBytes = surfaceBudgetMb(tier, phone) * 1e6;
		if (PRESETS[tier].cloudVolume > 0) volume?.setQuality({ scale: PRESETS[tier].cloudVolume, maxSamples: PRESETS[tier].cloudSamples });
		if (!PRESETS[tier].postProcessing) {
			post?.dispose();
			post = undefined;
		}
		resize();
	};

	const resize = () => {
		const width = renderParams?.width ?? window.innerWidth;
		const height = renderParams?.height ?? window.innerHeight;
		renderer.setPixelRatio(
			renderParams ? 1 : cappedPixelRatio(window.devicePixelRatio, PRESETS[tier].maxPixelRatio),
		);
		renderer.setSize(width, height, false);
		post?.setSize(width, height, renderer.getPixelRatio());
		camera.aspect = width / height;
		camera.updateProjectionMatrix();
		controls.resize();
	};

	const watchPixelRatio = () => {
		dprQuery?.removeEventListener('change', onPixelRatioChange);
		dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
		dprQuery.addEventListener('change', onPixelRatioChange);
	};

	function onPixelRatioChange() {
		resize();
		watchPixelRatio();
	}

	resize();
	watchPixelRatio();
	window.addEventListener('resize', resize);

	const viewport = new Vector2();
	const fitClipPlanes = () => {
		const { near, far } = clipPlanes(camera.position.length(), RADIUS, SHELLS);
		if (near === camera.near && far === camera.far) return;
		camera.near = near;
		camera.far = far;
		camera.updateProjectionMatrix();
	};

	const draw = (time: number) => {
		if (!renderParams) replay.update();
		const stormView = (clock.mode === 'replay' && Boolean(replay.state.selected || replay.state.loading)) || focus.selected;
		if (!renderParams) {
			controls.holdRotation(stormView || Boolean(replay.state.loading));
			controls.update(time);
		}
		renderer.getSize(focus.footprint.viewport);
		focus.update(performance.now());
		fitClipPlanes();
		if (clock.playing && clock.atPresent()) void replay.live();
		const now = clock.time();
		earth.setTime(now);
		camera.updateMatrixWorld();
		surface?.update(camera, renderParams?.height ?? window.innerHeight);
		atmosphere.setTime(now);
		// Live clouds would load only to be dropped while a storm opens.
		if (!renderParams && !(clock.mode === 'live' && replay.state.loading)) cloudPlayback.update(clock.mode, now);
		clouds.setTime(now);
		if (cloudDetail) {
			camera.updateMatrixWorld();
			cloudDetail.update({
				camera,
				inverseWorld: cloudInverse.copy(clouds.mesh.matrixWorld).invert(),
				shellRadius: cloudShellRadius(RADIUS),
				kmPerUnit: EARTH_RADIUS_KM / RADIUS,
				heightPx: canvas.clientHeight || window.innerHeight,
				frames: clouds.detailFrames(),
				now: performance.now(),
			});
			heightDetail?.update({
				camera,
				inverseWorld: cloudInverse,
				shellRadius: cloudShellRadius(RADIUS),
				kmPerUnit: EARTH_RADIUS_KM / RADIUS,
				heightPx: canvas.clientHeight || window.innerHeight,
				frames: clouds.heightFrames(),
				now: performance.now(),
			});
		}
		stars.setTime(now);
		data.update(now);
		const delays = playbackDelays();
		// Sizes, channels and bloom follow the camera height only, so a view never pumps with its own flashes.
		const kmPerPx = (2 * worldToKm(camera.position.length() - RADIUS, RADIUS) * Math.tan((camera.fov * Math.PI) / 360)) / renderer.getSize(viewport).y;
		lightning.stormView = stormView;
		lightning.viewKmPerPx = kmPerPx;
		lightning.setTime(now, delays, clock.mode === 'replay' ? clock.speed : 1);
		sound.update(now, delays);
		if (!renderParams && fps.frame(time)) downgrade();
		if (clouds.mesh.visible && PRESETS[tier].cloudLight) lightning.renderLightMap(renderer, camera);
		if (volume && PRESETS[tier].cloudVolume > 0) {
			volume.render(renderer, {
				camera,
				earth: earth.mesh,
				now,
				sun: sunVector.set(...sunDirection(new Date(now))),
				width: canvas.clientWidth || window.innerWidth,
				height: canvas.clientHeight || window.innerHeight,
				light: PRESETS[tier].cloudLight ? lightning.light : null,
			});
			// The flat layer steps aside pixel by pixel, where the volume knows the heights.
			clouds.setFlatShown(1);
		} else if (volume) {
			volume.mesh.visible = false;
			volume.uniforms.volumeOn.value = 0;
			clouds.setFlatShown(1);
		}
		if (post) {
			post.setBloom(bloomStrength(kmPerPx, BLOOM.strength));
			post.render();
		} else renderer.render(scene, camera);
	};
	if (!renderParams) renderer.setAnimationLoop(draw);
	const render = renderParams
		? createRenderHandle(renderParams, {
				clock,
				camera,
				radius: RADIUS,
				feed: live,
				clouds: cloudFeed,
				loaded: () => earth.mesh.visible && coverage.settled,
				draw: () => draw(0),
			})
		: undefined;

	const detachPicking = renderParams ? undefined : attachStormPicking(canvas, camera, focus, () => clock.mode === 'live');

	if (import.meta.env.DEV) void runDevFlights(controls.flyTo, location.search);
	const reload = (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.type === 'reload';
	const initialFrame: unknown = reload ? history.state?.scintilleReplayFrame : undefined;
	const navigation = renderParams ? undefined : new ReplayNavigation(replay, clock, controls, {
		url: () => new URL(location.href),
		initialView: (slug) => readFrameCheckpoint(initialFrame, slug, camera.fov, camera.aspect),
		write: (url, push) => { if (push) history.pushState(null, '', url); else history.replaceState(history.state, '', url); },
		onPop: (listener) => { window.addEventListener('popstate', listener); return () => window.removeEventListener('popstate', listener); },
	});
	const rememberFrame = () => {
		const detail = replay.state.selected;
		let checkpoint: FrameCheckpoint | null = null;
		if (clock.mode === 'replay' && detail && !replay.state.loading && controls.isAt(frameStorm(detail.bounds, camera.fov, camera.aspect))) {
			checkpoint = { slug: detail.storm.slug, fov: camera.fov, aspect: camera.aspect, view: controls.view() };
		}
		history.replaceState({ ...history.state, scintilleReplayFrame: checkpoint }, '', location.href);
	};
	if (navigation) window.addEventListener('pagehide', rememberFrame, { capture: true });
	if (!(import.meta.env.DEV && new URLSearchParams(location.search).has('replay'))) void navigation?.restore();

	return {
		flyTo: controls.flyTo,
		clock,
		data,
		replay,
		focus,
		shareUrl: () => navigation?.shareUrl() ?? location.href,
		clouds,
		cloudFeed,
		cloudStatus: () => cloudPlayback.status,
		sound,
		lightning,
		feedStatus: () =>
			feedStatus(data.liveClient.manifest, data.liveClient.loadedAt, clock.wallTime(), data.liveClient.failures > 0),
		observedTime: () => observedTime(clock.time(), playbackDelays(), focus.subject?.sources),
		hasData: (time) => data.covers(time),
		dataStart: () => data.coverageStart(),
		archiveStart: () => flashDays.index()?.firstDay ?? null,
		debug: {
			ring: live.ring,
			get client() { return data.liveClient; },
			delays: playbackDelays,
			late,
			quality: () => tier,
		},
		render,
		surface,
		cloudVolume: volume && compareClouds
			? {
					get detail() { return volume.detail; },
					set detail(on: boolean) { volume.detail = on; },
					coverage: () => volume.coverage(renderer),
					styleCheck: () => volume.styleCheck(renderer),
				}
			: undefined,
		dispose() {
			window.removeEventListener('keydown', cycleSurface);
			window.removeEventListener('keydown', cycleClouds);
			volume?.dispose();
			heightDetail?.dispose();
			surface?.dispose();
			renderer.setAnimationLoop(null);
			window.removeEventListener('pagehide', rememberFrame, { capture: true });
			controls.dispose();
			navigation?.dispose();
			detachPicking?.();
			focus.dispose();
			replay.dispose();
			track.dispose();
			data.dispose();
			detachCloudMode();
			cloudPlayback.dispose();
			detachCoverageLabel?.();
			coverage.dispose();
			window.removeEventListener('resize', resize);
			dprQuery?.removeEventListener('change', onPixelRatioChange);
			earth.dispose();
			atmosphere.dispose();
			detachDevClouds?.();
			clouds.dispose();
			cloudDetail?.dispose();
			stars.dispose();
			post?.dispose();
			lightning.dispose();
			sound.dispose();
			renderer.dispose();
		},
	};
}

const TAP_SLOP_PX = 8;
const TAP_MS = 600;
/** Pick radius around a tap or the mouse, CSS px. */
const PICK_PX = { mouse: 12, touch: 24 };

/** Tap or click on a live storm to select it; the mouse cursor shows which ones can be picked. */
function attachStormPicking(canvas: HTMLCanvasElement, camera: PerspectiveCamera, focus: StormFocus, live: () => boolean): () => void {
	let down: { id: number; x: number; y: number; t: number; multi: boolean } | undefined;
	let pointers = 0;
	let hover: { x: number; y: number } | undefined;
	let frame = 0;
	const at = (x: number, y: number, px: number) => {
		if (!live() || focus.cells().length === 0) return null;
		const rect = canvas.getBoundingClientRect();
		const ndc = new Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
		const point = surfacePoint(ndc, camera, RADIUS);
		if (!point) return null;
		const distance = camera.position.distanceTo(new Vector3(...latLonToVector(point.lat, point.lon)).multiplyScalar(RADIUS));
		const kmPerPx = (worldToKm(distance, RADIUS) * 2 * Math.tan((camera.fov * Math.PI) / 360)) / (rect.height || 1);
		return { ...point, radiusKm: Math.max(px * kmPerPx, 8) };
	};
	const onDown = (event: PointerEvent) => {
		pointers++;
		if (pointers === 1) down = { id: event.pointerId, x: event.clientX, y: event.clientY, t: performance.now(), multi: false };
		else if (down) down.multi = true;
	};
	const onUp = (event: PointerEvent) => {
		pointers = Math.max(0, pointers - 1);
		const start = down;
		if (pointers === 0) down = undefined;
		if (!start || start.multi || start.id !== event.pointerId || event.type === 'pointercancel') return;
		if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > TAP_SLOP_PX || performance.now() - start.t > TAP_MS) return;
		const hit = at(event.clientX, event.clientY, event.pointerType === 'touch' ? PICK_PX.touch : PICK_PX.mouse);
		if (hit) focus.pick(hit.lat, hit.lon, hit.radiusKm);
	};
	const onMove = (event: PointerEvent) => {
		if (event.pointerType !== 'mouse' || event.buttons !== 0) return;
		hover = { x: event.clientX, y: event.clientY };
		if (frame) return;
		frame = requestAnimationFrame(() => {
			frame = 0;
			const hit = hover && at(hover.x, hover.y, PICK_PX.mouse);
			const over = Boolean(hit && pickCell(focus.cells(), hit.lat, hit.lon, hit.radiusKm));
			canvas.style.cursor = over ? 'pointer' : '';
		});
	};
	canvas.addEventListener('pointerdown', onDown);
	canvas.addEventListener('pointerup', onUp);
	canvas.addEventListener('pointercancel', onUp);
	canvas.addEventListener('pointermove', onMove);
	return () => {
		cancelAnimationFrame(frame);
		canvas.style.cursor = '';
		canvas.removeEventListener('pointerdown', onDown);
		canvas.removeEventListener('pointerup', onUp);
		canvas.removeEventListener('pointercancel', onUp);
		canvas.removeEventListener('pointermove', onMove);
	};
}
