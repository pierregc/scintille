import { WIND_RULES } from '../../contract/wind';
import { cloudOpacityGlsl } from '../clouds';
import { WIND_FADE } from './look';

/** Streamline steps on each side of a texel. */
export const LIC_STEPS = 14;
/** Averages along a streamline are stored stretched by this factor around 0.5. */
export const LIC_STRETCH = 1.5;

const float = (x: number) => (Number.isInteger(x) ? `${x}.0` : String(x));

/** The hourly pair of fields (ADR 0039: u, v in red, green; 90° N at v = 1, 0° E at u = 0). */
const windFieldGlsl = /* glsl */ `
uniform sampler2D windA;
uniform sampler2D windB;
uniform vec2 windScale;
uniform float windCalm;
uniform float windFull;

const float PI = 3.14159265;
const float GRID_STEP = ${float(WIND_RULES.grid_step_degrees)};
const vec2 GRID = vec2(${float(WIND_RULES.width)}, ${float(WIND_RULES.height)});

// Twin of windUv() in look.ts.
vec2 windUv(vec3 p) {
	float lon = fract(atan(-p.z, p.x) / (2.0 * PI)) * 360.0;
	float lat = degrees(asin(clamp(p.y, -1.0, 1.0)));
	vec2 uv = (vec2(lon, 90.0 - lat) / GRID_STEP + 0.5) / GRID;
	return vec2(uv.x, 1.0 - uv.y);
}

// East and north wind in m/s.
vec2 windIn(sampler2D map, vec3 p, float scale) {
	return (textureLod(map, windUv(p), 0.0).rg * 255.0 - 128.0) / 127.0 * scale;
}

vec3 eastOf(vec3 p) {
	return normalize(vec3(p.z, 0.0, -p.x) + vec3(1e-6, 0.0, 0.0));
}

vec3 flowDirection(vec3 p, vec2 w) {
	vec3 east = eastOf(p);
	return (east * w.x + cross(p, east) * w.y) / max(length(w), 1e-3);
}
`;

export const bakeVertexShader = /* glsl */ `
varying vec2 vNdc;
void main() {
	vNdc = position.xy;
	gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** One texel of the bake: the sphere point seen through it, and the average of the noise along its streamline in `a` (red) and `b` (green). */
export const bakeFragmentShader = /* glsl */ `
precision highp sampler3D;
uniform mat4 inverseViewProjection;
uniform vec3 eye;
uniform float shellRadius;
uniform float windPair;
uniform sampler3D noiseMap;
uniform vec3 octave;
uniform float reach;
varying vec2 vNdc;
${windFieldGlsl}

const int STEPS = ${LIC_STEPS};

// Noise at the blend of two octaves.
float grain(vec3 p) {
	vec3 q = p * octave.x / 64.0;
	return mix(textureLod(noiseMap, q, 0.0).r, textureLod(noiseMap, q * 2.0 + 0.37, 0.0).r, octave.y);
}

float licAlong(sampler2D map, float scale, vec3 p0) {
	vec2 w0 = windIn(map, p0, scale);
	float strength = smoothstep(windCalm, windFull, length(w0));
	if (strength <= 0.0) return 0.5;
	float h = octave.z * 0.9 * (0.35 + 0.65 * strength) * reach;
	float sum = 0.0;
	float weight = 0.0;
	for (int side = 0; side < 2; side++) {
		float forward = side == 0 ? 1.0 : -1.0;
		vec3 p = p0;
		vec3 dir = flowDirection(p0, w0);
		for (int i = 0; i < STEPS; i++) {
			p = normalize(p + dir * (forward * h));
			if (i % 2 == 1) dir = flowDirection(p, windIn(map, p, scale));
			float k = 0.5 + 0.5 * cos(PI * (float(i) + 1.0) / float(STEPS));
			sum += grain(p) * k;
			weight += k;
		}
	}
	return clamp(0.5 + (sum / weight - 0.5) * ${float(LIC_STRETCH)}, 0.0, 1.0);
}

void main() {
	vec4 far = inverseViewProjection * vec4(vNdc, 1.0, 1.0);
	vec3 ray = normalize(far.xyz / far.w - eye);
	float b = dot(eye, ray);
	float disc = b * b - dot(eye, eye) + shellRadius * shellRadius;
	gl_FragColor = vec4(0.5);
	if (disc <= 0.0) return;
	vec3 p0 = normalize(eye + ray * (-b - sqrt(disc)));
	float a = licAlong(windA, windScale.x, p0);
	gl_FragColor = vec4(a, windPair > 0.0 ? licAlong(windB, windScale.y, p0) : a, 0.0, 1.0);
}
`;

export const windVertexShader = /* glsl */ `
varying vec3 vWorld;
void main() {
	vec4 world = modelMatrix * vec4(position, 1.0);
	vWorld = world.xyz;
	gl_Position = projectionMatrix * viewMatrix * world;
}
`;

/**
 * Fibres of the hourly pair crossfaded by `windMix`, from the newest bake crossfaded from the previous
 * one, drifting downwind in two phases.
 */
export const windFragmentShader = /* glsl */ `
precision highp sampler3D;
uniform sampler2D windBakeNew;
uniform sampler2D windBakeOld;
uniform mat4 windMatrixNew;
uniform mat4 windMatrixOld;
uniform vec3 windEyeNew;
uniform vec3 windEyeOld;
uniform vec2 windOctaveNew;
uniform vec2 windOctaveOld;
uniform float windBakeShare;
uniform float windOldShown;
uniform float windMix;
uniform sampler3D windNoise;
uniform float windShell;
uniform float windTime;
uniform float windDrift;
uniform float windSparse;
uniform float windSoft;
uniform float windGain;
uniform float windDayLevel;
uniform float windCloudVeil;
uniform float windOpacity;
uniform vec3 windSun;
uniform vec3 windColor;
varying vec3 vWorld;
${windFieldGlsl}
#ifdef CLOUD_VEIL
${cloudOpacityGlsl}
#endif

