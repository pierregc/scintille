import { CHANNEL } from './channel';
import { FlashKind } from './kind';
import { glslFloat as f, PROFILE } from './profile';
import { SKELETON } from './skeleton';

/**
 * Light of a channel segment before the view dims it: leaders light the path as they go, then strokes light it
 * again (docs/flash-profile.md, "Timing"). Reads the segment and flash attributes; needs `flashProfileGlsl`.
 */
export const segmentLightGlsl = /* glsl */ `
float segmentLight(float age, float at, float seed, int kind, float reached) {
	bool ground = isGround(kind);
	bool branch = segC.z > 0.5;
	bool inCloud = segC.w > 0.5;
	vec2 timing = flashLook.yz;
	// The channel of a single stroke below the cloud leaves the in-cloud activity after it to the glow.
	vec4 profile = flashProfileStroke(age, time - at, duration, flashShape.z, seed, flicker, kind, timing, kind != ${FlashKind.CgSingle} || inCloud);

	bool contact = segC.z > 3.5;
	float lit = 1.0;
	// Branches die first: from the first stroke for ground flashes, from the leader's passage in the cloud, at once without flicker.
	if (branch && !contact) {
		float reachedAt = flicker < 0.5 ? 0.0 : ground ? timing.x : kind == ${FlashKind.IcCrawler} ? segC.x * timing.y : (1.0 - sqrt(1.0 - segC.x)) * timing.y;
		lit = exp(-max(age - reachedAt, 0.0) / (ground ? ${f(CHANNEL.branchTau)} : ${f(CHANNEL.cloudBranchTau)}));
	}
	if (flicker > 0.5) {
		// The least light a segment shows, whatever the glow: the dim leader, a dart down the trunk, the crawler's tip.
		float least = 0.0;
		// The first stroke lights the channel from the ground up; the leader holds the rest until it gets there.
		float swept = 1.0;
		if (ground) {
			vec3 stroke = profile.yzw;
			if (stroke.x < 0.0 || (stroke.x < 0.5 && stroke.y < ${f(PROFILE.strokeSweep)})) least = ${f(PROFILE.leaderLevel)};
			if (stroke.x >= 0.0 && stroke.x < 0.5) swept = step(min(segA.z, segB.z) / ${f(SKELETON.cloudTopKm)}, stroke.y / ${f(PROFILE.strokeSweep)});
			if (!branch && stroke.x >= 0.0 && stroke.z < ${f(PROFILE.dart)}) {
				float tip = 1.0 - stroke.z / ${f(PROFILE.dart)};
				least = max(least, ${f(PROFILE.dartLevel)} * step(segC.x, tip) * smoothstep(tip - ${f(PROFILE.dartTrail)}, tip, segC.y));
			}
			// A second ground contact lights from the stroke that takes it, or the last one if the flash ends first.
			if (contact) {
				float takes = pulseHash(seed, 96.0) < 0.2 ? 0.0 : 1.0 + floor(3.0 * pulseHash(seed, 97.0));
				if (!(stroke.x >= takes || (stroke.x >= 0.0 && stroke.z > 1e5))) lit = 0.0;
			}
		} else if (kind == ${FlashKind.IcCrawler}) {
			least = smoothstep(reached - ${f(PROFILE.crawlerTip)}, reached, segC.y) * (1.0 - smoothstep(0.95, 1.0, reached));
		}
		lit *= max(swept, least / max(profile.x, 1e-4));
	}
	return profile.x * intensityBrightness(flashShape.x) * lit * segB.w;
}
`;
