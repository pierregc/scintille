import type { Clouds } from './index';

type KeyLike = Pick<KeyboardEvent, 'key' | 'repeat' | 'altKey' | 'ctrlKey' | 'metaKey' | 'target'>;

/** True for a bare `c` press outside text fields. */
export function isCloudToggleKey(event: KeyLike): boolean {
	if (event.key !== 'c' || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return false;
	const target = event.target as Partial<HTMLElement> | null;
	const tag = target?.tagName;
	return !(tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable);
}

/** Dev only: toggles clouds with `c`. */
export function attachDevClouds(clouds: Clouds, target: Pick<Window, 'addEventListener' | 'removeEventListener'>) {
	const onKey = (event: KeyboardEvent) => {
		if (isCloudToggleKey(event)) clouds.setVisible(!clouds.visible);
	};
	target.addEventListener('keydown', onKey);
	return () => target.removeEventListener('keydown', onKey);
}
