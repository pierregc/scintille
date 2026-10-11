import { PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import { createAtmosphere } from './atmosphere';
import { SceneClock } from './clock';
import { type Clouds, createClouds } from './clouds';
import { attachDevClouds } from './clouds/dev';
import { CloudFeed, LIVE_CLOUD_FRAMES } from './clouds/feed';
import { createGlobeControls, type GlobeControls } from './controls';
import { runDevFlights } from './dev-flight';
import { applyDevReplay } from './dev-replay';
import { createEarth } from './earth';
import { createLightning } from './lightning';
import { liveBaseUrl, startLiveFeed } from './live';
import { type FeedStatus, feedStatus } from './live/freshness';
import { createPostProcessing, type PostProcessing } from './post';
import { FpsMonitor, guessTier, lowerTier, PRESETS, tierFromSearch } from './quality';
import { createStarfield } from './starfield';
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
	readonly clouds: Clouds;
	readonly cloudFeed: CloudFeed;
	/** Freshness of the live feed now. */
	feedStatus(): FeedStatus;
	/** Whether observations are loaded for this time; false means unknown, not an empty sky. */
	hasData(time: number): boolean;
	/** Earliest loaded observation window (UTC ms), or null. */
	dataStart(): number | null;
	dispose(): void;
}

const RADIUS = 1;
const FOV = 35;

export function createGlobeApp(canvas: HTMLCanvasElement, context: WebGL2RenderingContext): GlobeApp {
	const renderer = new WebGLRenderer({ canvas, context, ...CONTEXT_ATTRIBUTES });
	const scene = new Scene();
	const camera = new PerspectiveCamera(FOV, 1, 0.1, 100);
	const controls = createGlobeControls(camera, canvas, RADIUS);

	let tier = tierFromSearch(location.search) ?? guessTier(deviceHints(context));
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

	const live = startLiveFeed({ now: () => clock.wallTime() });
	const lightning = createLightning(live.ring, {
		radius: RADIUS,
		capacity: preset.maxFlashes ?? live.ring.capacity,
		lightMapWidth: preset.cloudLight ? 1024 : 0,
	});
	scene.add(lightning.mesh);
	clouds.setFlashLight(lightning.lightMap);
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
		const width = window.innerWidth;
		const height = window.innerHeight;
		renderer.setPixelRatio(cappedPixelRatio(window.devicePixelRatio, PRESETS[tier].maxPixelRatio));
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

	renderer.setAnimationLoop((time) => {
		controls.update(time);
		const now = clock.time();
		earth.setTime(now);
		atmosphere.setTime(now);
		if (clouds.visible) cloudFeed.start();
		clouds.setTime(now);
		stars.setTime(now);
		lightning.setTime(now);
		if (fps.frame(time)) downgrade();
		if (clouds.mesh.visible && PRESETS[tier].cloudLight) lightning.renderLightMap(renderer);
		if (post) post.render();
		else renderer.render(scene, camera);
	});

	if (import.meta.env.DEV) void runDevFlights(controls.flyTo, location.search);

	return {
		flyTo: controls.flyTo,
		clock,
		clouds,
		cloudFeed,
		feedStatus: () =>
			feedStatus(live.client.manifest, live.client.loadedAt, clock.wallTime(), live.client.failures > 0),
		hasData: (time) => live.client.covers(time),
		dataStart: () => live.client.coverageStart(),
		dispose() {
			renderer.setAnimationLoop(null);
			controls.dispose();
			live.stop();
			cloudFeed.stop();
			window.removeEventListener('resize', resize);
			dprQuery?.removeEventListener('change', onPixelRatioChange);
			earth.dispose();
			atmosphere.dispose();
			detachDevClouds?.();
			clouds.dispose();
			stars.dispose();
			post?.dispose();
			lightning.dispose();
			renderer.dispose();
		},
	};
}
