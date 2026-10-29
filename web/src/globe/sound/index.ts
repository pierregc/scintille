import { type Camera, Vector3 } from 'three';
import type { FlashRing, SourceDelays } from '../live';
import type { Vec3 } from '../sun';
import { CROSSFADE_S, nextTrack, RELAY_S, type Track } from './ambient';
import catalog from './catalog.json';
import { CrackleScheduler, type Listener, MAX_VOICES, type Trigger } from './schedule';

/** Enough for the content (crackles stop at 9 kHz), and a third of the memory of 48 kHz for decoded tracks. */
const SAMPLE_RATE = 32_000;
const MASTER_GAIN = 0.8;
const BED_GAIN = 0.5;
const CRACKLE_GAIN = 0.6;
const FADE_S = 0.05;
const MIN_RATE = 0.8;
const RATE_RANGE = 0.45;
const CRACKLE_S = 0.26 / MIN_RATE;
/** The next track starts loading this long before it fades in. */
const PRELOAD_S = 15;

export interface Sound {
	/** Web Audio is available in this browser. */
	readonly supported: boolean;
	readonly enabled: boolean;
	/** Turns sound on or off; call from a user gesture so the browser lets audio start. */
	setEnabled(on: boolean): void;
	/** Crackles for flashes the playhead crossed since the last frame, each source `delays` behind; relays the ambient tracks. */
	update(sceneTime: number, delays?: SourceDelays): void;
	dispose(): void;
}

interface Voice {
	source: AudioBufferSourceNode;
	gain: GainNode;
}

interface Bed {
	track: Track;
	source: AudioBufferSourceNode;
	gain: GainNode;
}

interface Graph {
	context: AudioContext;
	master: GainNode;
	crackles: AudioBuffer[];
	voices: (Voice | null)[];
	bed: Bed | null;
	/** Audio time the next track fades in. */
	swapAt: number;
	upcoming: { track: Track; buffer: Promise<AudioBuffer> } | null;
}

const TRACKS: readonly Track[] = catalog.tracks;

function newContext(): AudioContext {
	try {
		return new AudioContext({ latencyHint: 'playback', sampleRate: SAMPLE_RATE });
	} catch {
		return new AudioContext({ latencyHint: 'playback' });
	}
}

