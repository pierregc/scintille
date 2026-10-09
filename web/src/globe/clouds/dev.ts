import { cloudFixtureUrl, CLOUD_FIXTURE, loadCloudFrame } from './frame';
import type { Clouds } from './index';

type KeyLike = Pick<KeyboardEvent, 'key' | 'repeat' | 'altKey' | 'ctrlKey' | 'metaKey' | 'target'>;

/** True for a bare `c` press outside text fields. */
export function isCloudToggleKey(event: KeyLike): boolean {
	if (event.key !== 'c' || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return false;
	const target = event.target as Partial<HTMLElement> | null;
	const tag = target?.tagName;
	return !(tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable);
}

/** Dev only, until ingestion (#61) and the HUD (#56): loads the fixture frame and toggles clouds with `c`. */
export function attachDevClouds(clouds: Clouds, target: Pick<Window, 'addEventListener' | 'removeEventListener'>) {
	void loadCloudFrame(cloudFixtureUrl(), CLOUD_FIXTURE.time).then(
		(frame) => clouds.setFrame(frame),
		(error: unknown) => console.warn('cloud fixture (run python3 fixtures/serve.py):', error),
	);
	const onKey = (event: KeyboardEvent) => {
		if (isCloudToggleKey(event)) clouds.setVisible(!clouds.visible);
	};
	target.addEventListener('keydown', onKey);
	return () => target.removeEventListener('keydown', onKey);
}
