// Port of darktable's AgX module (src/iop/agx.c, GPL-3.0-or-later) at its scene-referred
// defaults, for an sRGB display. Line references are to darktable commit
// bdce4fed98499b90077946e323f08069b979ee79.

import type { Gpu } from '../../gpu/gpu';
import { glslFloat } from '../../gpu/glsl';
import type { Image } from '../../gpu/image';
import { run } from '../../gpu/pass';
import { MIDDLE_GREY, srgbToXyz, rec2020ToXyz } from '../../colour/spaces';
import {
	diagonal,
	inverse,
	multiply,
	transform,
	transpose,
	glslMatrix,
	type Matrix3,
	type Vec2,
	type Vec3
} from '../../math/matrix';

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(`display transform: ${message}`);
}

// --- Parameters ---------------------------------------------------------------------------

/**
 * The subset of dt_iop_agx_params_t (agx.c:98) that the processing reads, with the darktable
 * field names. Fields whose default disables a feature (look, auto gamma, HDR, primaries
 * reversal) are represented by the assertions in `deriveCurve` and `derivePrimaries` instead.
 */
interface AgxParams {
	/** range_black_relative_ev, EV relative to 0.18 */
	readonly rangeBlackRelativeEv: number;
	/** range_white_relative_ev */
	readonly rangeWhiteRelativeEv: number;
	/** curve_pivot_x, position of the pivot in the log-encoded range [0, 1] */
	readonly curvePivotX: number;
	/** curve_pivot_y_linear_output */
	readonly curvePivotYLinearOutput: number;
	/** curve_contrast_around_pivot */
	readonly curveContrastAroundPivot: number;
	/** curve_linear_ratio_below_pivot ('toe start') */
	readonly curveLinearRatioBelowPivot: number;
	/** curve_linear_ratio_above_pivot ('shoulder start') */
	readonly curveLinearRatioAbovePivot: number;
	/** curve_toe_power */
	readonly curveToePower: number;
	/** curve_shoulder_power */
	readonly curveShoulderPower: number;
	/** curve_gamma */
	readonly curveGamma: number;
	/** curve_target_display_black_ratio */
	readonly curveTargetDisplayBlackRatio: number;
	/** curve_target_display_white_ratio */
	readonly curveTargetDisplayWhiteRatio: number;
	/** look_original_hue_mix_ratio ('preserve hue') */
	readonly lookOriginalHueMixRatio: number;
	/** red_inset, green_inset, blue_inset */
	readonly inset: Vec3;
	/** red_rotation, green_rotation, blue_rotation, radians */
	readonly rotation: Vec3;
	/** master_outset_ratio */
	readonly masterOutsetRatio: number;
	/** master_unrotation_ratio */
	readonly masterUnrotationRatio: number;
	/** red_outset, green_outset, blue_outset */
	readonly outset: Vec3;
	/** red_unrotation, green_unrotation, blue_unrotation */
	readonly unrotation: Vec3;
}

// reload_defaults() (agx.c:2937) sets these through _set_scene_referred_default_params()
// (agx.c:2778) whenever the workflow is scene-referred, overriding the $DEFAULT annotations
// in the struct: _set_default_curve_and_look_params() (agx.c:2714) and
// _set_blenderlike_primaries() (agx.c:358).
const rangeBlackRelativeEv = -10; // agx.c:2726
const rangeWhiteRelativeEv = 6.5; // agx.c:2727
const blenderRotation: Vec3 = [0.03540329, -0.02108586, -0.06305724]; // agx.c:371-373

