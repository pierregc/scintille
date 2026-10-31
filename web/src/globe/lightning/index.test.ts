import { AddEquation, AdditiveBlending, CustomBlending, InstancedBufferGeometry, MaxEquation, Mesh, OneFactor, OneMinusSrcColorFactor, ShaderMaterial, Vector2, type WebGLRenderer } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeChunk } from '../live/decode';
import { FlashRing } from '../live/ring';
import { encodeChunk } from '../live/testing';
import { budgetStart, createLightning, lightWindow } from './index';
import { MAX_SEGMENTS } from './skeleton';
import { maxBlendShare, PHONE, ZOOM } from './zoom';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

/** The screen-blended copy of the glow, drawn while a storm view crosses from max to screen blending. */
function screenTwin(glow: Mesh): Mesh {
	const twin = glow.children.find((child) => child instanceof Mesh && child.geometry === glow.geometry);
	if (!(twin instanceof Mesh)) throw new Error('missing screen twin');
	return twin;
}

describe('3D channel integration', () => {
	it('shares bloom layers and retires channels while the afterglow remains', () => {
		const ring = new FlashRing(8);
		ring.push(decodeChunk(encodeChunk(100, [{ offsetMs: 0, lat: 0, lon: 0 }]).buffer));
		const lightning = createLightning(ring, { storage: null, lightMapWidth: 0 });
		const child = lightning.mesh.children[0];
		expect(child).toBeInstanceOf(Mesh);
		if (!(child instanceof Mesh)) throw new Error('missing channel mesh');
		lightning.mesh.layers.enable(1);
		expect(child.layers.mask).toBe(lightning.mesh.layers.mask);
		lightning.setTime(100_100);
		expect(child.geometry.instanceCount).toBe(MAX_SEGMENTS);
		const halo = lightning.mesh.children[1];
		if (!(halo instanceof Mesh)) throw new Error('missing halo');
		expect(halo.geometry).toBe(child.geometry);
		expect(halo.visible).toBe(true);
		expect(halo.layers.mask).toBe(lightning.mesh.layers.mask);
		lightning.setTime(101_000);
		expect(child.geometry.instanceCount).toBe(0);
		if (!(lightning.mesh.geometry instanceof InstancedBufferGeometry)) throw new Error('missing glow geometry');
		expect(lightning.mesh.geometry.instanceCount).toBe(1);
		const disposed = vi.fn();
		child.geometry.addEventListener('dispose', disposed);
		lightning.dispose();
		expect(disposed).toHaveBeenCalledOnce();
	});

	it('budgets the halo during a burst and builds no channel too far away to read', () => {
		const ring = new FlashRing(1024);
		ring.push(decodeChunk(encodeChunk(100, Array.from({ length: 300 }, (_, i) => ({ offsetMs: 0, lat: (i % 60) * 0.5, lon: Math.floor(i / 60) }))).buffer));
		const lightning = createLightning(ring, { storage: null, lightMapWidth: 0 });
		let wall = 0;
		vi.spyOn(performance, 'now').mockImplementation(() => (wall += 100));
		for (let frame = 0; frame < 16; frame++) lightning.setTime(100_100);
		const halo = lightning.mesh.children[1];
		if (!(halo instanceof Mesh) || !(halo.material instanceof ShaderMaterial)) throw new Error('missing halo');
		expect(halo.material.uniforms.haloStrength.value).toBe(0);
		expect(halo.visible).toBe(false);
		lightning.viewKmPerPx = 12;
		lightning.setTime(100_100);
		expect(halo.geometry.instanceCount).toBe(0);
		lightning.dispose();
	});

	it('shares the reduced-motion profile uniform and cleans up its listener', () => {
		const preference = { matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() };
		vi.stubGlobal('matchMedia', () => preference);
		const lightning = createLightning(new FlashRing(8), { storage: null, lightMapWidth: 0 });
		const child = lightning.mesh.children[0];
		if (!(child instanceof Mesh) || !(child.material instanceof ShaderMaterial)) throw new Error('missing channel material');
		expect(child.material.uniforms.flicker.value).toBe(0);
		const applyMotion = preference.addEventListener.mock.calls[0][1] as () => void;
		preference.matches = false;
		applyMotion();
		expect(child.material.uniforms.flicker.value).toBe(1);
		lightning.dispose();
		expect(preference.removeEventListener).toHaveBeenCalledWith('change', applyMotion);
	});

	it('keeps channels for their flicker in wall clock time while replaying fast', () => {
		const ring = new FlashRing(8);
		ring.push(decodeChunk(encodeChunk(100, [{ offsetMs: 0, lat: 0, lon: 0 }]).buffer));
		const lightning = createLightning(ring, { storage: null, lightMapWidth: 0 });
		const channel = lightning.mesh.children[0];
		if (!(channel instanceof Mesh)) throw new Error('missing channel mesh');
		lightning.setTime(100_000, undefined, 60);
		lightning.setTime(106_000, undefined, 60);
		expect(channel.geometry.instanceCount).toBe(MAX_SEGMENTS);
		lightning.setTime(130_000, undefined, 60);
		expect(channel.geometry.instanceCount).toBe(0);
		lightning.dispose();
	});
});

