import { InstancedBufferGeometry, Mesh, ShaderMaterial } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeChunk } from '../live/decode';
import { FlashRing } from '../live/ring';
import { encodeChunk } from '../live/testing';
import { createLightning } from './index';

afterEach(() => vi.unstubAllGlobals());

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
		expect(child.geometry.instanceCount).toBe(1);
		const halo = lightning.mesh.children[1];
		if (!(halo instanceof Mesh) || !(halo.geometry instanceof InstancedBufferGeometry)) throw new Error('missing halo');
		expect(halo.geometry.instanceCount).toBe(1);
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

	it('budgets the halo and restores the round glow during a burst', () => {
		const ring = new FlashRing(1024);
		ring.push(decodeChunk(encodeChunk(100, Array.from({ length: 513 }, () => ({ offsetMs: 0, lat: 0, lon: 0 }))).buffer));
		const lightning = createLightning(ring, { storage: null, lightMapWidth: 0 });
		lightning.setTime(100_100);
		const halo = lightning.mesh.children[1];
		if (!(halo instanceof Mesh) || !(halo.geometry instanceof InstancedBufferGeometry)) throw new Error('missing halo');
		expect(halo.geometry.instanceCount).toBe(0);
		expect(halo.geometry.index?.count).toBe(8 * 6);
		if (!(halo.material instanceof ShaderMaterial)) throw new Error('missing halo material');
		expect(halo.material.uniforms.haloStrength.value).toBe(0);
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
});
