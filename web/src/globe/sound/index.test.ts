import { PerspectiveCamera } from 'three';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { decodeChunk } from '../live/decode';
import { FlashRing } from '../live/ring';
import { encodeChunk } from '../live/testing';
import { CROSSFADE_S, RELAY_S } from './ambient';
import { createSound } from './index';

function param() {
	return {
		value: 0,
		cancelScheduledValues: vi.fn(),
		setTargetAtTime: vi.fn(),
		setValueAtTime: vi.fn(),
		linearRampToValueAtTime: vi.fn(),
	};
}

function node() {
	return {
		connect() { return this; },
		disconnect: vi.fn(),
		gain: param(), frequency: param(), playbackRate: param(),
		positionX: param(), positionY: param(), positionZ: param(),
		threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(),
	};
}

type Source = ReturnType<typeof node> & { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; loop?: boolean };

let sources: Source[];
let fetched: string[];
let contexts: { currentTime: number }[];

beforeEach(() => {
	sources = [];
	fetched = [];
	contexts = [];
	class AudioContextStub {
		currentTime = 1;
		state = 'running';
		destination = node();
		constructor() {
			contexts.push(this);
		}
		createDynamicsCompressor = node;
		createGain = node;
		createBiquadFilter = node;
		createPanner = node;
		createBufferSource() {
			const source = { ...node(), start: vi.fn(), stop: vi.fn() };
			sources.push(source);
			return source;
		}
		decodeAudioData = async () => ({});
		resume = async () => {};
		suspend = async () => {};
		close = async () => {};
	}
	vi.stubGlobal('AudioContext', AudioContextStub);
	vi.stubGlobal('fetch', async (url: string) => {
		fetched.push(url);
		return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
	});
});

afterEach(() => vi.unstubAllGlobals());

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const crackles = () => sources.filter((s) => !s.loop);
const beds = () => sources.filter((s) => s.loop);

function scene() {
	const archive = new FlashRing(8);
	archive.push(decodeChunk(encodeChunk(100,
		Array.from({ length: 8 }, (_, i) => ({ offsetMs: i * 10, lat: 0, lon: 0 }))).buffer));
	const ring = new FlashRing(4);
	ring.replace(archive, 0, 4);
	const camera = new PerspectiveCamera(35, 1, 0.01, 100);
	camera.position.set(1.3, 0, 0);
	camera.lookAt(0, 0, 0);
	return { archive, ring, sound: createSound(ring, camera) };
}

it('keeps crackles on a window slide and stops them on dataset replacement', async () => {
	const { archive, ring, sound } = scene();
	try {
		sound.setEnabled(true);
		await settle();
		sound.update(100_000);
		sound.update(100_010);
		expect(crackles()).toHaveLength(1);
		expect(fetched.filter((u) => u.includes('/crackles/')).length).toBeGreaterThanOrEqual(8);
		ring.slide(archive, 2, 4);
		sound.update(100_020);
		expect(crackles()[0].stop).not.toHaveBeenCalled();
		ring.replace(archive, 2, 4);
		sound.update(100_020);
		expect(crackles()[0].stop).toHaveBeenCalledOnce();
	} finally { sound.dispose(); }
});

it('relays ambient tracks in crossfades, never the same twice in a row', async () => {
	const { sound } = scene();
	try {
		sound.setEnabled(true);
		sound.update(0);
		await settle();
		expect(beds()).toHaveLength(1);
		const tracks = () => fetched.filter((u) => u.includes('/tracks/'));
		expect(tracks()).toHaveLength(1);
		for (let k = 1; k <= 3; k++) {
			contexts[0].currentTime += RELAY_S;
			sound.update(0);
			sound.update(0);
			await settle();
			expect(beds()).toHaveLength(k + 1);
			const [old, next] = beds().slice(-2);
			expect(old.stop.mock.calls[0][0]).toBeGreaterThanOrEqual(contexts[0].currentTime + CROSSFADE_S);
			expect(next.start).toHaveBeenCalledOnce();
			expect(tracks()[k]).not.toBe(tracks()[k - 1]);
		}
	} finally { sound.dispose(); }
});
