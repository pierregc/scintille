import {
	AdditiveBlending,
	BufferAttribute,
	BufferGeometry,
	Points,
	ShaderMaterial,
	type WebGLRenderer,
} from 'three';

export interface Starfield {
	points: Points;
	/** Turns the sky with the Earth's rotation for a UTC instant in milliseconds. */
	setTime(utcMs: number): void;
	dispose(): void;
}

export interface Star {
	/** Unit vector in the celestial frame (Y toward the north celestial pole). */
	direction: [number, number, number];
	/** Linear brightness in (0, MAX_BRIGHTNESS]. */
	brightness: number;
	/** 0 = cool blue-white, 1 = warm orange. */
	warmth: number;
}

export const STAR_COUNT = 8000;
/** Kept low: with the exposure set for a sunlit Earth, stars are barely visible. */
export const MAX_BRIGHTNESS = 0.3;
const FAINTEST_MAGNITUDE = 6.5;
const BRIGHTEST_MAGNITUDE = 0;
/** Compresses the magnitude range like a photographic stretch, so faint stars do not vanish entirely. */
const CONTRAST = 0.5;
const DEG = Math.PI / 180;

/** Greenwich mean sidereal time in radians (IAU 1982, low precision). */
export function siderealAngle(utcMs: number): number {
	const days = utcMs / 86_400_000 + 2_440_587.5 - 2_451_545;
	const deg = (280.46061837 + 360.98564736629 * days) % 360;
	return (deg < 0 ? deg + 360 : deg) * DEG;
}

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

/** Procedural sky: uniform directions, star counts growing ~10^(0.5·m) with magnitude like the real sky. */
export function generateStars(count = STAR_COUNT, seed = 49): Star[] {
	const random = mulberry32(seed);
	const span = FAINTEST_MAGNITUDE - BRIGHTEST_MAGNITUDE;
	const floor = 10 ** (-0.5 * span);
	return Array.from({ length: count }, () => {
		const y = random() * 2 - 1;
		const phi = random() * 2 * Math.PI;
		const r = Math.sqrt(1 - y * y);
		const magnitude = FAINTEST_MAGNITUDE + 2 * Math.log10(floor + (1 - floor) * random());
		return {
			direction: [r * Math.cos(phi), y, -r * Math.sin(phi)],
			brightness: MAX_BRIGHTNESS * 10 ** (-0.4 * CONTRAST * (magnitude - BRIGHTEST_MAGNITUDE)),
			warmth: random() ** 2,
		};
	});
}

const vertexShader = /* glsl */ `
attribute float brightness;
attribute float warmth;
uniform float pixelRatio;
varying vec3 vColor;

void main() {
	vec3 cool = vec3(0.78, 0.85, 1.0);
	vec3 warm = vec3(1.0, 0.82, 0.62);
	vColor = mix(cool, warm, warmth) * brightness;
	vec3 view = mat3(viewMatrix) * mat3(modelMatrix) * position;
	gl_Position = (projectionMatrix * vec4(view, 1.0)).xyww;
	gl_PointSize = 2.5 * pixelRatio;
}
`;

const fragmentShader = /* glsl */ `
varying vec3 vColor;

void main() {
	vec2 d = gl_PointCoord - 0.5;
	float falloff = exp(-dot(d, d) * 8.0);
	gl_FragColor = vec4(vColor * falloff, 1.0);
	#include <colorspace_fragment>
}
`;

/** Faint star background at infinity, drawn first among opaque objects so the globe covers it. */
export function createStarfield(stars = generateStars()): Starfield {
	const position = new Float32Array(stars.length * 3);
	const brightness = new Float32Array(stars.length);
	const warmth = new Float32Array(stars.length);
	stars.forEach((star, i) => {
		position.set(star.direction, i * 3);
		brightness[i] = star.brightness;
		warmth[i] = star.warmth;
	});

	const geometry = new BufferGeometry();
	geometry.setAttribute('position', new BufferAttribute(position, 3));
	geometry.setAttribute('brightness', new BufferAttribute(brightness, 1));
	geometry.setAttribute('warmth', new BufferAttribute(warmth, 1));

	const material = new ShaderMaterial({
		vertexShader,
		fragmentShader,
		uniforms: { pixelRatio: { value: 1 } },
		blending: AdditiveBlending,
		depthTest: false,
		depthWrite: false,
	});

	const points = new Points(geometry, material);
	points.frustumCulled = false;
	points.renderOrder = -1;
	points.onBeforeRender = (renderer: WebGLRenderer) => {
		material.uniforms.pixelRatio.value = renderer.getPixelRatio();
	};

	return {
		points,
		setTime(utcMs) {
			points.rotation.y = -siderealAngle(utcMs);
		},
		dispose() {
			geometry.dispose();
			material.dispose();
		},
	};
}
