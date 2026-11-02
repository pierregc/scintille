import { describe, expect, it } from 'vitest';
import { CHANNEL } from './channel';
import { densityGlsl } from './density';
import { lightningVertexShader } from './lightning.glsl';
import { glslFloat as f } from './profile';
import { ribbonVertex } from './ribbon.glsl';
import { ZOOM, zoomGlsl } from './zoom';

describe('glow shader', () => {
	it('dips the glow while the channel shows by the named shares', () => {
		expect(lightningVertexShader).toContain(`mix(${f(CHANNEL.glowDip)}, ${f(CHANNEL.haloGlowDip)}, halo)`);
		expect(lightningVertexShader).toContain(`: ${f(CHANNEL.cloudGlowDip)}) * channel`);
	});

	it('keeps a named share of the glow over sunlit cloud near the floor and the far points whole', () => {
		expect(lightningVertexShader).toContain('uniform vec3 sunDirection;');
		expect(lightningVertexShader).toContain(`mix(1.0, ${f(CHANNEL.glowDayLevel)}, day * nearFloor(viewKmPerPx))`);
	});

	it('eases the glow level to the named floor level only below the named zoom', () => {
		expect(zoomGlsl).toContain(`log(kmPerPx / ${f(ZOOM.nearKmPerPx)}) / ${f(Math.log(ZOOM.floorKmPerPx / ZOOM.nearKmPerPx))}`);
		expect(zoomGlsl).toContain('float glowShare(float kmPerPx, float nearLevel, float rampLevel)');
		expect(zoomGlsl).toContain('mix(mix(rampLevel, 1.0, farness(kmPerPx)), nearLevel, nearFloor(kmPerPx))');
		expect(lightningVertexShader).toContain('glowShare(viewKmPerPx, nearGlowLevel, glowLevel)');
	});

	it('keeps a sprite near the floor for the sample only, and from afar or without a cloud light for the newest flashes', () => {
		expect(lightningVertexShader).toContain(densityGlsl);
		expect(lightningVertexShader).toContain('float hero = heroWeight(heroLot(flashShape.w, flashShape.x, isGround(int(flashLook.x + 0.5))), heroShare);');
		expect(lightningVertexShader).toContain('float keep = max(hero, pointWeight(farness(pointKm), lightMapOff) * pointBudget(flash.w));');
		expect(lightningVertexShader).toContain('brightness *= keep;');
	});

	it('weighs the glow by its share of a storm view blend', () => {
		expect(lightningVertexShader).toContain('uniform float blendWeight;');
		expect(lightningVertexShader).toContain('vBrightness = brightness * blendWeight;');
	});
});

describe('channel shader', () => {
	it('draws channels for the sample only, culled before the profile', () => {
		expect(ribbonVertex).toContain(densityGlsl);
		expect(ribbonVertex).toContain('float hero = heroWeight(heroLot(seed, flashShape.x, ground), heroShare);');
		expect(ribbonVertex).toContain('float shown = hero * smoothstep(0.0, 0.1, facing) * onScreen(at)');
		expect(ribbonVertex.indexOf('float hero = heroWeight(')).toBeLessThan(ribbonVertex.indexOf('vec4 profile = flashProfileStroke('));
	});
});

describe('halo shader', () => {
	it('tints the halo cool only', () => {
		expect(ribbonVertex).toContain('vTint = vec3(0.86, 0.9, 1.0);');
		expect(ribbonVertex).not.toMatch(/vTint = hue/);
	});
});
