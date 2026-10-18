import { PerspectiveCamera, Vector3 } from 'three';
import type { StormSearchRecord } from '../../contract/types';
import { latLonToVector } from '../sun';

export function projectMarker(lat: number, lon: number, camera: PerspectiveCamera) {
	const point = new Vector3(...latLonToVector(lat, lon));
	if (point.dot(camera.position) <= 1) return null;
	const projected = point.project(camera);
	return Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1 && projected.z > -1 && projected.z < 1 ? projected : null;
}

export function createDiscovery(canvas: HTMLCanvasElement, camera: PerspectiveCamera, resize: () => void) {
	const layer = document.createElement('div');
	layer.className = 'storm-markers';
	layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:1';
	document.body.append(layer);
	let down: { x: number; y: number; id: number } | null = null;
	const listeners = new AbortController();
	window.addEventListener('pointerdown', event => { if (!event.isPrimary) down = null; }, { capture: true, signal: listeners.signal });
	window.addEventListener('pointermove', event => { if (down && down.id === event.pointerId && Math.hypot(event.clientX - down.x, event.clientY - down.y) >= 6) down = null; }, { capture: true, signal: listeners.signal });
	window.addEventListener('pointercancel', () => { down = null; }, { capture: true, signal: listeners.signal });
	window.addEventListener('pointerup', () => { down = null; }, { signal: listeners.signal });
	let visible = false;
	let results: readonly StormSearchRecord[] = [];
	let onSelect: (slug: string) => void = () => {};
	let onGroup: (slugs: string[]) => void = () => {};
	let nodes: HTMLButtonElement[] = [];
	const setResults = (next: readonly StormSearchRecord[]) => {
		results = next.slice(0, 20);
		layer.replaceChildren();
		nodes = results.map((storm, index) => {
			const button = document.createElement('button');
			button.type = 'button';
			button.textContent = String(index + 1);
			button.title = storm.label;
			button.setAttribute('aria-label', `Replay ${storm.label}`);
			button.tabIndex = -1;
			button.style.cssText = 'position:absolute;width:44px;height:44px;border:0;border-radius:50%;background:radial-gradient(circle,rgba(8,16,24,.85) 0 10px,rgba(220,229,237,.6) 10px 11px,transparent 12px);color:#dce5ed;font:12px monospace;pointer-events:auto;touch-action:none;transform:translate(-50%,-50%);cursor:pointer';
			button.addEventListener('pointerdown', e => { e.stopPropagation(); down = e.isPrimary ? { x: e.clientX, y: e.clientY, id: e.pointerId } : null; });
			button.addEventListener('pointercancel', () => { down = null; });
			button.addEventListener('pointerup', e => {
				e.stopPropagation();
				if (down && down.id === e.pointerId && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6) {
					const group = JSON.parse(button.dataset.group ?? '[]') as string[];
					if (group.length > 1) onGroup(group); else onSelect(storm.slug);
				}
				down = null;
			});
			layer.append(button);
			return button;
		});
	};
	const setVisible = (value: boolean) => {
		down = null;
		visible = value;
		layer.hidden = !value;
		document.documentElement.classList.toggle('storm-browser-open', value);
		// Force layout before replay framing reads camera.aspect.
		resize();
	};
	return {
		setResults, setVisible,
		onSelect(callback: typeof onSelect) { onSelect = callback; },
		onGroup(callback: typeof onGroup) { onGroup = callback; },
		highlight(slug: string | null) { nodes.forEach((node, i) => { node.style.color = results[i].slug === slug ? '#fff4bb' : '#dce5ed'; node.style.fontWeight = results[i].slug === slug ? 'bold' : 'normal'; }); },
		update() {
			if (!visible) return;
			camera.updateMatrixWorld();
			const rect = canvas.getBoundingClientRect();
			const placed: { x: number; y: number; node: HTMLButtonElement; slugs: string[] }[] = [];
			results.forEach((storm, i) => {
				const node = nodes[i];
				const point = projectMarker(storm.marker.lat, storm.marker.lon, camera);
				node.hidden = !point;
				if (!point) return;
				const x = rect.left + (point.x + 1) * rect.width / 2, y = rect.top + (1 - point.y) * rect.height / 2;
				// Leave the existing clock and timeline their HUD space.
				if (y < rect.top + (rect.width <= 640 ? 90 : 120) || y > rect.bottom - (rect.width <= 640 ? 100 : 160)) { node.hidden = true; return; }
				const overlap = placed.find(p => Math.hypot(p.x - x, p.y - y) < 44);
				if (overlap) { overlap.slugs.push(storm.slug); overlap.node.textContent = `${overlap.slugs.length} ·`; overlap.node.dataset.group = JSON.stringify(overlap.slugs); node.hidden = true; return; }
				node.textContent = String(i + 1);
				node.dataset.group = JSON.stringify([storm.slug]);
				node.style.left = `${x}px`; node.style.top = `${y}px`;
				placed.push({ x, y, node, slugs: [storm.slug] });
			});
		},
		dispose() { listeners.abort(); setVisible(false); layer.remove(); nodes = []; results = []; },
	};
}
export type Discovery = ReturnType<typeof createDiscovery>;
