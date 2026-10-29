// Layout of the surface tile pyramid (ADR 0022), shared by the build, the check and the upload.

/** 90° × 90° source tiles at 15 arc seconds (463 m at the equator): columns A to D from 180° W, rows 1 and 2 from the north pole. */
export const SOURCE_PX = 21600;
export const COLUMNS = ['A', 'B', 'C', 'D'];
export const ROWS = ['1', '2'];

/** Tile content in texels, plus one border texel on each side copied from the neighbours. */
export const TILE = 450;
export const BORDER = 1;
export const MAX_LEVEL = 5;
export const LEVELS = [2, 3, 4, 5];

export const LAYERS = {
	day: { levels: [2, 3, 4, 5], mask: true, encoding: 'WebP q85 sRGB, alpha = water mask (255 water, 0 land, lossless), colour kept under it' },
	night: { levels: [2, 3, 4], mask: false, encoding: 'WebP q85 sRGB' },
};

export const PATH = '{layer}/{z}/{x}-{y}.webp';

export const columns = (z) => (4 * SOURCE_PX) / TILE / 2 ** (MAX_LEVEL - z);
export const rows = (z) => columns(z) / 2;
export const tilePath = (layer, z, x, y) => PATH.replace('{layer}', layer).replace('{z}', z).replace('{x}', x).replace('{y}', y);

/** Version of the published pyramid: tiles and manifest live under `textures/v<version>/` on R2. */
export const SURFACE_VERSION = 3;
