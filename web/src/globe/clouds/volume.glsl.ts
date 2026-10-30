import { flashLightGlsl } from '../lightning/light-map.glsl';
import { cloudOpacityGlsl } from './clouds.glsl';
import { volumeFieldGlsl } from './field.glsl';

export { volumeFieldGlsl } from './field.glsl';

const overlapGlsl = /* glsl */ `
// Length of the segment from height h0 to h1 (over len km) that lies between lo and hi.
float overlap(float h0, float h1, float lo, float hi, float len) {
	float a = min(h0, h1);
	float b = max(h0, h1);
	if (b - a < 1e-3) return (a >= lo && a <= hi) ? len : 0.0;
	return len * max(0.0, min(b, hi) - max(a, lo)) / (b - a);
}
`;

const windowGlsl = /* glsl */ `
// Latitude and longitude (radians) of a texel of the window being baked, and its direction.
vec2 bakeLatLon(vec2 uv) {
	return vec2(bakeWindow.x + (uv.y * 2.0 - 1.0) * bakeWindow.z, bakeWindow.y + (uv.x * 2.0 - 1.0) * bakeWindow.w);
}
vec3 bakeDirection(vec2 latLon) {
	return vec3(cos(latLon.x) * cos(latLon.y), sin(latLon.x), -cos(latLon.x) * sin(latLon.y));
}
`;

/** Gradient noise hashed from the position, so it never repeats (no texture, no period). */
export const noiseGlsl = /* glsl */ `
vec3 hash33(vec3 p) {
	p = fract(p * vec3(0.1031, 0.1030, 0.0973));
	p += dot(p, p.yxz + 33.33);
	return fract((p.xxy + p.yxx) * p.zyx) * 2.0 - 1.0;
}

// About -1 to 1, zero on average.
float gnoise(vec3 p) {
	vec3 i = floor(p);
	vec3 f = p - i;
	vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
	float n000 = dot(hash33(i), f);
	float n100 = dot(hash33(i + vec3(1.0, 0.0, 0.0)), f - vec3(1.0, 0.0, 0.0));
	float n010 = dot(hash33(i + vec3(0.0, 1.0, 0.0)), f - vec3(0.0, 1.0, 0.0));
	float n110 = dot(hash33(i + vec3(1.0, 1.0, 0.0)), f - vec3(1.0, 1.0, 0.0));
	float n001 = dot(hash33(i + vec3(0.0, 0.0, 1.0)), f - vec3(0.0, 0.0, 1.0));
	float n101 = dot(hash33(i + vec3(1.0, 0.0, 1.0)), f - vec3(1.0, 0.0, 1.0));
	float n011 = dot(hash33(i + vec3(0.0, 1.0, 1.0)), f - vec3(0.0, 1.0, 1.0));
	float n111 = dot(hash33(i + vec3(1.0, 1.0, 1.0)), f - vec3(1.0, 1.0, 1.0));
	float n = mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y), mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
	return clamp(n * 1.9, -1.0, 1.0);
}
`;

export const passVertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
	vUv = position.xy * 0.5 + 0.5;
	gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** Bakes the observations over one window: blended opacity, observed top, convective core, heights known. */
