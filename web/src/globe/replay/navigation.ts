import type { SceneClock } from '../clock';
import type { GlobeControls } from '../controls';
import type { StormReplay } from './index';
import { parseReplayLocation, replayUrl, type ReplayLocation } from './url';

export interface NavigationHost {
	url(): URL;
	write(url: URL, push: boolean): void;
	onPop(listener: () => void): () => void;
}

export class ReplayNavigation {
	#revision = 0;
	#applying = false;
	#disposed = false;
	readonly #off: (() => void)[];

	constructor(
		readonly replay: StormReplay,
		readonly clock: SceneClock,
		readonly controls: Pick<GlobeControls, 'view'>,
		readonly host: NavigationHost,
	) {
		this.#off = [host.onPop(() => { void this.restore(); }), clock.on('seek', () => {
			if (!this.#applying) this.#write(false);
		}), clock.on('playback', () => {
			if (!this.#applying) this.#write(false);
		}), replay.onChange((origin) => {
			if (origin !== 'user') return;
			this.#revision++;
			this.#applying = false;
			this.#write(true);
		})];
	}

	#snapshot(paused = !this.clock.playing): ReplayLocation | null {
		const detail = this.replay.state.selected;
		if (!detail || this.clock.mode !== 'replay') return null;
		return { slug: detail.storm.slug,
			time: Math.min(Math.max(this.clock.time(), Date.parse(detail.storm.t_start)), Date.parse(detail.storm.t_end)),
			speed: this.clock.speed, paused, view: this.controls.view() };
	}

	#write(push: boolean): void {
		if (this.#disposed || this.replay.state.loading) return;
		const current = this.host.url();
		const url = replayUrl(current, this.#snapshot());
		if (url.href !== current.href) this.host.write(url, push);
	}

	shareUrl(): string { return replayUrl(this.host.url(), this.#snapshot(true)).href; }

	async restore(): Promise<void> {
		if (this.#disposed) return;
		const revision = ++this.#revision;
		this.#applying = true;
		try {
			const state = parseReplayLocation(this.host.url());
			if (!state && this.host.url().searchParams.has('storm')) await this.replay.open(this.host.url().searchParams.get('storm') ?? '', 60, undefined, 'navigation');
			else if (!state) await this.replay.live('navigation');
			else if (state.slug === this.replay.state.selected?.storm.slug && !this.replay.state.loading) await this.replay.restore(state);
			else await this.replay.open(state.slug, state.speed, state, 'navigation');
			if (revision === this.#revision) this.#write(false);
		} finally { if (revision === this.#revision) this.#applying = false; }
	}

	dispose(): void {
		this.#disposed = true;
		this.#revision++;
		for (const off of this.#off) off();
	}
}
