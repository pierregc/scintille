import type { StormDetail } from '../../contract/types';
import type { SceneData } from '../archive';
import type { SceneClock } from '../clock';
import type { GlobeControls } from '../controls';
import { frameStorm } from './framing';
import type { ReplayLocation } from './url';

type Origin = 'user' | 'navigation';

export interface ReplayState {
	selected: StormDetail | null;
	loading: string | null;
	error: string | null;
}

/** Production entry shared by discovery and URL restoration; SceneData owns all data transitions. */
export class StormReplay {
	#state: ReplayState = { selected: null, loading: null, error: null };
	#revision = 0;
	#disposed = false;
	readonly #offMode: () => void;
	readonly #listeners = new Set<(origin: Origin) => void>();

	constructor(
		readonly data: Pick<SceneData, 'openStorm' | 'live'>,
		readonly clock: SceneClock,
		readonly controls: Pick<GlobeControls, 'flyTo' | 'cancelFlight'>,
		readonly baseUrl: string,
		readonly view: () => { fov: number; aspect: number },
	) {
		this.#offMode = clock.on('mode', (mode) => {
			if (mode === 'live' && this.#clear()) this.#emit('user');
		});
	}

	get state(): Readonly<ReplayState> { return this.#state; }

	onChange(listener: (origin: Origin) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emit(origin: Origin): void { for (const listener of this.#listeners) listener(origin); }

	async open(slug: string, speed = 60, restore?: ReplayLocation, origin: Origin = 'user'): Promise<boolean> {
		if (this.#disposed) return false;
		const revision = ++this.#revision;
		this.controls.cancelFlight();
		this.#state = { ...this.#state, loading: slug, error: null };
		try {
			const detail = await this.data.openStorm(this.baseUrl, slug, speed);
			if (!detail || revision !== this.#revision) return false;
			this.#state = { selected: detail, loading: slug, error: null };
			await this.#place(detail, revision, restore);
			if (revision === this.#revision) {
				this.#state = { ...this.#state, loading: null };
				this.#emit(origin);
			}
			return revision === this.#revision;
		} catch {
			if (revision !== this.#revision) return false;
			this.#state = { ...this.#state, loading: null, error: 'This storm replay could not be opened. Try another storm or return to live.' };
			return false;
		}
	}

	async restore(state: ReplayLocation): Promise<void> {
		const detail = this.#state.selected;
		if (!detail || this.#disposed) return;
		const revision = ++this.#revision;
		this.controls.cancelFlight();
		this.#state = { ...this.#state, error: null };
		this.clock.setSpeed(state.speed);
		await this.#place(detail, revision, state);
	}

	async #place(detail: StormDetail, revision: number, restore?: ReplayLocation): Promise<void> {
		this.clock.pause();
		if (restore) {
			this.clock.seek(Math.min(Math.max(restore.time ?? Date.parse(detail.storm.t_start), Date.parse(detail.storm.t_start)), Date.parse(detail.storm.t_end)));
		}
		const { fov, aspect } = this.view();
		if (restore?.view) await this.controls.flyTo({ ...restore.view, duration: 0 }, { preserveRange: true });
		else await this.controls.flyTo(frameStorm(detail.bounds, fov, aspect));
		if (revision === this.#revision && this.clock.mode === 'replay' && !restore?.paused) this.clock.play();
	}

	live(origin: Origin = 'user'): Promise<void> {
		this.#clear();
		const returning = this.data.live();
		this.#emit(origin);
		return returning;
	}

	#clear(): boolean {
		const hadState = Boolean(this.#state.selected || this.#state.loading || this.#state.error);
		this.#revision++;
		this.controls.cancelFlight();
		this.#state = { selected: null, loading: null, error: null };
		return hadState;
	}

	dispose(): void {
		this.#disposed = true;
		this.#clear();
		this.#offMode();
		this.#listeners.clear();
	}
}
