import type { Vec2 } from '../math/matrix';
import { TEMPERATURE_RANGE } from '../colour/illuminant';

/** The pipeline stage a control belongs to, which is also the screen it appears on. */
export type Stage = 'restoration' | 'adjustments';

interface Placement {
	readonly stage: Stage;
	readonly section: string;
	readonly label: string;
}

export interface Slider extends Placement {
	readonly widget: 'slider';
	readonly unit: string;
	readonly min: number;
	readonly max: number;
	readonly step: number;
	/** How the value is spread along the track. */
	readonly scale: 'linear' | 'logarithmic';
	readonly default: number;
}

export interface Wheel extends Placement {
	readonly widget: 'wheel';
	/** Distance from the centre to the rim. */
	readonly radius: number;
	readonly default: Vec2;
}

export type Control = Slider | Wheel;

const slider = (
	stage: Stage,
	section: string,
	label: string,
	unit: string,
	[min, max]: readonly [number, number],
	step: number,
	initial: number,
	scale: Slider['scale'] = 'linear'
): Slider => ({
	widget: 'slider',
	stage,
	section,
	label,
	unit,
	min,
	max,
	step,
	scale,
	default: initial
});

/**
 * Every user control: the single table the edit state's type, the panels and
 * the session log are derived from.
 */
export const controls = {
	exposure: slider('restoration', 'Exposure', 'Exposure', 'EV', [-4, 4], 0.01, 0.7),
	// The default light is the one the camera recorded; see `initialState`.
	temperature: slider(
		'restoration',
		'White balance',
		'Temperature',
		'K',
		TEMPERATURE_RANGE,
		10,
		6500,
		'logarithmic'
	),
	tint: slider('restoration', 'White balance', 'Tint', '', [-60, 60], 0.1, 0),
	shadows: slider('adjustments', 'Tone', 'Shadows', 'EV', [-2, 2], 0.01, 0),
	highlights: slider('adjustments', 'Tone', 'Highlights', 'EV', [-2, 2], 0.01, 0),
	contrast: slider('adjustments', 'Tone', 'Contrast', '', [0.5, 2], 0.01, 1),
	saturation: slider('adjustments', 'Colour', 'Saturation', '', [0, 2], 0.01, 1),
	balance: {
		widget: 'wheel',
		stage: 'adjustments',
		section: 'Colour',
		label: 'Balance',
		radius: 0.1,
		default: [0, 0]
	}
} as const satisfies Record<string, Control>;

export type ControlId = keyof typeof controls;

type Value<C extends Control> = C extends Slider ? number : Vec2;

/** The whole edit: one immutable value. */
export type EditState = { readonly [K in ControlId]: Value<(typeof controls)[K]> };

export const controlIds = Object.keys(controls) as ControlId[];

const entries = <T>(value: (id: ControlId) => T) =>
	Object.fromEntries(controlIds.map((id) => [id, value(id)]));

export const defaults = entries((id) => controls[id].default) as EditState;

/** `state` with the controls of one stage back at their values in `initial`. */
export const withStageReset = (state: EditState, initial: EditState, stage: Stage): EditState =>
	entries((id) => (controls[id].stage === stage ? initial[id] : state[id])) as EditState;
