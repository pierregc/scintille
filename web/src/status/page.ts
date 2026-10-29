import type { OpsMetrics } from '../contract/types';
import { formatDate, formatTime } from '../components/hud/format';
import { backoffDelay, DEFAULT_BACKOFF } from '../globe/live/client';
import { liveBaseUrl } from '../globe/live';
import { indexAt, niceMax, paths, SLOTS, type Frame } from './chart';
import { formatCount, parseMetrics, statusView, type Measure, type SourceView, type StatusView } from './metrics';

export const POLL_INTERVAL_MS = 60_000;
const W = 300;
const H = 64;
const SVG = 'http://www.w3.org/2000/svg';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text) node.textContent = text;
	return node;
}

function svg(tag: string, attrs: Record<string, string | number>): SVGElement {
	const node = document.createElementNS(SVG, tag);
	for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
	return node;
}

const VERDICT_TEXT = { met: 'within target', missed: 'outside target', unknown: 'not current' } as const;

function row(label: string, value: string, measure?: Measure): HTMLElement {
	const r = el('div', 'row');
	r.append(el('dt', '', label));
	const dd = el('dd');
	dd.append(el('span', 'value', value));
	if (measure) {
		const v = el('span', `verdict ${measure.verdict}`, `${measure.target} · ${VERDICT_TEXT[measure.verdict]}`);
		dd.append(v);
	}
	r.append(dd);
	return r;
}

function chart(s: SourceView, max: number): HTMLElement {
	const frame: Frame = { width: W, height: H, max };
	const { done, current } = paths(s.flashesPerMinute, frame);
	const figure = el('figure', 'chart');
	const plot = svg('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img' });
	plot.setAttribute('aria-label', `${s.label}: flashes per minute over the last hour`);
	plot.append(svg('line', { x1: 0, y1: H, x2: W, y2: H, class: 'base' }));
	if (done) plot.append(svg('path', { d: done, class: 'line' }));
	if (current) plot.append(svg('path', { d: current, class: 'line current' }));
	const cursor = svg('line', { x1: 0, y1: 0, x2: 0, y2: H, class: 'cursor', visibility: 'hidden' });
	plot.append(cursor);
	const tip = el('div', 'tip');
	tip.hidden = true;
	const axis = el('figcaption', 'axis');
	axis.append(el('span', '', '−60 min'), el('span', '', `max ${formatCount(max)} / min`), el('span', '', 'now'));
	const peak = Math.max(0, ...s.flashesPerMinute);
	const last = s.lastMinute === null ? 'no data' : formatCount(s.lastMinute);
	const summary = el('p', 'sr-only', `Last minute ${last}, peak ${formatCount(peak)} flashes per minute over the last hour.`);
	figure.append(plot, tip, axis, summary);

	const move = (clientX: number) => {
		const box = plot.getBoundingClientRect();
		const x = ((clientX - box.left) / box.width) * W;
		const i = indexAt(x, s.flashesPerMinute.length, W);
		if (i === null) return leave();
		const slotX = ((SLOTS - s.flashesPerMinute.length + i) / (SLOTS - 1)) * W;
		cursor.setAttribute('x1', String(slotX));
		cursor.setAttribute('x2', String(slotX));
		cursor.setAttribute('visibility', 'visible');
		const inProgress = i === s.flashesPerMinute.length - 1 ? ' · in progress' : '';
		tip.textContent = `${formatTime(s.seriesStartMs + i * 60_000).slice(0, 5)} · ${formatCount(s.flashesPerMinute[i] ?? 0)}${inProgress}`;
		const at = slotX / W;
		tip.style.left = `${at * 100}%`;
		tip.style.transform = `translateX(${at < 0.2 ? 0 : at > 0.8 ? -100 : -50}%)`;
		tip.hidden = false;
	};
	const leave = () => {
		cursor.setAttribute('visibility', 'hidden');
		tip.hidden = true;
	};
	plot.addEventListener('pointermove', (e) => move(e.clientX));
	plot.addEventListener('pointerdown', (e) => move(e.clientX));
	plot.addEventListener('pointerleave', leave);
	return figure;
}

function sourceBlock(s: SourceView, max: number): HTMLElement {
	const block = el('section', 'source');
	const head = el('header');
	head.append(el('h2', '', s.label));
	head.append(el('span', 'rate', s.lastMinute === null ? '—' : `${formatCount(s.lastMinute)} flashes / min`));
	const dl = el('dl');
	dl.append(
		row('Latency p50', s.latencyP50),
		row('Latency p95', s.latencyP95.text, s.latencyP95),
		row('Completeness, 1\u00a0h', s.completeness.text, s.completeness),
		row('Error budget, 30\u00a0d', s.errorBudget),
		row('Last file', s.lastFile),
	);
	dl.lastElementChild?.querySelector('.value')?.setAttribute('data-lastfile', s.source);
	block.append(head, chart(s, max), dl);
	return block;
}

