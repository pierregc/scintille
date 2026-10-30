/**
 * Field of the cloud columns around the view (ADR 0031): what the volume, the ground, the lightning
 * and the flat layer share. Texel: styled opacity, styled top / 20 km, convective core, heights known.
 */
export const volumeFieldGlsl = /* glsl */ `
uniform highp sampler2DArray volumeField;
uniform highp sampler2DArray volumeSun;
uniform vec4 volumeWindows[4];
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
	for (int k = 0; k < 4; k++) {
		vec3 w = volumeWindowUv(latLon, k);
		if (w.z < 0.98) return vec3(w.xy, float(k));
	}
	return vec3(0.0, 0.0, -1.0);
}

// A baked texture at a point: the finest window, faded into the next one near its edge so the
// detail of two windows never meets at a visible seam. Alpha 0 outside every window.
vec4 volumeSample(highp sampler2DArray map, vec2 latLon) {
	for (int k = 0; k < 4; k++) {
		vec3 w = volumeWindowUv(latLon, k);
		if (w.z >= 0.98) continue;
		vec4 fine = textureLod(map, vec3(w.xy, float(k)), 0.0);
		float edge = smoothstep(0.82, 0.96, w.z);
		// Past the coarsest window the flat layer takes over: fade into it, never along a straight seam.
		if (k == 3) return vec4(fine.rgb, fine.a * (1.0 - edge));
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
