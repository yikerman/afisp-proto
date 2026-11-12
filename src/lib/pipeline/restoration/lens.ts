// Ported from darktable's embedded-metadata lens correction (GPL-3.0-or-later) at master
// bdce4fed98499b90077946e323f08069b979ee79; line numbers below refer to that revision.

import type { Gpu } from '../../gpu/gpu';
import { upload, type Image, type Size, type Texture } from '../../gpu/image';
import { run } from '../../gpu/pass';
import { float } from '../../gpu/uniforms';
import type { GeometryKnot, LensCorrection } from '../../raw/lensData';

type Channel = 'red' | 'green' | 'blue';
const channels: readonly Channel[] = ['red', 'green', 'blue'];

/** The knot function at `radius`, read as the shader reads it (`interpolate` below). */
export function evaluate<K extends { readonly radius: number }>(
	knots: readonly K[],
	value: (knot: K) => number,
	radius: number
): number {
	const after = knots.findIndex((knot) => knot.radius > radius);
	if (after === 0) return value(knots[0]);
	if (after === -1) return value(knots[knots.length - 1]);
	const [a, b] = [knots[after - 1], knots[after]];
	return value(a) + ((radius - a.radius) / (b.radius - a.radius)) * (value(b) - value(a));
}

/**
 * The magnification `s` that keeps the corrected frame inside the input: an
 * output pixel at radius r reads channel c at radius (r / s) g_c(r / s).
 *
 * A pixel on the frame's edge is read on the same edge line or inside it
 * exactly when g_c(r / s) <= s, and the edge covers the radii from half the
 * shorter side to the corner. If the source radius t g_c(t) grows with t, as
 * it does for any lens, that bounds the interior too, so the condition holds
 * for every pixel when it holds for these radii. The smallest such s is found
 * by bisection; between knots g is linear, so its largest value over a range
 * of radii is at the range's ends or at a knot.
 *
 * darktable (src/iop/lens.cc:2783-2819) instead takes the largest g over the
 * same radii without dividing them by s, which only approximates this
 * condition, and clamps what falls outside.
 */
export function autoscale(geometry: readonly GeometryKnot[], size: Size): number {
	const halfDiagonal = Math.hypot(size.width, size.height) / 2;
	const shortest = Math.min(size.width, size.height) / 2 / halfDiagonal;
	const largest = (from: number, to: number) => {
		const radii = [from, to, ...geometry.map((k) => k.radius).filter((r) => r > from && r < to)];
		return Math.max(
			...radii.flatMap((r) => channels.map((c) => evaluate(geometry, (k) => k[c], r)))
		);
	};
	const all = geometry.flatMap((k) => channels.map((c) => k[c]));
	let [low, high] = [Math.min(...all), Math.max(...all)];
	while (high - low > 1e-9) {
		const s = (low + high) / 2;
		if (largest(shortest / s, 1 / s) <= s) high = s;
		else low = s;
	}
	return high;
}

// Linear between knots and constant outside them, as darktable's
// _interpolate_linear_spline (src/iop/lens.cc:2319). Knots are texels of a
// one-row texture, radius in x.
const interpolate = /* glsl */ `
vec4 knot(sampler2D knots, int i) {
	return texelFetch(knots, ivec2(i, 0), 0);
}

vec4 interpolate(sampler2D knots, float radius) {
	int n = textureSize(knots, 0).x;
	if (radius <= knot(knots, 0).x) { return knot(knots, 0); }
	if (radius >= knot(knots, n - 1).x) { return knot(knots, n - 1); }
	int low = 0;
	int high = n - 1;
	while (high - low > 1) {
		int middle = (low + high) / 2;
		if (knot(knots, middle).x <= radius) { low = middle; } else { high = middle; }
	}
	vec4 a = knot(knots, low);
	vec4 b = knot(knots, high);
	return mix(a, b, (radius - a.x) / (b.x - a.x));
}

float radius_of(vec2 position) {
	vec2 size = vec2(textureSize(camera, 0));
	return length(position - size / 2.0) / (length(size) / 2.0);
}`;

