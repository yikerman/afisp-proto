import { expect, test } from 'vitest';
import { acquireGpu } from '../../gpu/gpu';
import { download, upload, type Image } from '../../gpu/image';
import {
	diagonal,
	inverse,
	multiply,
	transform,
	transpose,
	type Matrix3,
	type Vec2,
	type Vec3
} from '../../math/matrix';
import { displayTransform } from './transform';

// An independent float64 transcription of darktable's CPU path (src/iop/agx.c at
// bdce4fed98499b90077946e323f08069b979ee79) with _set_scene_referred_default_params(),
// followed by darktable's colorout to sRGB: matrices from its built-in lcms profiles, then
// per-channel clipping and the sRGB curve.

const eps = 1e-6;
const clampf = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);
const map3 = (v: Vec3, f: (c: number) => number): Vec3 => [f(v[0]), f(v[1]), f(v[2])];

const p = {
	look_original_hue_mix_ratio: 0.6,
	range_black_relative_ev: -10,
	range_white_relative_ev: 6.5,
	curve_pivot_x: 10 / 16.5,
	curve_pivot_y_linear_output: 0.18,
	curve_contrast_around_pivot: 3,
	curve_linear_ratio_below_pivot: 0,
	curve_linear_ratio_above_pivot: 0,
	curve_toe_power: 1.5,
	curve_shoulder_power: 3.3,
	curve_gamma: 2.2,
	curve_target_display_black_ratio: 0,
	curve_target_display_white_ratio: 1,
	red_inset: 0.29462451,
	green_inset: 0.25861925,
	blue_inset: 0.14641371,
	red_rotation: 0.03540329,
	green_rotation: -0.02108586,
	blue_rotation: -0.06305724,
	master_outset_ratio: 1,
	master_unrotation_ratio: 0,
	red_outset: 0.290776401758,
	green_outset: 0.263155400753,
	blue_outset: 0.045810721815
};

// _scale(), agx.c:572
function scale(lx: number, ly: number, tx: number, ty: number, slope: number, power: number) {
	const projected = slope * Math.max(eps, lx - tx);
	const actual = Math.max(eps, ly - ty);
	const base = Math.max(eps, Math.pow(actual, -power) - Math.pow(projected, -power));
	return Math.min(1e9, Math.pow(base, -1 / power));
}