describe('storm view', () => {
	it('shows each flash alone without forgetting the afterglow chosen for the globe', () => {
		const lightning = createLightning(new FlashRing(8), { storage: null, lightMapWidth: 0 });
		const material = lightning.mesh.material as ShaderMaterial;
		lightning.setDisplayMinutes(30);
		expect(material.uniforms.duration.value).toBe(1800);
		lightning.stormView = true;
		expect(lightning.displayMinutes).toBe(30);
		expect(material.uniforms.duration.value).toBe(0);
		expect(material.blending).toBe(CustomBlending);
		lightning.stormView = false;
		expect(material.uniforms.duration.value).toBe(1800);
		expect(material.blending).toBe(AdditiveBlending);
		lightning.dispose();
	});

	it('keeps the brightest glow at each pixel near the floor and screen-blends from afar', () => {
		const lightning = createLightning(new FlashRing(8), { storage: null, lightMapWidth: 0 });
		const material = lightning.mesh.material as ShaderMaterial;
		const twin = screenTwin(lightning.mesh);
		lightning.viewKmPerPx = 0.3;
		expect(material.blending).toBe(AdditiveBlending);
		expect(twin.visible).toBe(false);
		lightning.stormView = true;
		expect(material.blending).toBe(CustomBlending);
		expect(material.blendEquation).toBe(MaxEquation);
		expect([material.blendSrc, material.blendDst]).toEqual([OneFactor, OneFactor]);
		expect(twin.visible).toBe(false);
		lightning.viewKmPerPx = 2;
		expect(material.blendEquation).toBe(AddEquation);
		expect([material.blendSrc, material.blendDst]).toEqual([OneFactor, OneMinusSrcColorFactor]);
		expect(twin.visible).toBe(false);
		lightning.viewKmPerPx = ZOOM.floorKmPerPx * 0.9;
		expect(material.blendEquation).toBe(MaxEquation);
		lightning.stormView = false;
		expect(material.blending).toBe(AdditiveBlending);
		expect(twin.visible).toBe(false);
		lightning.dispose();
	});

	it('fades a screen-blended twin in under the max-blended glow on the way out, without a new material', () => {
		const lightning = createLightning(new FlashRing(8), { storage: null, lightMapWidth: 0 });
		const material = lightning.mesh.material as ShaderMaterial;
		const twin = screenTwin(lightning.mesh);
		const twinMaterial = twin.material as ShaderMaterial;
		expect(twin.geometry).toBe(lightning.mesh.geometry);
		expect(twin.layers).toBe(lightning.mesh.layers);
		expect(twin.renderOrder).toBeLessThan(lightning.mesh.renderOrder);
		expect(twinMaterial.uniforms.time).toBe(material.uniforms.time);
		expect(twinMaterial.uniforms.nearGlowLevel).toBe(material.uniforms.nearGlowLevel);
		expect(material.uniforms.blendWeight.value).toBe(1);
		expect(twinMaterial.blendEquation).toBe(AddEquation);
		expect([twinMaterial.blendSrc, twinMaterial.blendDst]).toEqual([OneFactor, OneMinusSrcColorFactor]);
		lightning.stormView = true;
		let previous = 0;
		for (let kmPerPx = 0.6; kmPerPx < 1.1; kmPerPx *= 1.02) {
			lightning.viewKmPerPx = kmPerPx;
			const share = maxBlendShare(kmPerPx);
			expect(twin.visible).toBe(share > 0 && share < 1);
			expect(material.blendEquation).toBe(share > 0 ? MaxEquation : AddEquation);
			expect(material.uniforms.blendWeight.value).toBe(1);
			if (twin.visible) {
				expect(twinMaterial.uniforms.blendWeight.value).toBeCloseTo(1 - share, 9);
				expect(twinMaterial.uniforms.blendWeight.value).toBeGreaterThanOrEqual(previous);
				previous = twinMaterial.uniforms.blendWeight.value as number;
			}
		}
		expect(previous).toBeGreaterThan(0.9);
		lightning.dispose();
	});

	it('picks the blend from the zoom a phone draws at', () => {
		const lightning = createLightning(new FlashRing(8), { storage: null, lightMapWidth: 0, phone: true });
		const material = lightning.mesh.material as ShaderMaterial;
		const renderer = { getSize: (target: Vector2) => target.set(375, PHONE.viewHeight * 0.75) } as unknown as WebGLRenderer;
		// Only the renderer size matters to the glow before it draws.
		(lightning.mesh.onBeforeRender as unknown as (renderer: WebGLRenderer) => void)(renderer);
		lightning.stormView = true;
		lightning.viewKmPerPx = 1.2;
		expect(material.blendEquation).toBe(MaxEquation);
		expect(screenTwin(lightning.mesh).visible).toBe(true);
		lightning.viewKmPerPx = 1.4;
		expect(material.blendEquation).toBe(AddEquation);
		lightning.dispose();
	});

	it('draws the glow at a fraction near the floor only while the lit cloud carries the flash', () => {
		const level = (lightning: ReturnType<typeof createLightning>) => (lightning.mesh.material as ShaderMaterial).uniforms.nearGlowLevel.value as number;
		const lit = createLightning(new FlashRing(8), { storage: null, lightMapWidth: 64 });
		expect(lit.cloudLit).toBe(true);
		expect(level(lit)).toBe(ZOOM.nearGlowLevel);
		lit.cloudLit = false;
		expect(level(lit)).toBe(ZOOM.glowLevel);
		lit.cloudLit = true;
		expect(level(lit)).toBe(ZOOM.nearGlowLevel);
		lit.dispose();
		const unlit = createLightning(new FlashRing(8), { storage: null, lightMapWidth: 0 });
		expect(unlit.cloudLit).toBe(false);
		unlit.cloudLit = true;
		expect(unlit.cloudLit).toBe(false);
		expect(level(unlit)).toBe(ZOOM.glowLevel);
		unlit.dispose();
		const phone = createLightning(new FlashRing(8), { storage: null, lightMapWidth: 64, phone: true });
		const uniforms = (phone.mesh.material as ShaderMaterial).uniforms;
		expect(level(phone)).toBeCloseTo(ZOOM.nearGlowLevel * PHONE.nearLevel, 9);
		expect(uniforms.glowLevel.value).toBeCloseTo(ZOOM.glowLevel * PHONE.nearLevel, 9);
		phone.cloudLit = false;
		expect(level(phone)).toBeCloseTo(ZOOM.glowLevel * PHONE.nearLevel, 9);
		phone.dispose();
	});
});