export const rawFieldFragmentShader = /* glsl */ `
precision highp float;
precision highp sampler2DArray;
varying vec2 vUv;
uniform vec4 bakeWindow;
uniform float bakeTexels;
${cloudOpacityGlsl}
${windowGlsl}
#ifdef HEIGHTS
uniform highp sampler2DArray heightTiles;
uniform sampler2D heightPagesA;
uniform sampler2D heightPagesB;
uniform vec2 heightGrid;
uniform vec2 heightCells;
uniform float heightOn;

float heightTile(vec2 geo, float z, float slot) {
	vec2 count = vec2(exp2(z + 1.0), exp2(z));
	float size = heightGrid.x + 2.0 * heightGrid.y;
	vec2 st = (fract(geo * count) * heightGrid.x + heightGrid.y) / size;
	return textureLod(heightTiles, vec3(st, slot), 0.0).r * 20.0;
}

// Top height (km) of one frame at geo; negative where no height tile is loaded.
float frameHeight(sampler2D pages, vec2 geo) {
	ivec2 cell = ivec2(min(floor(geo * heightCells), heightCells - 1.0));
	vec4 top = texelFetch(pages, ivec2(cell.x * 2, cell.y), 0) * 255.0;
	if (top.g < 0.5) return -1.0;
	float value = heightTile(geo, top.g, top.r);
	if (top.b < 254.5) {
		vec4 under = texelFetch(pages, ivec2(cell.x * 2 + 1, cell.y), 0) * 255.0;
		if (under.g > 0.5) value = mix(heightTile(geo, under.g, under.r), value, top.b / 255.0);
	}
	return value;
}

float cloudHeight(vec2 geo) {
	if (heightOn < 0.5) return -1.0;
	float a = frameHeight(heightPagesA, geo);
	float b = cloudMix > 0.0 ? frameHeight(heightPagesB, geo) : a;
	if (a < 0.0 || b < 0.0) return max(a, b);
	return mix(a, b, cloudMix);
}
#else
float cloudHeight(vec2 geo) { return -1.0; }
#endif

void main() {
	vec2 latLon = bakeLatLon(vUv);
	vec2 geo = vec2(fract(latLon.y / 6.283185307 + 0.5), 0.5 - latLon.x / 3.141592654);
	vec2 uv = vec2(geo.x, 1.0 - geo.y);
	vec2 gx = vec2(bakeWindow.w / (3.141592654 * bakeTexels), 0.0);
	vec2 gy = vec2(0.0, bakeWindow.z / (1.570796327 * bakeTexels));
	float a = cloudOpacity(uv, geo, gx, gy) / max(cloudMaxOpacity, 1e-3);
	float wide = mix(textureLod(cloudMap, uv, 2.5).r, textureLod(cloudMapNext, uv, 2.5).r, cloudMix);
	float h = cloudHeight(geo);
	gl_FragColor = vec4(a, clamp(h, 0.0, 20.0) / 20.0, smoothstep(0.55, 0.85, wide), h >= 0.0 ? 1.0 : 0.0);
}
`;

/**
 * Styles one window of observations by cloud type (ADR 0031): fibres along thin and fraying edges,
 * smooth opaque sheets, billowing tops where the observed tops rise above their surroundings, a
 * gentle swell elsewhere. Detail is hashed (never repeats), no finer than 2.5 texels, and moves
 * cover only where it is partial, so averages over 4 km stay with the observations.
 */
export const styleFragmentShader = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D rawField;
uniform vec4 bakeWindow;
uniform float bakeTexels;
uniform float texelKm;
uniform float styled;
uniform vec3 sunDir;
${windowGlsl}
${noiseGlsl}

vec4 raw(vec2 offset) { return textureLod(rawField, vUv + offset / bakeTexels, 0.0); }

// Weight of a detail wavelength (km) this window can hold without aliasing.
float band(float wavelength) { return smoothstep(2.5, 4.0, wavelength / texelKm); }

// Streaks: noise averaged along a direction, so it stretches into fibres about 'len' km long.
float streaks(vec3 p, vec3 along, float width, float len) {
	float sum = 0.0;
	for (int i = 0; i < 7; i++) {
		float k = (float(i) - 3.0) / 3.0;
		sum += gnoise((p + along * k * len * 0.5) / width + vec3(17.0, 3.0, 29.0)) * (1.0 - abs(k) * 0.5);
	}
	return clamp(sum * 0.45, -1.0, 1.0);
}

// Rounded domes: inverted ridges, zero on average (the mean of 1 - |gnoise| is 0.707).
float billows(vec3 p, float size) {
	return (0.707 - abs(gnoise(p / size + vec3(5.0, 41.0, 13.0)))) * 2.2 * band(size);
}

// Crisp strokes from soft noise: keeps the sign, sharpens the shoulders.
float stroke(float x) { return sign(x) * pow(abs(x), 0.6); }