// _calculate_tone_mapping_params(), agx.c:884, without look, auto gamma and HDR
function toneMappingParams() {
	const gamma = p.curve_gamma;
	const pivotYAt = (g: number) =>
		Math.pow(
			clampf(
				p.curve_pivot_y_linear_output,
				p.curve_target_display_black_ratio,
				p.curve_target_display_white_ratio
			),
			1 / g
		);
	const range_in_ev = p.range_white_relative_ev - p.range_black_relative_ev;
	const pivot_x = clampf(p.curve_pivot_x, eps, 1 - eps);
	const pivot_y = pivotYAt(gamma);
	const compensation =
		(gamma * Math.pow(Math.max(eps, pivot_y), gamma - 1)) /
		(2.2 * Math.pow(Math.max(eps, pivotYAt(2.2)), 2.2 - 1));
	const slope = (p.curve_contrast_around_pivot * (range_in_ev / 16.5)) / compensation;

	const target_black = Math.pow(p.curve_target_display_black_ratio, 1 / gamma);
	const toe_power = Math.max(0.01, p.curve_toe_power);
	const dxBelow = ((pivot_y - target_black) * p.curve_linear_ratio_below_pivot) / slope;
	const toe_transition_x = Math.max(eps, pivot_x - dxBelow);
	const toe_transition_y = pivot_y - slope * (pivot_x - toe_transition_x);
	const toe_scale = -scale(
		1,
		1 - target_black,
		1 - toe_transition_x,
		1 - toe_transition_y,
		slope,
		toe_power
	);
	const toeDy = Math.max(eps, toe_transition_y - target_black);
	const toe_fallback_power = (slope * toe_transition_x) / toeDy;

	const target_white = Math.pow(p.curve_target_display_white_ratio, 1 / gamma);
	const dxAbove = ((target_white - pivot_y) * p.curve_linear_ratio_above_pivot) / slope;
	const shoulder_transition_x = Math.min(1 - eps, pivot_x + dxAbove);
	const shoulder_transition_y = pivot_y + slope * (shoulder_transition_x - pivot_x);
	const shoulder_power = Math.max(0.01, p.curve_shoulder_power);
	const shoulderDx = 1 - shoulder_transition_x;
	const shoulderDy = Math.max(eps, target_white - shoulder_transition_y);
	const shoulder_fallback_power = (slope * shoulderDx) / shoulderDy;
	return {
		range_in_ev,
		slope,
		target_black,
		toe_power,
		toe_transition_x,
		toe_transition_y,
		toe_scale,
		need_convex_toe: toeDy / toe_transition_x > slope,
		toe_fallback_power,
		toe_fallback_coefficient: toeDy / Math.pow(toe_transition_x, toe_fallback_power),
		intercept: toe_transition_y - slope * toe_transition_x,
		target_white,
		shoulder_transition_x,
		shoulder_transition_y,
		shoulder_power,
		shoulder_scale: scale(
			1,
			target_white,
			shoulder_transition_x,
			shoulder_transition_y,
			slope,
			shoulder_power
		),
		need_concave_shoulder: shoulderDy / shoulderDx > slope,
		shoulder_fallback_power,
		shoulder_fallback_coefficient: shoulderDy / Math.pow(shoulderDx, shoulder_fallback_power)
	};
}
const t = toneMappingParams();

const sigmoid = (x: number, power: number) => x / Math.pow(1 + Math.pow(x, power), 1 / power);
const scaledSigmoid = (x: number, s: number, power: number, tx: number, ty: number) =>
	s * sigmoid((t.slope * (x - tx)) / s, power) + ty;

// _apply_curve(), agx.c:638, with the fallbacks of agx.c:619-636
function applyCurve(x: number): number {
	let result: number;
	if (x < t.toe_transition_x) {
		result = t.need_convex_toe
			? x < 0
				? t.target_black
				: t.target_black +
					Math.max(0, t.toe_fallback_coefficient * Math.pow(x, t.toe_fallback_power))
			: scaledSigmoid(x, t.toe_scale, t.toe_power, t.toe_transition_x, t.toe_transition_y);
	} else if (x <= t.shoulder_transition_x) {
		result = t.slope * x + t.intercept;
	} else {
		result = t.need_concave_shoulder
			? x >= 1
				? t.target_white
				: t.target_white -
					Math.max(0, t.shoulder_fallback_coefficient * Math.pow(1 - x, t.shoulder_fallback_power))
			: scaledSigmoid(
					x,
					t.shoulder_scale,
					t.shoulder_power,
					t.shoulder_transition_x,
					t.shoulder_transition_y
				);
	}
	return clampf(result, t.target_black, t.target_white);
}

// _apply_log_encoding(), agx.c:723
const logEncoding = (x: number) =>
	clampf((Math.log2(Math.max(eps, x / 0.18)) - p.range_black_relative_ev) / t.range_in_ev, 0, 1);

