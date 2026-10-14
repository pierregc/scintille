import { CHANNEL, channelGlsl } from './channel';
import { intensityGlsl } from './intensity';
import { flashProfileGlsl, glslFloat as f, PROFILE } from './profile';

export const ribbonVertex = (segments: number) => /* glsl */ `
attribute vec4 rib;
attribute vec4 flash;
attribute vec3 flashShape;
uniform float time;
uniform float duration;
uniform float flicker;
uniform float radius;
uniform float kmToWorld;
attribute float channelSeed;
uniform vec2 viewport;
uniform float widthPx;
uniform float halo;
uniform float haloStrength;

varying vec2 vLocal;
varying float vLength;
varying float vLight;

${flashProfileGlsl}
${intensityGlsl}
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
	bool ground = channelHash(seed, 2.0) < ${f(CHANNEL.groundShare)};
	if (ground) {
		float progress = (origin + i * (1.0 - origin / S)) / S;
		p.z = ${f(CHANNEL.cloudBaseKm * CHANNEL.heightExaggeration)} * max(0.0, 1.0 - progress);
	} else {
		p.z = clamp(p.z, 8.0, 11.5);
	}
	return p;
}

void main() {
	vec3 normal = normalize(mat3(modelMatrix) * flash.xyz);
	vec3 base = (modelMatrix * vec4(flash.xyz * radius, 1.0)).xyz;
	float seed = fract(sin(dot(flash.xyz, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
	float age = time - flash.w;
	float facing = dot(normal, normalize(cameraPosition - base));
	float brightness = flashProfile(age, duration, flashShape.z, seed, flicker) * intensityBrightness(flashShape.x) * smoothstep(0.0, 0.1, facing);
	float end = min(clamp(flashShape.z / 1000.0, ${f(PROFILE.minFlicker)}, ${f(PROFILE.maxFlicker)}), duration * 0.6);
	float fade = 1.0 - smoothstep(end, end + ${f(CHANNEL.fade)}, age);
	float branchLevel = rib.x > 0.5 ? exp(-age / ${f(CHANNEL.branchTau)}) * 0.7 : 1.0;
	float light = brightness * fade * branchLevel;
	if (halo > 0.5) {
		float distanceKm = length(cameraPosition - base) / kmToWorld;
		light *= haloStrength * (1.0 - smoothstep(${f(CHANNEL.haloFadeStartKm)}, ${f(CHANNEL.haloFadeEndKm)}, distanceKm));
	}
	if (light < 0.002) {
		gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
		return;
	}
	float L = flashShape.y * ${f(CHANNEL.lengthScale)};
	vec3 east = abs(normal.y) > 0.999 ? vec3(1.0, 0.0, 0.0) : normalize(cross(vec3(0.0, 1.0, 0.0), normal));
	vec3 north = cross(normal, east);
	float distance = length(cameraPosition - base);
	float pixel = distance / (projectionMatrix[1][1] * viewport.y);
	float scale = max(kmToWorld, ${f(CHANNEL.minPixels)} * pixel / L);
	vec3 a = walk(rib.x, rib.y * SAMPLE, channelSeed, L);
	vec3 b = walk(rib.x, (rib.y + 1.0) * SAMPLE, channelSeed, L);
	mat3 frame = mat3(east * scale, north * scale, normal * kmToWorld);
	vec4 ca = projectionMatrix * viewMatrix * vec4(base + frame * a, 1.0);
	vec4 cb = projectionMatrix * viewMatrix * vec4(base + frame * b, 1.0);
	vec2 sa = ca.xy / ca.w * viewport;
	vec2 sb = cb.xy / cb.w * viewport;
	vec2 t = sb - sa;
	t = dot(t, t) > 1e-8 ? normalize(t) : vec2(1.0, 0.0);
	vec4 c = rib.z > 0.5 ? cb : ca;
	float taper = rib.x > 0.5 ? 1.0 - 0.7 * (rib.y + rib.z) / S : 1.0;
	float w = widthPx * (halo > 0.5 ? 8.0 : 1.0) * max(taper, 0.5);
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

