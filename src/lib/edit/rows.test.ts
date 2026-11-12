import { expect, test } from 'vitest';
import { ALL_TONES, type Rows } from '../pipeline/adjustments/row';
import { defaults } from './controls';
import {
	added,
	atoms,
	describe,
	drawn,
	presets,
	removed,
	started,
	usable,
	withStep,
	withTone,
	withWhat,
	withWhere,
	type Start
} from './rows';

const shadows: Start = { from: 'preset', preset: 'shadows' };
const gradient: Start = { from: 'atom', atom: 'gradient' };
const ellipse: Start = { from: 'atom', atom: 'ellipse' };

const areaOf = (row: number) => ({ how: 'add', element: { kind: 'area', row } }) as const;

test('rows are added with fresh ids and the whole picture cannot be removed', () => {
	const rows = added(added(defaults.rows, shadows), gradient);
	expect(rows.map((row) => row.id)).toEqual([0, 1, 2]);
	expect(removed(rows, 1).map((row) => row.name)).toEqual(['Whole picture', 'Gradient']);
	expect(removed(rows, 0)).toEqual(rows);
	expect(added(removed(rows, 1), ellipse).at(-1)!.id).toBe(3);
	expect(added(defaults.rows, { from: 'nothing' }).at(-1)!.where).toEqual([]);
});

test('changing a row leaves the others as they were', () => {
	const rows = added(defaults.rows, shadows);
	const changed = withWhat(rows, 1, { lightness: 1 });
	expect(changed[0]).toBe(rows[0]);
	expect(changed[1].what.lightness).toBe(1);
});

test('a row may use the area of rows before it, and loses the step when that row goes', () => {
	let rows: Rows = added(added(added(defaults.rows, shadows), gradient), ellipse);
	expect(usable(rows, 3).map((row) => row.id)).toEqual([1, 2]);
	expect(usable(rows, 1)).toEqual([]);
	rows = withWhere(rows, 3, (where) => [...where, areaOf(1)]);
	expect(describe(rows[3].where, rows)).toBe('ellipse · + area of Shadows');
	expect(describe(removed(rows, 1)[2].where, rows)).toBe('ellipse');
});

test('a step can change how it combines without changing what it selects', () => {
	const [, row] = added(defaults.rows, gradient);
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
	const round = drawn(atoms.ellipse.element, [0.5, 0.5], [0.5, 0.6], 2);
	expect(round.kind === 'ellipse' && round.radii[0]).toBeCloseTo(0.05, 12);
	expect(round.kind === 'ellipse' && round.radii[1]).toBeCloseTo(0.05, 12);
	expect(drawn(atoms.tones.element, [0, 0], [1, 1], 2)).toBe(atoms.tones.element);
});

test('where a row applies is described in words', () => {
	const rows = added(defaults.rows, shadows);
	expect(describe(rows[0].where, rows)).toBe('');
	expect(describe(rows[1].where, rows)).toBe('tones below -4');
});

test('a preset is made of atoms only, and an atom starts by selecting as much as it can', () => {
	const kinds = Object.values(atoms).map((atom) => atom.element.kind as string);
	for (const preset of Object.values(presets)) {
		for (const step of preset.where) expect(kinds).toContain(step.element.kind);
	}
	expect(started({ from: 'atom', atom: 'tones' }).where[0].element).toMatchObject({
		low: -16,
		high: 16
	});
	expect(started({ from: 'nothing' }).where).toEqual([]);
});