// dt_RGB_2_HSV() and dt_HSV_2_RGB(), src/common/colorspaces_inline_conversions.h
function rgbToHsv([r, g, b]: Vec3): Vec3 {
	const max = Math.max(r, g, b);
	const delta = max - Math.min(r, g, b);
	if (!(Math.abs(max) > 1e-6 && Math.abs(delta) > 1e-6)) return [0, 0, max];
	let hue = r === max ? (g - b) / delta : g === max ? 2 + (b - r) / delta : 4 + (r - g) / delta;
	hue /= 6;
	const h = hue - Math.floor(hue);
	return [h < 1 ? h : 0, delta / max, max];
}
function hsvToRgb([h, s, v]: Vec3): Vec3 {
	const c = s * v;
	const m = v - c;
	const i = Math.floor(h * 6);
	const fc = (h * 6 - i) * c;
	const top = c + m;
	const inc = fc + m;
	const dec = top - fc;
	const sectors: readonly Vec3[] = [
		[top, inc, m],
		[dec, top, m],
		[m, top, inc],
		[m, dec, top],
		[inc, m, top],
		[top, m, dec]
	];
	return sectors[Math.min(i, 5)]!;
}

// _lerp_hue(), agx.c:665; remainderf(d, 1) rounds the quotient to nearest, ties to even
function lerpHue(original: number, processed: number, mix: number): number {
	const d = processed - original;
	const n = Math.abs(d % 1) === 0.5 ? 2 * Math.round(d / 2) : Math.round(d);
	const mixed = (1 - mix) * (d - n) + original;
	return mixed - Math.floor(mixed);
}

// _compress_into_gamut(), agx.c:751
function compressIntoGamut(px: Vec3): Vec3 {
	const k: Vec3 = [0.2658180370250449, 0.59846986045365, 0.1357121025213052];
	const lum = (v: Vec3) => v[0] * k[0] + v[1] * k[1] + v[2] * k[2];
	const maxRgb = Math.max(...px);
	const opponent = map3(px, (c) => maxRgb - c);
	const yCompensateNegative = Math.max(...opponent) - lum(opponent) + lum(px);
	const offset = Math.max(-Math.min(...px), 0);
	const shifted = map3(px, (c) => c + offset);
	const maxShifted = Math.max(...shifted);
	const opponentShifted = map3(shifted, (c) => maxShifted - c);
	const yNew = Math.max(...opponentShifted) - lum(opponentShifted) + lum(shifted);
	const ratio = yNew > yCompensateNegative && yNew > eps ? yCompensateNegative / yNew : 1;
	return map3(shifted, (c) => ratio * c);
}

// lcms2 cmsCreateRGBProfile(): colorants adapted to D50 by Bradford, media white D50.
const D50: Vec3 = [0.9642, 1, 0.8249];
const xyY2XYZ = ([x, y]: Vec2): Vec3 => [x / y, 1, (1 - x - y) / y];
const XYZ2xy = ([X, Y, Z]: Vec3): Vec2 => [X / (X + Y + Z), Y / (X + Y + Z)];
type Primaries = readonly [Vec2, Vec2, Vec2];
function rgbToXyzMatrix([r, g, b]: Primaries, white: Vec2): Matrix3 {
	const m = transpose([xyY2XYZ(r), xyY2XYZ(g), xyY2XYZ(b)]);
	return multiply(m, diagonal(transform(inverse(m), xyY2XYZ(white))));
}
function lcmsColorants(primaries: Primaries): Matrix3 {
	const D65xyY: Vec2 = [0.31271, 0.32902]; // src/common/colorspaces.h:40
	const bradford: Matrix3 = [
		[0.8951, 0.2664, -0.1614],
		[-0.7502, 1.7135, 0.0367],
		[0.0389, -0.0685, 1.0296]
	];
	const src = transform(bradford, xyY2XYZ(D65xyY));
	const dst = transform(bradford, D50);
	const chad = multiply(
		inverse(bradford),
		multiply(diagonal([dst[0] / src[0], dst[1] / src[1], dst[2] / src[2]]), bradford)
	);
	return multiply(chad, rgbToXyzMatrix(primaries, D65xyY));
}
const rec2020In = lcmsColorants([
	[0.708, 0.292],
	[0.17, 0.797],
	[0.131, 0.046]
]);
const srgbIn = lcmsColorants([
	[0.64, 0.33],
	[0.3, 0.6],
	[0.15, 0.06]
]);
const rec2020Out = inverse(rec2020In);
const rec2020Primaries = transpose(rec2020In).map(XYZ2xy);
const whitepoint = XYZ2xy(D50);

