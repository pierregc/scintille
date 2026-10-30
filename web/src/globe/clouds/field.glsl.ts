/**
 * Field of the cloud columns around the view (ADR 0031): what the volume, the ground, the lightning
 * and the flat layer share. Texel: styled opacity, styled top / 20 km, convective core, heights known.
 */
export const volumeFieldGlsl = /* glsl */ `
uniform highp sampler2DArray volumeField;
uniform highp sampler2DArray volumeSun;
uniform vec4 volumeWindows[5];
// Windows in use: the four of the march, or up to five while only the far relief is baked.
uniform int volumeCount;
uniform float volumeOn;
uniform float volumeMaxOpacity;
uniform float volumeKnee;
uniform float volumeVeilOpacity;

// Latitude and longitude (radians) of a direction in the Earth's frame.
vec2 volumeLatLon(vec3 n) {
	n = normalize(n);
	return vec2(asin(clamp(n.y, -1.0, 1.0)), atan(-n.z, n.x));
}

// Texture coordinates of a point in window k and how far it is from the window's centre (0 to 1).
vec3 volumeWindowUv(vec2 latLon, int k) {
	vec4 w = volumeWindows[k];
	vec2 d = vec2(mod(latLon.y - w.y + 3.141592654, 6.283185307) - 3.141592654, latLon.x - w.x) / w.wz;
	return vec3(d * 0.5 + 0.5, max(abs(d.x), abs(d.y)));
}

// The finest baked window holding a point and its texture coordinates; z is -1 outside them all.
vec3 volumeWindowAt(vec2 latLon) {
	for (int k = 0; k < 5; k++) {
		if (k >= volumeCount) break;
		vec3 w = volumeWindowUv(latLon, k);
		if (w.z < 0.98) return vec3(w.xy, float(k));
	}
	return vec3(0.0, 0.0, -1.0);
}

// A baked texture at a point: the finest window, faded into the next one near its edge so the
// detail of two windows never meets at a visible seam. Alpha 0 outside every window.
vec4 volumeSample(highp sampler2DArray map, vec2 latLon) {
	for (int k = 0; k < 5; k++) {
		if (k >= volumeCount) break;
		vec3 w = volumeWindowUv(latLon, k);
		if (w.z >= 0.98) continue;
		vec4 fine = textureLod(map, vec3(w.xy, float(k)), 0.0);
		float edge = smoothstep(0.82, 0.96, w.z);
		// Past the coarsest window the flat layer takes over: fade into it, never along a straight seam.
		if (k == volumeCount - 1) return vec4(fine.rgb, fine.a * (1.0 - edge));
		if (edge <= 0.0) return fine;
		vec3 c = volumeWindowUv(latLon, k + 1);
		if (c.z >= 0.98) return fine;
		return mix(fine, textureLod(map, vec3(c.xy, float(k + 1)), 0.0), edge);
	}
	return vec4(0.0);
}

// Opacity for a cover: as observed up to the knee, then eased to a cap at full cover (ADR 0031).
float easeOpacity(float cover, float cap) {
	float a = clamp(cover, 0.0, 1.0);
	return a <= volumeKnee ? a : volumeKnee + (a - volumeKnee) * (cap - volumeKnee) / (1.0 - volumeKnee);
}
// Opacity of the clouds drawn straight down.
float capOpacity(float cover) { return easeOpacity(cover, volumeMaxOpacity); }
// Opacity of the clouds over a flash, lower so the densest clouds let flashes show through.
float veilOpacity(float cover) { return easeOpacity(cover, volumeVeilOpacity); }

// Base and top (km above sea level) and extinction (per km) of the column over a field texel:
// observed top and cover, assumed thickness, opacity straight down eased by capOpacity.
vec3 volumeColumn(vec4 f) {
	float a = capOpacity(f.r);
	float top = f.g * 20.0;
	float thick = mix(0.7, 1.0, smoothstep(1.0, 3.0, top));
	thick = mix(thick, mix(1.5, 2.5, smoothstep(0.6, 0.85, f.r)), smoothstep(3.0, 6.0, top));
	thick = mix(thick, top - 1.5, f.b * smoothstep(6.0, 10.0, top));
	// Bases stay 0.3 km up, except under the lowest tops, which keep at least 0.3 km of cloud.
	float base = max(0.0, min(max(0.3, top - thick), top - 0.3));
	return vec3(base, top, -log(1.0 - a) / max(top - base, 0.05));
}

// Extinction (per km) sunlight meets in a column, from the lighter veil: it sets how deep light and
// shadows reach, whatever the opacity the cloud is drawn with.
float lightSigma(vec4 f, vec3 col) { return -log(1.0 - veilOpacity(f.r)) / max(col.y - col.x, 0.05); }

// Share of a direction (Earth's frame) where the volume draws the clouds: heights known there.
float cloudKnownAt(vec3 direction) {
	if (volumeOn <= 0.0) return 0.0;
	return smoothstep(0.3, 0.7, volumeSample(volumeField, volumeLatLon(direction)).a) * volumeOn;
}

// Cloud top (km) over a direction in the Earth's frame; negative where unknown.
float cloudTopAt(vec3 direction) {
	if (volumeOn < 0.5) return -1.0;
	vec4 f = volumeSample(volumeField, volumeLatLon(direction));
	return f.a > 0.5 && f.r > 0.05 ? f.g * 20.0 : -1.0;
}

// Share of sunlight reaching the ground under the clouds at a direction in the Earth's frame.
float cloudShadowAt(vec3 direction) {
	if (volumeOn <= 0.0) return 1.0;
	vec4 s = volumeSample(volumeSun, volumeLatLon(direction));
	return mix(1.0, s.a > 0.5 ? s.r : 1.0, volumeOn);
}
`;

