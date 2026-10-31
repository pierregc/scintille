import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { cloudsFragmentShader } from '../clouds/clouds.glsl';
import { compositeFragmentShader, marchFragmentShader } from '../clouds/volume.glsl';
import { bandCentre, CLOUD_LIGHT, cloudLightDay, cloudLightGlsl, flashBand, glowDepths, sharpenExponent } from './cloud-light';
import { flashLightGlsl, lightMapVertexShader } from './light-map.glsl';
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
