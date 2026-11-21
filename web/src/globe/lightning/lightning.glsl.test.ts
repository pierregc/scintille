import { describe, expect, it } from 'vitest';
import { CHANNEL } from './channel';
import { DENSITY, densityGlsl } from './density';
import { channelLightVertexShader, lightMapVertexShader } from './light-map.glsl';
import { PROFILE } from './profile';
import { ribbonFragment } from './ribbon.glsl';
import { VEIL } from './veil';
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
		expect(lightningVertexShader).toContain('float keep = max(hero * disc, pointWeight(far, lightMapOff) * pointBudget(flash.w));');
		expect(lightningVertexShader).toContain('brightness *= keep;');
	});

	it('leaves a lit flash to its cloud light and channel up close, keeping the disc from afar, for its afterglow and without a cloud light', () => {
		expect(lightningVertexShader).toContain(
			`float disc = max(smoothstep(${f(DENSITY.pointFarness[0])}, ${f(DENSITY.pointFarness[1])}, far), max(lightMapOff, smoothstep(end, max(${f(PROFILE.life)}, end + ${f(PROFILE.tail)}), age)));`,
		);
	});

	it('keeps the disc of a flash over clear sky, where no cloud carries its light', () => {
		expect(lightningVertexShader).toContain(`disc = max(disc, 1.0 - smoothstep(${f(DENSITY.clearSky[0])}, ${f(DENSITY.clearSky[1])}, cloudOpacityAt(normal)));`);
		expect(lightningVertexShader.indexOf('cloudOpacityAt(normal)));')).toBeLessThan(lightningVertexShader.indexOf('float keep = max(hero * disc'));
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
		expect(ribbonVertex.indexOf('float hero = heroWeight(')).toBeLessThan(ribbonVertex.indexOf('float light = segmentLight('));
	});
});

describe('cloud light shaders', () => {
	it('lights the cloud in soft fades, exposed down, for the flashes outside a thin sample', () => {
		expect(lightMapVertexShader).toContain(densityGlsl);
		expect(lightMapVertexShader).toContain('float lively = hero <= 0.0 && pulseHash(seed, 201.0) < calm ? 0.0 : flicker;');
		expect(lightMapVertexShader).toContain('* shown * mix(fieldLevel, 1.0, hero);');
	});

	it('lights the cloud along the main channel of the flashes drawn in full', () => {
		expect(channelLightVertexShader).toContain('if (segA.w <= 0.0 || segC.z > 0.5) return;');
		expect(channelLightVertexShader).toContain('float light = segmentLight(age, at, seed, kind, reached) * shown');
		expect(channelLightVertexShader).toContain('heroWeight(heroLot(seed, flashShape.x, isGround(kind)), heroShare) * onScreen(at)');
	});
});

describe('channels behind the clouds drawn in relief', () => {
	it('fits each end of each segment under the top drawn over it', () => {
		expect(ribbonVertex).toContain('liftA = liftAt(segA.xyz);');
		expect(ribbonVertex).toContain('liftB = liftAt(segB.xyz);');
		expect(ribbonVertex).toContain('if (top <= 0.0) top = cloudFitTopAt(n);');
		expect(ribbonVertex).toContain('return top > 0.0 ? reliefLift(top) : flatLift;');
	});

	it('leaves the veil to the clouds as drawn on screen where the volume draws them', () => {
		expect(ribbonVertex).toContain('light *= mix(veiled.y, width / veiled.x, screen);');
		expect(ribbonVertex).toContain('slant), 1.0, screen);');
		expect(ribbonFragment).toContain('vec2 front = cloudFront(gl_FragCoord.xy / targetSize, vKm);');
		expect(ribbonFragment).toContain('behindLight(hidden, front.y, vLeast) * slantCore(hidden, vSlant)');
		expect(ribbonFragment).toContain('halo > 0.5 ? 1.0 - hidden');
		expect(ribbonFragment).toContain(`-${f(VEIL.hideRate)} * behind`);
	});

	it('scatters the light of main paths only, wide and soft', () => {
		expect(ribbonVertex).toContain('halo > 1.5 ? branch && segC.z < 3.5 :');
		expect(ribbonVertex).toContain(`width = clamp(${f(VEIL.scatterKm)} / kmPerPx, ${f(VEIL.scatterPx[0])}, ${f(VEIL.scatterPx[1])});`);
		expect(ribbonVertex).toContain(`smoothstep(0.0, ${f(VEIL.scatterFrom)}, light)`);
		expect(ribbonFragment).toContain('scatterLight(front.x, front.y, vSlant)');
	});
});

describe('halo shader', () => {
	it('tints the halo cool only', () => {
		expect(ribbonVertex).toContain('vTint = vec3(0.86, 0.9, 1.0);');
		expect(ribbonVertex).not.toMatch(/vTint = hue/);
	});
});