const sceneReferredDefaults: AgxParams = {
	rangeBlackRelativeEv,
	rangeWhiteRelativeEv,
	curvePivotX: -rangeBlackRelativeEv / (rangeWhiteRelativeEv - rangeBlackRelativeEv), // agx.c:2742
	curvePivotYLinearOutput: 0.18, // agx.c:2743
	curveContrastAroundPivot: 3, // agx.c:2733
	curveLinearRatioBelowPivot: 0, // agx.c:2734
	curveLinearRatioAbovePivot: 0, // agx.c:2735
	curveToePower: 1.5, // agx.c:2736
	curveShoulderPower: 3.3, // agx.c:2737
	curveGamma: 2.2, // agx.c:2741, _default_gamma (agx.c:82)
	curveTargetDisplayBlackRatio: 0, // agx.c:2738
	curveTargetDisplayWhiteRatio: 1, // agx.c:2739
	lookOriginalHueMixRatio: 0.6, // agx.c:2724
	inset: [0.29462451, 0.25861925, 0.14641371], // agx.c:368-370
	rotation: blenderRotation,
	masterOutsetRatio: 1, // agx.c:375
	masterUnrotationRatio: 0, // agx.c:378
	outset: [0.290776401758, 0.263155400753, 0.045810721815], // agx.c:380-382
	unrotation: blenderRotation // agx.c:383-385
};

// Defaults that switch features off. Each is checked where the code it disables would be.
const lookIsIdentity = true; // look_slope 1, look_brightness 1, look_lift 0, look_saturation 1 (agx.c:2718-2721)
const autoGamma = false; // auto_gamma (agx.c:2740)
// target_white_from_output TRUE (agx.c:2716) re-derives the curve for the output headroom
// (agx.c:1036); for SDR output the headroom is 1, which leaves the curve unchanged.
const outputHeadroom = 1;
// base_primaries DT_AGX_REC2020 (agx.c:362), the same profile as darktable's default working
// space, so pipe_to_base is the identity (agx.c:1544).
const basePrimariesAreWorkingSpace = true;

// --- Constants of darktable's code ---------------------------------------------------------

const EPSILON = 1e-6; // _epsilon, agx.c:81
const DEFAULT_GAMMA = 2.2; // _default_gamma, agx.c:82
// The dynamic range in EV for which the contrast parameter is defined (agx.c:907-909).
const REFERENCE_RANGE_EV = 16.5;
// The scene value the log encoding is relative to (0.18 at agx.c:729).
const AGX_MIDDLE_GREY = MIDDLE_GREY;

// --- Curve: _calculate_tone_mapping_params(), agx.c:884 ------------------------------------

/** One sigmoid segment, `scale * f((x - transition.x) * slope / scale) + transition.y`. */
interface Segment {
	readonly transitionX: number;
	readonly transitionY: number;
	readonly scale: number;
	readonly power: number;
}

interface Curve {
	readonly blackRelativeEv: number;
	readonly rangeInEv: number;
	readonly gamma: number;
	readonly slope: number;
	readonly intercept: number;
	readonly targetBlack: number;
	readonly targetWhite: number;
	readonly toe: Segment;
	readonly shoulder: Segment;
}

const clamp = (x: number, low: number, high: number) => Math.min(Math.max(x, low), high);

// _scale(), agx.c:572
function sigmoidScale(
	limitX: number,
	limitY: number,
	transitionX: number,
	transitionY: number,
	slope: number,
	power: number
): number {
	const projectedRise = slope * Math.max(EPSILON, limitX - transitionX);
	const actualRise = Math.max(EPSILON, limitY - transitionY);
	const base = Math.max(EPSILON, actualRise ** -power - projectedRise ** -power);
	return Math.min(1e9, base ** (-1 / power));
}

// _calculate_pivot_y_at_gamma(), agx.c:817
const pivotYAtGamma = (p: AgxParams, gamma: number) =>
	clamp(
		p.curvePivotYLinearOutput,
		p.curveTargetDisplayBlackRatio,
		p.curveTargetDisplayWhiteRatio
	) **
	(1 / gamma);

// _calculate_slope_gamma_compensation(), agx.c:858
function slopeGammaCompensation(gamma: number, pivotY: number, p: AgxParams): number {
	const atDefault = pivotYAtGamma(p, DEFAULT_GAMMA);
	const derivativeAtGamma = gamma * Math.max(EPSILON, pivotY) ** (gamma - 1);
	const derivativeAtDefault = DEFAULT_GAMMA * Math.max(EPSILON, atDefault) ** (DEFAULT_GAMMA - 1);
	return derivativeAtGamma / derivativeAtDefault;
}