void main() {
	vec4 c = raw(vec2(0.0));
	if (styled < 0.5 || c.a < 0.5 || c.r < 0.004) {
		gl_FragColor = c;
		return;
	}
	vec2 latLon = bakeLatLon(vUv);
	vec3 n = bakeDirection(latLon);
	vec3 east = vec3(-sin(latLon.y), 0.0, -cos(latLon.y));
	vec3 north = vec3(-sin(latLon.x) * cos(latLon.y), cos(latLon.x), sin(latLon.x) * sin(latLon.y));
	vec3 p = n * 6371.0;
	float a = c.r;
	float observedTop = c.g * 20.0;

	// Surroundings about 8 km away: mean top of the opaque texels with known heights, its spread,
	// the smoothed cover gradient.
	float r = max(2.0, 8.0 / texelKm);
	float aSum = 0.0;
	float hSum = 0.0;
	float hSquares = 0.0;
	float hWeight = 0.0;
	vec2 grad = vec2(0.0);
	for (int i = 0; i < 8; i++) {
		float angle = float(i) * 0.785398163;
		vec2 o = vec2(cos(angle), sin(angle));
		vec4 s = raw(o * r);
		float w = smoothstep(0.6, 0.9, s.r) * step(0.5, s.a);
		float h = s.g * 20.0;
		aSum += s.r;
		hSum += h * w;
		hSquares += h * h * w;
		hWeight += w;
		grad += o * s.r;
	}
	float hMean = hWeight > 0.0 ? hSum / hWeight : observedTop;
	// How much the observed tops vary around: rough where convection is active, flat on anvils.
	float roughness = hWeight > 0.0 ? sqrt(max(hSquares / hWeight - hMean * hMean, 0.0)) : 0.0;
	grad /= 4.0 * r;
	float edge = smoothstep(0.15, 0.6, length(grad) * 2.0 * r);
	vec2 g = length(grad) > 1e-6 ? normalize(grad) : vec2(1.0, 0.0);
	vec3 across = g.x * east + g.y * north;
	vec3 along = cross(n, across);

	// The 2 km tops carry compression noise that sunlight would turn into corduroy: inside a cloud,
	// keep their 3 km average (the heights' own error is about 1 km); edges keep the observed top.
	float near = max(1.0, 2.0 / texelKm);
	float sSum = observedTop * c.r;
	float sWeight = c.r;
	for (int i = 0; i < 8; i++) {
		float angle = float(i) * 0.785398163 + 0.39;
		vec4 s = raw(vec2(cos(angle), sin(angle)) * near);
		float w = s.r * step(0.5, s.a);
		sSum += s.g * 20.0 * w;
		sWeight += w;
	}
	float top = observedTop + clamp(sSum / max(sWeight, 1e-3) - observedTop, -0.4, 0.4) * (1.0 - edge);

	// Semi-transparent edges of a high system look warmer than they are, so their observed top
	// sits too low: lift them toward the plateau found walking 3 to 18 km into the system (local
	// radiative centre), as a thin plate instead of a slope down to the ground. Assumed, not styled.
	float cSum = 0.0;
	float cWeight = 0.0;
	for (int i = 1; i <= 6; i++) {
		vec4 s = raw(g * float(i) * 3.0 / texelKm);
		float w = smoothstep(0.5, 0.8, s.r) * step(0.5, s.a) * exp(-0.5 * float(i));
		cSum += w * s.g * 20.0;
		cWeight += w;
	}
	float centre = cWeight > 0.05 ? max(top, cSum / cWeight) : top;
	float semi = smoothstep(0.04, 0.2, a) * (1.0 - smoothstep(0.9, 0.97, a));
	float lift = semi * smoothstep(6.0, 9.0, centre) * smoothstep(1.0, 3.0, centre - top) * smoothstep(0.05, 0.3, cWeight);
	top = mix(top, centre - 0.3, 0.9 * lift);

	// By day the finest opacity carries the visible texture: inside an opaque high system its dips
	// are mostly the shadows of domes, cast away from the sun. Keep part of the cover, at most what
	// the visible ratio (never under 0.5) can have taken away, sink the shadow a little and raise
	// the dome found on its sunward side.
	float sunlit = smoothstep(-0.05, 0.05, dot(n, sunDir));
	float inside = smoothstep(0.8, 0.95, aSum / 8.0) * (1.0 - edge) * smoothstep(6.0, 8.0, top) * sunlit;
	float dip = (1.0 - a) * inside;
	a = max(a, min(a + 0.35 * dip, min(1.0, 2.0 * a)));
	vec2 sunward = vec2(dot(sunDir, east), dot(sunDir, north));
	sunward = length(sunward) > 1e-4 ? normalize(sunward) : vec2(0.0);
	float dome = 0.0;
	for (int i = 1; i <= 3; i++) {
		vec4 s = raw(-sunward * float(i) * max(1.0, 1.5 / texelKm));
		dome = max(dome, (1.0 - s.r) * inside);
	}

	float high = smoothstep(5.5, 7.5, top);
	float low = 1.0 - smoothstep(2.5, 4.0, top);
	float mid = clamp(1.0 - high - low, 0.0, 1.0);
	float opaque = smoothstep(0.55, 0.9, a);
	float partial = a * (1.0 - a) * 4.0;

	// Cover: thin high cloud combs into fibres along its edges; the fraying margins of opaque
	// high cloud (anvils) stream outward across them. Saturated interiors stay smooth.
	float width = max(3.5, 3.5 * texelKm);
	float thin = (1.0 - opaque) * smoothstep(4.0, 7.0, top);
	float strokes = band(width) * edge * a * (1.0 - a);
	float fibres = strokes * thin > 1e-3 ? stroke(streaks(p, along, width, 6.0 * width)) * band(width) * edge : 0.0;
	float fringe = strokes * high * opaque > 1e-3 ? stroke(streaks(p, across, width, 4.0 * width)) * band(width) * edge : 0.0;
	float cover = a + 0.45 * a * (1.0 - a) * (fibres * thin + fringe * high * opaque * partial);

	// Tops: billows where the observed tops rise above their opaque surroundings (overshooting tops)
	// or vary a lot (active convection), lobes on mid-level convective cells; anvil plateaus, lifted
	// edges and sheets keep a slow swell.
	float rise = smoothstep(0.3, 1.2, observedTop - hMean) * opaque * high * (1.0 - edge);
	float activity = smoothstep(0.35, 1.0, roughness) * opaque * high;
	float lumpy = max(rise, 0.6 * activity) * (1.0 - lift);
	float cells = opaque * (1.0 - high) * smoothstep(1.5, 3.0, top) * smoothstep(0.2, 0.6, max(roughness, observedTop - hMean));
	float swell = gnoise(p / 14.0 + vec3(3.0, 7.0, 11.0)) * band(14.0);
	float relief = lumpy * 0.75 * billows(p, 4.0) + 0.5 * cells * billows(p, 3.5)
		+ (0.15 * high * opaque + 0.3 * mid * opaque + 0.1 * low) * (1.0 - max(lumpy, cells)) * swell
		+ 0.8 * dome - 0.25 * dip;
	// Styling moves a top at most 0.95 km from its observation; lifted edges move from their lifted top.
	float styledTop = lift > 0.01 ? top + clamp(relief, -0.95, 0.95) : observedTop + clamp(top + relief - observedTop, -0.95, 0.95);

	gl_FragColor = vec4(clamp(cover, 0.0, 1.0), clamp(styledTop, 0.0, 20.0) / 20.0, c.b, c.a);
}
`;

/** Bakes one window of sunlight through the other columns: at the ground and at each column's own top. */
export const sunFragmentShader = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform vec4 bakeWindow;
uniform vec3 sunDir;
uniform float lightGain;
${volumeFieldGlsl}
${overlapGlsl}
${windowGlsl}

float towardSun(vec3 n, float height) {
	vec3 p = n * (6371.0 + height);
	float tau = 0.0;
	float ds = 0.35;
	for (int i = 0; i < 24; i++) {
		vec3 q = p + sunDir * ds;
		float h0 = length(p) - 6371.0;
		float h1 = length(q) - 6371.0;
		if (min(h0, h1) > 20.0) break;
		vec4 f = volumeSample(volumeField, volumeLatLon(p + q));
		if (f.a > 0.5) {
			vec3 c = volumeColumn(f);
			tau += c.z * overlap(h0, h1, c.x, c.y, ds);
		}
		p = q;
		ds *= 1.22;
	}
	return exp(-tau * lightGain);
}

void main() {
	vec2 latLon = bakeLatLon(vUv);
	vec3 n = bakeDirection(latLon);
	// Night side: nothing reads sunlight here (the ground's direct light and the tops' day factor are 0).
	if (dot(n, sunDir) < -0.05) {
		gl_FragColor = vec4(1.0, 1.0, 0.0, 1.0);
		return;
	}
	vec4 f = volumeSample(volumeField, latLon);
	float top = f.a > 0.5 ? f.g * 20.0 : 10.5;
	gl_FragColor = vec4(towardSun(n, 0.05), towardSun(n, top + 0.05), 0.0, 1.0);
}
`;

