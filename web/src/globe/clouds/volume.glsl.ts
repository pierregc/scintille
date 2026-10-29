import { flashLightGlsl } from '../lightning/light-map.glsl';
import { cloudOpacityGlsl } from './clouds.glsl';

/** Field of the cloud columns around the view (ADR 0028): what other materials share. */
export const volumeFieldGlsl = /* glsl */ `
uniform highp sampler2DArray volumeField;
uniform highp sampler2DArray volumeSun;
uniform vec4 volumeWindows[4];
uniform float volumeOn;

// Latitude and longitude (radians) of a direction in the Earth's frame.
vec2 volumeLatLon(vec3 n) {
	n = normalize(n);
	return vec2(asin(clamp(n.y, -1.0, 1.0)), atan(-n.z, n.x));
}

// The finest baked window holding a point and its texture coordinates; z is -1 outside them all.
vec3 volumeWindowAt(vec2 latLon) {
	for (int k = 0; k < 4; k++) {
		vec4 w = volumeWindows[k];
		vec2 d = vec2(mod(latLon.y - w.y + 3.141592654, 6.283185307) - 3.141592654, latLon.x - w.x) / w.wz;
		if (max(abs(d.x), abs(d.y)) < 0.98) return vec3(d * 0.5 + 0.5, float(k));
	}
	return vec3(0.0, 0.0, -1.0);
}

// Base and top (km above sea level) and extinction (per km) of the column over a field texel:
// observed top and opacity, assumed thickness (ADR 0028). Without heights, a 1 km layer at 10 km.
vec3 volumeColumn(vec4 f) {
	float a = min(f.r, 0.95);
	float top = 10.5;
	float thick = 1.0;
	if (f.a > 0.5) {
		top = f.g * 20.0;
		thick = mix(0.7, 1.0, smoothstep(1.0, 3.0, top));
		thick = mix(thick, mix(1.5, 2.5, smoothstep(0.6, 0.85, a)), smoothstep(3.0, 6.0, top));
		thick = mix(thick, top - 1.5, f.b * smoothstep(6.0, 10.0, top));
	}
	float base = max(0.3, top - thick);
	return vec3(base, top, -log(1.0 - a) / max(top - base, 0.3));
}

// Observed cloud top (km) over a direction in the Earth's frame; negative where unknown.
float cloudTopAt(vec3 direction) {
	if (volumeOn < 0.5) return -1.0;
	vec3 w = volumeWindowAt(volumeLatLon(direction));
	if (w.z < 0.0) return -1.0;
	vec4 f = textureLod(volumeField, w, 0.0);
	return f.a > 0.5 && f.r > 0.05 ? f.g * 20.0 : -1.0;
}

// Share of sunlight reaching the ground under the clouds at a direction in the Earth's frame.
float cloudShadowAt(vec3 direction) {
	if (volumeOn < 0.5) return 1.0;
	vec3 w = volumeWindowAt(volumeLatLon(direction));
	return w.z < 0.0 ? 1.0 : mix(1.0, textureLod(volumeSun, w, 0.0).r, volumeOn);
}
`;

const overlapGlsl = /* glsl */ `
// Length of the segment from height h0 to h1 (over len km) that lies between lo and hi.
float overlap(float h0, float h1, float lo, float hi, float len) {
	float a = min(h0, h1);
	float b = max(h0, h1);
	if (b - a < 1e-3) return (a >= lo && a <= hi) ? len : 0.0;
	return len * max(0.0, min(b, hi) - max(a, lo)) / (b - a);
}
`;

export const passVertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
	vUv = position.xy * 0.5 + 0.5;
	gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** Tileable Perlin-Worley noise, one slice per draw: red low-frequency cloud shapes, green to alpha finer cells. */
export const noiseFragmentShader = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform float slice;

vec3 hash3(vec3 p) {
	p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
	return fract(sin(p) * 43758.5453123);
}

float worley(vec3 p, float cells) {
	p *= cells;
	vec3 i = floor(p);
	vec3 f = fract(p);
	float best = 1.0;
	for (int z = -1; z <= 1; z++)
		for (int y = -1; y <= 1; y++)
			for (int x = -1; x <= 1; x++) {
				vec3 o = vec3(float(x), float(y), float(z));
				vec3 c = mod(i + o, cells);
				best = min(best, length(o + hash3(c) - f));
			}
	return 1.0 - best;
}