/**
 * Far relief (ADR 0031): the light of the dense tops' broad shape and the sunlit share of each top,
 * baked in the 4, 8 and 16 km windows, read at full resolution where a screen pixel covers some
 * kilometres. Include after `volumeFieldGlsl`.
 */
export const reliefFieldGlsl = /* glsl */ `
uniform highp sampler2DArray volumeRelief;
uniform float reliefOn;
uniform float shadeOn;

// Deck light, far relief light and sunlit share at the top in window k and coarser, faded into the
// next window near its edge; (1, 1, 1) past them all.
vec3 reliefIn(vec2 latLon, int from) {
	for (int k = 2; k < 5; k++) {
		if (k < from) continue;
		vec3 w = volumeWindowUv(latLon, k);
		if (w.z >= 0.98) continue;
		vec3 fine = textureLod(volumeRelief, vec3(w.xy, float(k - 2)), 0.0).rgb;
		float edge = smoothstep(0.82, 0.96, w.z);
		if (edge <= 0.0) return fine;
		vec3 coarse = vec3(1.0);
		if (k < 4) {
			vec3 c = volumeWindowUv(latLon, k + 1);
			if (c.z < 0.98) coarse = textureLod(volumeRelief, vec3(c.xy, float(k - 1)), 0.0).rgb;
		}
		return mix(fine, coarse, edge);
	}
	return vec3(1.0);
}

// The relief at a point seen with pxKm km per CSS pixel, from the window whose texel spans about
// 3.4 pixels: broad shapes 10 to 40 pixels across while a pixel covers up to about 4.7 km.
vec3 farRelief(vec2 latLon, float pxKm) {
	float level = log2(max(pxKm * 3.4, 1e-3));
	float lod = clamp(level, 2.0, 4.0);
	int k = int(floor(lod));
	vec3 r = reliefIn(latLon, k);
	if (lod > float(k)) r = mix(r, reliefIn(latLon, k + 1), lod - float(k));
	return mix(r, vec3(1.0), smoothstep(5.0, 5.6, level));
}

// Share of the far relief light where a pixel covers pxKm km: the volume's own light until then.
float reliefShare(float pxKm) { return reliefOn * smoothstep(0.9, 1.6, pxKm); }

// How much of the far relief light shows: where pixels are large enough and cloud dense enough.
float reliefWeight(float pxKm, float cover) { return reliefShare(pxKm) * smoothstep(0.4, 0.8, cover); }

// A colour toned by the far relief light: shade turns a little bluer, light only fills the headroom.
vec3 reliefTone(vec3 c, float f) {
	if (f >= 1.0) return c + c * max(1.0 - c, 0.0) * (f - 1.0) * 2.0;
	return c * f * mix(vec3(1.0), vec3(0.85, 0.95, 1.15), clamp(2.0 * (1.0 - f), 0.0, 1.0));
}
`;
