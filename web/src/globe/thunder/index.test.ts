import { PerspectiveCamera } from 'three';
import { afterEach, expect, it, vi } from 'vitest';
import { decodeChunk } from '../live/decode';
import { FlashRing } from '../live/ring';
import { encodeChunk } from '../live/testing';
import { createThunder } from './index';

function node() {
	return {
		connect() { return this; },
		disconnect: vi.fn(),
		gain: { value: 0, cancelScheduledValues: vi.fn(), setTargetAtTime: vi.fn() },
		frequency: { value: 0 }, pan: { value: 0 },
		threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 },
		attack: { value: 0 }, release: { value: 0 },
	};
}

afterEach(() => vi.unstubAllGlobals());

it('keeps pending thunder on a window slide and stops it on dataset replacement', () => {
	const sources: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }[] = [];
	class AudioContextStub {
		currentTime = 1;
		sampleRate = 1000;
		state = 'running';
		destination = node();
		createDynamicsCompressor = node;
		createWaveShaper = node;
		createGain = node;
		createBiquadFilter = node;
		createStereoPanner = node;
		createBuffer = () => ({ copyToChannel() {} });
		createBufferSource() {
			const source = { ...node(), start: vi.fn(), stop: vi.fn() };
			sources.push(source);
			return source;
		}
		resume = async () => {};
		close = async () => {};
	}
	vi.stubGlobal('AudioContext', AudioContextStub);
	const archive = new FlashRing(8);
	archive.push(decodeChunk(encodeChunk(100,
		Array.from({ length: 8 }, (_, i) => ({ offsetMs: i * 10, lat: 0, lon: 0 }))).buffer));
	const ring = new FlashRing(4);
	ring.replace(archive, 0, 4);
	const camera = new PerspectiveCamera(35, 1, 0.01, 100);
	camera.position.set(1.3, 0, 0);
	camera.lookAt(0, 0, 0);
	const thunder = createThunder(ring, camera);
	try {
		thunder.setEnabled(true);
		thunder.update(100_000);
		thunder.update(100_010);
		expect(sources).toHaveLength(1);
		expect(sources[0].start.mock.calls[0][0]).toBeGreaterThan(1);
		ring.slide(archive, 2, 4);
		thunder.update(100_020);
		expect(sources[0].stop).not.toHaveBeenCalled();
		ring.replace(archive, 2, 4);
		thunder.update(100_020);
		expect(sources[0].stop).toHaveBeenCalledOnce();
	} finally { thunder.dispose(); }
});
