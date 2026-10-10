import { afterEach, describe, expect, it, vi } from 'vitest';
import { GLOBE_FALLBACK, mountGlobeIsland } from './island';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('mountGlobeIsland', () => {
	it('shows the fallback and announces it when WebGL2 is unavailable', async () => {
		vi.useFakeTimers();
		const target = new EventTarget();
		vi.stubGlobal('window', target);
		vi.stubGlobal('document', { readyState: 'complete' });
		const canvas = { hidden: false, getContext: () => null } as unknown as HTMLCanvasElement;
		const fallback = { hidden: true } as HTMLElement;
		const announced = vi.fn();
		target.addEventListener(GLOBE_FALLBACK, announced);

		mountGlobeIsland({ canvas, fallback });
		await vi.runAllTimersAsync();

		expect(canvas.hidden).toBe(true);
		expect(fallback.hidden).toBe(false);
		expect(announced).toHaveBeenCalledOnce();
	});
});
