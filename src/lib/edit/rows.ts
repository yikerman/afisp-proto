import type { Vec2 } from '../math/matrix';
import {
	ALL_TONES,
	BRIGHTEST,
	DARKEST,
	HIGHLIGHTS,
	MIDTONES,
	SHADOWS,
	UNCHANGED,
	type Element,
	type How,
	type Row,
	type Rows,
	type Step,
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

/** What each way of combining is called. */
export const hows: Record<How, string> = {
	intersect: 'Intersect',
	add: 'Add',
	subtract: 'Subtract'
};

/** Elements that can be put into a row's where. A shape starts where the user then draws it. */
export const elements = {
	shadows: { name: 'Shadows', element: { kind: 'tones', ...SHADOWS } },
	midtones: { name: 'Midtones', element: { kind: 'tones', ...MIDTONES } },
	highlights: { name: 'Highlights', element: { kind: 'tones', ...HIGHLIGHTS } },
	tones: { name: 'Tones', element: { kind: 'tones', ...ALL_TONES } },
	gradient: { name: 'Gradient', element: { kind: 'gradient', from: [0.5, 0.2], to: [0.5, 0.6] } },
	ellipse: {
		name: 'Ellipse',
		element: { kind: 'ellipse', centre: [0.5, 0.5], radii: [0.2, 0.2], angle: 0, feather: 0.5 }
	}
} as const satisfies Record<string, { name: string; element: Element }>;

export type ElementKind = keyof typeof elements;

const nextId = (rows: Rows) => Math.max(...rows.map((row) => row.id)) + 1;

/** A new row over the whole picture, or starting from one element. */
export function added(rows: Rows, kind: ElementKind | 'everywhere'): Rows {
	const fresh: Row =
		kind === 'everywhere'
			? { id: nextId(rows), name: 'Modification', where: [], what: UNCHANGED }
			: {
					id: nextId(rows),
					name: elements[kind].name,
					where: [{ how: 'intersect', element: elements[kind].element }],
					what: UNCHANGED
				};
	return [...rows, fresh];
}

const refersTo = (id: number) => (step: Step) =>
	step.element.kind === 'area' && step.element.row === id;

/**
 * The rows without row `id`, and without the steps that used its area. The
 * first row is the whole picture and stays.
 */
export function removed(rows: Rows, id: number): Rows {
	const [whole, ...rest] = rows;
	const kept = rest
		.filter((row) => row.id !== id)
		.map((row) => ({ ...row, where: row.where.filter((step) => !refersTo(id)(step)) }));
	return [whole, ...kept];
}

const replaced = (rows: Rows, id: number, change: (row: Row) => Row): Rows =>
	rows.map((row) => (row.id === id ? change(row) : row)) as unknown as Rows;

export const renamed = (rows: Rows, id: number, name: string): Rows =>
	replaced(rows, id, (row) => ({ ...row, name }));

export const withWhat = (rows: Rows, id: number, change: Partial<What>): Rows =>
	replaced(rows, id, (row) => ({ ...row, what: { ...row.what, ...change } }));

export const withWhere = (rows: Rows, id: number, change: (where: Where) => Where): Rows =>
	replaced(rows, id, (row) => ({ ...row, where: change(row.where) }));

export const withStep = (where: Where, index: number, change: Partial<Step>): Where =>
	where.map((step, i) => (i === index ? { ...step, ...change } : step));

/** Rows whose area row `id` may use: those before it, so no area can depend on itself. */
export const usable = (rows: Rows, id: number): readonly Row[] =>
	rows.slice(
		1,
		rows.findIndex((row) => row.id === id)
	);

/** A tone range with one edge moved; the other edge gives way so the range stays a range. */
export function withTone<T extends Tones>(tones: T, edge: keyof Tones, value: number): T {
	const moved = { ...tones, [edge]: value };
	return {
		...moved,
		low: Math.min(moved.low, edge === 'low' ? moved.low : moved.high),
		high: Math.max(moved.high, edge === 'high' ? moved.high : moved.low)
	};
}

/** `element`, if it is a shape, drawn from one image point to another (as fractions). */
export function drawn(element: Element, from: Vec2, to: Vec2, aspect: number): Element {
	switch (element.kind) {
		case 'gradient':
			return { ...element, from, to };
		case 'ellipse': {
			// Lengths are fractions of the width; heights are scaled to match.
			const radius = Math.hypot(to[0] - from[0], (to[1] - from[1]) / aspect);
			return { ...element, centre: from, radii: [radius, radius] };
		}
		default:
			return element;
	}
}

export const isShape = (element: Element) =>
	element.kind === 'gradient' || element.kind === 'ellipse';

/** An element in a few words. */
export function named(element: Element, rows: Rows): string {
	switch (element.kind) {
		case 'tones': {
			const [low, high] = [element.low > DARKEST, element.high < BRIGHTEST];
			if (low && high) return `tones ${element.low} to ${element.high}`;
			if (low) return `tones above ${element.low}`;
			if (high) return `tones below ${element.high}`;
			return 'all tones';
		}
		case 'area':
			return `area of ${rows.find((row) => row.id === element.row)!.name}`;
		default:
			return element.kind;
	}
}

const signs: Record<How, string> = { intersect: '', add: '+ ', subtract: '− ' };

/** Where a row applies, in a few words, for the list. */
export const describe = (where: Where, rows: Rows): string =>
	where.map(({ how, element }) => `${signs[how]}${named(element, rows)}`).join(' · ');
