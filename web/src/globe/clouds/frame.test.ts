import { Texture, TextureLoader } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLOUD_ARCHIVE_RULES } from '../../contract/cloud-archive';
import { loadCloudFrame } from './frame';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('bounded cloud texture downloads', () => {
	it('rejects oversized live downloads even without an abort signal', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, {
			headers: { 'Content-Length': String(CLOUD_ARCHIVE_RULES.max_frame_bytes + 1) },
		})));
		const loader = new TextureLoader();
		const decode = vi.spyOn(loader, 'loadAsync');
		await expect(loadCloudFrame('https://example.test/cloud.webp', 0, loader)).rejects.toThrow('too large');
		expect(decode).not.toHaveBeenCalled();
	});

	it('uses the same bounded path for live and archive and releases the blob URL', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('image')));
		const loader = new TextureLoader();
		const texture = new Texture<HTMLImageElement>();
		vi.spyOn(loader, 'loadAsync').mockResolvedValue(texture);
		const revoke = vi.spyOn(URL, 'revokeObjectURL');
		const frame = await loadCloudFrame('https://example.test/cloud.webp', 42, loader);
		expect(frame).toEqual({ texture, time: 42 });
		expect(revoke).toHaveBeenCalledOnce();
		expect(revoke.mock.calls[0][0]).toMatch(/^blob:/);
		texture.dispose();
	});
});