// dt_rotate_and_scale_primary(), src/common/custom_primaries.c
function rotateAndScale(scaling: number, rotation: number, i: number): Vec2 {
	const [wx, wy] = whitepoint;
	const angle = Math.atan2(rec2020Primaries[i]![1] - wy, rec2020Primaries[i]![0] - wx) + rotation;
	const [c, s] = [Math.cos(angle), Math.sin(angle)];
	let distance = Number.MAX_VALUE;
	for (let e = 0; e < 3; e++) {
		const [x3, y3] = rec2020Primaries[e]!;
		const [x4, y4] = rec2020Primaries[(e + 1) % 3]!;
		const det = (a: number, b: number, cc: number, d: number) => a * d - b * cc;
		const denominator = det(-c, x3 - x4, -s, y3 - y4);
		if (denominator === 0) continue;
		const u = det(wx - x3, x3 - x4, wy - y3, y3 - y4) / denominator;
		if (u >= 0 && u < distance) distance = u;
	}
	return [scaling * distance * c + wx, scaling * distance * s + wy];
}

// _create_matrices(), agx.c:1373, base profile = pipe profile = linear Rec2020
const inset = [p.red_inset, p.green_inset, p.blue_inset];
const rotation = [p.red_rotation, p.green_rotation, p.blue_rotation];
const outset = [p.red_outset, p.green_outset, p.blue_outset];
const unrotation = [p.red_rotation, p.green_rotation, p.blue_rotation];
function customPrimaries(scaling: (i: number) => number, rotation: (i: number) => number) {
	const primary = (i: number) => rotateAndScale(scaling(i), rotation(i), i);
	return [primary(0), primary(1), primary(2)] as const;
}
const renderingToXyz = rgbToXyzMatrix(
	customPrimaries(
		(i) => 1 - inset[i]!,
		(i) => rotation[i]!
	),
	whitepoint
);
const baseToRendering = multiply(rec2020Out, renderingToXyz);
const outsetToXyz = rgbToXyzMatrix(
	customPrimaries(
		(i) => 1 - p.master_outset_ratio * outset[i]!,
		(i) => p.master_unrotation_ratio * unrotation[i]!
	),
	whitepoint
);
const renderingToPipe = inverse(multiply(rec2020Out, outsetToXyz));

// process(), agx.c:1477
function agx(input: Vec3): Vec3 {
	const sanitised = map3(input, (c) => (Number.isNaN(c) ? 0 : clampf(c, -1e6, 1e6)));
	const rendering = transform(baseToRendering, compressIntoGamut(sanitised));
	const hBefore = rgbToHsv(rendering)[0];
	const curved = map3(rendering, (c) => applyCurve(logEncoding(c)));
	const linear = map3(curved, (c) => Math.pow(Math.max(0, c), p.curve_gamma));
	const hsv = rgbToHsv(linear);
	const out = hsvToRgb([lerpHue(hBefore, hsv[0], p.look_original_hue_mix_ratio), hsv[1], hsv[2]]);
	return transform(renderingToPipe, out);
}

const srgbEncode = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);

function reference(scene: Vec3): Vec3 {
	const linear = transform(multiply(inverse(srgbIn), rec2020In), agx(scene));
	return map3(linear, (c) => srgbEncode(clampf(c, 0, 1)));
}

// --- GPU -----------------------------------------------------------------------------------

