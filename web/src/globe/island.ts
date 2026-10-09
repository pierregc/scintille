import type { GlobeApp } from './app';
import { getWebGL2Context } from './webgl';

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
		} catch {
			showFallback();
		}
	};

	const stop = () => {
		generation++;
		app?.dispose();
		app = undefined;
	};

	window.addEventListener('pagehide', stop);
	window.addEventListener('pageshow', (event) => {
		if (event.persisted && !app) void start();
	});
	void start();
}
