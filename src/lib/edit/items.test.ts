import { expect, test } from 'vitest';
import { defaults, type EditState } from './controls';
import { items } from './items';

const item = (id: string) => items.find((i) => i.id === id)!;
const initial: EditState = { ...defaults, temperature: 5377, tint: 5.1 };
const apply = (state: EditState, id: string, value: unknown): EditState => ({
	...state,
	...item(id).write(value as never, state, initial)
});

test('every item reads back the value it was set to', () => {
	const cases: readonly (readonly [string, unknown])[] = [
		['exposure', 1.25],
		['temperature', 4200],
		['lightSource', 'a'],
		['lightSource', 'as-shot'],
		['lightHue', 75],
		['lightChroma', 60]
	];
	for (const [id, value] of cases) {
		const read = item(id).read(apply(initial, id, value), initial);
		if (typeof value === 'number') expect(read).toBeCloseTo(value, 4);
		else expect(read).toBe(value);
	}
});

test('hue and chroma are another reading of temperature and tint', () => {
	const moved = apply(initial, 'lightHue', item('lightHue').read(initial, initial));
	expect(moved.temperature).toBeCloseTo(initial.temperature, 3);
	expect(moved.tint).toBeCloseTo(initial.tint, 5);
});

test('a light that matches no named source reads as custom', () => {
	expect(item('lightSource').read(initial, initial)).toBe('as-shot');
	expect(item('lightSource').read({ ...initial, temperature: 5000 }, initial)).toBe('custom');
	expect(apply(initial, 'lightSource', 'custom')).toEqual(initial);
});

test('picking a tone as middle grey sets the exposure that puts it there', () => {
	const twoStopsUnder = [0.045, 0.045, 0.045];
	expect(apply(initial, 'pickMiddleGrey', twoStopsUnder).exposure).toBeCloseTo(
		initial.exposure + 2,
		2
	);
	expect(apply(initial, 'pickMiddleGrey', [0, 0, 0])).toEqual(initial);
});

test('picking something already neutral keeps the light', () => {
	const picked = apply(initial, 'pickNeutral', [0.3, 0.3, 0.3]);
	expect(picked.temperature).toBeCloseTo(initial.temperature, -1);
	expect(picked.tint).toBeCloseTo(initial.tint, 0);
});
