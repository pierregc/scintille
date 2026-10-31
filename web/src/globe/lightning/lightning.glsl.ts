import { cloudOpacityGlsl } from '../clouds/clouds.glsl';
import { volumeFieldGlsl } from '../clouds/field.glsl';
import { CHANNEL, channelGlsl, cloudDriftGlsl } from './channel';
import { DENSITY, densityGlsl } from './density';
import { intensityGlsl } from './intensity';
import { playbackGlsl } from './playback';
import { flashProfileGlsl, glslFloat as f, PROFILE } from './profile';
import { veilGlsl } from './veil';
import { zoomGlsl } from './zoom';

export const lightningVertexShader = /* glsl */ `
attribute vec4 flash;
attribute vec4 flashShape;

uniform float time;
uniform float duration;
uniform float radius;
uniform float lift;
uniform float kmToWorld;
uniform float viewportHeight;
uniform float viewScale;
uniform float nearGlowLevel;
uniform float flicker;
uniform float haloStrength;

varying vec2 vCorner;
varying float vBrightness;
varying float vDip;

${playbackGlsl}
${flashProfileGlsl}
${intensityGlsl}
${zoomGlsl}
${channelGlsl}
${densityGlsl}
${cloudDriftGlsl}
${veilGlsl}
#ifdef CLOUDS
${cloudOpacityGlsl}
#endif
#ifdef VOLUME
${volumeFieldGlsl}
#endif
void main() {
	vec3 normal = normalize(mat3(modelMatrix) * flash.xyz);
	vec3 center = (modelMatrix * vec4(flash.xyz * radius * (1.0 + lift), 1.0)).xyz;
	float facing = dot(normal, normalize(cameraPosition - center));
	float seed = flashShape.w;
	bool ground = isGround(seed);
	float age = wallAge(time, flash.w);
	float brightness = flashProfile(age, time - flash.w, duration, flashShape.z, seed, flicker, ground) * intensityBrightness(flashShape.x) * smoothstep(0.0, 0.1, facing) * onScreen(flash.w);
	if (brightness <= 0.0) {
		gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
		return;
	}

	vec3 east = abs(normal.y) > 0.999 ? vec3(1.0, 0.0, 0.0) : normalize(cross(vec3(0.0, 1.0, 0.0), normal));
	vec3 north = cross(normal, east);
	float distance = length(cameraPosition - center);
	float kmPerPx = 2.0 * distance / (projectionMatrix[1][1] * viewportHeight) / kmToWorld;
	float viewKmPerPx = kmPerPx * viewScale;
	float size = glowRadiusKm(flashShape.y, flashShape.x, kmPerPx, viewScale) * kmToWorld;
	brightness *= glowShare(viewKmPerPx, nearGlowLevel);
	// Near the floor only the sample drawn in full keeps its sprite: the cloud light carries the rest, or half a sprite when it has no surface.
	brightness *= max(heroWeight(heroLot(seed, flashShape.x), heroShare), max(farness(viewKmPerPx), lightMapOff * ${f(DENSITY.weakGlow)}));
	if (brightness <= 0.0) {
		gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
		return;
	}

	// The glow steps back while the channel shows, so the lit cloud does not wash it out.
	float halo = haloStrength * (1.0 - smoothstep(${f(CHANNEL.haloFadeStartKm)}, ${f(CHANNEL.haloFadeEndKm)}, distance / kmToWorld));
	float end = clamp(flashShape.z / 1000.0, ${f(PROFILE.minFlicker)}, ${f(PROFILE.maxFlicker)});
	float channel = channelReveal(flashShape.y, viewKmPerPx) * (1.0 - smoothstep(end, end + ${f(CHANNEL.fade)}, age));
	vDip = (ground ? mix(${f(CHANNEL.glowDip)}, ${f(CHANNEL.haloGlowDip)}, halo) : ${f(CHANNEL.cloudGlowDip)}) * channel;
#ifdef CLOUDS
	// Only as much as the cloud lets a ground channel show; in-cloud ones still carry their light, veiled.
	if (ground && vDip > 0.0 && cloudShown > 0.5) {
		float opacity = cloudOpacityAt(normal);
#ifdef VOLUME
		float known = cloudKnownAt(normal);
		if (known > 0.0) opacity = mix(opacity, veilOpacity(volumeSample(volumeField, volumeLatLon(normal)).r), known);
#endif
		vDip *= cloudTransmission(opacity, 1.0);
	}
#endif
	vec2 drift = cloudDrift(age, end, flashShape.y, seed, ground) * kmToWorld * flicker;
	vec3 world = center + east * (position.x * size + drift.x) + north * (position.y * size + drift.y);
	gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
	vCorner = position.xy;
	vBrightness = brightness;
}
`;

export const lightningFragmentShader = /* glsl */ `
uniform vec3 color;
uniform float exposure;

varying vec2 vCorner;
varying float vBrightness;
varying float vDip;

void main() {
	vec2 g = vCorner;
	float r2 = dot(g, g);
	float glow = r2 < 1.0 ? (exp(-r2 * 12.0) + 0.25 * exp(-r2 * 3.0)) * (1.0 - r2) : 0.0;
	float light = vBrightness * glow * (1.0 - vDip);
	if (light <= 0.0) discard;
	gl_FragColor = vec4(color * exposure * light, 1.0);
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}
`;
