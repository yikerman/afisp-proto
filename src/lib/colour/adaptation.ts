import { compose, diagonal, inverse, transform, type Matrix3, type Vec3 } from '../math/matrix';

// Li et al., "Comprehensive color solutions: CAM16, CAT16, and CAM16-UCS", 2017.
const CAT16: Matrix3 = [
	[0.401288, 0.650173, -0.051461],
	[-0.250268, 1.204414, 0.045854],
	[-0.002079, 0.048952, 0.953127]
];

/** XYZ to XYZ, complete adaptation from one white to another (von Kries scaling in CAT16). */
export function adaptation(from: Vec3, to: Vec3): Matrix3 {
	const source = transform(CAT16, from);
	const target = transform(CAT16, to);
	const gains: Vec3 = [target[0] / source[0], target[1] / source[1], target[2] / source[2]];
	return compose(inverse(CAT16), diagonal(gains), CAT16);
}