function setText(node: Element, text: string): void {
	if (node.textContent !== text) node.textContent = text;
}

/** Patches text in place when the structure is unchanged, so values stay selectable. */
function sync(container: Element, next: Element): void {
	const current = container.firstElementChild;
	if (!current || current.outerHTML.replace(/>[^<]*</g, '><') !== next.outerHTML.replace(/>[^<]*</g, '><')) {
		container.replaceChildren(next);
		return;
	}
	const a = current.querySelectorAll('*');
	const b = next.querySelectorAll('*');
	b.forEach((node, i) => {
		const target = a[i];
		if (target && node.childElementCount === 0) setText(target, node.textContent ?? '');
	});
}

/** Rebuilds the source blocks only when `full`, so a tick keeps the chart hover in place. */
function render(root: HTMLElement, view: StatusView, full: boolean): void {
	const q = <T extends Element>(sel: string) => root.querySelector<T>(sel) as T;
	root.dataset.stale = String(view.stale);
	setText(q('[data-state]'), view.state);
	setText(
		q('[data-asof]'),
		view.generatedAtMs === null ? '' : `as of ${formatDate(view.generatedAtMs)} ${formatTime(view.generatedAtMs)}`,
	);
	const banner = q<HTMLElement>('[data-banner]');
	setText(banner, view.banner);
	banner.hidden = view.banner === '';

	if (full) {
		// One axis per source: MTG LI arrives in 10 minute bursts that would flatten the GLM charts.
		q('[data-sources]').replaceChildren(
			...view.sources.map((s) => sourceBlock(s, niceMax(Math.max(0, ...s.flashesPerMinute)))),
		);
	} else {
		for (const s of view.sources) {
			const node = root.querySelector(`[data-lastfile="${s.source}"]`);
			if (node) setText(node, s.lastFile);
		}
	}

	const freshness = el('dl');
	freshness.append(...view.freshness.map((l) => row(l.label, l.measure.text, l.measure)));
	sync(q('[data-freshness]'), freshness);

	const quality = el('dl');
	if (view.generatedAtMs !== null) {
		quality.append(row('Status', view.quality.text), row('Last run', view.quality.checkedAt));
		if (view.quality.failed.length) quality.append(row('Not passing', view.quality.failed.join(', ')));
	}
	sync(q('[data-quality]'), quality);

	const lake = el('dl');
	if (view.lake) {
		lake.append(
			row('Size', view.lake.size),
			row('Tables', view.lake.tables),
			row('Data files', view.lake.files),
			row('Rows', view.lake.rows),
			row('Measured', view.lake.measured.text, view.lake.measured),
		);
	}
	if (view.catalog) lake.append(row('Catalog ops, month', view.catalog.text), row('Free tier used', view.catalog.share));
	sync(q('[data-lake]'), lake);

	const storms = el('dl');
	if (view.storms) {
		storms.append(
			row('Detected', view.storms.detected),
			row('Published', view.storms.published),
			row('Highlighted', view.storms.highlighted),
			row('Updated', view.storms.measured.text, view.storms.measured),
		);
	}
	sync(q('[data-storms]'), storms);
}

/** Polls `live/metrics.json` and keeps the page in step; ages tick every second. */
export function startStatusPage(root: HTMLElement, url = new URL('live/metrics.json', liveBaseUrl()).href): () => void {
	let metrics: OpsMetrics | null = null;
	let loadedAt: number | null = null;
	let failures = 0;
	let poll: ReturnType<typeof setTimeout> | undefined;
	let lastJson = '';

	let drawn: { metrics: OpsMetrics | null; stale: boolean } | null = null;

	const draw = () => {
		const view = statusView(metrics, loadedAt, Date.now(), failures > 0);
		const full = drawn?.metrics !== metrics || drawn.stale !== view.stale;
		render(root, view, full);
		drawn = { metrics, stale: view.stale };
	};

	const load = async () => {
		clearTimeout(poll);
		try {
			const res = await fetch(url, { cache: 'no-store' });
			if (!res.ok) throw new Error(`metrics: HTTP ${res.status}`);
			const text = await res.text();
			const parsed = parseMetrics(JSON.parse(text));
			if (text !== lastJson) {
				metrics = parsed;
				loadedAt = Date.now();
				lastJson = text;
			}
			failures = 0;
		} catch (error) {
			failures += 1;
			console.warn('status:', error);
		}
		draw();
		if (document.hidden) return;
		const delay = failures ? backoffDelay(failures, DEFAULT_BACKOFF, Math.random) : POLL_INTERVAL_MS;
		poll = setTimeout(load, delay);
	};

	const tick = setInterval(() => {
		if (metrics && !document.hidden) draw();
	}, 1000);
	const onVisible = () => {
		if (!document.hidden) void load();
	};
	document.addEventListener('visibilitychange', onVisible);
	draw();
	void load();
	return () => {
		clearTimeout(poll);
		clearInterval(tick);
		document.removeEventListener('visibilitychange', onVisible);
	};
}
