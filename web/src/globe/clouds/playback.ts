import type { ClockMode } from '../clock';
import type { ArchiveCloudFeed } from './archive';
import type { CloudFeed } from './feed';
import type { Clouds } from './index';

/** Owns the cloud source transition; the scene clock still owns playback time. */
export class CloudPlayback {
	#archiveMode: boolean | undefined;
	constructor(
		readonly clouds: Pick<Clouds, 'visible'>,
		readonly live: Pick<CloudFeed, 'start' | 'stop' | 'settled' | 'attribution'>,
		readonly archive: Pick<ArchiveCloudFeed, 'setTime' | 'stop' | 'settled' | 'attribution'>,
	) {}

	get status(): { settled: boolean; attribution: string | null } {
		return this.#archiveMode ? this.archive : this.live;
	}

	update(mode: ClockMode, time: number): void {
		const archive = mode === 'replay';
		if (archive !== this.#archiveMode) {
			this.live.stop();
			this.archive.stop();
			this.#archiveMode = archive;
		}
		if (!this.clouds.visible) return;
		if (archive) this.archive.setTime(time);
		else this.live.start();
	}

	dispose(): void {
		this.live.stop();
		this.archive.stop();
	}
}