/**
 * Marches a quarter of the reduced pixels through the columns. Each step integrates the column it
 * crosses exactly and lights it once, at about half a mean free path inside: no random sampling,
 * so a still or gliding view stays clean. Output: light and transmittance, then the mean depth.
 */
export const marchFragmentShader = /* glsl */ `
precision highp float;
uniform mat4 rayMatrix;
uniform vec3 eyeKm;
uniform vec2 marchSize;
uniform vec2 phase;
uniform vec2 subPixel;
uniform float pixelAngle;
uniform vec3 sunDir;
uniform float lightGain;
uniform float scatterGain;
uniform float relief;
uniform float frameJitter;
uniform int maxSamples;
uniform vec3 flashColor;
uniform float flashGain;
${volumeFieldGlsl}
${flashLightGlsl}
${overlapGlsl}
layout(location = 1) out highp vec4 marchDepth;

const float R = 6371.0;
const float SLAB = 20.0;

vec2 sphere(vec3 ro, vec3 rd, float r) {
	float b = dot(ro, rd);
	float c = dot(ro, ro) - r * r;
	float d = b * b - c;
	if (d < 0.0) return vec2(-1.0);
	d = sqrt(d);
	return vec2(-b - d, -b + d);
}

float hg(float c, float g) { return (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * c, 1.5); }

float topAt(vec2 latLon) { return volumeSample(volumeField, latLon).g * 20.0; }

// Light scattered toward the eye over a crossing of len km of a column of extinction sigma, by
// light that fades as exp(-rate * depth below the top); depth is d0 at the entry and grows by
// descent per km. Exact, so a crossing gives the same light however the steps cut it.
float crossing(float sigma, float rate, float d0, float descent, float len) {
	float k = sigma + rate * descent;
	float fade = exp(-rate * d0);
	if (abs(k) < 1e-4) return fade * sigma * len;
	return fade * sigma / k * (1.0 - exp(-k * len));
}

// Normal of the styled top surface at a point, from its slopes over about one pixel of ground.
vec3 surfaceNormal(vec2 latLon, vec3 up, float spanKm) {
	float dLat = spanKm / R;
	float dLon = spanKm / (R * max(cos(latLon.x), 0.2));
	float sx = (topAt(latLon + vec2(0.0, dLon)) - topAt(latLon - vec2(0.0, dLon))) / (2.0 * spanKm);
	float sy = (topAt(latLon + vec2(dLat, 0.0)) - topAt(latLon - vec2(dLat, 0.0))) / (2.0 * spanKm);
	vec3 east = vec3(-sin(latLon.y), 0.0, -cos(latLon.y));
	vec3 north = vec3(-sin(latLon.x) * cos(latLon.y), cos(latLon.x), sin(latLon.x) * sin(latLon.y));
	return normalize(up - (east * sx + north * sy) * relief);
}

void main() {
	// Rays wander within their pixel from frame to frame; the history averages them into smooth edges.
	vec2 px = floor(gl_FragCoord.xy) * 2.0 + phase + 0.5 + subPixel;
	vec2 ndc = px / marchSize * 2.0 - 1.0;
	vec4 far = rayMatrix * vec4(ndc, 1.0, 1.0);
	vec3 rd = normalize(far.xyz / far.w - eyeKm);
	vec3 ro = eyeKm;
	vec2 outer = sphere(ro, rd, R + SLAB);
	vec2 ground = sphere(ro, rd, R);
	if (outer.y < 0.0) {
		gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
		marchDepth = vec4(-1.0);
		return;
	}
	float t0 = max(outer.x, 0.0);
	float t1 = ground.x > 0.0 ? ground.x : outer.y;
	float c = dot(rd, sunDir);
	float phaseSun = mix(hg(c, 0.65), hg(c, -0.2), 0.35);
	float phaseSoft = 0.5 * mix(hg(c, 0.3), 1.0, 0.5);
	float T = 1.0;
	vec3 L = vec3(0.0);
	float glowLight = 0.0;
	float depthSum = 0.0;
	float heightSum = 0.0;
	float depthWeight = 0.0;
	// Each pixel shifts its steps by a low-discrepancy offset that turns every frame, so step
	// boundaries never line up into contours; the first step starts at the slab top, never past it.
	float jitter = fract(dot(floor(gl_FragCoord.xy), vec2(0.7548776662, 0.5698402910)) + frameJitter);
	float t = t0;
	int crossings = 0;
	for (int i = 0; i < 160; i++) {
		if (crossings >= maxSamples || t >= t1 || T < 0.02) break;
		vec3 pm = ro + rd * t;
		vec3 up = normalize(pm);
		float rise = dot(rd, up);
		float across = sqrt(max(1.0 - rise * rise, 0.0));
		// Clear air is crossed about a pixel and a half of ground at a time; inside a column the
		// crossing is cut every half pixel of ground, finer than the relief.
		float foot = max(0.5, 1.2 * t * pixelAngle);
		float sideways = 0.5 * foot / max(across, 1e-3);
		float ds = clamp(1.25 * foot / max(across, 0.12), 0.4, 24.0);
		ds = min(i == 0 ? ds * max(jitter, 0.02) : ds, t1 - t);
		float h0 = length(pm) - R;
		float h1 = length(pm + rd * ds) - R;
		vec4 f = volumeSample(volumeField, volumeLatLon(pm + rd * (0.5 * ds)));
		vec3 col = volumeColumn(f);
		float next = t + ds;
		if (f.a > 0.3 && f.r > 0.003 && overlap(h0, h1, col.x, col.y, ds) > 0.0) {
			// The ray's whole crossing of this column, cut sideways: a column is integrated in one
			// piece wherever the steps fall, so near-vertical views stay clean.
			float ta = t;
			float tb = t + ds;
			if (abs(rise) > 1e-4) {
				float tTop = t + (col.y - h0) / rise;
				float tBase = t + (col.x - h0) / rise;
				ta = max(t, min(tTop, tBase));
				tb = min(max(tTop, tBase), ta + sideways);
			}
			// Read the column again where the ray is inside it: oblique crossings shift sideways.
			vec3 pin = ro + rd * (0.5 * (ta + tb));
			f = volumeSample(volumeField, volumeLatLon(pin));
			col = volumeColumn(f);
			if (abs(rise) > 1e-4) {
				float tTop = t + (col.y - h0) / rise;
				float tBase = t + (col.x - h0) / rise;
				ta = max(t, min(tTop, tBase));
				tb = min(max(tTop, tBase), ta + sideways);
			}
			// Where heights are only partly known (edges of the tiles and windows), the volume gives
			// way to the flat layer by the same share.
			float known = smoothstep(0.3, 0.7, f.a);
			float len = known > 0.0 ? tb - ta : 0.0;
			if (len > 0.0) {
				crossings++;
				next = max(tb, t + 0.05);
				float sigma = col.z;
				float alpha = (1.0 - exp(-sigma * len)) * known;
				// Light, normal and colours are read where the ray has gone about half a mean free
				// path in; the fall of sunlight with depth is integrated exactly along the crossing.
				float tv = ta + min(len, 1.0 / max(sigma, 1e-3)) * 0.5;
				vec3 ps = ro + rd * tv;
				float h = length(ps) - R;
				vec3 nrm = ps / (R + h);
				vec2 ll = volumeLatLon(ps);
				float s = dot(nrm, sunDir);
				float day = smoothstep(-0.03, 0.06, s);
				vec3 lit = vec3(0.0);
				float open = 1.0;
				if (day > 0.0) {
					float d0 = max(col.y - (length(ro + rd * ta) - R), 0.0);
					// A wall facing the sun, with lower cloud or clear air on its sunward side, takes the sun
					// directly instead of through the column above it.
					vec3 sunSide = sunDir - nrm * s;
					if (s > 0.05 && d0 > 0.3 && length(sunSide) > 1e-3) {
						float sideTop = topAt(volumeLatLon(ps + normalize(sunSide) * 1.5));
						d0 = mix(d0, 0.0, smoothstep(-0.5, 1.5, h - sideTop));
					}
					float descent = -rise;
					float k = sigma * lightGain / max(s, 0.25);
					float sunTop = volumeSample(volumeSun, ll).g * day;
					// Relief: the top surface lit by its own slope, fading within about a kilometre; only read
					// where it shows (near the top, on a crossing that is not nearly clear).
					vec3 normal = nrm;
					if (d0 < 2.5 && alpha > 0.02) normal = surfaceNormal(ll, nrm, max(foot, 2.0));
					float tilt = clamp(dot(normal, sunDir) / max(s, 0.05), 0.0, 1.8);
					// Relief shows most under a low sun, and only on dense cloud.
					float m = mix(0.5, 0.9, 1.0 - smoothstep(0.2, 0.6, s)) * (tilt - 1.0) * smoothstep(0.5, 0.9, f.r);
					float direct = sunTop * (crossing(sigma, k, d0, descent, len) + m * crossing(sigma, k + 1.2, d0, descent, len));
					float soft = sqrt(sunTop) * (crossing(sigma, 0.5 * k, d0, descent, len) + 0.5 * m * crossing(sigma, 0.5 * k + 1.2, d0, descent, len));
					float deep = sqrt(sqrt(sunTop)) * crossing(sigma, 0.25 * k, d0, descent, len);
					open = mix(0.55, 1.0, clamp(dot(normal, nrm), 0.0, 1.0));
					// The sun reddens through the air below it: high tops stay white at a low sun, low cloud
					// turns peach, and only near sunset do anvils go ivory and pink.
					float air = exp(-h / 8.0) / max(s + 0.04, 0.03);
					vec3 sunColor = vec3(1.0, 0.97, 0.93) * exp(-max(air - 1.0, 0.0) * vec3(0.03, 0.075, 0.17));
					float powder = 1.0 - exp(-2.0 * sigma * lightGain);
					// A low sun lights tops at a grazing angle; the eye (and the flat layer, by sqrt) keeps them bright.
					float grazing = clamp(0.95 * pow(max(s, 0.05), -0.6), 1.0, 2.2);
					// Thick clouds send back most of the sunlight they get through many scatterings: their
					// brightness follows their real depth, not the transparency kept for the flashes.
					lit = sunColor * (phaseSun * direct + phaseSoft * soft + 0.25 * deep) * mix(0.6, 1.0, powder) * scatterGain * grazing;
				}
				float hn = clamp((h - col.x) / max(col.y - col.x, 0.3), 0.0, 1.0);
				vec3 sky = mix(vec3(0.0012, 0.0015, 0.0025), vec3(0.085, 0.1, 0.13) * mix(0.35, 1.0, smoothstep(0.0, 0.4, s)), smoothstep(-0.12, 0.1, s));
				L += T * (lit * known + sky * mix(0.45, 1.0, hn) * open * alpha);
				// Flashes light the cloud from inside, around the middle of the column. Kept apart from
				// the history, so each flash rises and fades in real time.
				float hm = 0.5 * (length(ro + rd * ta) + length(ro + rd * tb)) - R;
				vec2 geo = vec2(ll.y / 6.283185307 + 0.5, ll.x / 3.141592654 + 0.5);
				float glow = flashLightAtLod(geo) * exp(-pow((hm - 8.5) / 3.5, 2.0));
				glowLight += T * (1.0 - exp(-flashGain * glow)) * 2.5 * alpha;
				depthSum += T * alpha * tv;
				heightSum += T * alpha * h;
				depthWeight += T * alpha;
				T *= 1.0 - alpha;
			}
		}
		t = next;
	}
	gl_FragColor = vec4(L, T);
	// Depth for the reprojection, glow of the flashes, height of the cloud seen (for the haze above it).
	marchDepth = vec4(depthWeight > 0.0 ? depthSum / depthWeight : t1, glowLight, depthWeight > 0.0 ? heightSum / depthWeight : 0.0, 1.0);
}
`;