/** Ambient tracks relayed in crossfades, and a spatialized crackle for flashes on screen. Silent until enabled. */
export function createSound(ring: FlashRing, camera: Camera, radius = 1, base = '/sound/'): Sound {
	const supported = typeof AudioContext === 'function';
	const scheduler = new CrackleScheduler(ring, { radius, maxVoices: MAX_VOICES, voiceSeconds: CRACKLE_S });
	const projected = new Vector3();
	const position: Vec3 = [0, 0, 0];
	const listener: Listener = {
		position,
		screen(point, out) {
			projected.set(point[0], point[1], point[2]).project(camera);
			if (Math.abs(projected.x) > 1 || Math.abs(projected.y) > 1 || projected.z > 1) return false;
			out[0] = projected.x;
			out[1] = projected.y;
			return true;
		},
	};
	let graph: Graph | undefined;
	let enabled = false;
	let generation = ring.generation;

	const load = (context: AudioContext, path: string) =>
		fetch(`${base}${path}`)
			.then((res) => {
				if (!res.ok) throw new Error(`${res.status} ${path}`);
				return res.arrayBuffer();
			})
			.then((bytes) => context.decodeAudioData(bytes));

	const queue = (g: Graph) => {
		const track = nextTrack(TRACKS, g.upcoming?.track ?? g.bed?.track ?? null);
		const buffer = load(g.context, `tracks/${track.id}.mp3`);
		buffer.catch((err) => console.warn('sound: track not loaded', err));
		g.upcoming = { track, buffer };
	};

	const relay = (g: Graph, track: Track, buffer: AudioBuffer, fade: number) => {
		const { context } = g;
		const now = context.currentTime;
		const old = g.bed;
		if (old) {
			old.gain.gain.cancelScheduledValues(now);
			old.gain.gain.setValueAtTime(old.gain.gain.value, now);
			old.gain.gain.linearRampToValueAtTime(0, now + fade);
			old.source.stop(now + fade + 0.1);
			old.source.onended = () => old.gain.disconnect();
		}
		const source = context.createBufferSource();
		source.buffer = buffer;
		source.loop = true;
		source.loopStart = catalog.pad;
		source.loopEnd = catalog.pad + track.loop;
		const gain = context.createGain();
		gain.gain.setValueAtTime(0, now);
		gain.gain.linearRampToValueAtTime(BED_GAIN, now + fade);
		source.connect(gain).connect(g.master);
		source.start(now, catalog.pad + Math.random() * track.loop);
		g.bed = { track, source, gain };
		g.swapAt = now + RELAY_S;
		g.upcoming = null;
	};

	const advance = (g: Graph) => {
		const now = g.context.currentTime;
		if (!g.upcoming && now >= g.swapAt - (g.bed ? PRELOAD_S : 0)) queue(g);
		if (g.bed && now < g.swapAt) return;
		const next = g.upcoming;
		if (!next) return;
		g.swapAt = Number.POSITIVE_INFINITY;
		void next.buffer.then(
			(buffer) => {
				if (graph === g && g.upcoming === next) relay(g, next.track, buffer, g.bed ? CROSSFADE_S : CROSSFADE_S / 2);
			},
			() => {
				if (graph !== g) return;
				g.upcoming = null;
				g.swapAt = g.context.currentTime + RELAY_S;
			},
		);
	};

	const build = (): Graph => {
		const context = newContext();
		const compressor = context.createDynamicsCompressor();
		compressor.threshold.value = -20;
		compressor.knee.value = 12;
		compressor.ratio.value = 3;
		compressor.attack.value = 0.01;
		compressor.release.value = 0.4;
		const master = context.createGain();
		master.gain.value = 0;
		master.connect(compressor).connect(context.destination);
		const g: Graph = { context, master, crackles: [], voices: Array.from({ length: MAX_VOICES }, () => null), bed: null, swapAt: 0, upcoming: null };
		Promise.all(catalog.crackles.map((_, i) => load(context, `crackles/${String(i).padStart(2, '0')}.mp3`)))
			.then((buffers) => {
				g.crackles = buffers;
			})
			.catch((err) => console.warn('sound: crackles not loaded', err));
		return g;
	};

	const stop = (g: Graph, slot: number) => {
		const voice = g.voices[slot];
		if (!voice) return;
		const now = g.context.currentTime;
		voice.gain.gain.cancelScheduledValues(now);
		voice.gain.gain.setTargetAtTime(0, now, FADE_S / 3);
		voice.source.stop(now + FADE_S * 2);
		g.voices[slot] = null;
	};

	const play = (g: Graph, t: Trigger) => {
		if (!g.crackles.length) return;
		if (t.replaced) stop(g, t.voice);
		const { context } = g;
		const source = context.createBufferSource();
		source.buffer = g.crackles[Math.floor(Math.random() * g.crackles.length)];
		source.playbackRate.value = MIN_RATE + Math.random() * RATE_RANGE;
		const filter = context.createBiquadFilter();
		filter.type = 'lowpass';
		filter.frequency.value = t.cutoff;
		const gain = context.createGain();
		gain.gain.value = t.gain * CRACKLE_GAIN;
		const panner = context.createPanner();
		panner.panningModel = 'HRTF';
		panner.distanceModel = 'linear';
		panner.rolloffFactor = 0;
		[panner.positionX.value, panner.positionY.value, panner.positionZ.value] = t.position;
		source.connect(filter).connect(gain).connect(panner).connect(g.master);
		const voice = { source, gain };
		source.onended = () => {
			panner.disconnect();
			if (g.voices[t.voice] === voice) g.voices[t.voice] = null;
		};
		source.start(t.start);
		g.voices[t.voice] = voice;
	};

	return {
		supported,
		get enabled() {
			return enabled;
		},
		setEnabled(on) {
			if (!supported || on === enabled) return;
			enabled = on;
			graph ??= build();
			const { context, master } = graph;
			const now = context.currentTime;
			master.gain.cancelScheduledValues(now);
			master.gain.setTargetAtTime(on ? MASTER_GAIN : 0, now, FADE_S);
			if (on) {
				void context.resume();
			} else {
				for (let i = 0; i < graph.voices.length; i++) stop(graph, i);
				scheduler.reset();
				setTimeout(() => {
					if (!enabled && context.state === 'running') void context.suspend();
				}, 500);
			}
		},
		update(sceneTime, delays) {
			if (generation !== ring.generation) {
				generation = ring.generation;
				if (graph) for (let i = 0; i < graph.voices.length; i++) stop(graph, i);
				scheduler.reset();
				scheduler.skipTo(sceneTime);
			}
			if (!enabled || !graph || graph.context.state !== 'running') {
				scheduler.skipTo(sceneTime);
				return;
			}
			advance(graph);
			camera.updateMatrixWorld();
			position[0] = camera.position.x;
			position[1] = camera.position.y;
			position[2] = camera.position.z;
			const trigger = scheduler.update(sceneTime, graph.context.currentTime, listener, delays);
			if (trigger) play(graph, trigger);
		},
		dispose() {
			enabled = false;
			void graph?.context.close();
			graph = undefined;
		},
	};
}
