/** Vectors of the GLSL twins evaluated as JavaScript. */
type Vec = { x: number; y: number; z?: number };

const vec2 = (x: number, y = x): Vec => ({ x, y });
const vec3 = (x: number, y = x, z = y): Vec => ({ x, y, z });
const smoothstep = (a: number, b: number, x: number): number => {
	const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
	return t * t * (3 - 2 * t);
};

/**
 * GLSL source evaluated as JavaScript, so tests can run the shader twins against the TypeScript
 * functions: float arithmetic, `vec2` and `vec3` as objects with `x`, `y`, `z`, and these built-ins.
 */
export function glslAsJs<T>(source: string, names: string[]): T {
	const types = '(?:float|int|bool|vec2|vec3)';
	const js = source
		.replace(new RegExp(`^${types} (\\w+)\\(([^)]*)\\) \\{`, 'gm'), (_, name: string, params: string) => `function ${name}(${params.replace(new RegExp(`\\b${types} `, 'g'), '')}) {`)
		.replace(new RegExp(`\\b${types} (\\w+) =`, 'g'), 'let $1 =');
	const builtins: Record<string, (...x: never[]) => unknown> = {
		fract: (x: number) => x - Math.floor(x),
		sin: Math.sin,
		exp: Math.exp,
		pow: Math.pow,
		sqrt: Math.sqrt,
		floor: Math.floor,
		mix: (a: number, b: number, t: number) => a + (b - a) * t,
		clamp: (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x)),
		smoothstep,
		min: Math.min,
		max: Math.max,
		float: (x: number) => x,
		vec2,
		vec3,
		length: (v: Vec) => Math.hypot(v.x, v.y, v.z ?? 0),
	};
	return new Function(...Object.keys(builtins), `${js}\nreturn { ${names.join(', ')} };`)(...Object.values(builtins));
}