const vignettingGlsl = /* glsl */ `
${interpolate}

vec4 pixel(ivec2 p) {
	float gain = interpolate(vignetting, radius_of(vec2(p) + 0.5)).y;
	return vec4(texelFetch(camera, p, 0).rgb * gain, 1);
}`;

// Bicubic with a = -0.5 (Keys 1981), darktable's bicubic
// (_maketaps_bicubic, src/common/interpolation.c:193), and like its
// dt_interpolation_compute_sample, mirrored at the border (interpolation.c:486).
// `autoscale` keeps every position inside the frame, so a mirrored tap is at
// most two texels outside it and lands inside.
const geometryGlsl = /* glsl */ `
${interpolate}

vec4 keys(float t) {
	vec4 x = vec4(1.0 + t, t, 1.0 - t, 2.0 - t);
	vec4 near = (1.5 * x - 2.5) * x * x + 1.0;
	vec4 far = ((-0.5 * x + 2.5) * x - 4.0) * x + 2.0;
	return mix(far, near, lessThan(x, vec4(1)));
}

int mirror(int i, int last) {
	return i < 0 ? -i : (i > last ? 2 * last - i : i);
}

float bicubic(int channel, vec2 position) {
	ivec2 last = textureSize(camera, 0) - 1;
	// Texel i has its centre at i + 0.5.
	vec2 index = position - 0.5;
	ivec2 base = ivec2(floor(index));
	vec4 wx = keys(index.x - floor(index.x));
	vec4 wy = keys(index.y - floor(index.y));
	float sum = 0.0;
	for (int j = 0; j < 4; j++) {
		float row = 0.0;
		for (int i = 0; i < 4; i++) {
			ivec2 tap = base + ivec2(i - 1, j - 1);
			row += wx[i] * texelFetch(camera, ivec2(mirror(tap.x, last.x), mirror(tap.y, last.y)), 0)[channel];
		}
		sum += wy[j] * row;
	}
	return sum;
}

vec4 pixel(ivec2 p) {
	vec2 size = vec2(textureSize(camera, 0));
	vec2 offset = (vec2(p) + 0.5 - size / 2.0) / u.scale;
	vec4 scales = interpolate(geometry, length(offset) / (length(size) / 2.0));
	vec3 rgb = vec3(0);
	for (int c = 0; c < 3; c++) {
		rgb[c] = bicubic(c, size / 2.0 + offset * scales[c + 1]);
	}
	return vec4(rgb, 1);
}`;

const knotTexture = (gpu: Gpu, rows: readonly (readonly number[])[]): Texture =>
	upload(
		gpu,
		{ width: rows.length, height: 1 },
		'RGBA32F',
		new Float32Array(rows.flatMap((row) => [...row, 0, 0, 0, 0].slice(0, 4)))
	);

/**
 * Corrects vignetting, then distortion and lateral chromatic aberration, in
 * that order as darktable does (src/iop/lens.cc:3124-3174): vignetting is a
 * property of where light fell on the sensor, so its gain is a function of
 * the input radius. Radii are measured from the frame's centre in
 * half-diagonals of the frame.
 *
 * The frame keeps its size and is magnified by `autoscale`, so every output
 * pixel reads from inside the input and no undefined border is shown.
 */
export function correctLens(
	gpu: Gpu,
	camera: Image<'camera'>,
	correction: LensCorrection
): Image<'camera'> {
	const size: Size = { width: camera.width, height: camera.height };
	const vignetting = knotTexture(
		gpu,
		correction.vignetting.map((k) => [k.radius, k.gain])
	);
	const geometry = knotTexture(
		gpu,
		correction.geometry.map((k) => [k.radius, k.red, k.green, k.blue])
	);
	const shaded = run<'camera'>(gpu, {
		label: 'lens vignetting',
		glsl: vignettingGlsl,
		textures: { camera, vignetting },
		uniforms: {},
		size,
		format: 'RGBA16F'
	});
	const corrected = run<'camera'>(gpu, {
		label: 'lens geometry',
		glsl: geometryGlsl,
		textures: { camera: shaded, geometry },
		uniforms: { scale: float(autoscale(correction.geometry, size)) },
		size,
		format: 'RGBA16F'
	});
	for (const texture of [vignetting, geometry, shaded]) texture.destroy();
	return corrected;
}
