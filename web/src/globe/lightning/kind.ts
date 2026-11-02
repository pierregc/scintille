/**
 * The seven procedural looks a flash can be drawn in: a rendering choice drawn from its seed, never a
 * satellite classification (ADR 0033). The rest of the kind API is in channel.ts; this module imports
 * nothing so profile.ts can read the kind.
 */
export const enum FlashKind {
	/** Negative cloud-to-ground, several strokes down one channel. */
	CgMulti = 0,
	/** Negative cloud-to-ground, one stroke. */
	CgSingle = 1,
	/** Positive cloud-to-ground from the anvil: oblique, far from the core, a long continuing current. */
	CgPositive = 2,
	/** Bolt from the blue: leaves the cloud side and strikes far away. */
	BoltFromBlue = 3,
	/** In-cloud: an oblique trunk, then fans spreading under the anvil. */
	IcTrunkFan = 4,
	/** In-cloud crawler along the cloud base: the long or large flashes, steady and slow. */
	IcCrawler = 5,
	/** In-cloud fan with a branch poking out into clear air. */
	CloudToAir = 6,
}

/** Cloud-to-ground kinds strike the ground; the others stay in the cloud. */
export function isGround(kind: FlashKind): boolean {
	return kind <= FlashKind.BoltFromBlue;
}
