import cases from './replay/framing-cases.json';

export const REPLAY_FIXTURE_SLUG = '2026-07-15-orlando';

export function isReplayFixture(slug: string | null): boolean {
	return cases.some((item) => item.slug === slug);
}