function deriveCurve(p: AgxParams): Curve {
	assert(!autoGamma, 'auto gamma (agx.c:826) is not ported');
	assert(outputHeadroom === 1, 'HDR output (agx.c:1036) is not ported');

	const rangeInEv = p.rangeWhiteRelativeEv - p.rangeBlackRelativeEv;
	const pivotX = clamp(p.curvePivotX, EPSILON, 1 - EPSILON);
	const gamma = p.curveGamma;
	const pivotY = pivotYAtGamma(p, gamma);
	const slope =
		(p.curveContrastAroundPivot * (rangeInEv / REFERENCE_RANGE_EV)) /
		slopeGammaCompensation(gamma, pivotY, p);

	const targetBlack = p.curveTargetDisplayBlackRatio ** (1 / gamma);
	const toePower = Math.max(0.01, p.curveToePower);
	const toeLengthY = (pivotY - targetBlack) * p.curveLinearRatioBelowPivot;
	const toeTransitionX = Math.max(EPSILON, pivotX - toeLengthY / slope);
	const toeTransitionY = pivotY - slope * (pivotX - toeTransitionX);
	// The toe is the shoulder construction mirrored about (0.5, 0.5), hence the negated scale.
	const toeScale = -sigmoidScale(
		1,
		1 - targetBlack,
		1 - toeTransitionX,
		1 - toeTransitionY,
		slope,
		toePower
	);
	const toeSlopeToLimit = Math.max(EPSILON, toeTransitionY - targetBlack) / toeTransitionX;
	assert(toeSlopeToLimit <= slope, 'the convex fallback toe (agx.c:619) is not ported');

	const targetWhite = p.curveTargetDisplayWhiteRatio ** (1 / gamma);
	const shoulderPower = Math.max(0.01, p.curveShoulderPower);
	const shoulderLengthY = (targetWhite - pivotY) * p.curveLinearRatioAbovePivot;
	const shoulderTransitionX = Math.min(1 - EPSILON, pivotX + shoulderLengthY / slope);
	const shoulderTransitionY = pivotY + slope * (shoulderTransitionX - pivotX);
	const shoulderScale = sigmoidScale(
		1,
		targetWhite,
		shoulderTransitionX,
		shoulderTransitionY,
		slope,
		shoulderPower
	);
	const shoulderSlopeToLimit =
		Math.max(EPSILON, targetWhite - shoulderTransitionY) / (1 - shoulderTransitionX);
	assert(shoulderSlopeToLimit <= slope, 'the concave fallback shoulder (agx.c:628) is not ported');

	return {
		blackRelativeEv: p.rangeBlackRelativeEv,
		rangeInEv,
		gamma,
		slope,
		intercept: toeTransitionY - slope * toeTransitionX,
		targetBlack,
		targetWhite,
		toe: {
			transitionX: toeTransitionX,
			transitionY: toeTransitionY,
			scale: toeScale,
			power: toePower
		},
		shoulder: {
			transitionX: shoulderTransitionX,
			transitionY: shoulderTransitionY,
			scale: shoulderScale,
			power: shoulderPower
		}
	};
}

// --- Primaries: _create_matrices(), agx.c:1373 ---------------------------------------------

/** A matrix profile as darktable holds it (dt_iop_order_iccprofile_info_t). */
interface Profile {
	/** RGB to D50 XYZ, from the ICC colorant tags. */
	readonly toXyz: Matrix3;
	/** xy of the colorant tags. */
	readonly primaries: readonly [Vec2, Vec2, Vec2];
	/** xy of the media white point tag. */
	readonly white: Vec2;
}

const xyzOf = ([x, y]: Vec2): Vec3 => [x / y, 1, (1 - x - y) / y];
const xyOf = ([X, Y, Z]: Vec3): Vec2 => [X / (X + Y + Z), Y / (X + Y + Z)];

/** RGB to XYZ from primaries and white (Lindbloom), as both lcms and darktable build it. */
function matrixFromPrimaries(primaries: readonly [Vec2, Vec2, Vec2], white: Vec2): Matrix3 {
	const m = transpose([xyzOf(primaries[0]), xyzOf(primaries[1]), xyzOf(primaries[2])]);
	return multiply(m, diagonal(transform(inverse(m), xyzOf(white))));
}

