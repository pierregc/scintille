import type { GlobeApp } from './app';
import { getWebGL2Context } from './webgl';

/** Window events announcing the running globe app, for the HUD. */
export const GLOBE_READY = 'globe:ready';
export const GLOBE_GONE = 'globe:gone';

interface IslandElements {
	canvas: HTMLCanvasElement;
	fallback: HTMLElement;
}

/** Resolves once the page has loaded and the main thread is idle. */
export async function afterLoadIdle(): Promise<void> {
	if (document.readyState !== 'complete') {
		await new Promise<void>((resolve) => window.addEventListener('load', () => resolve(), { once: true }));
	}
	await new Promise<void>((resolve) => {
		if ('requestIdleCallback' in window) window.requestIdleCallback(() => resolve(), { timeout: 2000 });
		else setTimeout(resolve, 200);
	});
}

/** Mounts the globe after load/idle, or shows the fallback when WebGL2 is unavailable. */
export function mountGlobeIsland({ canvas, fallback }: IslandElements): void {
	let app: GlobeApp | undefined;
	let generation = 0;

	const showFallback = () => {
		canvas.hidden = true;
		fallback.hidden = false;
	};

	const start = async () => {
		const current = ++generation;
		await afterLoadIdle();
		if (current !== generation) return;
		const context = getWebGL2Context(canvas);
		if (!context) return showFallback();
		try {
			const { createGlobeApp } = await import('./app');
			if (current !== generation) return;
			app = createGlobeApp(canvas, context);
			window.dispatchEvent(new CustomEvent(GLOBE_READY, { detail: app }));
		} catch {
			showFallback();
		}
	};

	const stop = () => {
		generation++;
		if (app) window.dispatchEvent(new CustomEvent(GLOBE_GONE));
		app?.dispose();
		app = undefined;
	};

	window.addEventListener('pagehide', stop);
	window.addEventListener('pageshow', (event) => {
		if (event.persisted && !app) void start();
	});
	void start();
}