/** Runs the transform on one row of pixels; returns the inputs as stored (f16) and the outputs. */
async function evaluate(pixels: readonly Vec3[]): Promise<{ input: Vec3[]; output: Vec3[] }> {
	const gpu = await acquireGpu('accept');
	const data = new Float16Array(pixels.flatMap(([r, g, b]) => [r, g, b, 1]));
	const size = { width: pixels.length, height: 1 };
	const scene: Image<'scene'> = upload(gpu, 'scene', size, 'rgba16float', data);
	const result = new Float16Array(await download(gpu, displayTransform(gpu, scene)));
	const rgb = (a: Float16Array, i: number): Vec3 => [a[4 * i]!, a[4 * i + 1]!, a[4 * i + 2]!];
	for (let i = 0; i < pixels.length; i++) expect(result[4 * i + 3]).toBe(1);
	return {
		input: pixels.map((_, i) => rgb(data, i)),
		output: pixels.map((_, i) => rgb(result, i))
	};
}

// rgba16float output: values in [0.5, 1) are spaced 2^-11 apart, so rounding alone contributes
// up to 2.4e-4; the observed maximum on SwiftShader is 2.2e-4.
const TOLERANCE = 5e-4;

const whiteEnd = 0.18 * 2 ** p.range_white_relative_ev; // 16.29

test('neutral ramp: neutral, monotonic, black at 0, white at and beyond the range end', async () => {
	const levels = [0, 1e-4, 1e-3, 0.005, 0.02, 0.05, 0.1, 0.18, 0.3, 0.6, 1, 2, 4, 8, 12, 16];
	const { output } = await evaluate([...levels, whiteEnd, 30, 1000].map((v) => [v, v, v]));
	for (const [r, g, b] of output) {
		expect(g).toBe(r);
		expect(b).toBe(r);
		expect(r).toBeGreaterThanOrEqual(0);
		expect(r).toBeLessThanOrEqual(1);
	}
	const ramp = output.map(([r]) => r);
	for (let i = 1; i < ramp.length; i++) expect(ramp[i]).toBeGreaterThanOrEqual(ramp[i - 1]!);
	expect(ramp[0]).toBeLessThan(1e-3);
	for (const white of ramp.slice(-3)) expect(white).toBeCloseTo(1, 3);
});

test('middle grey', async () => {
	// The pivot: 0.18 sits at curve_pivot_x and maps to curve_pivot_y_linear_output = 0.18
	// in display-linear light, which sRGB encodes as 0.4614.
	const pivot = srgbEncode(p.curve_pivot_y_linear_output);
	expect(pivot).toBeCloseTo(0.461356, 6);
	expect(reference([0.18, 0.18, 0.18])[0]).toBeCloseTo(pivot, 6);

	// The pipeline's middle grey, 0.1845, is 0.036 EV above AgX's 0.18 pivot.
	const grey = reference([0.1845, 0.1845, 0.1845])[0];
	expect(grey).toBeCloseTo(0.468036, 6);

	const { input, output } = await evaluate([
		[0.18, 0.18, 0.18],
		[0.1845, 0.1845, 0.1845]
	]);
	expect(Math.abs(output[0]![0] - reference(input[0]!)[0])).toBeLessThan(TOLERANCE);
	expect(Math.abs(output[1]![0] - reference(input[1]!)[0])).toBeLessThan(TOLERANCE);
	expect(Math.abs(output[1]![0] - grey)).toBeLessThan(TOLERANCE);
});

test('chromatic colours match the float64 transcription of agx.c', async () => {
	const colours: Vec3[] = [
		[0.18, 0, 0],
		[0, 0.18, 0],
		[0, 0, 0.18],
		[0.3, 0.15, 0.05],
		[0.05, 0.2, 0.4],
		[0.002, 0.001, 0.0005],
		[2, 0.5, 0.1],
		[20, 1, 0.1],
		[0.4, 0.05, 0.3],
		[0.1, 0.12, 0.09]
	];
	const { input, output } = await evaluate(colours);
	for (let i = 0; i < colours.length; i++) {
		const expected = reference(input[i]!);
		for (let c = 0; c < 3; c++) {
			expect(Math.abs(output[i]![c] - expected[c]), `${input[i]} channel ${c}`).toBeLessThan(
				TOLERANCE
			);
		}
	}
});
