export type ClockMode = 'live' | 'replay' | 'render';

export interface ClockEvents {
	mode: ClockMode;
	seek: number;
	playback: { playing: boolean; speed: number };
}

type Listener<T> = (value: T) => void;

/** Single source of scene time (UTC ms) for every time-dependent layer. */
export class SceneClock {
	#mode: ClockMode = 'live';
	#playing = true;
	#speed = 1;
	#anchorScene = 0;
	#anchorWall = 0;
	#step = 0;
	#frame = 0;
	readonly #now: () => number;
	readonly #listeners: { [K in keyof ClockEvents]: Set<Listener<ClockEvents[K]>> } = {
		mode: new Set(),
		seek: new Set(),
		playback: new Set(),
	};

	constructor(now: () => number = () => Date.now()) {
		this.#now = now;
	}

	get mode(): ClockMode {
		return this.#mode;
	}

	get playing(): boolean {
		return this.#playing;
	}

	get speed(): number {
		return this.#speed;
	}

	/** Wall-clock time in UTC milliseconds, whatever the mode: for data freshness, never for the scene. */
	wallTime(): number {
		return this.#now();
	}

	/** Current scene time in UTC milliseconds. */
	time(): number {
		switch (this.#mode) {
			case 'live':
				return this.#now();
			case 'replay': {
				const now = this.#now();
				return Math.min(this.#playing ? this.#anchorScene + (now - this.#anchorWall) * this.#speed : this.#anchorScene, now);
			}
			case 'render':
				return this.#anchorScene + this.#frame * this.#step;
		}
	}

	/** True once a replay has caught up with the present, where it holds. */
	atPresent(): boolean {
		return this.#mode === 'replay' && this.time() >= this.#now();
	}

	live(): void {
		this.#playing = true;
		this.#speed = 1;
		this.#setMode('live');
	}

	/** Replays from `start`, playing at `speed` times real time, never past the present. */
	replay(start: number, speed = 1): void {
		assertSpeed(speed);
		this.#speed = speed;
		this.#playing = true;
		this.#anchor(Math.min(start, this.#now()));
		this.#setMode('replay');
	}

	/** Deterministic mode for offline rendering: time only moves on `advance()`. */
	render(start: number, step: number): void {
		if (!(step > 0)) throw new RangeError(`step must be positive, got ${step}`);
		this.#step = step;
		this.#playing = false;
		this.#anchor(start);
		this.#setMode('render');
	}

	advance(): number {
		this.#requireMode('render', 'advance');
		this.#frame++;
		return this.time();
	}

	play(): void {
		this.#requireMode('replay', 'play');
		if (this.#playing) return;
		this.#anchorWall = this.#now();
		this.#playing = true;
		this.#emit('playback', { playing: this.#playing, speed: this.#speed });
	}

	pause(): void {
		this.#requireMode('replay', 'pause');
		if (!this.#playing) return;
		this.#anchorScene = this.time();
		this.#playing = false;
		this.#emit('playback', { playing: this.#playing, speed: this.#speed });
	}

	setSpeed(speed: number): void {
		this.#requireMode('replay', 'setSpeed');
		assertSpeed(speed);
		this.#anchor(this.time());
		this.#speed = speed;
		this.#emit('playback', { playing: this.#playing, speed: this.#speed });
	}

	seek(time: number): void {
		if (this.#mode === 'live') throw new Error('seek is not available in live mode');
		if (this.#mode === 'replay') time = Math.min(time, this.#now());
		this.#anchor(time);
		this.#emit('seek', time);
	}

	/** Subscribes to an event; returns the unsubscribe function. */
	on<K extends keyof ClockEvents>(event: K, listener: Listener<ClockEvents[K]>): () => void {
		const listeners = this.#listeners[event] as Set<Listener<ClockEvents[K]>>;
		listeners.add(listener);
		return () => listeners.delete(listener);
	}

	#anchor(sceneTime: number): void {
		this.#anchorScene = sceneTime;
		this.#frame = 0;
		this.#anchorWall = this.#now();
	}

	#setMode(mode: ClockMode): void {
		if (mode === this.#mode) return;
		this.#mode = mode;
		this.#emit('mode', mode);
	}

	#requireMode(mode: ClockMode, action: string): void {
		if (this.#mode !== mode) throw new Error(`${action} is only available in ${mode} mode`);
	}

	#emit<K extends keyof ClockEvents>(event: K, value: ClockEvents[K]): void {
		for (const listener of this.#listeners[event] as Set<Listener<ClockEvents[K]>>) listener(value);
	}
}

function assertSpeed(speed: number): void {
	if (!Number.isFinite(speed) || speed <= 0) throw new RangeError(`speed must be positive, got ${speed}`);
}
