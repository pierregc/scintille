import { type FlashRing, NO_DELAY, type SourceDelays } from '../live';
import { CHANNEL, channelHash } from './channel';
import { FlashPlayback } from './playback';
import { flickerLength, PROFILE } from './profile';

export const CHANNEL_STRIDE = 8;
export const CHANNEL_CAPACITY = 2048;

/** Compact, bounded window of flashes whose channels are still visible. */
export class ChannelInstances {
	readonly data: Float32Array;
	count = 0;

	constructor(readonly ring: FlashRing, readonly capacity = CHANNEL_CAPACITY) {
		if (!Number.isInteger(capacity) || capacity <= 0) throw new RangeError(`bad capacity ${capacity}`);
		this.data = new Float32Array(capacity * CHANNEL_STRIDE);
	}

	sync(sceneTime: number, origin: number, playback = new FlashPlayback(), delays: SourceDelays = NO_DELAY): void {
		const ring = this.ring;
		const cutoff = sceneTime - playback.span(PROFILE.maxFlicker + CHANNEL.fade, sceneTime) - delays.max;
		let lo = 0;
		let hi = ring.size;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (ring.time[ring.slot(mid)] < cutoff) lo = mid + 1;
			else hi = mid;
		}
		this.count = 0;
		for (let i = lo; i < ring.size; i++) {
			const s = ring.slot(i);
			if (ring.time[s] > sceneTime - delays.min) break;
			const playsAt = ring.time[s] + delays.ms[ring.source[s]];
			if (playsAt > sceneTime) continue;
			const age = playback.age(playsAt, sceneTime);
			if (age >= flickerLength(ring.durationMs[s]) + CHANNEL.fade) continue;
			const lat = ring.lat[s] * Math.PI / 180;
			const lon = ring.lon[s] * Math.PI / 180;
			const o = (this.count % this.capacity) * CHANNEL_STRIDE;
			this.data[o] = Math.cos(lat) * Math.cos(lon);
			this.data[o + 1] = Math.sin(lat);
			this.data[o + 2] = -Math.cos(lat) * Math.sin(lon);
			this.data[o + 3] = (playsAt - origin) / 1000;
			this.data[o + 4] = ring.intensity[s];
			this.data[o + 5] = Math.max(3, Math.sqrt(ring.areaKm2[s] / Math.PI));
			this.data[o + 6] = ring.durationMs[s];
			this.data[o + 7] = channelHash(ring.time[s] % 86_400_000 + ring.lat[s] * 100 + ring.lon[s], 0);
			this.count++;
		}
		this.count = Math.min(this.count, this.capacity);
	}
}
