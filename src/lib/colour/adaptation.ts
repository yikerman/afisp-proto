import { compose, diagonal, inverse, transform, type Matrix3, type Vec3 } from '../math/matrix';

// Li et al., "Comprehensive color solutions: CAM16, CAT16, and CAM16-UCS", 2017.
const CAT16: Matrix3 = [
	[0.401288, 0.650173, -0.051461],
	[-0.250268, 1.204414, 0.045854],
	[-0.002079, 0.048952, 0.953127]
];

// Lam, 1985; the transform ICC profiles are defined with.
const BRADFORD: Matrix3 = [
	[0.8951, 0.2664, -0.1614],
	[-0.7502, 1.7135, 0.0367],
	[0.0389, -0.0685, 1.0296]
];

/** XYZ to XYZ, complete adaptation from one white to another: von Kries scaling in `cone` space. */
const vonKries =
	(cone: Matrix3) =>
	(from: Vec3, to: Vec3): Matrix3 => {
		const source = transform(cone, from);
		const target = transform(cone, to);
		const gains: Vec3 = [target[0] / source[0], target[1] / source[1], target[2] / source[2]];
		return compose(inverse(cone), diagonal(gains), cone);
	};

export const adaptation = vonKries(CAT16);
export const bradfordAdaptation = vonKries(BRADFORD);
