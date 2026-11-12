import { TEMPERATURE_RANGE } from '../colour/illuminant';
import type { Vec2 } from '../math/matrix';
import { EVERYWHERE, UNCHANGED, type Row, type Rows } from '../pipeline/adjustments/row';
import type { LensChoice } from '../pipeline/render';

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

export const restoration = { stage: 'restoration' } as const;
const lens = { ...restoration, section: 'Lens correction' } as const;
const stops = { unit: 'EV', step: 0.01 };

/**
 * Every Restoration control: the table that part of the edit state's type, its
 * panel and its log entries are derived from. Adjustments are rows, not a fixed
 * set of controls; see `rows.ts`.
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

	lens: {
		widget: 'choice',
		...restoration,
		section: 'Lens correction',
		label: 'Correction',
		advanced: false,
		options: [
			{ value: 'embedded', label: 'From the file' },
			{ value: 'manual', label: 'Manual' },
			{ value: 'none', label: 'None' }
		],
		default: 'embedded'
	} satisfies Choice<LensChoice['source']> as Choice<LensChoice['source']>,
	// Shown only for manual correction; see `items.ts`.
	lensDistortion: slider({
		...lens,
		label: 'Distortion',
		unit: '%',
		step: 0.1,
		min: -20,
		max: 20,
		default: 0
	}),
	lensVignetting: slider({ ...lens, label: 'Vignetting', ...stops, min: -1, max: 3, default: 0 }),
	lensRed: slider({
		...lens,
		label: 'Red fringe',
		unit: '‰',
		step: 0.01,
		min: -10,
		max: 10,
		default: 0
	}),
	lensBlue: slider({
		...lens,
		label: 'Blue fringe',
		unit: '‰',
		step: 0.01,
		min: -10,
		max: 10,
		default: 0
	})
} as const satisfies Record<string, Control>;

export type ControlId = keyof typeof controls;

/** The row every edit starts with and always keeps. */
export const WHOLE_PICTURE: Row = {
	id: 0,
	name: 'Whole picture',
	where: EVERYWHERE,
	what: UNCHANGED
};

type Value<C extends Control> = C extends Slider ? number : C extends Choice<infer V> ? V : Vec2;

/** The whole edit: one immutable value. */
export type EditState = { readonly [K in ControlId]: Value<(typeof controls)[K]> } & {
	readonly rows: Rows;
};

/** The nearest value a slider can hold: within its range, on its step. */
export function admit(spec: Slider, value: number): number {
	const decimals = Math.max(0, -Math.floor(Math.log10(spec.step)));
	const stepped = Math.round(value / spec.step) * spec.step;
	return Number(Math.min(Math.max(stepped, spec.min), spec.max).toFixed(decimals));
}

export const controlIds = Object.keys(controls) as ControlId[];

export const defaults: EditState = {
	...(Object.fromEntries(controlIds.map((id) => [id, controls[id].default])) as {
		[K in ControlId]: Value<(typeof controls)[K]>;
	}),
	rows: [WHOLE_PICTURE]
};

/** `state` as Restoration alone leaves it: the adjustments it opened with. */
export const withoutAdjustments = (state: EditState, initial: EditState): EditState => ({
	...state,
	rows: initial.rows
});
