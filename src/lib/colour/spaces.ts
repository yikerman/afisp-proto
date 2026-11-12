import {
	diagonal,
	inverse,
	multiply,
	transform,
	transpose,
	type Matrix3,
	type Vec2,
	type Vec3
} from '../math/matrix';

/** CIE xy chromaticity. */
export type Chromaticity = Vec2;

/** XYZ of a chromaticity at luminance Y = 1. */
export const whiteXyz = ([x, y]: Chromaticity): Vec3 => [x / y, 1, (1 - x - y) / y];

export const D65: Chromaticity = [0.3127, 0.329];

/** RGB to XYZ for primaries and a white point, the white mapping to Y = 1 (SMPTE RP 177). */
function rgbToXyz(red: Chromaticity, green: Chromaticity, blue: Chromaticity, white: Chromaticity) {
	const primaries = transpose([whiteXyz(red), whiteXyz(green), whiteXyz(blue)]);
	return multiply(primaries, diagonal(transform(inverse(primaries), whiteXyz(white))));
}

// ITU-R BT.2020
export const rec2020ToXyz: Matrix3 = rgbToXyz([0.708, 0.292], [0.17, 0.797], [0.131, 0.046], D65);
export const xyzToRec2020: Matrix3 = inverse(rec2020ToXyz);

// IEC 61966-2-1
export const srgbToXyz: Matrix3 = rgbToXyz([0.64, 0.33], [0.3, 0.6], [0.15, 0.06], D65);

/** Weights giving the luminance Y of a linear Rec.2020 colour. */
export const rec2020Luminance: Vec3 = rec2020ToXyz[1];

/**
 * Scene luminance of middle grey: what exposure places the subject on, what
 * stops are measured from, and what the display transform pivots about.
 */
export const MIDDLE_GREY = 0.18;
