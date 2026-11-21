import { cloudOpacityGlsl } from '../clouds/clouds.glsl';
import { cloudScreenGlsl, volumeFieldGlsl } from '../clouds/field.glsl';
import { CHANNEL, channelGlsl } from './channel';
import { densityGlsl } from './density';
import { intensityGlsl } from './intensity';
import { playbackGlsl } from './playback';
import { flashProfileGlsl, glslFloat as f, PROFILE } from './profile';
import { overlapToneGlsl, ribbonGlsl } from './ribbon';
import { segmentLightGlsl } from './segment.glsl';
import { VEIL, veilGlsl } from './veil';
import { zoomGlsl } from './zoom';

/**
 * One channel segment per instance, from the skeletons of `ChannelPool`, drawn as a screen-space ribbon. `halo` 0
 * draws the core, 1 the halo of a channel in clear air, 2 the light the drawn clouds scatter around a channel behind them.
 */
export const ribbonVertex = /* glsl */ `
attribute vec2 corner;
attribute vec4 segA;
attribute vec4 segB;
attribute vec4 segC;
attribute vec4 flash;
attribute vec4 flashShape;
attribute vec3 flashLook;
uniform float time;
uniform float poolShift;
uniform float duration;
uniform float flicker;
uniform float radius;
uniform float kmToWorld;
uniform vec2 viewport;
uniform float viewScale;
uniform float pixelRatio;
uniform float halo;
uniform float haloStrength;
uniform vec3 sunDirection;

varying vec2 vLocal;
varying float vLength;
varying vec2 vShare;
varying float vLight;
varying vec3 vTint;
varying float vKm;
varying float vScreen;
varying float vLeast;
varying float vSlant;

${playbackGlsl}
${channelGlsl}
${flashProfileGlsl}
${intensityGlsl}
${zoomGlsl}
${veilGlsl}
${ribbonGlsl}
#ifdef CLOUDS
${cloudOpacityGlsl}
#endif
#ifdef VOLUME
${volumeFieldGlsl}
#endif
${densityGlsl}
${segmentLightGlsl}
void cull() {
	gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
}

#ifdef VOLUME
// The lift under the drawn top over a point of the path (km east and north of the flash), or under the flash's own where unknown there.
vec4 liftAt(vec3 p) {
	vec3 n = normalize(flash.xyz);
	vec3 e = abs(n.y) > 0.999 ? vec3(1.0, 0.0, 0.0) : normalize(cross(vec3(0.0, 1.0, 0.0), n));
	float top = cloudFitTopAt(n + (e * p.x + cross(n, e) * p.y) / 6371.0);
	if (top <= 0.0) top = cloudFitTopAt(n);
	return top > 0.0 ? reliefLift(top) : flatLift;
}
#endif

void main() {
	float seed = flashShape.w;
	int kind = int(flashLook.x + 0.5);
	bool ground = isGround(kind);
	bool branch = segC.z > 0.5;
	bool inCloud = segC.w > 0.5;
	bool trace = segC.w > 1.5;
	// Halos follow the main channel of ground flashes in clear air and the traces of in-cloud trunks; fainter paths keep a bare core.
	// The clouds scatter the light of main paths only: around every branch the glow would draw a web.
	if (segA.w <= 0.0 || (halo > 1.5 ? branch && segC.z < 3.5 : halo > 0.5 && !trace && (!ground || branch || inCloud))) {
		cull();
		return;
	}
	float at = flash.w + poolShift;
	float age = wallAge(time, at);
	float end = clamp(flashShape.z / 1000.0, ${f(PROFILE.minFlicker)}, ${f(PROFILE.maxFlicker)});
	// Leaders light the path as they go, then strokes light it again (docs/flash-profile.md, "Timing").
	vec2 timing = flashLook.yz;
	float reached = flicker < 0.5 ? 1.0 : spread(age, timing, kind);
	float grown = clamp((reached - segC.x) / max(segC.y - segC.x, 1e-4), 0.0, 1.0);
	if (grown < 0.001) {
		cull();
		return;
	}
	// Only the sample drawn in full at this replay speed gets a channel.
	float hero = heroWeight(heroLot(seed, flashShape.x, ground), heroShare);
	if (hero <= 0.0) {
		cull();
		return;
	}
	vec3 normal = normalize(mat3(modelMatrix) * flash.xyz);
	vec3 base = (modelMatrix * vec4(flash.xyz * radius, 1.0)).xyz;
	float facing = dot(normal, normalize(cameraPosition - base));
	float distance = length(cameraPosition - base);
	float kmPerPx = distance / (projectionMatrix[1][1] * viewport.y) / kmToWorld;
	// Channels facing away, past the storm view's budget, faded out or too small to read skip the profile.
	float shown = hero * smoothstep(0.0, 0.1, facing) * onScreen(at) * (1.0 - smoothstep(end, end + ${f(CHANNEL.fade)}, age)) * channelReveal(flashShape.y, kmPerPx);
	if (shown <= 0.0) {
		cull();
		return;
	}
	float light = segmentLight(age, at, seed, kind, reached) * shown;
	if (halo > 0.5) light *= haloStrength * (1.0 - smoothstep(${f(CHANNEL.haloFadeStartKm)}, ${f(CHANNEL.haloFadeEndKm)}, distance / kmToWorld));
	light *= mix(1.0, ${f(CHANNEL.dayLevel)}, smoothstep(-0.05, 0.25, dot(normal, normalize(sunDirection))));
	if (light < 0.002) {
		cull();
		return;
	}
	vec3 east = abs(normal.y) > 0.999 ? vec3(1.0, 0.0, 0.0) : normalize(cross(vec3(0.0, 1.0, 0.0), normal));
	vec3 north = cross(normal, east);
	mat3 frame = mat3(east, north, normal) * kmToWorld;
	float width = segA.w;
	// Channels follow the drawn top where the clouds are in relief, at each end of each segment: their part in the
	// cloud ends just under it while a drop under the base keeps its height.
	vec4 liftA = flatLift;
	vec4 liftB = flatLift;
#ifdef VOLUME
	liftA = liftAt(segA.xyz);
	liftB = liftAt(segB.xyz);
#endif
	vec3 a = liftPoint(segA.xyz, liftA);
	vec3 whole = liftPoint(segB.xyz, liftB);
	vec3 mid = 0.5 * (a + whole);
	// The cloud where the line of sight leaves it veils a channel inside it and dims one below it to a trace.
	float opacity = inCloud ? ${f(VEIL.fallback)} : 0.0;
	float slant = 1.0;
	// Share of the veil left to the clouds as drawn on screen, pixel by pixel: where the volume draws them.
	float screen = 0.0;
#ifdef CLOUDS
	if (cloudShown > 0.5) {
		vec3 crossing = cloudCrossing(base + frame * mid, cameraPosition);
		slant = dot(normalize(crossing), normalize(cameraPosition - crossing));
		opacity = cloudOpacityAt(crossing);
#ifdef VOLUME
		// Where the volume draws the clouds, its lighter veil dims the channel (ADR 0031).
		float known = cloudKnownAt(crossing);
		if (known > 0.0) opacity = mix(opacity, veilOpacity(volumeSample(volumeField, volumeLatLon(crossing)).r), known);
		screen = known;
#endif
	}
#endif
	if (halo > 1.5) {
		if (screen <= 0.0) {
			cull();
			return;
		}
		width = clamp(${f(VEIL.scatterKm)} / kmPerPx, ${f(VEIL.scatterPx[0])}, ${f(VEIL.scatterPx[1])});
		// Dim paths, the glow of leaders between pulses, scatter nothing to speak of.
		light *= screen * smoothstep(0.0, ${f(VEIL.scatterFrom)}, light);
	} else if (inCloud) {
		// Slightly transparent from above; at a slant the cloud crossed toward the eye veils and spreads it (ADR 0035).
		vec2 seen = seenThrough(opacity, slant);
		vec2 veiled = cloudVeil(seen.x, 0.5 * (segA.z + segB.z), kmPerPx / seen.y, width, segC.w);
		if (!trace) light *= veilOverlap(length(segB.xyz - segA.xyz) / kmPerPx, width, veiled.x);
		// On screen the cloud dims it; here it only spreads it.
		light *= mix(veiled.y, width / veiled.x, screen);
		// A trace's halo is sized from its core width, not from the width the cloud spreads it to.
		if (halo < 0.5 || !trace) width = veiled.x;
	} else {
		light *= mix(clearAirLight(opacity * mix(${f(VEIL.through)}, 1.0, grazingShare(slant)), slant), 1.0, screen);
	}
	// Hairlines draw no thinner than the pixel grid renders evenly and give up light instead, so they never break into dashes.
	vec2 thin = halo > 1.5 ? vec2(width, 1.0) : hairline(width, pixelRatio * viewScale);
	width = thin.x;
	light *= thin.y;
	if (light < 0.002) {
		cull();
		return;
	}
	vec3 b = mix(a, whole, grown);
	vec4 ca = projectionMatrix * viewMatrix * vec4(base + frame * a, 1.0);
	vec4 cb = projectionMatrix * viewMatrix * vec4(base + frame * b, 1.0);
	vec2 sa = ca.xy / ca.w * viewport;
	vec2 sb = cb.xy / cb.w * viewport;
	vec2 t = sb - sa;
	t = dot(t, t) > 1e-8 ? normalize(t) : vec2(1.0, 0.0);
	vec4 c = corner.x > 0.5 ? cb : ca;
	float w = width * (halo > 0.5 && halo < 1.5 ? 8.0 : 1.0);
	// Halos round off their ends; cores overlap half a width at each joint and cross-fade there, so they never bead.
	float cap = halo > 0.5 ? 1.0 : 0.5;
	float along = corner.x > 0.5 ? cap : -cap;
	c.xy += (vec2(-t.y, t.x) * corner.y + t * along) * w / viewport * c.w;
	gl_Position = c;
	vLength = length(sb - sa) / w;
	// Each segment's cross-fade adds up to its length, then gets back the light overlapping segments used to add, by its
	// unforeshortened span: on screen and in the bloom's linear buffer.
	vShare = lengthShare(vLength) * overlapGain(length((segB.xyz - segA.xyz) * liftA.xyz) / kmPerPx / w);
	vLocal = vec2(corner.x > 0.5 ? vLength + cap : -cap, corner.y);
	vLight = light;
	// The light around a channel leans cool; its core stays white. Rose and warm tints are dust and distance, seen from the ground.
	vTint = vec3(0.86, 0.9, 1.0);
	vKm = length(cameraPosition - (base + frame * (corner.x > 0.5 ? b : a))) / kmToWorld;
	vScreen = screen;
	vLeast = inCloud ? ${f(VEIL.behindMin)} : ${f(VEIL.trace)};
	vSlant = slantShare(slant);
}
`;

