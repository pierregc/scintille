import type { StormDetail } from '../../contract/types';
import type { SceneData } from '../archive';
import type { SceneClock } from '../clock';
import type { GlobeControls } from '../controls';
import { frameStorm } from './framing';

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

	constructor(
		readonly data: Pick<SceneData, 'openStorm' | 'live'>,
		readonly clock: SceneClock,
		readonly controls: Pick<GlobeControls, 'flyTo' | 'cancelFlight'>,
		readonly baseUrl: string,
		readonly view: () => { fov: number; aspect: number },
	) {
		this.#offMode = clock.on('mode', (mode) => {
			if (mode === 'live') this.#clear();
		});
	}

	get state(): Readonly<ReplayState> { return this.#state; }

	async open(slug: string, speed = 60): Promise<boolean> {
		if (this.#disposed) return false;
		const revision = ++this.#revision;
		this.controls.cancelFlight();
		this.#state = { ...this.#state, loading: slug, error: null };
		try {
			const detail = await this.data.openStorm(this.baseUrl, slug, speed);
			if (!detail || revision !== this.#revision) return false;
			this.#state = { selected: detail, loading: null, error: null };
			const { fov, aspect } = this.view();
			await this.controls.flyTo(frameStorm(detail.bounds, fov, aspect));
			return revision === this.#revision;
		} catch {
			if (revision !== this.#revision) return false;
			this.#state = { ...this.#state, loading: null, error: 'This storm replay could not be opened. Try another storm or return to live.' };
			return false;
		}
	}

	live(): Promise<void> {
		this.#clear();
		return this.data.live();
	}

	#clear(): void {
		this.#revision++;
		this.controls.cancelFlight();
		this.#state = { selected: null, loading: null, error: null };
	}

	dispose(): void {
		this.#disposed = true;
		this.#clear();
		this.#offMode();
	}
}
