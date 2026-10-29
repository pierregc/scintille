import { type FlashRing, NO_DELAY, type SourceDelays } from '../live';
import type { Vec3 } from '../sun';
import { distanceKm, facesCamera, type Voicing, voicing } from './spatial';
import { VoicePool } from './voices';

export const MAX_VOICES = 8;
/** Wall-clock seconds between two new crackles, plus up to JITTER_S at random, so a burst never ticks like a clock. */
export const MIN_GAP_S = 0.14;
export const JITTER_S = 0.2;
/** A playhead jump longer than this (scene ms) is a seek, not playback: it stays silent. */
export const MAX_STEP_MS = 60_000;
/** Flashes considered per frame, to bound the cost of fast replays. */
export const MAX_SCAN = 2048;
/** Quieter flashes are not worth a voice. */
export const MIN_GAIN = 0.02;
const DEG = Math.PI / 180;

export interface Listener {
	/** Camera position in world units. */
	position: Vec3;
	/** Writes the screen position (-1 to 1) of a world point into `out`; false when it is off screen. */
	screen(point: Vec3, out: [number, number]): boolean;
}

export interface Trigger extends Voicing {
	/** Voice slot to play on. */
	voice: number;
	/** The slot's current voice must be stopped first. */
	replaced: boolean;
	/** Ring slot of the flash. */
	flash: number;
	/** Audio time the crackle starts at. */
	start: number;
}

export interface SchedulerOptions {
	radius?: number;
	maxVoices?: number;
	/** Longest crackle, seconds. */
	voiceSeconds: number;
	random?: () => number;
}

/** Picks which flashes crossing the playhead get a crackle, and how it sounds. */
export class CrackleScheduler {
	readonly #ring: FlashRing;
	readonly #radius: number;
	readonly #voiceSeconds: number;
	readonly #random: () => number;
	readonly #pool: VoicePool;
	readonly #direction: Vec3 = [0, 0, 0];
	readonly #point: Vec3 = [0, 0, 0];
	readonly #screen: [number, number] = [0, 0];
	#last = Number.NaN;
	#next = Number.NEGATIVE_INFINITY;

	constructor(ring: FlashRing, { radius = 1, maxVoices = MAX_VOICES, voiceSeconds, random = Math.random }: SchedulerOptions) {
		this.#ring = ring;
		this.#radius = radius;
		this.#voiceSeconds = voiceSeconds;
		this.#random = random;
		this.#pool = new VoicePool(maxVoices);
	}

	/** Voices playing or scheduled at `audioTime`. */
	active(audioTime: number): number {
		return this.#pool.active(audioTime);
	}

	/** Moves the playhead without sound, e.g. while muted. */
	skipTo(sceneTime: number): void {
		this.#last = sceneTime;
	}

	/** Releases every voice, after the audio graph stopped them. */
	reset(): void {
		this.#pool.reset();
		this.#next = Number.NEGATIVE_INFINITY;
	}

	/** Returns the crackle to start for flashes played since the previous call, at most one per call. */
	update(sceneTime: number, audioTime: number, listener: Listener, delays: SourceDelays = NO_DELAY): Trigger | null {
		const from = this.#last;
		this.#last = sceneTime;
		const step = sceneTime - from;
		if (!(step > 0 && step <= MAX_STEP_MS)) return null;
		if (audioTime < this.#next) return null;

		const ring = this.#ring;
		const r = this.#radius;
		const dir = this.#direction;
		const point = this.#point;
		const screen = this.#screen;
		let best: Voicing | null = null;
		let bestSlot = -1;
		for (const delay of delays.values) {
			const first = this.#firstAfter(from - delay);
			const last = Math.min(ring.size, first + MAX_SCAN);
			for (let i = first; i < last; i++) {
				const s = ring.slot(i);
				if (ring.time[s] > sceneTime - delay) break;
				if (delays.ms[ring.source[s]] !== delay) continue;
				const lat = ring.lat[s] * DEG;
				const lon = ring.lon[s] * DEG;
				const cosLat = Math.cos(lat);
				dir[0] = cosLat * Math.cos(lon);
				dir[1] = Math.sin(lat);
				dir[2] = -cosLat * Math.sin(lon);
				if (!facesCamera(dir, listener.position, r)) continue;
				point[0] = dir[0] * r;
				point[1] = dir[1] * r;
				point[2] = dir[2] * r;
				if (!listener.screen(point, screen)) continue;
				const v = voicing(ring.intensity[s], distanceKm(dir, listener.position, r), screen[0], screen[1]);
				if (v.gain >= MIN_GAIN && (!best || v.gain > best.gain)) {
					best = v;
					bestSlot = s;
				}
			}
		}
		if (!best) return null;

		const claim = this.#pool.claim(audioTime, audioTime + this.#voiceSeconds, best.gain);
		if (!claim) return null;
		this.#next = audioTime + MIN_GAP_S + JITTER_S * this.#random();
		return { ...best, voice: claim.slot, replaced: claim.replaced, flash: bestSlot, start: audioTime };
	}

	/** Index (oldest = 0) of the first stored flash strictly after `time`; assumes time order. */
	#firstAfter(time: number): number {
		const ring = this.#ring;
		let lo = 0;
		let hi = ring.size;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (ring.time[ring.slot(mid)] <= time) lo = mid + 1;
			else hi = mid;
		}
		return lo;
	}
}
