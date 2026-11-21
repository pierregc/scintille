/**
 * Counts the requests the page started in the last `windowMs`, from resource timing. Every host of
 * the zone shares one rate limit, so pages, textures and feeds all count.
 */
export function pagePressure(windowMs = 10_000): () => number {
	if (typeof PerformanceObserver === 'undefined' || typeof performance === 'undefined') return () => 0;
	let starts: number[] = [];
	const observer = new PerformanceObserver((list) => {
		for (const entry of list.getEntries()) starts.push(entry.startTime);
	});
	try {
		observer.observe({ type: 'resource', buffered: true });
	} catch {
		return () => 0;
	}
	return () => {
		const from = performance.now() - windowMs;
		starts = starts.filter((start) => start >= from);
		return starts.length;
	};
}
