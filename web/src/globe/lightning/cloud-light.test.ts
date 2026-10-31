import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { cloudsFragmentShader } from '../clouds/clouds.glsl';
import { compositeFragmentShader, marchFragmentShader } from '../clouds/volume.glsl';
import { cloudDrift, cloudDriftGlsl, flashKind, flashTiming } from './channel';
import { isGround } from './kind';
import {
	bandCentre,
	CLOUD_LIGHT,
	cloudLightDay,
	cloudLightGlsl,
	cloudPatch,
	cloudPatchGlsl,
	flashBand,
	glowDepths,
	patchEdge,
	patchEdgeGlsl,
	sharpenExponent,
} from './cloud-light';
import { flashLightGlsl, lightMapFragmentShader, lightMapVertexShader } from './light-map.glsl';
import { glslFloat as f } from './profile';

/** Glow the march gathers through a tower (flat Earth), cut in pieces as the march cuts a ray `deg` off the vertical. */
function towerGlow(deg: number, top = 16, base = 1.5, light = 0.3): number {
	const foot = 0.58;
	const cos = Math.cos((deg * Math.PI) / 180);
	const sideways = (0.5 * foot) / Math.max(Math.sin((deg * Math.PI) / 180), 1e-3);
	const sigma = -Math.log(0.05) / (top - base);
	let entry = top;
	let T = 1;
	let glow = 0;
	while (entry > base + 1e-6 && T > 0.02) {
		const len = Math.min((entry - base) / cos, sideways);
		const alpha = 1 - Math.exp(-sigma * len);
		const band = glowDepths(sigma, len).reduce((sum, depth) => sum + flashBand(entry - depth * cos, top) / 2, 0);
		glow += T * (1 - Math.exp(-CLOUD_LIGHT.gain * light * band)) * alpha;
		T *= 1 - alpha;
		entry -= len * cos;
	}
	return glow;
}

describe('flashBand', () => {
	it('lights towers under their crown and lower cloud at the flash height', () => {
		expect(bandCentre(14)).toBe(11);
		expect(bandCentre(11)).toBe(CLOUD_LIGHT.fallbackHeightKm);
		expect(bandCentre(3)).toBe(CLOUD_LIGHT.fallbackHeightKm);
		expect(bandCentre(-1)).toBe(CLOUD_LIGHT.fallbackHeightKm);
	});

	it('peaks at the band centre and falls to 1/e one half width away', () => {
		expect(flashBand(11, 14)).toBe(1);
		expect(flashBand(11 + CLOUD_LIGHT.widthKm, 14)).toBeCloseTo(Math.exp(-1), 9);
		expect(flashBand(2.5, 3)).toBeLessThan(0.06);
		expect(flashBand(9.75, 11)).toBeGreaterThan(0.85);
	});
});

describe('glowDepths', () => {
	it('splits the light a crossing sends back into quarters', () => {
		const [sigma, len] = [0.4, 6];
		const sent = (depth: number) => 1 - Math.exp(-sigma * depth);
		const [first, third] = glowDepths(sigma, len);
		expect(sent(first) / sent(len)).toBeCloseTo(0.25, 9);
		expect(sent(third) / sent(len)).toBeCloseTo(0.75, 9);
		expect(glowDepths(1e-3, 2)[1]).toBeLessThanOrEqual(2);
	});

	it('lights a tower alike whether the march takes it in one piece or in many', () => {
		const nadir = towerGlow(0.3);
		for (const deg of [2, 5, 10, 20]) expect(nadir / towerGlow(deg)).toBeGreaterThan(0.9);
		for (const deg of [2, 5, 10, 20]) expect(nadir / towerGlow(deg)).toBeLessThan(1.15);
		expect(towerGlow(0.3, 14, 1.5) / towerGlow(10, 14, 1.5)).toBeLessThan(1.15);
	});
});

/** The kind of a short, small flash (never a crawler). */
const kindOf = (seed: number) => flashKind(seed, 100, 50);

