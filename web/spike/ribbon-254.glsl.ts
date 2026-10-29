// Frozen copy of the #254 walk-based channel shader, kept for GPU comparisons.
import { CHANNEL, channelGlsl } from '../src/globe/lightning/channel';
import { intensityGlsl } from '../src/globe/lightning/intensity';
import { playbackGlsl } from '../src/globe/lightning/playback';
import { flashProfileGlsl, glslFloat as f, PROFILE } from '../src/globe/lightning/profile';
import { zoomGlsl } from '../src/globe/lightning/zoom';

export const ribbonVertex = (segments: number) => /* glsl */ `
attribute vec4 rib;
attribute vec4 flash;
attribute vec4 flashShape;
uniform float time;
uniform float duration;
uniform float flicker;
uniform float radius;
uniform float kmToWorld;
uniform vec2 viewport;
uniform float widthPx;
uniform float halo;
uniform float haloStrength;

varying vec2 vLocal;
varying float vLength;
varying float vLight;

${playbackGlsl}
${flashProfileGlsl}
${intensityGlsl}
${zoomGlsl}
${channelGlsl}
const float S = 16.0;
const float SAMPLE = ${f(16 / segments)};

// Both kinds keep the same horizontal walk; only their altitude differs.
vec3 walk(float b, float i, float seed, float L) {
	float heading = channelHash(seed, 1.0) * 6.2831853;
	vec3 dir = vec3(cos(heading), sin(heading), 0.0);
	vec3 p = vec3(-dir.xy * L, 10.0);
	float stepLen = L * 2.0 / S;
	float origin = 0.0;
	if (b > 0.5) {
		origin = floor(S * (0.15 + 0.6 * channelHash(seed, 10.0 + b)));
		for (float j = 0.0; j < S; j++) {
			if (j >= origin) break;
			p += dir * stepLen + (vec3(channelHash(seed, 100.0 + j), channelHash(seed, 200.0 + j), channelHash(seed, 300.0 + j)) - 0.5) * stepLen * vec3(1.6, 1.6, 0.4);
		}
		float turn = (channelHash(seed, 20.0 + b) - 0.5) * 2.4;
		dir = vec3(cos(heading + turn), sin(heading + turn), 0.0);
		stepLen *= 0.25 + 0.35 * channelHash(seed, 30.0 + b);
	}
	for (float j = 0.0; j < S; j++) {
		if (j >= i) break;
		float k = b * 1000.0 + j;
		p += dir * stepLen + (vec3(channelHash(seed, 100.0 + k), channelHash(seed, 200.0 + k), channelHash(seed, 300.0 + k)) - 0.5) * stepLen * vec3(1.6, 1.6, 0.4);
	}
	if (isGround(seed)) {
		float progress = (origin + i * (1.0 - origin / S)) / S;
		p.z = 17.5 * max(0.0, 1.0 - progress);
	} else {
		p.z = clamp(p.z, 8.0, 11.5);
	}
	return p;
}

void main() {
	vec3 normal = normalize(mat3(modelMatrix) * flash.xyz);
	vec3 base = (modelMatrix * vec4(flash.xyz * radius, 1.0)).xyz;
	float seed = flashShape.w;
	bool ground = isGround(seed);
	float age = wallAge(time, flash.w);
	float facing = dot(normal, normalize(cameraPosition - base));
	float distance = length(cameraPosition - base);
	float kmPerPx = distance / (projectionMatrix[1][1] * viewport.y) / kmToWorld;
	float brightness = flashProfile(age, time - flash.w, duration, flashShape.z, seed, flicker, ground) * intensityBrightness(flashShape.x) * smoothstep(0.0, 0.1, facing) * onScreen(flash.w);
	float end = clamp(flashShape.z / 1000.0, ${f(PROFILE.minFlicker)}, ${f(PROFILE.maxFlicker)});
	float fade = 1.0 - smoothstep(end, end + ${f(CHANNEL.fade)}, age);

	// Leaders light the path as they go: in-cloud ones crawl over the flash, ground ones drop at once.
	float reached = flicker < 0.5 ? 1.0 : ground ? spread(age, end, true) : ${f(CHANNEL.cloudStart)} + ${f(1 - CHANNEL.cloudStart)} * spread(age, end, false);
	float head = reached * S;
	float origin = rib.x > 0.5 ? floor(S * (0.15 + 0.6 * channelHash(seed, 10.0 + rib.x))) : 0.0;
	float pace = rib.x > 0.5 ? 0.5 : 1.0;
	float from = origin + rib.y * SAMPLE * pace;
	float grown = clamp((head - from) / (SAMPLE * pace), 0.0, 1.0);
	float branchLevel = 1.0;
	if (rib.x > 0.5) {
		// Branches light once, when the leader reaches them.
		float q = clamp((origin / S - ${f(CHANNEL.cloudStart)}) / ${f(1 - CHANNEL.cloudStart)}, 0.0, 1.0);
		float reachedAt = ground ? 0.0 : (1.0 - sqrt(1.0 - q)) * ${f(PROFILE.cloudSpread)} * end;
		branchLevel = 0.7 * exp(-max(age - reachedAt, 0.0) / (ground ? ${f(CHANNEL.branchTau)} : ${f(CHANNEL.cloudBranchTau)}));
	}
	float light = brightness * fade * branchLevel * channelReveal(flashShape.y, kmPerPx) * step(0.001, grown);
	if (halo > 0.5) {
		light *= ground ? haloStrength * (1.0 - smoothstep(${f(CHANNEL.haloFadeStartKm)}, ${f(CHANNEL.haloFadeEndKm)}, distance / kmToWorld)) : 0.0;
	}
	// In-cloud channels are seen through the cloud: wider, softer and dimmer.
	float width = ground ? widthPx : max(widthPx, 0.6 / kmPerPx);
	if (!ground) light *= 0.45 * sqrt(widthPx / width);
	if (light < 0.002) {
		gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
		return;
	}
	float L = flashShape.y * ${f(CHANNEL.lengthScale)};
	vec3 east = abs(normal.y) > 0.999 ? vec3(1.0, 0.0, 0.0) : normalize(cross(vec3(0.0, 1.0, 0.0), normal));
	vec3 north = cross(normal, east);
	vec3 a = walk(rib.x, rib.y * SAMPLE, seed, L);
	vec3 b = mix(a, walk(rib.x, (rib.y + 1.0) * SAMPLE, seed, L), grown);
	mat3 frame = mat3(east, north, normal) * kmToWorld;
	vec4 ca = projectionMatrix * viewMatrix * vec4(base + frame * a, 1.0);
	vec4 cb = projectionMatrix * viewMatrix * vec4(base + frame * b, 1.0);
	vec2 sa = ca.xy / ca.w * viewport;
	vec2 sb = cb.xy / cb.w * viewport;
	vec2 t = sb - sa;
	t = dot(t, t) > 1e-8 ? normalize(t) : vec2(1.0, 0.0);
	vec4 c = rib.z > 0.5 ? cb : ca;
	float taper = rib.x > 0.5 ? 1.0 - 0.7 * (rib.y + rib.z) / S : 1.0;
	float w = width * (halo > 0.5 ? 8.0 : 1.0) * max(taper, 0.5);
	float along = rib.z > 0.5 ? 1.0 : -1.0;
	c.xy += (vec2(-t.y, t.x) * rib.w + t * along) * w / viewport * c.w;
	gl_Position = c;
	vLength = length(sb - sa) / w;
	vLocal = vec2(rib.z > 0.5 ? vLength + 1.0 : -1.0, rib.w);
	vLight = light * taper;
}
`;

export const ribbonFragment = /* glsl */ `
uniform vec3 color;
uniform float exposure;
uniform float halo;

varying vec2 vLocal;
varying float vLength;
varying float vLight;
void main() {
	vec2 d = vec2(vLocal.x - clamp(vLocal.x, 0.0, vLength), vLocal.y);
	float x2 = min(dot(d, d), 1.0);
	float light = halo > 0.5 ? 0.3 * exp(-x2 * 5.0) * (1.0 - x2) : exp(-x2 * 3.0) * (1.0 - x2);
	gl_FragColor = vec4(color * exposure * vLight * light, 1.0);
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}
`;

