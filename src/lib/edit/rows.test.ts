import { expect, test } from 'vitest';
import { ALL_TONES, type Rows } from '../pipeline/adjustments/row';
import { defaults } from './controls';
import {
	added,
	describe,
	drawn,
	elements,
	removed,
	usable,
	withStep,
	withTone,
	withWhat,
	withWhere
} from './rows';

const areaOf = (row: number) => ({ how: 'add', element: { kind: 'area', row } }) as const;

test('rows are added with fresh ids and the whole picture cannot be removed', () => {
	const rows = added(added(defaults.rows, 'shadows'), 'gradient');
	expect(rows.map((row) => row.id)).toEqual([0, 1, 2]);
	expect(removed(rows, 1).map((row) => row.name)).toEqual(['Whole picture', 'Gradient']);
	expect(removed(rows, 0)).toEqual(rows);
	expect(added(removed(rows, 1), 'ellipse').at(-1)!.id).toBe(3);
	expect(added(defaults.rows, 'everywhere').at(-1)!.where).toEqual([]);
});

test('changing a row leaves the others as they were', () => {
	const rows = added(defaults.rows, 'shadows');
	const changed = withWhat(rows, 1, { lightness: 1 });
	expect(changed[0]).toBe(rows[0]);
	expect(changed[1].what.lightness).toBe(1);
});

test('a row may use the area of rows before it, and loses the step when that row goes', () => {
	let rows: Rows = added(added(added(defaults.rows, 'shadows'), 'gradient'), 'ellipse');
	expect(usable(rows, 3).map((row) => row.id)).toEqual([1, 2]);
	expect(usable(rows, 1)).toEqual([]);
	rows = withWhere(rows, 3, (where) => [...where, areaOf(1)]);
	expect(describe(rows[3].where, rows)).toBe('ellipse · + area of Shadows');
	expect(describe(removed(rows, 1)[2].where, rows)).toBe('ellipse');
});

test('a step can change how it combines without changing what it selects', () => {
	const [, row] = added(defaults.rows, 'gradient');
	const changed = withStep(row.where, 0, { how: 'subtract' });
	expect(changed[0].element).toBe(row.where[0].element);
	expect(describe(changed, [row])).toBe('− gradient');
});

test('a tone range stays a range when one edge passes the other', () => {
	expect(withTone({ low: -2, high: 2, softness: 1 }, 'low', 3)).toEqual({
		low: 3,
		high: 3,
		softness: 1
	});
	expect(withTone({ low: -2, high: 2, softness: 1 }, 'high', -5)).toEqual({
		low: -5,
		high: -5,
		softness: 1
	});
	expect(withTone(ALL_TONES, 'softness', 2).softness).toBe(2);
});

test('an ellipse drawn on a wide picture is round', () => {
	// 0.1 of the height on a 2:1 picture is 0.05 of the width.
	const round = drawn(elements.ellipse.element, [0.5, 0.5], [0.5, 0.6], 2);
	expect(round.kind === 'ellipse' && round.radii[0]).toBeCloseTo(0.05, 12);
	expect(round.kind === 'ellipse' && round.radii[1]).toBeCloseTo(0.05, 12);
	expect(drawn(elements.shadows.element, [0, 0], [1, 1], 2)).toBe(elements.shadows.element);
});

test('where a row applies is described in words', () => {
	const rows = added(defaults.rows, 'shadows');
	expect(describe(rows[0].where, rows)).toBe('');
	expect(describe(rows[1].where, rows)).toBe('tones below -4');
});
