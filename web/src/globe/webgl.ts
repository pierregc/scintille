type CanvasLike = Pick<HTMLCanvasElement, 'getContext'>;

export const CONTEXT_ATTRIBUTES: WebGLContextAttributes = { alpha: true, antialias: true };

/** The canvas WebGL2 context, or null when WebGL2 is unavailable. */
export function getWebGL2Context(
	canvas: CanvasLike,
	attributes: WebGLContextAttributes = CONTEXT_ATTRIBUTES,
): WebGL2RenderingContext | null {
	try {
		return canvas.getContext('webgl2', attributes);
	} catch {
		return null;
	}
}
