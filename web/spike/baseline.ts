import { CHANNEL, channelGlsl } from './baseline-channel';
import { intensityGlsl } from '../src/globe/lightning/intensity';
import { flashProfileGlsl, glslFloat as f, PROFILE } from '../src/globe/lightning/profile';

export const lightningVertexShader = /* glsl */ `
attribute vec4 flash;
attribute vec3 flashShape;

uniform float time;
uniform float duration;
uniform float radius;
uniform float lift;
uniform float kmToWorld;
uniform float glowScale;
uniform float minPixels;
uniform float viewportHeight;
uniform float flicker;

varying vec2 vCorner;
varying float vBrightness;
varying vec2 vScale;
varying float vChannelPixels;
varying float vChannel;
varying float vFade;
varying float vBranch;
varying float vSeed;
varying float vShape;

${flashProfileGlsl}
${intensityGlsl}
${channelGlsl}
void main() {
	vec3 normal = normalize(mat3(modelMatrix) * flash.xyz);
	vec3 center = (modelMatrix * vec4(flash.xyz * radius * (1.0 + lift), 1.0)).xyz;
	float facing = dot(normal, normalize(cameraPosition - center));
	float seed = fract(sin(dot(flash.xyz, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
	float age = time - flash.w;
	float brightness = flashProfile(age, duration, flashShape.z, seed, flicker) * intensityBrightness(flashShape.x) * smoothstep(0.0, 0.1, facing);
	if (brightness <= 0.0) {
		gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
		return;
	}

	vec3 east = abs(normal.y) > 0.999 ? vec3(1.0, 0.0, 0.0) : normalize(cross(vec3(0.0, 1.0, 0.0), normal));
	vec3 north = cross(normal, east);
	float distance = length(cameraPosition - center);
	float pixel = 2.0 * distance / (projectionMatrix[1][1] * viewportHeight);
	float size = max(flashShape.y * kmToWorld * glowScale, minPixels * pixel) * intensityScale(flashShape.x);

	float flickerEnd = clamp(flashShape.z / 1000.0, ${f(CHANNEL.fade)}, ${f(PROFILE.maxFlicker)}) + ${f(CHANNEL.fade)};
	vFade = 1.0 - smoothstep(0.0, flickerEnd, age);
	vChannel = brightness * vFade;
	float channel = vChannel > 0.0 ? max(flashShape.y * kmToWorld * ${f(CHANNEL.lengthScale)}, ${f(CHANNEL.minPixels)} * pixel) : 0.0;
	float quad = max(size, channel * 1.1);

	vec3 world = center + (east * position.x + north * position.y) * quad;
	gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
	vCorner = position.xy;
	vBrightness = brightness;
	vScale = vec2(quad / size, channel > 0.0 ? quad / channel : 0.0);
	vChannelPixels = channel / pixel;
	vBranch = exp(-age / ${f(CHANNEL.branchTau)});
	vSeed = seed;
	vShape = channelShape(flashShape.y, channelHash(seed, 90.0));
}
`;

export const lightningFragmentShader = /* glsl */ `
uniform vec3 color;
uniform float exposure;

varying vec2 vCorner;
varying float vBrightness;
varying vec2 vScale;
varying float vChannelPixels;
varying float vChannel;
varying float vFade;
varying float vBranch;
varying float vSeed;
varying float vShape;

${channelGlsl}
void main() {
	vec2 g = vCorner * vScale.x;
	float r2 = dot(g, g);
	float glow = r2 < 1.0 ? (exp(-r2 * 12.0) + 0.25 * exp(-r2 * 3.0)) * (1.0 - r2) : 0.0;
	float light = vBrightness * glow * (1.0 - ${f(CHANNEL.glowDip)} * vFade);
	if (vChannel > 0.001) {
		float angle = channelHash(vSeed, 91.0) * 6.2831853;
		vec2 p = mat2(cos(angle), sin(angle), -sin(angle), cos(angle)) * vCorner * vScale.y;
		float edge = 1.0 - smoothstep(0.8, 1.0, max(abs(vCorner.x), abs(vCorner.y)));
		light += vChannel * edge * channelLight(p, vSeed, vShape, vChannelPixels, vBranch);
	}
	if (light <= 0.0) discard;
	gl_FragColor = vec4(color * exposure * light, 1.0);
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}
`;
