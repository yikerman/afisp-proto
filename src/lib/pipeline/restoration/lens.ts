// Ported from darktable's embedded-metadata lens correction (GPL-3.0-or-later) at master
// bdce4fed98499b90077946e323f08069b979ee79; line numbers below refer to that revision.

import type { Gpu } from '../../gpu/gpu';
import type { Image, Size } from '../../gpu/image';
import { run } from '../../gpu/pass';
import { f32 } from '../../gpu/uniforms';
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
const interpolate = /* wgsl */ `
fn knot(knots: texture_2d<f32>, i: i32) -> vec4f {
	return textureLoad(knots, vec2i(i, 0), 0);
}

fn interpolate(knots: texture_2d<f32>, radius: f32) -> vec4f {
	let n = i32(textureDimensions(knots).x);
	if (radius <= knot(knots, 0).x) { return knot(knots, 0); }
	if (radius >= knot(knots, n - 1).x) { return knot(knots, n - 1); }
	var low = 0;
	var high = n - 1;
	while (high - low > 1) {
		let middle = (low + high) / 2;
		if (knot(knots, middle).x <= radius) { low = middle; } else { high = middle; }
	}
	let a = knot(knots, low);
	let b = knot(knots, high);
	return mix(a, b, (radius - a.x) / (b.x - a.x));
}

fn radius_of(position: vec2f) -> f32 {
	let size = vec2f(textureDimensions(camera));
	return length(position - size / 2) / (length(size) / 2);
}`;

const vignettingWgsl = /* wgsl */ `
${interpolate}

fn pixel(p: vec2i) -> vec4f {
	let gain = interpolate(vignetting, radius_of(vec2f(p) + 0.5)).y;
	return vec4f(textureLoad(camera, p, 0).rgb * gain, 1);
}`;

// Bicubic with a = -0.5 (Keys 1981), darktable's bicubic
// (_maketaps_bicubic, src/common/interpolation.c:193), and like its
// dt_interpolation_compute_sample, mirrored at the border (interpolation.c:486).
const geometryWgsl = /* wgsl */ `
${interpolate}

fn keys(t: f32) -> vec4f {
	let x = vec4f(1 + t, t, 1 - t, 2 - t);
	let near = (1.5 * x - 2.5) * x * x + 1;
	let far = ((-0.5 * x + 2.5) * x - 4) * x + 2;
	return select(far, near, x < vec4f(1));
}

fn mirror(i: vec2i, last: vec2i) -> vec2i {
	return select(select(i, 2 * last - i, i > last), -i, i < vec2i(0));
}

fn bicubic(channel: i32, position: vec2f) -> f32 {
	let last = vec2i(textureDimensions(camera)) - 1;
	// Texel i has its centre at i + 0.5.
	let index = position - 0.5;
	let base = vec2i(floor(index));
	let wx = keys(index.x - floor(index.x));
	let wy = keys(index.y - floor(index.y));
	var sum = 0.0;
	for (var j = 0; j < 4; j++) {
		var row = 0.0;
		for (var i = 0; i < 4; i++) {
			row += wx[i] * textureLoad(camera, mirror(base + vec2i(i - 1, j - 1), last), 0)[channel];
		}
		sum += wy[j] * row;
	}
	return sum;
}

fn pixel(p: vec2i) -> vec4f {
	let size = vec2f(textureDimensions(camera));
	let offset = (vec2f(p) + 0.5 - size / 2) / u.scale;
	let scales = interpolate(geometry, length(offset) / (length(size) / 2));
	var rgb = vec3f(0);
	for (var c = 0; c < 3; c++) {
		rgb[c] = bicubic(c, size / 2 + offset * scales[c + 1]);
	}
	return vec4f(rgb, 1);
}`;

function knotTexture(gpu: Gpu, label: string, rows: readonly (readonly number[])[]): GPUTexture {
	const texture = gpu.device.createTexture({
		label,
		size: [rows.length, 1],
		format: 'rgba32float',
		usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
	});
	gpu.device.queue.writeTexture(
		{ texture },
		new Float32Array(rows.flatMap((row) => [...row, 0, 0, 0, 0].slice(0, 4))),
		{ bytesPerRow: 16 * rows.length },
		[rows.length, 1]
	);
	return texture;
}

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
		'lens vignetting knots',
		correction.vignetting.map((k) => [k.radius, k.gain])
	);
	const geometry = knotTexture(
		gpu,
		'lens geometry knots',
		correction.geometry.map((k) => [k.radius, k.red, k.green, k.blue])
	);
	const shaded = run<'camera'>(gpu, {
		label: 'lens vignetting',
		wgsl: vignettingWgsl,
		textures: { camera, vignetting },
		uniforms: {},
		size,
		format: 'rgba16float'
	});
	const corrected = run<'camera'>(gpu, {
		label: 'lens geometry',
		wgsl: geometryWgsl,
		textures: { camera: shaded, geometry },
		uniforms: { scale: f32(autoscale(correction.geometry, size)) },
		size,
		format: 'rgba16float'
	});
	for (const texture of [vignetting, geometry, shaded]) texture.destroy();
	return corrected;
}
