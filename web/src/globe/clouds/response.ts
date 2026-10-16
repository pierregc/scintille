/** Bound bytes while reading, including responses without a Content-Length header. */
export async function boundedBody(response: Response, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
	if (Number(response.headers.get('Content-Length')) > maxBytes) {
		await response.body?.cancel();
		throw new Error('cloud response too large');
	}
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) throw new Error('cloud response too large');
			chunks.push(value);
		}
	} catch (error) {
		await reader.cancel().catch(() => {});
		throw error;
	} finally { reader.releaseLock(); }
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
	return bytes;
}
