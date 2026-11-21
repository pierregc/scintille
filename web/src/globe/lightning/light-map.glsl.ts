import { CHANNEL, channelGlsl, cloudDriftGlsl } from './channel';
import { CLOUD_LIGHT, cloudPatchGlsl, patchEdgeGlsl } from './cloud-light';
import { densityGlsl } from './density';
import { intensityGlsl } from './intensity';
import { playbackGlsl } from './playback';
import { flashProfileGlsl, glslFloat as f, PROFILE } from './profile';
import { segmentLightGlsl } from './segment.glsl';
import { zoomGlsl } from './zoom';

/** Splats each flash as a soft, seeded patch in a point sprite over an equirectangular window of the globe, in SphereGeometry UV angles. */
export const lightMapVertexShader = /* glsl */ `
attribute vec4 flash;
attribute vec4 flashShape;
attribute vec3 flashLook;

uniform float time;
uniform float duration;
uniform float flicker;
uniform vec4 window;
uniform float splat;
uniform float level;
uniform float spreadKm;
uniform float minSplatKm;
uniform float wrap;
uniform vec2 mapSize;
uniform float fieldLevel;
uniform float calm;
uniform float channelGlow;
uniform float viewKmPerPx;

varying vec2 vScale;
varying float vBrightness;
varying vec4 vPatch;
varying vec4 vLobes;

${playbackGlsl}
${channelGlsl}
${flashProfileGlsl}
${intensityGlsl}
${cloudDriftGlsl}
${zoomGlsl}
${patchEdgeGlsl}
${cloudPatchGlsl}
${densityGlsl}
void main() {
	float sceneAge = time - flash.w;
	if (sceneAge < 0.0) {
		gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
		return;
	}
	vec3 d = normalize(flash.xyz);
	float seed = flashShape.w;
	int kind = int(flashLook.x + 0.5);
	float age = wallAge(time, flash.w);
	float lat = asin(clamp(d.y, -1.0, 1.0));
	vec2 drift = cloudDrift(age, flashShape.y, seed, kind, flashLook.yz) / 6371.0 * flicker;
	lat += drift.y;
	float lon = atan(-d.z, d.x) + drift.x / max(cos(lat), 0.05);
	float relative = mod(lon - window.x + 3.14159265, 6.28318531) - 3.14159265;
	// Flashes near the antimeridian of the window are drawn a second time on the other side.
	relative += wrap * (relative > 0.0 ? -6.28318531 : 6.28318531);
	vec2 center = vec2(relative, lat - window.y) / window.zw;
	// Flashes outside the window or past the storm view's budget skip the profile.
	float shown = abs(center.x) < 1.2 && abs(center.y) < 1.2 ? onScreen(flash.w) : 0.0;
	// Outside the sample drawn in full, a crowded storm view lights the cloud in soft fades, exposed down with the load.
	float hero = heroWeight(heroLot(seed, flashShape.x, isGround(kind)), heroShare);
	float lively = hero <= 0.0 && pulseHash(seed, 201.0) < calm ? 0.0 : flicker;
	float pulse = shown > 0.0 ? flashProfile(age, sceneAge, duration, flashShape.z, seed, lively, kind, flashLook.yz, true) : 0.0;
	float brightness = pulse * intensityBrightness(flashShape.x) * shown * mix(fieldLevel, 1.0, hero);
	// Where its channel lights the cloud along its path, the footprint keeps a share.
	brightness *= 1.0 - ${f(CLOUD_LIGHT.channelDip)} * hero * channelGlow * channelReveal(flashShape.y, viewKmPerPx);
	if (brightness <= 0.0) {
		gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
		return;
	}
	// The whole footprint lights on the flash's pulses, whatever its energy, a smaller patch between them, where the light has drifted; reduced motion keeps the footprint.
	float full = mix(1.0, smoothstep(${f(CLOUD_LIGHT.fullFrom)}, ${f(CLOUD_LIGHT.fullTo)}, pulse), lively);
	float footprint = flashShape.y * splat * mix(${f(CLOUD_LIGHT.dimSplat)}, 1.0, full);
	float radiusKm = max(max(footprint, spreadKm), minSplatKm);
	float radius = radiusKm / 6371.0;
	vec2 pixels = vec2(radius / max(cos(lat), 0.05), radius) / window.zw * mapSize * 0.5;
	gl_PointSize = 2.0 * max(pixels.x, pixels.y);
	gl_Position = vec4(center, 0.0, 1.0);
	vScale = gl_PointSize * 0.5 / pixels;
	vBrightness = brightness * level;
	// An elongated, irregular patch along the drift or the ground channel's feed, within the same radius; round where the splat floor sets the size.
	float own = footprint / max(radiusKm, 1e-6);
	vLobes = patchLobes(seed, own);
	vPatch = cloudPatch(seed, own, vLobes);
}
`;