float perlin(vec3 p, float cells) {
	p *= cells;
	vec3 i = floor(p);
	vec3 f = fract(p);
	vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
	float v = 0.0;
	for (int z = 0; z <= 1; z++)
		for (int y = 0; y <= 1; y++)
			for (int x = 0; x <= 1; x++) {
				vec3 o = vec3(float(x), float(y), float(z));
				vec3 g = normalize(hash3(mod(i + o, cells)) * 2.0 - 1.0);
				vec3 w = mix(1.0 - u, u, o);
				v += w.x * w.y * w.z * dot(g, f - o);
			}
	return v;
}

void main() {
	vec3 p = vec3(vUv, (slice + 0.5) / 64.0);
	float pf = clamp((perlin(p, 4.0) + 0.5 * perlin(p, 8.0) + 0.25 * perlin(p, 16.0)) * 0.8 + 0.5, 0.0, 1.0);
	float w4 = worley(p, 4.0);
	float w8 = worley(p, 8.0);
	float w16 = worley(p, 16.0);
	float wf = w4 * 0.625 + w8 * 0.25 + w16 * 0.125;
	gl_FragColor = vec4(clamp(pf * 0.55 + wf * 0.45, 0.0, 1.0), w4, w8, w16);
}
`;

/** Bakes one window of the field: blended opacity, observed top, convective core, heights known. */
export const fieldFragmentShader = /* glsl */ `
precision highp float;
precision highp sampler2DArray;
varying vec2 vUv;
uniform vec4 bakeWindow;
uniform float bakeTexels;
${cloudOpacityGlsl}
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
	vec2 latLon = vec2(bakeWindow.x + (vUv.y * 2.0 - 1.0) * bakeWindow.z, bakeWindow.y + (vUv.x * 2.0 - 1.0) * bakeWindow.w);
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

/** Bakes one window of sunlight transmittance at 0, 4, 8 and 12 km through the columns. */
export const sunFragmentShader = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform vec4 bakeWindow;
uniform vec3 sunDir;
uniform float lightGain;
${volumeFieldGlsl}
${overlapGlsl}
void main() {
	vec2 latLon = vec2(bakeWindow.x + (vUv.y * 2.0 - 1.0) * bakeWindow.z, bakeWindow.y + (vUv.x * 2.0 - 1.0) * bakeWindow.w);
	vec3 n = vec3(cos(latLon.x) * cos(latLon.y), sin(latLon.x), -cos(latLon.x) * sin(latLon.y));
	vec4 t;
	for (int k = 0; k < 4; k++) {
		vec3 p = n * (6371.0 + float(k) * 4.0);
		float tau = 0.0;
		float ds = 0.6;
		for (int i = 0; i < 10; i++) {
			vec3 q = p + sunDir * ds;
			float h0 = length(p) - 6371.0;
			float h1 = length(q) - 6371.0;
			if (min(h0, h1) > 20.0) break;
			vec3 w = volumeWindowAt(volumeLatLon(p + q));
			if (w.z >= 0.0) {
				vec3 c = volumeColumn(textureLod(volumeField, w, 0.0));
				tau += c.z * overlap(h0, h1, c.x, c.y, ds);
			}
			p = q;
			ds *= 1.5;
		}
		t[k] = exp(-tau * lightGain);
	}
	gl_FragColor = t;
}
`;

/** Marches a quarter of the reduced pixels through the columns, with styled detail (ADR 0030). */
export const marchFragmentShader = /* glsl */ `
precision highp float;
precision highp sampler3D;
uniform mat4 rayMatrix;
uniform vec3 eyeKm;
uniform vec2 marchSize;
uniform vec2 phase;
uniform float frameSeed;
uniform highp sampler3D noise;
uniform float detail;
uniform float driftKm;
uniform vec3 sunDir;
uniform float lightGain;
uniform int maxSamples;
uniform vec3 flashColor;
uniform float flashGain;
${volumeFieldGlsl}
${flashLightGlsl}
${overlapGlsl}

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

float remap(float v, float a, float b, float c, float d) { return c + (v - a) / (b - a) * (d - c); }
float hg(float c, float g) { return (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * c, 1.5); }

