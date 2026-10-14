import { PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import { SceneData } from './archive';
import { atmosphereParameters, createAtmosphere } from './atmosphere';
import { SceneClock } from './clock';
import { cloudShellRadius, type Clouds, createClouds } from './clouds';
import { attachDevClouds } from './clouds/dev';
import { CloudFeed, LIVE_CLOUD_FRAMES } from './clouds/feed';
import { createGlobeControls, type GlobeControls } from './controls';
import { createCoverage } from './coverage';
import { attachCoverageLabel } from './coverage/label';
import { runDevFlights } from './dev-flight';
import { applyDevReplay } from './dev-replay';
import { createEarth } from './earth';
import { kmToWorld } from './flight';
import { CLOUD_TOP_KM, createLightning, type Lightning } from './lightning';
import { type FlashRing, type LiveClient, LIVE_DELAYS, liveBaseUrl, NO_DELAY, type SourceDelays, startLiveFeed } from './live';
import { type FeedStatus, feedStatus } from './live/freshness';
import { clipPlanes } from './orbit';
import { createPostProcessing, type PostProcessing } from './post';
import { createRenderHandle, type RenderHandle } from './render/mode';
import type { RenderParams } from './render/params';
import { FpsMonitor, guessTier, lowerTier, PRESETS, tierFromSearch } from './quality';
import { createStarfield } from './starfield';
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
	readonly clouds: Clouds;
	readonly cloudFeed: CloudFeed;
	readonly thunder: Thunder;
	readonly lightning: Pick<Lightning, 'displayMinutes' | 'setDisplayMinutes'>;
	/** Freshness of the live feed now. */
	feedStatus(): FeedStatus;
	/** Whether observations are loaded for this time; false means unknown, not an empty sky. */
	hasData(time: number): boolean;
	/** Earliest loaded observation window (UTC ms), or null. */
	dataStart(): number | null;
	/** Internals shown by the debug panel. */
	readonly debug: { ring: FlashRing; client: LiveClient; delays(): SourceDelays; quality(): string };
	/** Set in render mode only. */
	readonly render?: RenderHandle;
	dispose(): void;
}

const RADIUS = 1;
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
	const atmosphere = createAtmosphere(RADIUS);
	earth.mesh.add(atmosphere.mesh);
	const clouds = createClouds(renderer.capabilities.getMaxAnisotropy(), {
		radius: RADIUS,
		bicubic: preset.cloudBicubic,
		maxFrames: LIVE_CLOUD_FRAMES,
	});
	earth.mesh.add(clouds.mesh);
	const cloudFeed = new CloudFeed({
		baseUrl: liveBaseUrl(),
		tier: preset.clouds,
		onFrame: (frame) => clouds.setFrame(frame),
		onError: (error) => console.warn('clouds:', error),
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
	const lightning = createLightning(live.ring, {
		radius: RADIUS,
		capacity: preset.maxFlashes ?? live.ring.capacity,
		lightMapWidth: preset.cloudLight ? 1024 : 0,
	});
	scene.add(lightning.mesh);
	clouds.setFlashLight(lightning.lightMap);
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
		earth.setTime(now);
		atmosphere.setTime(now);
		if (clouds.visible && !renderParams) cloudFeed.start();
		clouds.setTime(now);
		stars.setTime(now);
		data.update(now);
		const delays = playbackDelays();
		lightning.setTime(now, delays);
		thunder.update(now, delays);
		if (!renderParams && fps.frame(time)) downgrade();
		if (clouds.mesh.visible && PRESETS[tier].cloudLight) lightning.renderLightMap(renderer);
		if (post) post.render();
		else renderer.render(scene, camera);
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

	return {
		flyTo: controls.flyTo,
		clock,
		data,
		clouds,
		cloudFeed,
		thunder,
		lightning,
		feedStatus: () =>
			feedStatus(data.liveClient.manifest, data.liveClient.loadedAt, clock.wallTime(), data.liveClient.failures > 0),
		hasData: (time) => data.covers(time),
		dataStart: () => data.coverageStart(),
		debug: {
			ring: live.ring,
			get client() { return data.liveClient; },
			delays: playbackDelays,
			quality: () => tier,
		},
		render,
		dispose() {
			renderer.setAnimationLoop(null);
			controls.dispose();
			data.dispose();
			cloudFeed.stop();
			detachCoverageLabel?.();
			coverage.dispose();
			window.removeEventListener('resize', resize);
			dprQuery?.removeEventListener('change', onPixelRatioChange);
			earth.dispose();
			atmosphere.dispose();
			detachDevClouds?.();
			clouds.dispose();
			stars.dispose();
			post?.dispose();
			lightning.dispose();
			thunder.dispose();
			renderer.dispose();
		},
	};
}
