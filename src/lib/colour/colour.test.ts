import { expect, test } from 'vitest';
import { inverse, multiply, transform, type Vec3 } from '../math/matrix';
import { adaptation } from './adaptation';
import { chromaticity, illuminant } from './illuminant';
import { D65, rec2020Luminance, rec2020ToXyz, whiteXyz, xyzToRec2020 } from './spaces';

const close = (actual: readonly number[], expected: readonly number[], digits: number) =>
	actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i], digits));

test('Rec.2020 matrix matches the published one', () => {
	// ITU-R BT.2020, luminance row.
	close(rec2020Luminance, [0.2627, 0.678, 0.0593], 4);
	close(transform(rec2020ToXyz, [1, 1, 1]), whiteXyz(D65), 12);
	close(multiply(rec2020ToXyz, xyzToRec2020).flat(), [1, 0, 0, 0, 1, 0, 0, 0, 1], 12);
});

test('inverse of a matrix undoes it', () => {
	const m = [[2, 1, 0], [0, 3, 1], [1, 0, 4]] as const; // prettier-ignore
	close(multiply(m, inverse(m)).flat(), [1, 0, 0, 0, 1, 0, 0, 0, 1], 12);
});

test('adaptation maps the source white to the target white', () => {
	const tungsten: Vec3 = whiteXyz([0.4476, 0.4074]);
	close(transform(adaptation(tungsten, whiteXyz(D65)), tungsten), whiteXyz(D65), 12);
	close(adaptation(tungsten, tungsten).flat(), [1, 0, 0, 0, 1, 0, 0, 0, 1], 12);
});

test('blackbody chromaticities match known values', () => {
	// Wyszecki & Stiles, blackbody locus. The cubic fit is good to about 1e-3.
	close(chromaticity({ temperature: 6500, tint: 0 }), [0.3135, 0.3237], 2);
	close(chromaticity({ temperature: 2856, tint: 0 }), [0.4476, 0.4074], 2);
	// D65 lies about 0.003 above the locus, on the green side.
	const d65 = illuminant(D65);
	expect(d65.temperature).toBeGreaterThan(6400);
	expect(d65.temperature).toBeLessThan(6600);
	expect(d65.tint).toBeCloseTo(3.2, 0);
});

test('temperature and tint round-trip through chromaticity', () => {
	for (const xy of [D65, [0.4476, 0.4074], [0.28, 0.3], [0.36, 0.34]] as const) {
		close(chromaticity(illuminant(xy)), xy, 7);
	}
});
