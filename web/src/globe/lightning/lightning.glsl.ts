import { CHANNEL } from './channel';
import { intensityGlsl } from './intensity';
import { playbackGlsl } from './playback';
import { flashProfileGlsl, glslFloat as f, PROFILE } from './profile';
import { zoomGlsl } from './zoom';

export const lightningVertexShader = /* glsl */ `
attribute vec4 flash;
attribute vec3 flashShape;

uniform float time;
uniform float duration;
uniform float radius;
uniform float lift;
uniform float kmToWorld;
uniform float viewportHeight;
uniform float flicker;
uniform float haloStrength;

varying vec2 vCorner;
varying float vBrightness;
varying float vDip;

${playbackGlsl}
${flashProfileGlsl}
${intensityGlsl}
${zoomGlsl}
void main() {
	vec3 normal = normalize(mat3(modelMatrix) * flash.xyz);
	vec3 center = (modelMatrix * vec4(flash.xyz * radius * (1.0 + lift), 1.0)).xyz;
	float facing = dot(normal, normalize(cameraPosition - center));
	float seed = fract(sin(dot(flash.xyz, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
	float age = wallAge(time, flash.w);
	float brightness = flashProfile(age, time - flash.w, duration, flashShape.z, seed, flicker) * intensityBrightness(flashShape.x) * smoothstep(0.0, 0.1, facing);
	if (brightness <= 0.0) {
		gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
		return;
	}

	vec3 east = abs(normal.y) > 0.999 ? vec3(1.0, 0.0, 0.0) : normalize(cross(vec3(0.0, 1.0, 0.0), normal));
	vec3 north = cross(normal, east);
	float distance = length(cameraPosition - center);
	float kmPerPx = 2.0 * distance / (projectionMatrix[1][1] * viewportHeight) / kmToWorld;
	float size = glowRadiusKm(flashShape.y, flashShape.x, kmPerPx) * kmToWorld;

	// The glow steps back while the channel shows, so the lit cloud does not wash it out.
	float halo = haloStrength * (1.0 - smoothstep(${f(CHANNEL.haloFadeStartKm)}, ${f(CHANNEL.haloFadeEndKm)}, distance / kmToWorld));
	float end = clamp(flashShape.z / 1000.0, ${f(PROFILE.minFlicker)}, ${f(PROFILE.maxFlicker)});
	float channel = channelReveal(flashShape.y, kmPerPx) * (1.0 - smoothstep(end, end + ${f(CHANNEL.fade)}, age));
	vDip = mix(${f(CHANNEL.glowDip)}, ${f(CHANNEL.haloGlowDip)}, halo) * channel;
	vec3 world = center + (east * position.x + north * position.y) * size;
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
