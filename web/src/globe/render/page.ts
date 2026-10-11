import type { GlobeApp } from '../app';
import { getWebGL2Context } from '../webgl';
import { parseRenderParams, type RenderParams } from './params';

/** What the render page exposes as `window.scintilleRender` to the headless driver. */
export interface RenderApi {
	readonly params: RenderParams | null;
	/** Resolves when frames can be drawn; rejects with the reason they cannot. */
	readonly ready: Promise<void>;
	/** Draws frame `index` and returns it as a PNG data URL. */
	frame(index: number): string;
}

declare global {
	interface Window {
		scintilleRender?: RenderApi;
	}
}

export function mountRenderPage(canvas: HTMLCanvasElement, search = location.search): RenderApi {
	let params: RenderParams | null = null;
	let app: GlobeApp | undefined;
	const ready = (async () => {
		params = parseRenderParams(search);
		canvas.style.width = `${params.width}px`;
		canvas.style.height = `${params.height}px`;
		const context = getWebGL2Context(canvas, { alpha: false, antialias: true });
		if (!context) throw new Error('WebGL 2 is not available');
		const { createGlobeApp } = await import('../app');
		app = createGlobeApp(canvas, context, { render: params });
		await app.render?.ready();
	})();
	ready.catch((error: unknown) => console.error('render:', error));

	const api: RenderApi = {
		get params() {
			return params;
		},
		ready,
		frame(index) {
			if (!app?.render) throw new Error('renderer is not ready');
			app.render.frame(index);
			return canvas.toDataURL('image/png');
		},
	};
	window.scintilleRender = api;
	return api;
}