describe('storm view budget', () => {
	it('finds where the newest flashes played by now begin', () => {
		const ring = new FlashRing(16);
		ring.push(decodeChunk(encodeChunk(100, [0, 100, 200, 300, 400].map((offsetMs) => ({ offsetMs, lat: 0, lon: 0 }))).buffer));
		expect(budgetStart(ring, 100_350, 2)).toBe(100_200);
		expect(budgetStart(ring, 100_350, 4)).toBe(Number.NEGATIVE_INFINITY);
		expect(budgetStart(ring, 100_400, 4)).toBe(100_100);
	});
});

describe('light map window', () => {
	it('frames the view finely near the floor and the whole globe from afar', () => {
		const near = lightWindow({ lat: 0.3, lon: -0.8 }, 400);
		expect(near.x).toBe(-0.8);
		expect(near.y).toBe(0.3);
		expect(near.w).toBeCloseTo(1200 / 6371, 6);
		expect(near.z).toBeCloseTo((2 * near.w) / Math.cos(0.3 + near.w), 6);
		const far = lightWindow({ lat: 0.3, lon: -0.8 }, 20_000);
		expect([far.y, far.z, far.w]).toEqual([0, Math.PI, Math.PI / 2]);
	});

	it('stays within the poles as it grows', () => {
		const window = lightWindow({ lat: 1.4, lon: 0 }, 1000);
		expect(window.y + window.w).toBeCloseTo(Math.PI / 2, 6);
		expect(window.z).toBe(Math.PI);
	});
});
