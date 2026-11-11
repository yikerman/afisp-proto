import { MIDDLE_GREY, rec2020Luminance } from '../colour/spaces';
import type { Gpu } from '../gpu/gpu';
import type { Image, Size } from '../gpu/image';
import { run } from '../gpu/pass';
import { f32, vec2f } from '../gpu/uniforms';
import { wgslVector } from '../math/matrix';

/**
 * The restored scene and the fields derived from it. This is everything an
 * adjustment may read besides its own parameters: tonal zones and masks are
 * defined on it, so no adjustment can move another's target.
 */
export interface Reference {
	readonly scene: Image<'scene'>;
	/** Luminance in stops relative to middle grey. */
	readonly stops: Image<'stops'>;
	/** `stops` with detail removed and edges kept: the tonal zone a pixel belongs to. */
	readonly smoothedStops: Image<'stops'>;
}

/** WGSL view of the reference at one pixel, for shaders that bind its three textures. */
export const referenceWgsl = /* wgsl */ `
struct Reference {
	scene: vec3f,
	stops: f32,
	smoothed_stops: f32,
}

fn reference_at(p: vec2i) -> Reference {
	return Reference(
		textureLoad(scene, p, 0).rgb,
		textureLoad(stops, p, 0).r,
		textureLoad(smoothed_stops, p, 0).r,
	);
}`;

export const referenceTextures = (reference: Reference) => ({
	scene: reference.scene,
	stops: reference.stops,
	smoothed_stops: reference.smoothedStops
});

// Black has no finite distance from middle grey in stops; the field bottoms out here.
const DARKEST_STOPS = -16;

const stopsWgsl = /* wgsl */ `
fn pixel(p: vec2i) -> vec4f {
	let luminance = dot(textureLoad(scene, p, 0).rgb, ${wgslVector(rec2020Luminance)});
	return vec4f(max(log2(luminance / ${MIDDLE_GREY}), ${DARKEST_STOPS}), 0, 0, 1);
}`;

// Smoothing is a guided filter with the image as its own guide (He, Sun & Tang,
// "Guided Image Filtering", 2013), with the coefficients computed on a reduced
// image and interpolated (He & Sun, "Fast Guided Filter", 2015). The window is a
// fraction of the image so the result does not depend on resolution.
const REDUCED_LONG_SIDE = 512;
const WINDOW_RADIUS = 0.025; // of the long side
const EDGE_VARIANCE = 0.25; // stops squared: local contrast above this counts as an edge

/** Block means of the value and its square, in r and g. */
const reduceWgsl = /* wgsl */ `
fn pixel(p: vec2i) -> vec4f {
	let factor = i32(u.factor);
	let limit = vec2i(textureDimensions(stops)) - 1;
	var sum = vec2f(0);
	for (var y = 0; y < factor; y++) {
		for (var x = 0; x < factor; x++) {
			let v = textureLoad(stops, min(p * factor + vec2i(x, y), limit), 0).r;
			sum += vec2f(v, v * v);
		}
	}
	return vec4f(sum / f32(factor * factor), 0, 1);
}`;

const boxWgsl = /* wgsl */ `
fn pixel(p: vec2i) -> vec4f {
	let radius = i32(u.radius);
	let limit = vec2i(textureDimensions(image)) - 1;
	var sum = vec4f(0);
	for (var i = -radius; i <= radius; i++) {
		sum += textureLoad(image, clamp(p + i * vec2i(u.axis), vec2i(0), limit), 0);
	}
	return sum / f32(2 * radius + 1);
}`;

/** Per window, the line `smoothed = a * value + b` that best fits it; a and b in r and g. */
const coefficientsWgsl = /* wgsl */ `
fn pixel(p: vec2i) -> vec4f {
	let moments = textureLoad(means, p, 0);
	let variance = moments.g - moments.r * moments.r;
	let a = variance / (variance + ${EDGE_VARIANCE});
	return vec4f(a, (1 - a) * moments.r, 0, 1);
}`;

const applyWgsl = /* wgsl */ `
fn pixel(p: vec2i) -> vec4f {
	let limit = vec2i(textureDimensions(coefficients)) - 1;
	let position = (vec2f(p) + 0.5) / u.factor - 0.5;
	let corner = vec2i(floor(position));
	let t = position - floor(position);
	let c00 = textureLoad(coefficients, clamp(corner, vec2i(0), limit), 0);
	let c10 = textureLoad(coefficients, clamp(corner + vec2i(1, 0), vec2i(0), limit), 0);
	let c01 = textureLoad(coefficients, clamp(corner + vec2i(0, 1), vec2i(0), limit), 0);
	let c11 = textureLoad(coefficients, clamp(corner + vec2i(1, 1), vec2i(0), limit), 0);
	let c = mix(mix(c00, c10, t.x), mix(c01, c11, t.x), t.y);
	return vec4f(c.r * textureLoad(stops, p, 0).r + c.g, 0, 0, 1);
}`;

function box(gpu: Gpu, image: GPUTexture, radius: number): GPUTexture {
	const blur = (source: GPUTexture, axis: readonly [number, number]) =>
		run(gpu, {
			label: 'box',
			wgsl: boxWgsl,
			textures: { image: source },
			uniforms: { radius: f32(radius), axis: vec2f(axis) },
			size: source,
			format: 'rgba32float'
		});
	const horizontal = blur(image, [1, 0]);
	const both = blur(horizontal, [0, 1]);
	horizontal.destroy();
	return both;
}

function smooth(gpu: Gpu, stops: Image<'stops'>): Image<'stops'> {
	const longSide = Math.max(stops.width, stops.height);
	const factor = Math.ceil(longSide / REDUCED_LONG_SIDE);
	const reducedSize: Size = {
		width: Math.ceil(stops.width / factor),
		height: Math.ceil(stops.height / factor)
	};
	const radius = Math.round((WINDOW_RADIUS * longSide) / factor);

	const reduced = run(gpu, {
		label: 'reduce',
		wgsl: reduceWgsl,
		textures: { stops },
		uniforms: { factor: f32(factor) },
		size: reducedSize,
		format: 'rgba32float'
	});
	const means = box(gpu, reduced, radius);
	const perWindow = run(gpu, {
		label: 'coefficients',
		wgsl: coefficientsWgsl,
		textures: { means },
		uniforms: {},
		size: reducedSize,
		format: 'rgba32float'
	});
	const coefficients = box(gpu, perWindow, radius);
	const smoothed = run<'stops'>(gpu, {
		label: 'smoothed stops',
		wgsl: applyWgsl,
		textures: { stops, coefficients },
		uniforms: { factor: f32(factor) },
		size: stops,
		format: 'r32float'
	});
	for (const texture of [reduced, means, perWindow, coefficients]) texture.destroy();
	return smoothed;
}

/** Takes ownership of `scene`. */
export function measure(gpu: Gpu, scene: Image<'scene'>): Reference {
	const stops = run<'stops'>(gpu, {
		label: 'stops',
		wgsl: stopsWgsl,
		textures: { scene },
		uniforms: {},
		size: scene,
		format: 'r32float'
	});
	return { scene, stops, smoothedStops: smooth(gpu, stops) };
}

export function destroyReference(reference: Reference): void {
	reference.scene.destroy();
	reference.stops.destroy();
	reference.smoothedStops.destroy();
}
