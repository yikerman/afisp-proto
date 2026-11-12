import type { Module } from './module';

/** Tonal zones the curve is defined at, in stops relative to middle grey. */
export const NODE_STOPS = [-8, -6, -4, -2, 0, 2, 4, 6, 8] as const;
const [FIRST, SPACING, COUNT] = [NODE_STOPS[0], NODE_STOPS[1] - NODE_STOPS[0], NODE_STOPS.length];

type Nodes = { readonly nodes: `array<f32, ${typeof COUNT}>` };

/**
 * Exposure offset as a curve over tonal zones, as in darktable's tone
 * equalizer. Reading the zone from the smoothed image moves each region as a
 * whole, so detail inside it keeps its contrast.
 *
 * The curve is the monotone cubic through the nodes (Fritsch & Carlson,
 * "Monotone Piecewise Cubic Interpolation", 1980): it reproduces straight lines
 * exactly and never overshoots a node, so a zone left at zero stays at zero.
 */
export const toneEqualizer: Module<'tone', Nodes> = {
	kind: 'tone',
	name: 'tone_equalizer',
	params: { nodes: `array<f32, ${COUNT}>` },
	identity: { nodes: NODE_STOPS.map(() => 0) },
	imports: [],
	wgsl: /* wgsl */ `
fn tone_equalizer_tangent(before: f32, after: f32) -> f32 {
	return select(0.0, 2 * before * after / (before + after), before * after > 0);
}

fn tone_equalizer(reference: Reference, params: tone_equalizer_params) -> f32 {
	var nodes = params.nodes;
	let last = ${COUNT - 1};
	let x = clamp((reference.smoothed_stops - (${FIRST})) / ${SPACING}, 0, f32(last));
	let i = min(i32(x), last - 1);
	let t = x - f32(i);

	let rise = nodes[i + 1] - nodes[i];
	// Past either end the curve continues its last segment.
	let rise_before = nodes[i] - nodes[max(i - 1, 0)];
	let rise_after = nodes[min(i + 2, last)] - nodes[i + 1];
	let m0 = select(tone_equalizer_tangent(rise_before, rise), rise, i == 0);
	let m1 = select(tone_equalizer_tangent(rise, rise_after), rise, i == last - 1);

	let t2 = t * t;
	let t3 = t2 * t;
	return (2 * t3 - 3 * t2 + 1) * nodes[i] + (t3 - 2 * t2 + t) * m0
		+ (-2 * t3 + 3 * t2) * nodes[i + 1] + (t3 - t2) * m1;
}`
};

export interface ToneControls {
	/** Stops added everywhere: a lighter or darker picture with every zone where it was. */
	readonly brightness: number;
	/** Stops added to everything four or more stops below middle grey. */
	readonly shadows: number;
	/** Stops added to everything four or more stops above middle grey. */
	readonly highlights: number;
	/** Slope of output stops against input stops, about middle grey. */
	readonly contrast: number;
}

// Each control's share at the nodes. Both shelves are zero at middle grey and
// beyond it, so neither changes overall brightness or reaches into the other's side.
const SHADOWS = [1, 1, 1, 0.5, 0, 0, 0, 0, 0] as const;
const HIGHLIGHTS = [0, 0, 0, 0, 0, 0.5, 1, 1, 1] as const;

/** The curve the three tone controls stand for. */
export const toneCurve = ({
	brightness,
	shadows,
	highlights,
	contrast
}: ToneControls): readonly number[] =>
	NODE_STOPS.map(
		(stops, i) =>
			brightness + shadows * SHADOWS[i] + highlights * HIGHLIGHTS[i] + (contrast - 1) * stops
	);
