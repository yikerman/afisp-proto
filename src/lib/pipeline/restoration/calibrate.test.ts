import { expect, test } from 'vitest';
import { rec2020Luminance } from '../../colour/spaces';
import { transform } from '../../math/matrix';
import type { RawMeta } from '../../raw/decode';
import { asShotIlluminant, calibrationMatrix } from './calibrate';

// Sony ILCE-7RM3, values as LibRaw reports them.
const meta = {
	asShotGains: [2612 / 1024, 1, 1620 / 1024],
	xyzToCamera: [
		[0.664, -0.1847, -0.0503],
		[-0.5238, 1.301, 0.2474],
		[-0.0993, 0.1673, 0.6527]
	]
} as unknown as RawMeta;

test('a neutral surface under the as-shot light is R=G=B', () => {
	const grey = transform(calibrationMatrix(meta, asShotIlluminant(meta)), [0.3, 0.3, 0.3]);
	expect(grey[0]).toBeCloseTo(grey[1], 6);
	expect(grey[2]).toBeCloseTo(grey[1], 6);
});

test('sensor clipping under the as-shot light is luminance 1', () => {
	const scene = transform(calibrationMatrix(meta, asShotIlluminant(meta)), [1, 1, 1]);
	expect(scene.reduce((y, c, i) => y + c * rec2020Luminance[i], 0)).toBeCloseTo(1, 6);
});

test('telling the pipeline the light was bluer makes the picture warmer', () => {
	const asShot = asShotIlluminant(meta);
	const bluer = { ...asShot, temperature: asShot.temperature + 2000 };
	const [r, , b] = transform(calibrationMatrix(meta, bluer), [0.3, 0.3, 0.3]);
	expect(r).toBeGreaterThan(b);
});
