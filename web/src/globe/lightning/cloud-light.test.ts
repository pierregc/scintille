import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { cloudsFragmentShader } from '../clouds/clouds.glsl';
import { compositeFragmentShader, marchFragmentShader } from '../clouds/volume.glsl';
import { bandCentre, CLOUD_LIGHT, cloudLightGlsl, flashBand } from './cloud-light';
import { flashLightGlsl, lightMapVertexShader } from './light-map.glsl';
import { glslFloat as f } from './profile';

describe('flashBand', () => {
	it('lights towers under their crown and lower cloud at the flash height', () => {
		expect(bandCentre(14)).toBe(11);
		expect(bandCentre(11)).toBe(CLOUD_LIGHT.fallbackHeightKm);
		expect(bandCentre(3)).toBe(CLOUD_LIGHT.fallbackHeightKm);
		expect(bandCentre(-1)).toBe(CLOUD_LIGHT.fallbackHeightKm);
	});

	it('peaks at the band centre and falls to 1/e one width away', () => {
		expect(flashBand(11, 14)).toBe(1);
		expect(flashBand(11 + CLOUD_LIGHT.widthKm, 14)).toBeCloseTo(Math.exp(-1), 9);
		expect(flashBand(2.5, 3)).toBeLessThan(0.06);
		expect(flashBand(9.75, 11)).toBeGreaterThan(0.85);
	});
});

describe('the GLSL consumers share the cloud light numbers', () => {
	it('splats the whole footprint on bright pulses and a patch between them', () => {
		expect(lightMapVertexShader).toContain(`smoothstep(${f(CLOUD_LIGHT.fullFrom)}, ${f(CLOUD_LIGHT.fullTo)}, pulse)`);
		expect(lightMapVertexShader).toContain(`mix(${f(CLOUD_LIGHT.dimSplat)}, 1.0, full)`);
	});

	it('sharpens every read of the light map', () => {
		expect(flashLightGlsl).toContain(`pow(texture2D(flashLight, local * 0.5 + 0.5).r, ${f(CLOUD_LIGHT.sharpen)})`);
		expect(flashLightGlsl).toContain(`pow(textureLod(flashLight, local * 0.5 + 0.5, 0.0).r, ${f(CLOUD_LIGHT.sharpen)})`);
		expect(cloudsFragmentShader).toContain(flashLightGlsl);
		expect(marchFragmentShader).toContain(flashLightGlsl);
	});

	it('shapes the volume glow by each column with the same band and boost', () => {
		expect(cloudLightGlsl).toContain(`max(top - ${f(CLOUD_LIGHT.belowTopKm)}, ${f(CLOUD_LIGHT.fallbackHeightKm)})) / ${f(CLOUD_LIGHT.widthKm)}`);
		expect(marchFragmentShader).toContain(cloudLightGlsl);
		expect(marchFragmentShader).toContain(`flashBand(hm, col.y)`);
		expect(marchFragmentShader).toContain(`* ${f(CLOUD_LIGHT.volumeBoost)} * alpha`);
	});

	it('feeds the same gain to the flat layer and the volume', async () => {
		const volume = await readFile(new URL('../clouds/volume.ts', import.meta.url), 'utf8');
		expect(volume).toContain('flashGain.value = view.light ? CLOUD_LIGHT.gain : 0;');
	});

	it('keeps the same trace over sunlit cloud in both renderers', () => {
		const trace = `mix(1.0, ${f(CLOUD_LIGHT.dayLevel)}, smoothstep(-0.05, 0.25, s))`;
		expect(cloudsFragmentShader).toContain(`* max(1.0 - color, 0.0) * ${trace}`);
		expect(marchFragmentShader).toContain(`* alpha * ${trace}`);
		expect(compositeFragmentShader).toContain('seen.g / shown * max(1.0 - rgb, 0.0)');
	});
});
