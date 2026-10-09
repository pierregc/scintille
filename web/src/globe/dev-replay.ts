import type { SceneClock } from './clock';

/** Dev only: `?replay=<ISO 8601 UTC>&speed=<n>` replays the scene clock, e.g. over the fixture hour. */
export function applyDevReplay(clock: SceneClock, search: string): void {
	const params = new URLSearchParams(search);
	const start = Date.parse(params.get('replay') ?? '');
	if (Number.isNaN(start)) return;
	const speed = Number(params.get('speed') ?? 1);
	clock.replay(start, Number.isFinite(speed) && speed > 0 ? speed : 1);
}
