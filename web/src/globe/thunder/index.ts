import { type Camera, Vector3 } from 'three';
import type { FlashRing, SourceDelays } from '../live';
import type { Vec3 } from '../sun';
import { type Listener, MAX_VOICES, ThunderScheduler, type Trigger } from './schedule';
import { CLAP_SECONDS, softClipCurve, thunderClap } from './synth';

const VARIANTS = 6;
const MASTER_GAIN = 0.7;
const FADE_S = 0.05;

export interface Thunder {
	/** Web Audio is available in this browser. */
	readonly supported: boolean;
	readonly enabled: boolean;
	/** Turns sound on or off; call from a user gesture so the browser lets audio start. */
	setEnabled(on: boolean): void;
	/** Schedules thunder for flashes the playhead crossed since the last frame, each source `delays` behind. */
	update(sceneTime: number, delays?: SourceDelays): void;
	dispose(): void;
}

interface Voice {
	source: AudioBufferSourceNode;
	gain: GainNode;
}

interface Graph {
	context: AudioContext;
	master: GainNode;
	clips: AudioBuffer[];
	voices: (Voice | null)[];
}

/** Spatialized, procedurally synthesized thunder. Silent until enabled. */
export function createThunder(ring: FlashRing, camera: Camera, radius = 1): Thunder {
	const supported = typeof AudioContext === 'function';
	const scheduler = new ThunderScheduler(ring, { radius, maxVoices: MAX_VOICES, voiceSeconds: CLAP_SECONDS });
	const projected = new Vector3();
	const position: Vec3 = [0, 0, 0];
	const listener: Listener = {
		position,
		screenX(point) {
			projected.set(point[0], point[1], point[2]).project(camera);
			return Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1 && projected.z <= 1 ? projected.x : null;
		},
	};
	let graph: Graph | undefined;
	let enabled = false;
	let generation = ring.generation;

	const build = (): Graph => {
		const context = new AudioContext({ latencyHint: 'playback' });
		const limiter = context.createDynamicsCompressor();
		limiter.threshold.value = -12;
		limiter.knee.value = 0;
		limiter.ratio.value = 20;
		limiter.attack.value = 0.002;
		limiter.release.value = 0.25;
		const clipper = context.createWaveShaper();
		clipper.curve = softClipCurve();
		const master = context.createGain();
		master.gain.value = 0;
		master.connect(limiter).connect(clipper).connect(context.destination);
		const clips = Array.from({ length: VARIANTS }, (_, i) => {
			const samples = thunderClap(context.sampleRate, i + 1);
			const buffer = context.createBuffer(1, samples.length, context.sampleRate);
			buffer.copyToChannel(samples, 0);
			return buffer;
		});
		return { context, master, clips, voices: Array.from({ length: MAX_VOICES }, () => null) };
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
		if (t.replaced) stop(g, t.voice);
		const { context } = g;
		const source = context.createBufferSource();
		source.buffer = g.clips[t.flash % g.clips.length];
		const filter = context.createBiquadFilter();
		filter.type = 'lowpass';
		filter.frequency.value = t.cutoff;
		const gain = context.createGain();
		gain.gain.value = t.gain;
		const panner = context.createStereoPanner();
		panner.pan.value = t.pan;
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
