import { describe, expect, it, vi } from 'vitest';
import { CONTEXT_ATTRIBUTES, getWebGL2Context } from './webgl';

const canvasReturning = (context: unknown) => ({ getContext: vi.fn(() => context) }) as unknown as HTMLCanvasElement;

describe('getWebGL2Context', () => {
	it('returns the webgl2 context when available', () => {
		const context = {};
		expect(getWebGL2Context(canvasReturning(context))).toBe(context);
	});

	it('requests webgl2 with the renderer attributes', () => {
		const canvas = canvasReturning(null);
		getWebGL2Context(canvas);
		expect(canvas.getContext).toHaveBeenCalledWith('webgl2', CONTEXT_ATTRIBUTES);
	});

	it('returns null when the browser has no webgl2', () => {
		expect(getWebGL2Context(canvasReturning(null))).toBeNull();
	});

	it('returns null when context creation throws', () => {
		const canvas = {
			getContext: () => {
				throw new Error('blocked');
			},
		} as unknown as HTMLCanvasElement;
		expect(getWebGL2Context(canvas)).toBeNull();
	});
});