/** Farthest point of a flash's fitted patch, in splat radii, over `n` directions. */
function patchFarthest(seed: number, own = 1, n = 3600): number {
	const { aspect, fit } = cloudPatch(seed, kindOf(seed), own);
	let far = 0;
	for (let k = 0; k < n; k++) {
		const t = (k * 2 * Math.PI) / n;
		far = Math.max(far, patchEdge(t, seed, own) * fit * Math.hypot(Math.cos(t), Math.sin(t) / aspect));
	}
	return far;
}

describe('cloudPatch', () => {
	const seeds = Array.from({ length: 500 }, (_, i) => (i + 0.5) / 500);

	it('draws an elongated, irregular patch whose farthest point is the splat radius', () => {
		for (const seed of seeds) {
			const { aspect } = cloudPatch(seed, kindOf(seed));
			expect(aspect).toBeGreaterThanOrEqual(CLOUD_LIGHT.aspectMin);
			expect(aspect).toBeLessThanOrEqual(CLOUD_LIGHT.aspectMax);
			expect(patchFarthest(seed)).toBeGreaterThanOrEqual(1 - 1e-9);
			expect(patchFarthest(seed)).toBeLessThan(1.02);
		}
		const edges = seeds.map((seed) => patchEdge(seed * 7, seed));
		expect(Math.max(...edges) - Math.min(...edges)).toBeGreaterThan(0.3);
	});

	it('lies along the drift of in-cloud flashes', () => {
		for (const seed of seeds.filter((s) => !isGround(kindOf(s)))) {
			const { heading } = cloudPatch(seed, kindOf(seed));
			const [east, north] = cloudDrift(0.05, 10, seed, kindOf(seed), flashTiming(kindOf(seed), 10, 0.3, seed));
			expect(Math.abs(east * Math.sin(heading) - north * Math.cos(heading))).toBeLessThan(1e-9);
		}
		expect(cloudDriftGlsl).toContain('channelHash(seed, 1.0)');
		expect(cloudPatchGlsl).toContain('channelHash(seed, ground ? 3.0 : 1.0)');
	});

	it('is round where the splat floor, not the footprint, sets the size', () => {
		for (const seed of seeds.slice(0, 20)) {
			expect(cloudPatch(seed, kindOf(seed), 0)).toMatchObject({ aspect: 1, fit: 1 });
			expect(patchEdge(1, seed, 0)).toBe(1);
			expect(patchFarthest(seed, 0.5)).toBeLessThan(1.02);
		}
	});
});

describe('cloud light shares', () => {
	it('keeps all of it at night and a trace over sunlit cloud', () => {
		expect(cloudLightDay(-0.2)).toBe(1);
		expect(cloudLightDay(CLOUD_LIGHT.dayFrom)).toBe(1);
		expect(cloudLightDay(CLOUD_LIGHT.dayTo)).toBeCloseTo(CLOUD_LIGHT.dayLevel, 9);
		expect(cloudLightDay(0.9)).toBeCloseTo(CLOUD_LIGHT.dayLevel, 9);
	});

	it('sharpens the light map near the floor only', () => {
		expect(sharpenExponent(0)).toBe(CLOUD_LIGHT.sharpen);
		expect(sharpenExponent((3 * 400) / 6371)).toBeGreaterThan(1.2);
		expect(sharpenExponent(Math.PI / 2)).toBe(1);
	});
});

