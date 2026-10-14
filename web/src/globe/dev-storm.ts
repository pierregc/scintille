import type { SceneData } from './archive';
import type { GlobeControls } from './controls';

export const REPLAY_FIXTURE_SLUG = '2026-07-15-orlando';

/** Fixture-only entry for checking the loader on dev and Preview builds. */
export async function runDevStorm(
	data: Pick<SceneData, 'openStorm'>,
	flyTo: GlobeControls['flyTo'],
	search: string,
	baseUrl: string,
): Promise<boolean> {
	const params = new URLSearchParams(search);
	if (params.get('storm') !== REPLAY_FIXTURE_SLUG) return false;
	const requested = Number(params.get('speed') ?? 1);
	const speed = Number.isFinite(requested) && requested > 0 ? requested : 1;
	const detail = await data.openStorm(baseUrl, REPLAY_FIXTURE_SLUG, speed);
	if (!detail) return false;
	await flyTo({ lat: 28.5, lon: -81.3, altitude: 2000, duration: 0 });
	return true;
}