export const lightMapFragmentShader = /* glsl */ `
varying vec2 vScale;
varying float vBrightness;
varying vec4 vPatch;
varying vec4 vLobes;

${patchEdgeGlsl}
void main() {
	// East and north in splat radii (gl_PointCoord runs south), then along and across the patch.
	vec2 corner = (gl_PointCoord * 2.0 - 1.0) * vec2(1.0, -1.0) * vScale;
	vec2 p = vec2(dot(corner, vPatch.xy), dot(corner, vec2(-vPatch.y, vPatch.x)) * vPatch.z);
	float r2 = dot(p, p);
	if (r2 > 0.0) {
		float edge = patchEdge(atan(p.y, p.x), vLobes) * vPatch.w;
		r2 /= edge * edge;
	}
	if (r2 > 1.0) discard;
	gl_FragColor = vec4(vec3(vBrightness * exp(-r2 * 4.0) * (1.0 - r2)), 1.0);
}
`;

/**
 * Channel segments of the flashes drawn in full, splatted into the fine light map as soft tubes: the cloud
 * lights along the path of its lightning. Same instances as the ribbons.
 */
export const channelLightVertexShader = /* glsl */ `
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
uniform vec4 window;
uniform float level;
uniform vec2 mapSize;
uniform float viewKmPerPx;

varying vec2 vLocal;
varying float vLength;
varying float vLight;

${playbackGlsl}
${channelGlsl}
${flashProfileGlsl}
${intensityGlsl}
${zoomGlsl}
${densityGlsl}
${segmentLightGlsl}
void main() {
	gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
	// Main paths only: branches would draw the cloud a web of lines.
	if (segA.w <= 0.0 || segC.z > 0.5) return;
	float seed = flashShape.w;
	int kind = int(flashLook.x + 0.5);
	float at = flash.w + poolShift;
	float age = wallAge(time, at);
	float end = clamp(flashShape.z / 1000.0, ${f(PROFILE.minFlicker)}, ${f(PROFILE.maxFlicker)});
	float reached = flicker < 0.5 ? 1.0 : spread(age, flashLook.yz, kind);
	float grown = clamp((reached - segC.x) / max(segC.y - segC.x, 1e-4), 0.0, 1.0);
	if (grown < 0.001) return;
	float shown = heroWeight(heroLot(seed, flashShape.x, isGround(kind)), heroShare) * onScreen(at)
		* (1.0 - smoothstep(end, end + ${f(CHANNEL.fade)}, age)) * channelReveal(flashShape.y, viewKmPerPx);
	if (shown <= 0.0) return;
	// A drop lights the cloud less the nearer the ground it runs.
	float light = segmentLight(age, at, seed, kind, reached) * shown * mix(${f(CLOUD_LIGHT.channelLowLevel)}, 1.0, smoothstep(0.0, ${f(CLOUD_LIGHT.channelLowKm)}, 0.5 * (segA.z + segB.z)));
	if (light < 0.002) return;
	vec3 d = normalize(flash.xyz);
	float lat = asin(clamp(d.y, -1.0, 1.0));
	float lon = mod(atan(-d.z, d.x) - window.x + 3.14159265, 6.28318531) - 3.14159265;
	// Km east and north to pixels of the map.
	vec2 px = mapSize * 0.5 / (window.zw * 6371.0) * vec2(1.0 / max(cos(lat), 0.05), 1.0);
	vec2 origin = vec2(lon, lat - window.y) / window.zw * mapSize * 0.5;
	vec2 sa = origin + segA.xy * px;
	vec2 sb = origin + mix(segA.xy, segB.xy, grown) * px;
	vec2 t = sb - sa;
	t = dot(t, t) > 1e-8 ? normalize(t) : vec2(1.0, 0.0);
	float w = max(${f(CLOUD_LIGHT.channelKm)} * px.y, 1.5);
	float along = corner.x > 0.5 ? 1.0 : -1.0;
	vec2 p = (corner.x > 0.5 ? sb : sa) + (vec2(-t.y, t.x) * corner.y + t * along) * w;
	gl_Position = vec4(p / (mapSize * 0.5), 0.0, 1.0);
	vLength = length(sb - sa) / w;
	vLocal = vec2(corner.x > 0.5 ? vLength + 1.0 : -1.0, corner.y);
	// A tube narrower than the map draws keeps its light, spread over the width drawn.
	vLight = light * level * ${f(CLOUD_LIGHT.channelLevel)} * min(1.0, ${f(CLOUD_LIGHT.channelKm)} * px.y / w);
}
`;