// Density at p of a column (base, top, extinction) of opacity a; the noise erodes it below the
// observations' scale and bends its top by up to 0.7 km.
float density(vec3 p, float h, vec3 col, float a, bool fine) {
	float thick = max(col.y - col.x, 0.3);
	float hn = (h - col.x) / thick;
	if (detail < 0.5) return (hn >= 0.0 && hn <= 1.0) ? col.z : 0.0;
	if (hn < -0.1 || h > col.y + 0.8) return 0.0;
	vec3 q = (p + vec3(driftKm, 0.0, 0.0)) / 22.0;
	vec4 n = texture(noise, q);
	hn -= (n.r - 0.5) * 1.4 / thick;
	float prof = smoothstep(-0.1, 0.12, hn) * (1.0 - smoothstep(0.85, 1.0, hn));
	float cells = n.g * 0.625 + n.b * 0.25 + n.a * 0.125;
	float shape = remap(n.r, cells - 1.0, 1.0, 0.0, 1.0);
	float cover = clamp(a / 0.95, 0.0, 1.0);
	float broken = clamp(remap(shape * prof, 1.0 - cover * 0.92 - 0.08, 1.0, 0.0, 1.0), 0.0, 1.0);
	// Thin clouds stay veils, gently textured; thick ones break into cells and wisps.
	float veil = prof * (0.7 + 0.6 * n.r);
	float solid = smoothstep(0.45, 0.85, a);
	float d = mix(veil, broken * 3.0, solid);
	if (d <= 0.0 || !fine || solid < 0.01) return col.z * d;
	vec4 m = texture(noise, q * 5.5);
	float wisps = m.g * 0.625 + m.b * 0.25 + m.a * 0.125;
	float eroded = clamp(remap(broken, wisps * 0.35 * (1.0 - broken), 1.0, 0.0, 1.0), 0.0, 1.0);
	return col.z * mix(veil, eroded * 3.0, solid);
}

float sunAt(vec3 w, float h) {
	vec4 t = textureLod(volumeSun, w, 0.0);
	float x = clamp(h / 4.0, 0.0, 3.0);
	return x < 1.0 ? mix(t.x, t.y, x) : x < 2.0 ? mix(t.y, t.z, x - 1.0) : mix(t.z, t.w, x - 2.0);
}

void main() {
	vec2 px = floor(gl_FragCoord.xy) * 2.0 + phase + 0.5;
	vec2 ndc = px / marchSize * 2.0 - 1.0;
	vec4 far = rayMatrix * vec4(ndc, 1.0, 1.0);
	vec3 rd = normalize(far.xyz / far.w - eyeKm);
	vec3 ro = eyeKm;
	vec2 outer = sphere(ro, rd, R + SLAB);
	if (outer.y < 0.0) {
		gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
		return;
	}
	vec2 ground = sphere(ro, rd, R);
	float t0 = max(outer.x, 0.0);
	float t1 = ground.x > 0.0 ? ground.x : outer.y;
	vec3 up = normalize(ro + rd * t0);
	float sinH = sqrt(max(1.0 - pow(dot(rd, up), 2.0), 0.0));
	float c = dot(rd, sunDir);
	float phaseSun = mix(hg(c, 0.65), hg(c, -0.2), 0.35);
	float jitter = fract(52.9829189 * fract(dot(px + frameSeed * 5.588238, vec2(0.06711056, 0.00583715))));
	float T = 1.0;
	vec3 L = vec3(0.0);
	float t = t0 + jitter * clamp(0.7 / max(sinH, 0.12), 0.4, 16.0);
	int samples = 0;
	for (int i = 0; i < 96; i++) {
		if (samples >= maxSamples || t >= t1 || T < 0.02) break;
		vec3 pm = ro + rd * t;
		vec3 w = volumeWindowAt(volumeLatLon(pm));
		float texel = w.z < 0.5 ? 1.0 : w.z < 1.5 ? 2.0 : w.z < 2.5 ? 4.0 : 8.0;
		float ds = min(clamp(0.7 * texel / max(sinH, 0.12), 0.4, 16.0), t1 - t);
		if (w.z < 0.0) {
			t += ds;
			continue;
		}
		vec3 p1 = ro + rd * (t + ds);
		float h0 = length(pm) - R;
		float h1 = length(p1) - R;
		vec4 f = textureLod(volumeField, volumeWindowAt(volumeLatLon(pm + p1)), 0.0);
		vec3 col = volumeColumn(f);
		float lo = col.x - (detail > 0.5 ? 0.4 : 0.0);
		float hi = col.y + (detail > 0.5 ? 0.8 : 0.0);
		if (f.r > 0.003 && overlap(h0, h1, lo, hi, ds) > 0.0) {
			float ta = t;
			float tb = t + ds;
			if (abs(h1 - h0) > 1e-3) {
				float fa = clamp((lo - h0) / (h1 - h0), 0.0, 1.0);
				float fb = clamp((hi - h0) / (h1 - h0), 0.0, 1.0);
				ta = t + ds * min(fa, fb);
				tb = t + ds * max(fa, fb);
			}
			int sub = detail > 0.5 ? int(clamp(ceil((tb - ta) / 0.45), 1.0, 6.0)) : 1;
			float dl = (tb - ta) / float(sub);
			for (int j = 0; j < 6; j++) {
				if (j >= sub || T < 0.02) break;
				vec3 p = ro + rd * (ta + (float(j) + jitter) * dl);
				float h = length(p) - R;
				float sigma = density(p, h, col, f.r, true);
				samples++;
				if (sigma <= 0.0) continue;
				vec3 nrm = p / (R + h);
				float s = dot(nrm, sunDir);
				float day = smoothstep(-0.03, 0.06, s);
				float sun = sunAt(w, clamp(h, col.x, col.y)) * day;
				if (detail > 0.5 && sun > 0.01) {
					vec3 q1 = p + sunDir * 0.4;
					vec3 q2 = p + sunDir * 1.2;
					float occ = density(q1, length(q1) - R, col, f.r, false) * 0.4 + density(q2, length(q2) - R, col, f.r, false) * 0.8;
					sun *= exp(-occ * lightGain);
				}
				float hn = clamp((h - col.x) / max(col.y - col.x, 0.3), 0.0, 1.0);
				vec3 sunColor = mix(vec3(1.0, 0.5, 0.25), vec3(1.0, 0.96, 0.9), smoothstep(0.03, 0.45, s));
				float scatter = phaseSun * sun + 0.5 * mix(hg(c, 0.3), 1.0, 0.5) * sqrt(sun) + 0.25 * sqrt(sqrt(sun));
				float powder = 1.0 - exp(-2.0 * sigma * lightGain);
				vec3 sky = mix(vec3(0.0012, 0.0015, 0.0025), vec3(0.11, 0.14, 0.2) * mix(0.35, 1.0, smoothstep(0.0, 0.4, s)), smoothstep(-0.12, 0.1, s));
				vec3 S = sunColor * scatter * mix(0.55, 1.0, powder) * 0.75 + sky * mix(0.4, 1.0, hn);
				vec2 geo = vec2(atan(-nrm.z, nrm.x) / 6.283185307 + 0.5, asin(clamp(nrm.y, -1.0, 1.0)) / 3.141592654 + 0.5);
				float glow = flashLightAt(geo) * exp(-pow((h - 8.5) / 3.5, 2.0));
				S += flashColor * (1.0 - exp(-flashGain * glow)) * 2.5;
				float alpha = 1.0 - exp(-sigma * dl);
				L += T * alpha * S;
				T *= 1.0 - alpha;
			}
		}
		t += ds;
		samples++;
	}
	gl_FragColor = vec4(L, T);
}
`;

/** Rebuilds the reduced image from this frame's quarter and the reprojected history. */
export const resolveFragmentShader = /* glsl */ `
precision highp float;
uniform sampler2D fresh;
uniform sampler2D history;
uniform vec2 freshSize;
uniform vec2 marchSize;
uniform vec2 phase;
uniform mat4 rayMatrix;
uniform vec3 eyeKm;
uniform mat4 previous;
uniform float historyValid;