// lcms2 (cmsCreateRGBProfile, cmsvirt.c; _cmsAdaptMatrixToD50, cmswtpnt.c) stores the
// colorants adapted to D50 with Bradford and writes D50 as the media white point.
const D50_XYZ: Vec3 = [0.9642, 1, 0.8249]; // cmsD50X, cmsD50Y, cmsD50Z, lcms2.h
const BRADFORD: Matrix3 = [
	[0.8951, 0.2664, -0.1614],
	[-0.7502, 1.7135, 0.0367],
	[0.0389, -0.0685, 1.0296]
]; // _cmsAdaptationMatrix, cmswtpnt.c

function bradfordToD50(white: Vec3): Matrix3 {
	const source = transform(BRADFORD, white);
	const target = transform(BRADFORD, D50_XYZ);
	const gains: Vec3 = [target[0] / source[0], target[1] / source[1], target[2] / source[2]];
	return multiply(inverse(BRADFORD), multiply(diagonal(gains), BRADFORD));
}

// darktable's built-in linear Rec2020 profile: D65xyY (src/common/colorspaces.h:40) and
// Rec2020_Primaries (src/common/colorspaces.c:65).
function darktableRec2020(): Profile {
	const d65: Vec2 = [0.31271, 0.32902];
	const primaries: readonly [Vec2, Vec2, Vec2] = [
		[0.708, 0.292],
		[0.17, 0.797],
		[0.131, 0.046]
	];
	const toXyz = multiply(bradfordToD50(xyzOf(d65)), matrixFromPrimaries(primaries, d65));
	const [red, green, blue] = transpose(toXyz);
	return { toXyz, primaries: [xyOf(red), xyOf(green), xyOf(blue)], white: xyOf(D50_XYZ) };
}

// _find_distance_to_edge(), src/common/custom_primaries.c: the distance from the white point
// along a direction to the nearest of the lines through the gamut triangle's edges.
function distanceToEdge(profile: Profile, cos: number, sin: number): number {
	const [x1, y1] = profile.white;
	const [x2, y2] = [x1 + cos, y1 + sin];
	let distance = Infinity;
	for (let i = 0; i < 3; i++) {
		const [x3, y3] = profile.primaries[i];
		const [x4, y4] = profile.primaries[(i + 1) % 3];
		const denominator = (x1 - x2) * (y3 - y4) - (x3 - x4) * (y1 - y2);
		if (denominator === 0) continue;
		const t = ((x1 - x3) * (y3 - y4) - (x3 - x4) * (y1 - y3)) / denominator;
		if (t >= 0) distance = Math.min(distance, t);
	}
	return distance;
}

// dt_rotate_and_scale_primary(), src/common/custom_primaries.c
function rotateAndScalePrimary(
	profile: Profile,
	scaling: number,
	rotation: number,
	index: 0 | 1 | 2
): Vec2 {
	const [wx, wy] = profile.white;
	const [px, py] = profile.primaries[index];
	const angle = Math.atan2(py - wy, px - wx) + rotation;
	const distance = distanceToEdge(profile, Math.cos(angle), Math.sin(angle));
	return [wx + scaling * distance * Math.cos(angle), wy + scaling * distance * Math.sin(angle)];
}

function customPrimaries(
	profile: Profile,
	scaling: Vec3,
	rotation: Vec3
): readonly [Vec2, Vec2, Vec2] {
	return [
		rotateAndScalePrimary(profile, scaling[0], rotation[0], 0),
		rotateAndScalePrimary(profile, scaling[1], rotation[1], 1),
		rotateAndScalePrimary(profile, scaling[2], rotation[2], 2)
	];
}

interface Primaries {
	/** Base RGB into the inset and rotated rendering space the curve runs in. */
	readonly baseToRendering: Matrix3;
	/** The curve's output back to base RGB, undoing the rotation and restoring purity. */
	readonly renderingToBase: Matrix3;
}