describe('the GLSL consumers share the cloud light numbers', () => {
	it('splats the whole footprint on bright pulses and a patch between them, the whole footprint under reduced motion', () => {
		expect(lightMapVertexShader).toContain(`float full = mix(1.0, smoothstep(${f(CLOUD_LIGHT.fullFrom)}, ${f(CLOUD_LIGHT.fullTo)}, pulse), flicker)`);
		expect(lightMapVertexShader).toContain(`mix(${f(CLOUD_LIGHT.dimSplat)}, 1.0, full)`);
	});

	it('splats the same seeded patch, its lobes and aspect, inside the splat radius', () => {
		expect(cloudPatchGlsl).toContain(`mix(1.0, mix(${f(CLOUD_LIGHT.aspectMin)}, ${f(CLOUD_LIGHT.aspectMax)}, channelHash(seed, 4.0)), own)`);
		expect(cloudPatchGlsl).toContain(`vec2(${f(CLOUD_LIGHT.lobe2)}, ${f(CLOUD_LIGHT.lobe3)}) * own`);
		expect(cloudPatchGlsl).toContain('vec2(channelHash(seed, 5.0), channelHash(seed, 6.0)) * 6.28318531');
		expect(patchEdgeGlsl).toContain('1.0 + lobes.z * sin(2.0 * theta + lobes.x) + lobes.w * sin(3.0 * theta + lobes.y)');
		expect(lightMapVertexShader).toContain(patchEdgeGlsl);
		expect(lightMapVertexShader).toContain(cloudPatchGlsl);
		expect(lightMapVertexShader).toContain('float own = footprint / max(radiusKm, 1e-6);');
		expect(lightMapFragmentShader).toContain(patchEdgeGlsl);
		expect(lightMapFragmentShader).toContain('float edge = patchEdge(atan(p.y, p.x), vLobes) * vPatch.w;');
		expect(lightMapFragmentShader).toContain('exp(-r2 * 4.0) * (1.0 - r2)');
	});

	it('sharpens every read of the light map, by the window', () => {
		expect(flashLightGlsl).toContain(`pow(light, mix(${f(CLOUD_LIGHT.sharpen)}, 1.0, clamp(flashWindow.w / 1.57079633, 0.0, 1.0)))`);
		expect(flashLightGlsl).toContain('sharpenFlashLight(texture2D(flashLight, local * 0.5 + 0.5).r)');
		expect(flashLightGlsl).toContain('sharpenFlashLight(textureLod(flashLight, local * 0.5 + 0.5, 0.0).r)');
		expect(cloudsFragmentShader).toContain(flashLightGlsl);
		expect(marchFragmentShader).toContain(flashLightGlsl);
	});

	it('shapes the volume glow by each column with the same band and boost', () => {
		expect(cloudLightGlsl).toContain(`max(top - ${f(CLOUD_LIGHT.belowTopKm)}, ${f(CLOUD_LIGHT.fallbackHeightKm)})) / ${f(CLOUD_LIGHT.widthKm)}`);
		expect(cloudLightGlsl).toContain('min(-log(1.0 - vec2(0.25, 0.75) * a) / sigma, vec2(len))');
		expect(marchFragmentShader).toContain(cloudLightGlsl);
		expect(marchFragmentShader).toContain('vec2 glowAt = ta + glowDepths(max(sigma, 1e-3), len);');
		expect(marchFragmentShader).toContain('0.5 * (flashBand(length(ro + rd * glowAt.x) - R, col.y) + flashBand(length(ro + rd * glowAt.y) - R, col.y))');
		expect(marchFragmentShader).toContain(`* ${f(CLOUD_LIGHT.volumeBoost)} * alpha`);
	});

	it('feeds the same gain to the flat layer and the volume', async () => {
		const volume = await readFile(new URL('../clouds/volume.ts', import.meta.url), 'utf8');
		expect(volume).toContain('flashGain.value = view.light ? CLOUD_LIGHT.gain : 0;');
	});

	it('keeps the same trace over sunlit cloud in both renderers, at the local sun', () => {
		expect(cloudLightGlsl).toContain(`mix(1.0, ${f(CLOUD_LIGHT.dayLevel)}, smoothstep(${f(CLOUD_LIGHT.dayFrom)}, ${f(CLOUD_LIGHT.dayTo)}, s))`);
		expect(cloudsFragmentShader).toContain(cloudLightGlsl);
		expect(cloudsFragmentShader).toContain('* max(1.0 - color, 0.0) * cloudLightDay(s - sunDip);');
		expect(cloudsFragmentShader).toContain('float s = dot(n, sun) + sunDip;');
		expect(marchFragmentShader).toContain('* alpha * cloudLightDay(s);');
		expect(compositeFragmentShader).toContain('seen.g / shown * max(1.0 - rgb, 0.0)');
	});
});
