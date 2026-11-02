import { cloudOpacityGlsl } from '../clouds/clouds.glsl';
import { volumeFieldGlsl } from '../clouds/volume.glsl';
import { CHANNEL, channelGlsl } from './channel';
import { intensityGlsl } from './intensity';
import { playbackGlsl } from './playback';
import { flashProfileGlsl, glslFloat as f, PROFILE } from './profile';
import { SKELETON } from './skeleton';
import { VEIL, veilGlsl } from './veil';
import { zoomGlsl } from './zoom';

/** One channel segment per instance, from the skeletons of `ChannelPool`, drawn as a screen-space ribbon. */
export const ribbonVertex = /* glsl */ `
attribute vec2 corner;
attribute vec4 segA;
attribute vec4 segB;
attribute vec4 segC;
attribute vec4 flash;
attribute vec4 flashShape;
uniform float time;
uniform float poolShift;
uniform float duration;
uniform float flicker;
uniform float radius;
uniform float kmToWorld;
uniform vec2 viewport;
uniform float halo;
uniform float haloStrength;
uniform vec3 sunDirection;

varying vec2 vLocal;
varying float vLength;
varying float vLight;
varying vec3 vTint;

${playbackGlsl}
${channelGlsl}
${flashProfileGlsl}
${intensityGlsl}
${zoomGlsl}
${veilGlsl}
#ifdef CLOUDS
${cloudOpacityGlsl}
#endif
#ifdef VOLUME
${volumeFieldGlsl}
#endif

void cull() {
	gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
}

void main() {
	float seed = flashShape.w;
	int kind = flashKind(seed, flashShape.z, flashShape.y);
	bool ground = isGround(kind);
	bool branch = segC.z > 0.5;
	bool inCloud = segC.w > 0.5;
	// Halos follow the main channel of ground flashes in clear air only; fainter paths keep a bare core.
	if (segA.w <= 0.0 || (halo > 0.5 && (!ground || branch || inCloud))) {
		cull();
		return;
	}
	vec3 normal = normalize(mat3(modelMatrix) * flash.xyz);
	vec3 base = (modelMatrix * vec4(flash.xyz * radius, 1.0)).xyz;
	float at = flash.w + poolShift;
	float age = wallAge(time, at);
	float facing = dot(normal, normalize(cameraPosition - base));
	float distance = length(cameraPosition - base);
	float kmPerPx = distance / (projectionMatrix[1][1] * viewport.y) / kmToWorld;
	float brightness = flashProfile(age, time - at, duration, flashShape.z, seed, flicker, kind)
		* intensityBrightness(flashShape.x) * smoothstep(0.0, 0.1, facing) * onScreen(at);
	float end = clamp(flashShape.z / 1000.0, ${f(PROFILE.minFlicker)}, ${f(PROFILE.maxFlicker)});
	float fade = 1.0 - smoothstep(end, end + ${f(CHANNEL.fade)}, age);

	// Leaders light the path as they go: in-cloud ones crawl over the flash, ground ones drop at once.
	float reached = flicker < 0.5 ? 1.0 : ground ? spread(age, end, true) : ${f(CHANNEL.cloudStart)} + ${f(1 - CHANNEL.cloudStart)} * spread(age, end, false);
	float grown = clamp((reached - segC.x) / max(segC.y - segC.x, 1e-4), 0.0, 1.0);
	// Branches light once, when the leader reaches them; main channels light again with every pulse.
	float lit = 1.0;
	if (branch) {
		float q = clamp((segC.x - ${f(CHANNEL.cloudStart)}) / ${f(1 - CHANNEL.cloudStart)}, 0.0, 1.0);
		float reachedAt = ground ? 0.0 : (1.0 - sqrt(1.0 - q)) * ${f(PROFILE.cloudSpread)} * end;
		lit = exp(-max(age - reachedAt, 0.0) / (ground ? ${f(CHANNEL.branchTau)} : ${f(CHANNEL.cloudBranchTau)}));
	}
	float light = brightness * fade * lit * segB.w * channelReveal(flashShape.y, kmPerPx) * step(0.001, grown);
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
	// Channels stay under the observed top where the clouds are in relief (ADR 0028).
	vec3 lift = vec3(1.0);
#ifdef VOLUME
	float top = cloudTopAt(flash.xyz);
	if (top > 0.0) lift.z = clamp((top - 0.5) / ${f(SKELETON.cloudTopKm)}, 0.3, 1.0);
#endif
	vec3 mid = 0.5 * (segA.xyz + segB.xyz) * lift;
	// The cloud where the line of sight leaves it veils a channel inside it and hides one below it.
	float opacity = inCloud ? ${f(VEIL.fallback)} : 0.0;
	float slant = 1.0;
#ifdef CLOUDS
	if (cloudShown > 0.5) {
		vec3 crossing = cloudCrossing(base + frame * mid, cameraPosition);
		slant = dot(normalize(crossing), normalize(cameraPosition - crossing));
		opacity = cloudOpacityAt(crossing);
#ifdef VOLUME
		// Where the volume draws the clouds, its lighter veil dims the channel (ADR 0031).
		float known = cloudKnownAt(crossing);
		if (known > 0.0) opacity = mix(opacity, veilOpacity(volumeSample(volumeField, volumeLatLon(crossing)).r), known);
#endif
	}
#endif
	if (inCloud) {
		vec2 veiled = cloudVeil(opacity, mid.z, kmPerPx, width);
		width = veiled.x;
		light *= veiled.y;
	} else {
		light *= cloudTransmission(opacity, slant);
	}
	// Hairlines draw a pixel wide and give up light instead, so they never break into dashes.
	if (width < 0.75) {
		light *= width / 0.75;
		width = 0.75;
	}
	if (light < 0.002) {
		cull();
		return;
	}
	vec3 a = segA.xyz * lift;
	vec3 b = mix(a, segB.xyz * lift, grown);
	vec4 ca = projectionMatrix * viewMatrix * vec4(base + frame * a, 1.0);
	vec4 cb = projectionMatrix * viewMatrix * vec4(base + frame * b, 1.0);
	vec2 sa = ca.xy / ca.w * viewport;
	vec2 sb = cb.xy / cb.w * viewport;
	vec2 t = sb - sa;
	t = dot(t, t) > 1e-8 ? normalize(t) : vec2(1.0, 0.0);
	vec4 c = corner.x > 0.5 ? cb : ca;
	float w = width * (halo > 0.5 ? 8.0 : 1.0);
	// Halos round off their ends; cores overlap half a width at each joint and cross-fade there, so they never bead.
	float cap = halo > 0.5 ? 1.0 : 0.5;
	float along = corner.x > 0.5 ? cap : -cap;
	c.xy += (vec2(-t.y, t.x) * corner.y + t * along) * w / viewport * c.w;
	gl_Position = c;
	vLength = length(sb - sa) / w;
	vLocal = vec2(corner.x > 0.5 ? vLength + cap : -cap, corner.y);
	vLight = light;
	// The light around a channel leans cool, sometimes rosy or warm; its core stays white.
	float hue = pulseHash(seed, 120.0);
	vTint = hue < 0.15 ? vec3(1.0, 0.86, 0.95) : hue < 0.3 ? vec3(1.0, 0.94, 0.86) : vec3(0.86, 0.9, 1.0);
}
`;

export const ribbonFragment = /* glsl */ `
uniform vec3 color;
uniform float exposure;
uniform float halo;

varying vec2 vLocal;
varying float vLength;
varying float vLight;
varying vec3 vTint;
void main() {
	float light;
	if (halo > 0.5) {
		vec2 d = vec2(vLocal.x - clamp(vLocal.x, 0.0, vLength), vLocal.y);
		float x2 = min(dot(d, d), 1.0);
		light = 0.3 * exp(-x2 * 5.0) * (1.0 - x2);
	} else {
		float y2 = min(vLocal.y * vLocal.y, 1.0);
		float ends = clamp((vLocal.x + 0.5), 0.0, 1.0) * clamp((vLength + 0.5 - vLocal.x), 0.0, 1.0);
		light = exp(-y2 * 3.0) * (1.0 - y2) * ends;
	}
	vec3 hue = halo > 0.5 ? color * vTint : mix(vec3(1.0), color, 0.5);
	gl_FragColor = vec4(hue * exposure * vLight * light, 1.0);
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}
`;
