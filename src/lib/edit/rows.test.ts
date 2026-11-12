import { expect, test } from 'vitest';
import { ALL_TONES } from '../pipeline/adjustments/row';
import { defaults } from './controls';
import { added, describe, drawn, removed, withTone, withWhat } from './rows';

test('rows are added with fresh ids and the whole picture cannot be removed', () => {
	const rows = added(added(defaults.rows, 'shadows'), 'gradient');
	expect(rows.map((row) => row.id)).toEqual([0, 1, 2]);
	expect(removed(rows, 1).map((row) => row.name)).toEqual(['Whole picture', 'Gradient']);
	expect(removed(rows, 0)).toEqual(rows);
	expect(added(removed(rows, 1), 'ellipse').at(-1)!.id).toBe(3);
});

test('changing a row leaves the others as they were', () => {
	const rows = added(defaults.rows, 'shadows');
	const changed = withWhat(rows, 1, { lightness: 1 });
	expect(changed[0]).toBe(rows[0]);
	expect(changed[1].what.lightness).toBe(1);
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
	const place = { kind: 'ellipse', centre: [0, 0], radii: [0, 0], angle: 0, feather: 0.5 } as const;
	// 0.1 of the height on a 2:1 picture is 0.05 of the width.
	const round = drawn(place, [0.5, 0.5], [0.5, 0.6], 2);
	expect(round.kind === 'ellipse' && round.radii[0]).toBeCloseTo(0.05, 12);
	expect(round.kind === 'ellipse' && round.radii[1]).toBeCloseTo(0.05, 12);
});

test('where a row applies is described in words', () => {
	const [whole, shadows, gradient] = added(added(defaults.rows, 'shadows'), 'gradient');
	expect(describe(whole.where)).toBe('');
	expect(describe(shadows.where)).toBe('tones below -4');
	expect(describe({ ...gradient.where, outside: true })).toBe('outside gradient');
});