export const ribbonFragment = /* glsl */ `
uniform vec3 color;
uniform float exposure;
uniform float halo;

varying vec2 vLocal;
varying float vLength;
varying vec2 vShare;
varying float vLight;
varying vec3 vTint;
varying float vKm;
varying float vScreen;
varying float vLeast;
varying float vSlant;
${overlapToneGlsl}
${veilGlsl}
#ifdef VOLUME
${cloudScreenGlsl(f(VEIL.hideRate))}
uniform vec2 targetSize;
#endif
void main() {
	float light;
	float fade = 1.0;
	if (halo > 0.5) {
		vec2 d = vec2(vLocal.x - clamp(vLocal.x, 0.0, vLength), vLocal.y);
		float x2 = min(dot(d, d), 1.0);
		light = (halo > 1.5 ? 1.0 : 0.3) * exp(-x2 * 5.0) * (1.0 - x2);
	} else {
		float y2 = min(vLocal.y * vLocal.y, 1.0);
		light = exp(-y2 * 3.0) * (1.0 - y2);
		// The cross-fade splits the screen value, after the conversion below, so the two quads at a joint add up to one
		// instead of beading.
		fade = clamp(vLocal.x + 0.5, 0.0, 1.0) * clamp(vLength + 0.5 - vLocal.x, 0.0, 1.0);
	}
	// Behind the clouds as drawn, the core dims with depth, its clear air halo goes and the cloud glows around it.
	float veil = halo > 1.5 ? 0.0 : 1.0;
#ifdef VOLUME
	if (vScreen > 0.0) {
		vec2 front = cloudFront(gl_FragCoord.xy / targetSize, vKm);
		float hidden = front.x * vScreen;
		veil = halo > 1.5 ? scatterLight(front.x, front.y, vSlant) : halo > 0.5 ? 1.0 - hidden : behindLight(hidden, front.y, vLeast) * slantCore(hidden, vSlant);
	}
#endif
	vec3 hue = halo > 1.5 ? color : halo > 0.5 ? color * vTint : mix(vec3(1.0), color, 0.5);
	gl_FragColor = vec4(hue * exposure * vLight * light * veil, 1.0);
	#include <tonemapping_fragment>
	vec3 value = gl_FragColor.rgb;
	#include <colorspace_fragment>
	// On screen the overlap light follows the tone, as the old conversion of each quad did; the bloom's buffer is linear.
	if (halo < 0.5) {
		bool screen = linearToOutputTexel(vec4(0.25)).r > 0.4;
		gl_FragColor.rgb *= fade * (screen ? mix(vec3(vShare.y), vec3(vShare.x), overlapTone(value)) : vec3(vShare.y));
	}
}
`;
