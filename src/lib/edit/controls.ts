import { TEMPERATURE_RANGE } from '../colour/illuminant';
import type { Vec2 } from '../math/matrix';

/** The pipeline stage a control belongs to, which is also the screen it appears on. */
export type Stage = 'restoration' | 'adjustments';

interface Placement {
	readonly stage: Stage;
	readonly section: string;
	readonly label: string;
	/**
	 * Advanced controls have a default that is right for most pictures. They
	 * stay out of the way, folded under their section, but are never withheld.
	 */
	readonly advanced: boolean;
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

export interface Choice<V extends string = string> extends Placement {
	readonly widget: 'choice';
	readonly options: readonly { readonly value: V; readonly label: string }[];
	readonly default: V;
}

/** A control that holds a value in the edit state. */
export type Control = Slider | Wheel | Choice;

/** Takes a colour from the picture. It holds no value; what it does with the colour is its item's. */
export interface Picker extends Placement {
	readonly widget: 'picker';
}

type Common = 'widget' | 'scale' | 'advanced';

export const slider = (
	spec: Omit<Slider, Common> & Partial<Pick<Slider, 'scale' | 'advanced'>>
): Slider => ({
	widget: 'slider',
	scale: 'linear',
	advanced: false,
	...spec
});

const wheel = (label: string): Wheel => ({
	widget: 'wheel',
	stage: 'adjustments',
	section: 'Colour balance',
	label,
	advanced: false,
	radius: 0.1,
	default: [0, 0]
});

export const [restoration, adjustments] = [
	{ stage: 'restoration' },
	{ stage: 'adjustments' }
] as const;
const stops = { unit: 'EV', step: 0.01 };
const ratio = { unit: '', step: 0.01 };

/**
 * Every user control: the single table the edit state's type, the panels and
 * the session log are derived from.
 */
export const controls = {
	exposure: slider({
		...restoration,
		section: 'Exposure',
		label: 'Exposure',
		...stops,
		min: -4,
		max: 4,
		default: 0.7
	}),

	// The default light is the one the camera recorded; see `initialState`.
	temperature: slider({
		...restoration,
		section: 'White balance',
		label: 'Temperature',
		unit: 'K',
		step: 10,
		min: TEMPERATURE_RANGE[0],
		max: TEMPERATURE_RANGE[1],
		scale: 'logarithmic',
		default: 6500
	}),
	tint: slider({
		...restoration,
		section: 'White balance',
		label: 'Tint',
		unit: '',
		step: 0.1,
		min: -60,
		max: 60,
		default: 0
	}),

	shadows: slider({
		...adjustments,
		section: 'Tone',
		label: 'Shadows',
		...stops,
		min: -2,
		max: 2,
		default: 0
	}),
	highlights: slider({
		...adjustments,
		section: 'Tone',
		label: 'Highlights',
		...stops,
		min: -2,
		max: 2,
		default: 0
	}),
	contrast: slider({
		...adjustments,
		section: 'Tone',
		label: 'Contrast',
		...ratio,
		min: 0.5,
		max: 2,
		default: 1
	}),

	saturation: slider({
		...adjustments,
		section: 'Colour',
		label: 'Saturation',
		...ratio,
		min: 0,
		max: 2,
		default: 1
	}),
	balance: wheel('Global'),
	balanceShadows: wheel('Shadows'),
	balanceMidtones: wheel('Midtones'),
	balanceHighlights: wheel('Highlights'),

	localContrast: slider({
		...adjustments,
		section: 'Detail',
		label: 'Local contrast',
		...ratio,
		min: -1,
		max: 1,
		default: 0
	})
} as const satisfies Record<string, Control>;

export type ControlId = keyof typeof controls;

type Value<C extends Control> = C extends Slider ? number : C extends Choice<infer V> ? V : Vec2;

/** The whole edit: one immutable value. */
export type EditState = { readonly [K in ControlId]: Value<(typeof controls)[K]> };

/** The nearest value a slider can hold: within its range, on its step. */
export function admit(spec: Slider, value: number): number {
	const decimals = Math.max(0, -Math.floor(Math.log10(spec.step)));
	const stepped = Math.round(value / spec.step) * spec.step;
	return Number(Math.min(Math.max(stepped, spec.min), spec.max).toFixed(decimals));
}

export const controlIds = Object.keys(controls) as ControlId[];

const entries = <T>(value: (id: ControlId) => T) =>
	Object.fromEntries(controlIds.map((id) => [id, value(id)]));

export const defaults = entries((id) => controls[id].default) as EditState;

/** `state` with the controls of one stage back at their values in `initial`. */
export const withStageReset = (state: EditState, initial: EditState, stage: Stage): EditState =>
	entries((id) => (controls[id].stage === stage ? initial[id] : state[id])) as EditState;