export const channelLightFragmentShader = /* glsl */ `
varying vec2 vLocal;
varying float vLength;
varying float vLight;

void main() {
	vec2 d = vec2(vLocal.x - clamp(vLocal.x, 0.0, vLength), vLocal.y);
	float x2 = min(dot(d, d), 1.0);
	gl_FragColor = vec4(vec3(vLight * exp(-x2 * 4.0) * (1.0 - x2)), 1.0);
}
`;

/**
 * Reads the flash light at an Earth UV: the fine map around the view where it reaches, the wide one elsewhere,
 * sharpened near the floor, zero outside the wide window, each fading over the edge of its window.
 */
export const flashLightGlsl = /* glsl */ `
uniform sampler2D flashLight;
uniform vec4 flashWindow;
uniform sampler2D flashLightNear;
uniform vec4 flashWindowNear;
uniform float flashNear;
// Sharper near the floor; the globe overview keeps its broad glow.
float sharpenFlashLight(float light) {
	return pow(light, mix(${f(CLOUD_LIGHT.sharpen)}, 1.0, clamp(flashWindow.w / 1.57079633, 0.0, 1.0)));
}
vec2 flashLocal(vec2 uv, vec4 window) {
	vec2 angle = vec2((uv.x - 0.5) * 6.28318531, (uv.y - 0.5) * 3.14159265);
	return vec2(mod(angle.x - window.x + 3.14159265, 6.28318531) - 3.14159265, angle.y - window.y) / window.zw;
}
float flashEdge(vec2 local, float from) {
	vec2 edge = 1.0 - smoothstep(from, 1.0, abs(local));
	return edge.x * edge.y;
}
float flashLightAt(vec2 uv) {
	vec2 local = flashLocal(uv, flashWindow);
	float light = textureLod(flashLight, local * 0.5 + 0.5, 0.0).r * flashEdge(local, 0.9);
	if (flashNear > 0.0) {
		vec2 near = flashLocal(uv, flashWindowNear);
		float w = flashEdge(near, ${f(CLOUD_LIGHT.nearEdge)}) * flashNear;
		if (w > 0.0) light = mix(light, textureLod(flashLightNear, near * 0.5 + 0.5, 0.0).r, w);
	}
	return sharpenFlashLight(light);
}
// The same name the loops use: neither read takes implicit gradients.
float flashLightAtLod(vec2 uv) {
	return flashLightAt(uv);
}
`;
