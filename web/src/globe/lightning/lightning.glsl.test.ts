import { describe, expect, it } from 'vitest';
import { CHANNEL } from './channel';
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
		expect(zoomGlsl).toContain(`mix(mix(${f(ZOOM.glowLevel)}, 1.0, farness(kmPerPx)), nearLevel, nearFloor(kmPerPx))`);
		expect(lightningVertexShader).toContain('glowShare(viewKmPerPx, nearGlowLevel)');
	});
});

describe('halo shader', () => {
	it('tints the halo cool only', () => {
		expect(ribbonVertex).toContain('vTint = vec3(0.86, 0.9, 1.0);');
		expect(ribbonVertex).not.toMatch(/vTint = hue/);
	});
});