vec2 sphere(vec3 ro, vec3 rd, float r) {
	float b = dot(ro, rd);
	float c = dot(ro, ro) - r * r;
	float d = b * b - c;
	if (d < 0.0) return vec2(-1.0);
	d = sqrt(d);
	return vec2(-b - d, -b + d);
}

void main() {
	vec2 px = floor(gl_FragCoord.xy);
	vec2 q = (px - phase) / 2.0;
	ivec2 q0 = ivec2(floor(q));
	ivec2 hi = ivec2(freshSize) - 1;
	vec4 a = texelFetch(fresh, clamp(q0, ivec2(0), hi), 0);
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
	vec2 ndc = (px + 0.5) / marchSize * 2.0 - 1.0;
	vec4 far = rayMatrix * vec4(ndc, 1.0, 1.0);
	vec3 rd = normalize(far.xyz / far.w - eyeKm);
	vec2 shell = sphere(eyeKm, rd, 6379.0);
	vec2 ground = sphere(eyeKm, rd, 6371.0);
	float t = shell.x > 0.0 ? shell.x : ground.x > 0.0 ? ground.x : max(shell.y, 0.0);
	vec4 clip = previous * vec4(eyeKm + rd * t, 1.0);
	vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
	if (t <= 0.0 || clip.w <= 0.0 || any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) {
		gl_FragColor = current;
		return;
	}
	vec4 lo = min(min(a, b), min(c, d)) - 0.1;
	vec4 hiv = max(max(a, b), max(c, d)) + 0.1;
	vec4 past = clamp(texture2D(history, uv), lo, hiv);
	gl_FragColor = isFresh ? mix(past, a, 0.5) : past;
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
uniform float fade;
void main() {
	vec4 c = texture2D(resolved, vUv);
	float coverage = (1.0 - c.a) * fade;
	gl_FragColor = vec4(c.rgb / max(1.0 - c.a, 1e-3), coverage);
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}
`;