/** Rebuilds the reduced image from this frame's quarter and the history, reprojected at the clouds' depth. */
export const resolveFragmentShader = /* glsl */ `
precision highp float;
uniform sampler2D fresh;
uniform sampler2D freshDepth;
uniform sampler2D history;
uniform vec2 freshSize;
uniform vec2 marchSize;
uniform vec2 phase;
uniform mat4 rayMatrix;
uniform vec3 eyeKm;
uniform mat4 previous;
uniform float historyValid;

void main() {
	vec2 px = floor(gl_FragCoord.xy);
	vec2 q = (px - phase) / 2.0;
	ivec2 q0 = ivec2(floor(q));
	ivec2 hi = ivec2(freshSize) - 1;
	ivec2 i00 = clamp(q0, ivec2(0), hi);
	vec4 a = texelFetch(fresh, i00, 0);
	vec4 b = texelFetch(fresh, clamp(q0 + ivec2(1, 0), ivec2(0), hi), 0);
	vec4 c = texelFetch(fresh, clamp(q0 + ivec2(0, 1), ivec2(0), hi), 0);
	vec4 d = texelFetch(fresh, clamp(q0 + ivec2(1, 1), ivec2(0), hi), 0);
	vec2 f = fract(q);
	vec4 up = mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
	bool isFresh = all(equal(mod(px, 2.0), phase));
	vec4 current = isFresh ? a : up;
	if (historyValid < 0.5) {
		gl_FragColor = current;
		return;
	}
	// Where this pixel's clouds were last frame, from the depth marched at the nearest fresh pixel.
	float depth = texelFetch(freshDepth, i00, 0).r;
	vec2 ndc = (px + 0.5) / marchSize * 2.0 - 1.0;
	vec4 far = rayMatrix * vec4(ndc, 1.0, 1.0);
	vec3 rd = normalize(far.xyz / far.w - eyeKm);
	vec4 clip = previous * vec4(eyeKm + rd * depth, 1.0);
	vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
	if (depth <= 0.0 || clip.w <= 0.0 || any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) {
		gl_FragColor = current;
		return;
	}
	// Still views keep a long history (the jittered steps average out); moving ones, and pixels whose
	// clouds change (a new frame, a moving terminator), trust it less, clamped to what this frame
	// marched nearby, so nothing smears.
	float motion = length(uv * marchSize - (px + 0.5));
	float moving = smoothstep(0.05, 0.75, motion);
	vec4 kept = texture2D(history, uv);
	// Only a change of cover (a new frame, clouds coming or going) shortens the history; light
	// that varies with the jittered steps is what the history averages away.
	float change = smoothstep(0.1, 0.3, abs(a.a - kept.a));
	float box = mix(0.15, 0.05, moving);
	vec4 lo = min(min(a, b), min(c, d)) - box;
	vec4 hiv = max(max(a, b), max(c, d)) + box;
	vec4 past = clamp(kept, lo, hiv);
	gl_FragColor = isFresh ? mix(past, a, mix(mix(0.05, 0.35, moving), 0.6, change)) : past;
}
`;

/** Draws the resolved clouds over the ground: straight colour and coverage, faded with the flat layer. */
export const compositeVertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
	vUv = position.xy * 0.5 + 0.5;
	gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const compositeFragmentShader = /* glsl */ `
varying vec2 vUv;
uniform sampler2D resolved;
uniform sampler2D freshDepth;
uniform vec2 marchSize;
uniform vec2 freshSize;
uniform vec2 phase;
uniform vec3 flashColor;
uniform float fade;
void main() {
	vec4 c = texture2D(resolved, vUv);
	// The flashes' glow comes straight from this frame's quarter, never from the history.
	vec2 q = ((vUv * marchSize - phase - 0.5) / 2.0 + 0.5) / freshSize;
	float glow = texture2D(freshDepth, q).g;
	float coverage = (1.0 - c.a) * fade;
	gl_FragColor = vec4((c.rgb + flashColor * glow) / max(1.0 - c.a, 1e-3), coverage);
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}
`;
