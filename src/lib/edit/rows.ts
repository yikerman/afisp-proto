import type { Vec2 } from '../math/matrix';
import {
	ALL_TONES,
	BRIGHTEST,
	DARKEST,
	EVERYWHERE,
	HIGHLIGHTS,
	MIDTONES,
	SHADOWS,
	UNCHANGED,
	type Place,
	type Row,
	type Rows,
	type Tones,
	type What,
	type Where
} from '../pipeline/adjustments/row';
import { slider, type Slider, type Wheel } from './controls';

const what = { stage: 'adjustments', section: 'What' } as const;
const where = { stage: 'adjustments', section: 'Where' } as const;

/** The settings every row has. */
export const settings = {
	lightness: slider({
		...what,
		label: 'Lightness',
		unit: 'EV',
		step: 0.01,
		min: -4,
		max: 4,
		default: UNCHANGED.lightness
	}),
	contrast: slider({
		...what,
		label: 'Contrast',
		unit: '',
		step: 0.01,
		min: 0.25,
		max: 3,
		default: UNCHANGED.contrast
	}),
	detail: slider({
		...what,
		label: 'Detail',
		unit: '',
		step: 0.01,
		min: -1,
		max: 2,
		default: UNCHANGED.detail
	}),
	saturation: slider({
		...what,
		label: 'Saturation',
		unit: '',
		step: 0.01,
		min: 0,
		max: 2,
		default: UNCHANGED.saturation
	})
} as const satisfies { [K in keyof What]?: Slider };

export const colour: Wheel = {
	widget: 'wheel',
	...what,
	label: 'Colour',
	advanced: false,
	radius: 0.1,
	default: UNCHANGED.colour
};

const tone = (label: string, initial: number): Slider =>
	slider({
		...where,
		label,
		unit: 'EV',
		step: 0.1,
		min: DARKEST,
		max: BRIGHTEST,
		default: initial
	});

/** The edges of a tone range, and how far it fades past them. */
export const toneRange = {
	low: tone('Darkest', ALL_TONES.low),
	high: tone('Brightest', ALL_TONES.high),
	softness: slider({
		...where,
		label: 'Softness',
		unit: 'EV',
		step: 0.1,
		min: 0,
		max: 8,
		default: 0
	})
} as const satisfies { [K in keyof Tones]: Slider };

export const feather = slider({
	...where,
	label: 'Feather',
	unit: '',
	step: 0.01,
	min: 0,
	max: 2,
	default: 0.5
});

/** Kinds of row that can be added. A place starts where the user then draws it. */
export const additions = {
	shadows: { name: 'Shadows', where: { ...EVERYWHERE, tones: SHADOWS } },
	midtones: { name: 'Midtones', where: { ...EVERYWHERE, tones: MIDTONES } },
	highlights: { name: 'Highlights', where: { ...EVERYWHERE, tones: HIGHLIGHTS } },
	gradient: {
		name: 'Gradient',
		where: { ...EVERYWHERE, place: { kind: 'gradient', from: [0.5, 0.2], to: [0.5, 0.6] } }
	},
	ellipse: {
		name: 'Ellipse',
		where: {
			...EVERYWHERE,
			place: { kind: 'ellipse', centre: [0.5, 0.5], radii: [0.2, 0.2], angle: 0, feather: 0.5 }
		}
	}
} as const satisfies Record<string, { name: string; where: Where }>;

export type Addition = keyof typeof additions;

export function added(rows: Rows, kind: Addition): Rows {
	const id = Math.max(...rows.map((row) => row.id)) + 1;
	return [...rows, { id, ...additions[kind], what: UNCHANGED }];
}

/** The first row is the whole picture and stays. */
export const removed = (rows: Rows, id: number): Rows => {
	const [whole, ...rest] = rows;
	return [whole, ...rest.filter((row) => row.id !== id)];
};

const replaced = (rows: Rows, id: number, change: (row: Row) => Row): Rows =>
	rows.map((row) => (row.id === id ? change(row) : row)) as unknown as Rows;

export const withWhat = (rows: Rows, id: number, change: Partial<What>): Rows =>
	replaced(rows, id, (row) => ({ ...row, what: { ...row.what, ...change } }));

export const withWhere = (rows: Rows, id: number, change: Partial<Where>): Rows =>
	replaced(rows, id, (row) => ({ ...row, where: { ...row.where, ...change } }));

/** A tone range with one edge moved; the other edge gives way so the range stays a range. */
export function withTone(tones: Tones, edge: keyof Tones, value: number): Tones {
	const moved = { ...tones, [edge]: value };
	return {
		...moved,
		low: Math.min(moved.low, edge === 'low' ? moved.low : moved.high),
		high: Math.max(moved.high, edge === 'high' ? moved.high : moved.low)
	};
}

/** A place of the same kind as `place`, drawn from one image point to another (as fractions). */
export function drawn(place: Place, from: Vec2, to: Vec2, aspect: number): Place {
	switch (place.kind) {
		case 'everywhere':
			return place;
		case 'gradient':
			return { ...place, from, to };
		case 'ellipse': {
			// Lengths are fractions of the width; heights are scaled to match.
			const radius = Math.hypot(to[0] - from[0], (to[1] - from[1]) / aspect);
			return { ...place, centre: from, radii: [radius, radius] };
		}
	}
}

/** A short description of where a row applies, for the list. */
export function describe({ place, outside, tones }: Where): string {
	const parts: string[] = [];
	if (place.kind !== 'everywhere') parts.push(outside ? `outside ${place.kind}` : place.kind);
	const [low, high] = [tones.low > DARKEST, tones.high < BRIGHTEST];
	if (low && high) parts.push(`tones ${tones.low} to ${tones.high}`);
	else if (low) parts.push(`tones above ${tones.low}`);
	else if (high) parts.push(`tones below ${tones.high}`);
	return parts.join(' · ');
}