const float SPREAD = ${0.5 / Math.sqrt(LIC_STEPS)};

vec2 bakeUv(mat4 m, vec3 p) {
	vec4 c = m * vec4(p * windShell, 1.0);
	return c.w > 0.0 ? c.xy / c.w * 0.5 + 0.5 : vec2(-1.0);
}

float lic(float stored) {
	return 0.5 + (stored - 0.5) / ${float(LIC_STRETCH)};
}

float fibre(float value) {
	float edge = windSparse * 2.2;
	return smoothstep(0.5 + SPREAD * (edge - 0.3 * windSoft), 0.5 + SPREAD * (edge + 0.7 * windSoft), value);
}

// One field's fibres times its strength, drifting: two bake reads at the phases' offsets downwind.
float drifting(sampler2D map, mat4 m, float cell, vec3 p0, vec2 w, float t1, bool second) {
	float strength = smoothstep(windCalm, windFull, length(w));
	if (strength <= 0.0) return 0.0;
	vec3 travel = flowDirection(p0, w) * (cell * 12.0 * strength);
	float t2 = fract(t1 + 0.5);
	float w1 = 1.0 - abs(2.0 * t1 - 1.0);
	float w2 = 1.0 - w1;
	vec2 s1 = textureLod(map, bakeUv(m, normalize(p0 - travel * (t1 - 0.5))), 0.0).rg;
	vec2 s2 = textureLod(map, bakeUv(m, normalize(p0 - travel * (t2 - 0.5))), 0.0).rg;
	float a = lic(second ? s1.g : s1.r);
	float b = lic(second ? s2.g : s2.r);
	return fibre(0.5 + (w1 * a + w2 * b - 0.5) / sqrt(w1 * w1 + w2 * w2)) * strength;
}

float fibres(sampler2D map, mat4 m, vec3 eye, vec2 octave, vec3 p0, vec2 wa, vec2 wb) {
	vec2 uv = bakeUv(m, p0);
	if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0))) || dot(p0, eye) <= windShell) return 0.0;
	bool useA = windMix < 0.998;
	bool useB = windMix > 0.002;
	if (windDrift <= 0.0) {
		vec2 c = textureLod(map, uv, 0.0).rg;
		float a = useA ? fibre(lic(c.r)) * smoothstep(windCalm, windFull, length(wa)) : 0.0;
		float b = useB ? fibre(lic(c.g)) * smoothstep(windCalm, windFull, length(wb)) : 0.0;
		return mix(a, b, windMix);
	}
	float t1 = fract(windTime + textureLod(windNoise, p0 * octave.x / 768.0 + 0.11, 0.0).r * 3.0);
	float a = useA ? drifting(map, m, octave.y, p0, wa, t1, false) : 0.0;
	float b = useB ? drifting(map, m, octave.y, p0, wb, t1, true) : 0.0;
	return mix(a, b, windMix);
}

void main() {
	vec3 p0 = normalize(vWorld);
#ifdef CLOUD_VEIL
	// Cloud cover blurred over a few pixels, so the veil steps aside from whole cloud fields, gaps included.
	vec2 geo = cloudGeo(p0);
	vec2 gx = dFdx(geo);
	vec2 gy = dFdy(geo);
	gx.x -= floor(gx.x + 0.5);
	gy.x -= floor(gy.x + 0.5);
#endif
	vec2 wa = windIn(windA, p0, windScale.x);
	vec2 wb = windMix > 0.002 ? windIn(windB, p0, windScale.y) : wa;
	if (max(length(wa), length(wb)) <= windCalm) discard;
	float value = fibres(windBakeNew, windMatrixNew, windEyeNew, windOctaveNew, p0, wa, wb) * windBakeShare;
	if (windOldShown > 0.0) value += fibres(windBakeOld, windMatrixOld, windEyeOld, windOctaveOld, p0, wa, wb) * (1.0 - windBakeShare);
	if (value <= 0.0) discard;

	float facing = smoothstep(0.1, 0.5, dot(p0, normalize(cameraPosition - vWorld)));
	float day = smoothstep(-0.1, 0.25, dot(p0, windSun));
	float alpha = windGain * windOpacity * value * facing * mix(1.0, windDayLevel, day);
#ifdef CLOUD_VEIL
	// Twin of cloudVeil() in look.ts: observed clouds keep the fibres off them in daylight.
	if (day > 0.0) {
		float cover = cloudOpacity(vec2(geo.x, 1.0 - geo.y), geo, gx * ${float(WIND_FADE.cloudBlurPx)}, gy * ${float(WIND_FADE.cloudBlurPx)});
		alpha *= 1.0 - windCloudVeil * day * smoothstep(0.0, ${float(WIND_FADE.cloudOpaque)}, cover);
	}
#endif
	gl_FragColor = vec4(windColor * alpha, alpha);
	#include <colorspace_fragment>
}
`;