function derivePrimaries(p: AgxParams): Primaries {
	// disable_primaries_adjustments and completely_reverse_primaries are FALSE (agx.c:360-361),
	// so _get_primaries_params() takes the per-primary outsets (agx.c:1086).
	assert(basePrimariesAreWorkingSpace, 'base primaries other than Rec2020 are not ported');
	const base = darktableRec2020();
	const fromXyz = inverse(base.toXyz);
	const map = (v: Vec3, f: (x: number) => number): Vec3 => [f(v[0]), f(v[1]), f(v[2])];

	const inset = customPrimaries(
		base,
		map(p.inset, (i) => 1 - i),
		p.rotation
	);
	const outset = customPrimaries(
		base,
		map(p.outset, (o) => 1 - p.masterOutsetRatio * o),
		map(p.unrotation, (r) => p.masterUnrotationRatio * r)
	);
	return {
		baseToRendering: multiply(fromXyz, matrixFromPrimaries(inset, base.white)),
		renderingToBase: inverse(multiply(fromXyz, matrixFromPrimaries(outset, base.white)))
	};
}

// --- GLSL --------------------------------------------------------------------------------

const curve = deriveCurve(sceneReferredDefaults);
const primaries = derivePrimaries(sceneReferredDefaults);
assert(lookIsIdentity, '_agx_look() (agx.c:696) is not ported');
// Our scene and darktable's working space are both linear Rec.2020, so the module's output
// goes straight to the display primaries.
const renderingToSrgb = multiply(
	inverse(srgbToXyz),
	multiply(rec2020ToXyz, primaries.renderingToBase)
);

/**
 * `vec3 display_transform(vec3 scene)`: scene-linear Rec.2020 to sRGB-encoded
 * values in [0, 1]. Every other name it defines starts with `agx_` or `AGX_`.
 */
