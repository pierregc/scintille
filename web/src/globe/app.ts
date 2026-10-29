import { Matrix4, PerspectiveCamera, Scene, Vector2, WebGLRenderer } from 'three';
import { BUILD } from '../version';
import { SceneData } from './archive';
import { atmosphereParameters, createAtmosphere } from './atmosphere';
import { SceneClock } from './clock';
import { cloudShellRadius, type Clouds, createClouds } from './clouds';
import { ArchiveCloudFeed } from './clouds/archive';
import { createCloudDetail } from './clouds/detail';
import { attachDevClouds } from './clouds/dev';
import { CloudFeed, LIVE_CLOUD_FRAMES } from './clouds/feed';
import { CloudPlayback } from './clouds/playback';
import { createGlobeControls, type GlobeControls } from './controls';
import { createCoverage } from './coverage';
import { attachCoverageLabel } from './coverage/label';
import { runDevFlights } from './dev-flight';
import { applyDevReplay } from './dev-replay';
import { isReplayFixture } from './dev-storm';
import { createEarth, surfaceRoot, texturesRoot } from './earth';
import { kmToWorld, worldToKm } from './flight';
import { CLOUD_TOP_KM, createLightning, type Lightning } from './lightning';
import { bloomStrength } from './lightning/zoom';
import { type FlashRing, type LiveClient, LIVE_DELAYS, liveBaseUrl, NO_DELAY, type SourceDelays, startLiveFeed } from './live';
import { type FeedStatus, feedStatus } from './live/freshness';
import { clipPlanes } from './orbit';
import { BLOOM, createPostProcessing, type PostProcessing } from './post';
import { createRenderHandle, type RenderHandle } from './render/mode';
import type { RenderParams } from './render/params';
import { FpsMonitor, guessTier, lowerTier, PRESETS, tierFromSearch } from './quality';
import { observedTime } from './scene-time';
import { createStarfield } from './starfield';
import { SURFACE_MODES, SurfaceDetail, surfaceFromSearch } from './detail';
import { StormReplay } from './replay';
import { StormTrack } from './replay/track';
import { ReplayNavigation } from './replay/navigation';
import { readFrameCheckpoint, type FrameCheckpoint } from './replay/checkpoint';
import { frameStorm } from './replay/framing';
import { createThunder, type Thunder } from './thunder';
import { cappedPixelRatio } from './viewport';
import { CONTEXT_ATTRIBUTES } from './webgl';

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
	shareUrl(): string;
	readonly clouds: Clouds;
	readonly cloudFeed: CloudFeed;
	cloudStatus(): { settled: boolean; attribution: string | null };
	readonly thunder: Thunder;
	readonly lightning: Pick<Lightning, 'displayMinutes' | 'setDisplayMinutes' | 'stormView'>;
	/** Freshness of the live feed now. */
	feedStatus(): FeedStatus;
	/** Time of the newest flashes drawn, for the selected storm's sources if any: ages are measured from it. */
	observedTime(): number;
	/** Whether observations are loaded for this time; false means unknown, not an empty sky. */
	hasData(time: number): boolean;
	/** Earliest loaded observation window (UTC ms), or null. */
	dataStart(): number | null;
	/** Internals shown by the debug panel. */
	readonly debug: { ring: FlashRing; client: LiveClient; delays(): SourceDelays; quality(): string };
	/** Set in render mode only. */
	readonly render?: RenderHandle;
	/** Surface detail prototypes (#125), in development and PR previews only. */
	readonly surface?: SurfaceDetail;
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

	let tier = renderParams?.quality ?? tierFromSearch(location.search) ?? guessTier(deviceHints(context));
	const preset = PRESETS[tier];
	canvas.dataset.quality = tier;
	const fps = new FpsMonitor();

	const clock = new SceneClock();
	if (import.meta.env.DEV) applyDevReplay(clock, location.search);
	const earth = createEarth(renderer, RADIUS, preset.textures);
	scene.add(earth.mesh);
	const surface = import.meta.env.DEV || BUILD.pr !== null
		? new SurfaceDetail({
				earth: earth.material,
				root: texturesRoot(),
				surfaceRoot: surfaceRoot(),
				radius: RADIUS,
				baseTexelKm: (40075 / Number.parseInt(preset.textures, 10)) / 1024,
				anisotropy: Math.min(8, renderer.capabilities.getMaxAnisotropy()),
				pixelRatio: () => renderer.getPixelRatio(),
				...surfaceFromSearch(location.search),
			})
		: undefined;
	if (surface) {
		earth.mesh.add(surface.tiles.group);
		earth.mesh.add(surface.vectors.group);
	}
	const cycleSurface = (event: KeyboardEvent) => {
		if (!surface || event.key !== 'S' || !event.shiftKey) return;
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

	const live = startLiveFeed({ now: () => clock.wallTime(), onManifest: (manifest) => coverage.setManifest(manifest) });
	const data = new SceneData(clock, live, (ring) => startLiveFeed({
		ring,
		now: () => clock.wallTime(),
		onManifest: (manifest) => coverage.setManifest(manifest),
	}));
	const replay = new StormReplay(data, clock, controls, replayBase, () => ({ fov: camera.fov, aspect: camera.aspect }));
	const track = new StormTrack(RADIUS);
	scene.add(track.group);
	const lightning = createLightning(live.ring, {
		radius: RADIUS,
		capacity: preset.maxFlashes ?? live.ring.capacity,
		lightMapWidth: preset.cloudLight ? 1024 : 0,
	});
	scene.add(lightning.mesh);
	clouds.setFlashLight(lightning.light);
	const thunder = createThunder(live.ring, camera, RADIUS);
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

	const playbackDelays = () => (clock.mode === 'live' ? LIVE_DELAYS : NO_DELAY);

	const viewport = new Vector2();
	const fitClipPlanes = () => {
		const { near, far } = clipPlanes(camera.position.length(), RADIUS, SHELLS);
		if (near === camera.near && far === camera.far) return;
		camera.near = near;
		camera.far = far;
		camera.updateProjectionMatrix();
	};

	const draw = (time: number) => {
		if (!renderParams) controls.update(time);
		fitClipPlanes();
		const now = clock.time();
		track.setStorm(clock.mode === 'replay' ? replay.state.selected : null);
		track.setTime(now);
		earth.setTime(now);
		camera.updateMatrixWorld();
		surface?.update(camera, renderParams?.height ?? window.innerHeight);
		atmosphere.setTime(now);
		if (!renderParams) cloudPlayback.update(clock.mode, now);
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
		}
		stars.setTime(now);
		data.update(now);
		const delays = playbackDelays();
		// Sizes, channels and bloom follow the camera height only, so a view never pumps with its own flashes.
		const kmPerPx = (2 * worldToKm(camera.position.length() - RADIUS, RADIUS) * Math.tan((camera.fov * Math.PI) / 360)) / renderer.getSize(viewport).y;
		lightning.stormView = clock.mode === 'replay' && Boolean(replay.state.selected || replay.state.loading);
		lightning.viewKmPerPx = kmPerPx;
		lightning.setTime(now, delays, clock.mode === 'replay' ? clock.speed : 1);
		thunder.update(now, delays);
		if (!renderParams && fps.frame(time)) downgrade();
		if (clouds.mesh.visible && PRESETS[tier].cloudLight) lightning.renderLightMap(renderer, camera);
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
		shareUrl: () => navigation?.shareUrl() ?? location.href,
		clouds,
		cloudFeed,
		cloudStatus: () => cloudPlayback.status,
		thunder,
		lightning,
		feedStatus: () =>
			feedStatus(data.liveClient.manifest, data.liveClient.loadedAt, clock.wallTime(), data.liveClient.failures > 0),
		observedTime: () => observedTime(clock.time(), playbackDelays(), replay.state.selected?.storm.sources),
		hasData: (time) => data.covers(time),
		dataStart: () => data.coverageStart(),
		debug: {
			ring: live.ring,
			get client() { return data.liveClient; },
			delays: playbackDelays,
			quality: () => tier,
		},
		render,
		surface,
		dispose() {
			window.removeEventListener('keydown', cycleSurface);
			surface?.dispose();
			renderer.setAnimationLoop(null);
			window.removeEventListener('pagehide', rememberFrame, { capture: true });
			controls.dispose();
			navigation?.dispose();
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
			thunder.dispose();
			renderer.dispose();
		},
	};
}
