import { AdditiveBlending, CustomBlending, InstancedBufferGeometry, Mesh, ShaderMaterial } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeChunk } from '../live/decode';
import { FlashRing } from '../live/ring';
import { encodeChunk } from '../live/testing';
import { DENSITY, heroShare } from './density';
import { aliveCount, budgetStart, createLightning, lightWindow } from './index';
import { MAX_SEGMENTS } from './skeleton';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

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
});

describe('storm view budget', () => {
	it('finds where the newest flashes played by now begin', () => {
		const ring = new FlashRing(16);
		ring.push(decodeChunk(encodeChunk(100, [0, 100, 200, 300, 400].map((offsetMs) => ({ offsetMs, lat: 0, lon: 0 }))).buffer));
		expect(budgetStart(ring, 100_350, 2)).toBe(100_200);
		expect(budgetStart(ring, 100_350, 4)).toBe(Number.NEGATIVE_INFINITY);
		expect(budgetStart(ring, 100_400, 4)).toBe(100_100);
		expect(budgetStart(ring, 100_400, Infinity)).toBe(Number.NEGATIVE_INFINITY);
	});

	it('counts the flashes played within a span of scene time', () => {
		const ring = new FlashRing(16);
		ring.push(decodeChunk(encodeChunk(100, [0, 100, 200, 300, 400].map((offsetMs) => ({ offsetMs, lat: 0, lon: 0 }))).buffer));
		expect(aliveCount(ring, 100_400, 250)).toBe(3);
		expect(aliveCount(ring, 100_350, 51)).toBe(1);
		expect(aliveCount(ring, 100_350, 50)).toBe(0);
		expect(aliveCount(ring, 99_000, 1000)).toBe(0);
		expect(aliveCount(ring, 200_000, 1e6)).toBe(5);
	});
});

describe('storm view sample', () => {
	/** 2,000 flashes over 240 s of scene time, then 200 over the next 240 s. */
	const burst = () => {
		const ring = new FlashRing(4096);
		const flashes = [
			...Array.from({ length: 2000 }, (_, i) => ({ offsetMs: i * 120, lat: (i % 50) * 0.1, lon: Math.floor(i / 50) * 0.1 })),
			...Array.from({ length: 200 }, (_, i) => ({ offsetMs: 240_000 + i * 1200, lat: (i % 50) * 0.1, lon: 5 + Math.floor(i / 50) * 0.1 })),
		];
		ring.push(decodeChunk(encodeChunk(100, flashes).buffer));
		return ring;
	};

	it('draws a share of the flashes sized for the replay speed and lifts the newest-flashes cap', () => {
		const ring = burst();
		const lightning = createLightning(ring, { storage: null, lightMapWidth: 0 });
		const material = lightning.mesh.material as ShaderMaterial;
		lightning.stormView = true;
		lightning.setTime(340_000, undefined, 600);
		const wanted = heroShare(20, 2000);
		expect(lightning.stats.alive).toBe(2000);
		expect(lightning.stats.target).toBe(20);
		expect(lightning.heroShare).toBeCloseTo(wanted, 9);
		expect(material.uniforms.heroShare.value).toBe(lightning.heroShare);
		expect(material.uniforms.budgetFrom.value).toBe(-1e6);
		expect(lightning.stats.drawn).toBeGreaterThan(0);
		expect(lightning.stats.drawn).toBeLessThan(200);
		lightning.setTime(340_000, undefined, 600);
		expect(lightning.stats.channels).toBe(lightning.stats.drawn);
		lightning.dispose();
	});

	it('draws every flash at 1× and outside storm views, where the newest-flashes cap applies', () => {
		const ring = burst();
		const lightning = createLightning(ring, { storage: null, lightMapWidth: 0 });
		const material = lightning.mesh.material as ShaderMaterial;
		lightning.setTime(340_000, undefined, 600);
		expect(lightning.heroShare).toBe(1);
		expect(material.uniforms.budgetFrom.value).toBe(-1e6);
		lightning.stormView = true;
		lightning.setTime(340_000, undefined, 1);
		expect(lightning.heroShare).toBe(1);
		expect(lightning.stats.target).toBe(Infinity);
		expect(material.uniforms.budgetFrom.value).toBeCloseTo((budgetStart(ring, 340_000, 500) - 340_000) / 1000, 6);
		lightning.dispose();
	});

	it('follows a changing rate over the smoothing time and jumps on a seek', () => {
		const ring = burst();
		const lightning = createLightning(ring, { storage: null, lightMapWidth: 0 });
		let wall = 0;
		vi.spyOn(performance, 'now').mockImplementation(() => wall);
		lightning.stormView = true;
		lightning.setTime(340_000, undefined, 600);
		const dense = lightning.heroShare;
		const shares: number[] = [];
		for (let frame = 1; frame <= 120; frame++) {
			wall += 1000 / 60;
			lightning.setTime(340_000 + frame * 10_000, undefined, 600);
			shares.push(lightning.heroShare);
		}
		const sparse = heroShare(20, lightning.stats.alive);
		expect(lightning.stats.alive).toBeLessThan(2000);
		for (let i = 1; i < shares.length; i++) {
			expect(shares[i]).toBeGreaterThanOrEqual(shares[i - 1]);
			expect(shares[i] / shares[i - 1]).toBeLessThanOrEqual((sparse / dense) ** (1 / 60 / DENSITY.smoothing) + 1e-9);
		}
		expect(shares[shares.length - 1]).toBeGreaterThan(dense);
		expect(shares[shares.length - 1]).toBeLessThan(sparse);
		wall += 1000 / 60;
		lightning.setTime(340_000, undefined, 600);
		expect(lightning.heroShare).toBeCloseTo(dense, 9);
		lightning.dispose();
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