export const displayTransformGlsl = `
const float AGX_EPSILON = ${glslFloat(EPSILON)};
const float AGX_MIDDLE_GREY = ${glslFloat(AGX_MIDDLE_GREY)};
const float AGX_BLACK_RELATIVE_EV = ${glslFloat(curve.blackRelativeEv)};
const float AGX_RANGE_IN_EV = ${glslFloat(curve.rangeInEv)};
const float AGX_GAMMA = ${glslFloat(curve.gamma)};
const float AGX_SLOPE = ${glslFloat(curve.slope)};
const float AGX_INTERCEPT = ${glslFloat(curve.intercept)};
const float AGX_TARGET_BLACK = ${glslFloat(curve.targetBlack)};
const float AGX_TARGET_WHITE = ${glslFloat(curve.targetWhite)};
const float AGX_TOE_X = ${glslFloat(curve.toe.transitionX)};
const float AGX_TOE_Y = ${glslFloat(curve.toe.transitionY)};
const float AGX_TOE_SCALE = ${glslFloat(curve.toe.scale)};
const float AGX_TOE_POWER = ${glslFloat(curve.toe.power)};
const float AGX_SHOULDER_X = ${glslFloat(curve.shoulder.transitionX)};
const float AGX_SHOULDER_Y = ${glslFloat(curve.shoulder.transitionY)};
const float AGX_SHOULDER_SCALE = ${glslFloat(curve.shoulder.scale)};
const float AGX_SHOULDER_POWER = ${glslFloat(curve.shoulder.power)};
const float AGX_HUE_MIX = ${glslFloat(sceneReferredDefaults.lookOriginalHueMixRatio)};
const mat3 AGX_BASE_TO_RENDERING = ${glslMatrix(primaries.baseToRendering)};
const mat3 AGX_RENDERING_TO_SRGB = ${glslMatrix(renderingToSrgb)};

// _apply_log_encoding(), agx.c:723
float agx_log_encoding(float x) {
	float relative = max(AGX_EPSILON, x / AGX_MIDDLE_GREY);
	return clamp((log2(relative) - AGX_BLACK_RELATIVE_EV) / AGX_RANGE_IN_EV, 0.0, 1.0);
}

// _scaled_sigmoid(), agx.c:607
float agx_scaled_sigmoid(float x, float scale, float power, float transition_x, float transition_y) {
	float t = AGX_SLOPE * (x - transition_x) / scale;
	return scale * t / pow(1.0 + pow(t, power), 1.0 / power) + transition_y;
}

// _apply_curve(), agx.c:638
float agx_curve(float x) {
	float y;
	if (x < AGX_TOE_X) {
		y = agx_scaled_sigmoid(x, AGX_TOE_SCALE, AGX_TOE_POWER, AGX_TOE_X, AGX_TOE_Y);
	} else if (x <= AGX_SHOULDER_X) {
		y = AGX_SLOPE * x + AGX_INTERCEPT;
	} else {
		y = agx_scaled_sigmoid(x, AGX_SHOULDER_SCALE, AGX_SHOULDER_POWER, AGX_SHOULDER_X, AGX_SHOULDER_Y);
	}
	return clamp(y, AGX_TARGET_BLACK, AGX_TARGET_WHITE);
}

// dt_RGB_2_HSV(), src/common/colorspaces_inline_conversions.h
vec3 agx_rgb_to_hsv(vec3 rgb) {
	float high = max(rgb.r, max(rgb.g, rgb.b));
	float delta = high - min(rgb.r, min(rgb.g, rgb.b));
	if (abs(high) <= 1e-6 || abs(delta) <= 1e-6) {
		return vec3(0.0, 0.0, high);
	}
	float hue;
	if (rgb.r == high) {
		hue = (rgb.g - rgb.b) / delta;
	} else if (rgb.g == high) {
		hue = 2.0 + (rgb.b - rgb.r) / delta;
	} else {
		hue = 4.0 + (rgb.r - rgb.g) / delta;
	}
	hue /= 6.0;
	float h = hue - floor(hue);
	return vec3(h < 1.0 ? h : 0.0, delta / high, high);
}

// dt_HSV_2_RGB(), src/common/colorspaces_inline_conversions.h
vec3 agx_hsv_to_rgb(vec3 hsv) {
	float c = hsv.y * hsv.z;
	float low = hsv.z - c;
	float sector = floor(hsv.x * 6.0);
	float fc = (hsv.x * 6.0 - sector) * c;
	float top = c + low;
	float rising = fc + low;
	float falling = top - fc;
	switch (int(sector)) {
		case 0: return vec3(top, rising, low);
		case 1: return vec3(falling, top, low);
		case 2: return vec3(low, top, rising);
		case 3: return vec3(low, falling, top);
		case 4: return vec3(rising, low, top);
		default: return vec3(top, low, falling);
	}
}

// _lerp_hue(), agx.c:665; x - roundEven(x) is C's remainderf(x, 1), which rounds ties to even.
float agx_lerp_hue(float original, float processed, float ratio) {
	float difference = processed - original - roundEven(processed - original);
	float mixed = (1.0 - ratio) * difference + original;
	return mixed - floor(mixed);
}

float agx_srgb_encode(float linear) {
	return linear <= 0.0031308 ? 12.92 * linear : 1.055 * pow(linear, 1.0 / 2.4) - 0.055;
}

// process(), agx.c:1477, then the display's colour space. _compress_into_gamut() (agx.c:751)
// is omitted: it is the identity for non-negative input, where its offset is 0 and the two
// luminances it compares are computed identically.
vec3 display_transform(vec3 scene) {
	vec3 rendering = AGX_BASE_TO_RENDERING * scene;
	// _agx_tone_mapping(), agx.c:1189
	vec3 curved = vec3(
		agx_curve(agx_log_encoding(rendering.r)),
		agx_curve(agx_log_encoding(rendering.g)),
		agx_curve(agx_log_encoding(rendering.b))
	);
	vec3 linear = pow(max(curved, vec3(0.0)), vec3(AGX_GAMMA));
	vec3 hsv = agx_rgb_to_hsv(linear);
	hsv.x = agx_lerp_hue(agx_rgb_to_hsv(rendering).x, hsv.x, AGX_HUE_MIX);
	vec3 display = clamp(AGX_RENDERING_TO_SRGB * agx_hsv_to_rgb(hsv), 0.0, 1.0);
	return vec3(agx_srgb_encode(display.r), agx_srgb_encode(display.g), agx_srgb_encode(display.b));
}
`;

export function displayTransform(gpu: Gpu, scene: Image<'scene'>): Image<'display'> {
	return run<'display'>(gpu, {
		label: 'display transform',
		glsl: `${displayTransformGlsl}
			vec4 pixel(ivec2 p) {
				return vec4(display_transform(texelFetch(scene, p, 0).rgb), 1.0);
			}`,
		textures: { scene },
		uniforms: {},
		size: { width: scene.width, height: scene.height },
		format: 'RGBA16F'
	});
}
