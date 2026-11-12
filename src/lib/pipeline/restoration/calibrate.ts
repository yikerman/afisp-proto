import { adaptation } from '../../colour/adaptation';
import { chromaticity, illuminant, type Illuminant } from '../../colour/illuminant';
import { D65, rec2020ToXyz, whiteXyz, xyzToRec2020 } from '../../colour/spaces';
import type { Gpu } from '../../gpu/gpu';
import type { Image, Size } from '../../gpu/image';
import { run } from '../../gpu/pass';
import { float, mat3, vec2 } from '../../gpu/uniforms';
import {
	columnMajor,
	compose,
	diagonal,
	inverse,
	transform,
	type Matrix3,
	type Vec2,
	type Vec3
} from '../../math/matrix';
import type { QuarterTurns, RawMeta } from '../../raw/decode';
import { demosaicGains } from './linearise';

const reciprocal = (v: Vec3): Vec3 => [1 / v[0], 1 / v[1], 1 / v[2]];

/** XYZ of what the camera recorded as neutral, i.e. of the light it measured. */
const asShotWhite = (meta: RawMeta): Vec3 =>
	transform(inverse(meta.xyzToCamera), reciprocal(meta.asShotGains));

export function asShotIlluminant(meta: RawMeta): Illuminant {
	const [x, y, z] = asShotWhite(meta);
	return illuminant([x / (x + y + z), y / (x + y + z)]);
}

/**
 * Demosaiced camera RGB to scene-linear Rec.2020, for a scene lit by `light`.
 * Surfaces that are neutral under `light` come out R=G=B, and a sensor that
 * clips under the as-shot light comes out at luminance 1.
 */
export function calibrationMatrix(meta: RawMeta, light: Illuminant): Matrix3 {
	const [x, y] = chromaticity(light);
	const white = whiteXyz([x, y]);
	const clipping = asShotWhite(meta)[1] * Math.min(...meta.asShotGains);
	return compose(
		diagonal([1 / clipping, 1 / clipping, 1 / clipping]),
		xyzToRec2020,
		adaptation(white, whiteXyz(D65)),
		inverse(meta.xyzToCamera),
		diagonal(reciprocal(demosaicGains(meta)))
	);
}

/**
 * The light under which `sample`, a scene colour restored assuming `assumed`,
 * would have come out neutral.
 */
export function neutralisingLight(sample: Vec3, assumed: Illuminant): Illuminant {
	const assumedWhite = whiteXyz(chromaticity(assumed));
	const adapted = transform(rec2020ToXyz, sample);
	const [x, y, z] = transform(inverse(adaptation(assumedWhite, whiteXyz(D65))), adapted);
	return illuminant([x / (x + y + z), y / (x + y + z)]);
}

/** Output pixel to source pixel, as `origin + x * xAxis + y * yAxis`, for an upright image. */
function upright(source: Size, turns: QuarterTurns) {
	const [w, h] = [source.width - 1, source.height - 1];
	const frames: Record<QuarterTurns, { origin: Vec2; xAxis: Vec2; yAxis: Vec2 }> = {
		0: { origin: [0, 0], xAxis: [1, 0], yAxis: [0, 1] },
		1: { origin: [0, h], xAxis: [0, -1], yAxis: [1, 0] },
		2: { origin: [w, h], xAxis: [-1, 0], yAxis: [0, -1] },
		3: { origin: [w, 0], xAxis: [0, 1], yAxis: [-1, 0] }
	};
	const size: Size = turns % 2 === 0 ? source : { width: source.height, height: source.width };
	return { ...frames[turns], size };
}

/** Size of the upright image the pipeline produces for a file. */
export const imageSize = (meta: RawMeta): Size => upright(meta.active, meta.orientation).size;

const glsl = /* glsl */ `
vec4 pixel(ivec2 p) {
	ivec2 source = ivec2(u.origin + float(p.x) * u.x_axis + float(p.y) * u.y_axis);
	vec3 rgb = u.matrix * texelFetch(camera, source, 0).rgb;
	// Colours outside Rec.2020 are clipped to it; the scene encoding is non-negative.
	return vec4(max(rgb, vec3(0)) * u.gain, 1);
}`;

export interface Calibration {
	readonly light: Illuminant;
	/** Stops added so the tone meant to be middle grey lands on it. */
	readonly exposure: number;
}

/** Colour calibration, white balance and exposure: camera RGB to the scene, upright. */
export function calibrate(
	gpu: Gpu,
	camera: Image<'camera'>,
	meta: RawMeta,
	{ light, exposure }: Calibration
): Image<'scene'> {
	const { origin, xAxis, yAxis, size } = upright(camera, meta.orientation);
	return run(gpu, {
		label: 'calibrate',
		glsl,
		textures: { camera },
		uniforms: {
			matrix: mat3(columnMajor(calibrationMatrix(meta, light))),
			origin: vec2(origin),
			x_axis: vec2(xAxis),
			y_axis: vec2(yAxis),
			gain: float(2 ** exposure)
		},
		size,
		format: 'RGBA16F'
	});
}
