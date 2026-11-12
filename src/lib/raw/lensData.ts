// The Sony conversion is ported from darktable (GPL-3.0-or-later) at master
// bdce4fed98499b90077946e323f08069b979ee79; line numbers below refer to that revision.

/**
 * One sample of the geometric correction. For an output pixel at `radius` from
 * the image centre, in half-diagonals of the image, each channel is read from
 * the input at that radius times the channel's scale. Green carries the
 * distortion; red and blue differ from it by the lateral chromatic aberration.
 */
export interface GeometryKnot {
	readonly radius: number;
	readonly red: number;
	readonly green: number;
	readonly blue: number;
}

/** One sample of the vignetting correction: the gain for an input pixel at `radius`. */
export interface VignettingKnot {
	readonly radius: number;
	readonly gain: number;
}

/**
 * Lens correction as functions of radius, whatever their source. Each is
 * sampled at knots and read as darktable reads embedded corrections: linear
 * between knots and constant beyond the first and the last
 * (`_interpolate_linear_spline`, src/iop/lens.cc:2319).
 *
 * Holds for every value: each list is non-empty, radii strictly ascending,
 * scales and gains positive. No correction is every scale and gain 1.
 */
export interface LensCorrection {
	readonly geometry: readonly GeometryKnot[];
	readonly vignetting: readonly VignettingKnot[];
}

/** Settings for a correction made by hand. All zero is no correction. */
export interface ManualLens {
	/**
	 * Distortion of the lens in percent of the radius at the corner: barrel
	 * (negative) or pincushion (positive). Range -20 to 20.
	 */
	readonly distortion: number;
	/** Brightening towards the corners, in stops at the corner. Range -1 to 3. */
	readonly vignetting: number;
	/**
	 * Lateral chromatic aberration: magnification of red and of blue against
	 * green, in per mille. Range -10 to 10, as darktable's TCA override
	 * (0.99 to 1.01, src/iop/lens.cc:139).
	 */
	readonly red: number;
	readonly blue: number;
}

// Manual corrections are sampled densely enough that linear interpolation of
// r^2 stays within about 0.1 px of the model on a 42 MP frame at the extreme of the
// distortion range. Knots fall on the corner (radius 1) and reach 1.5 because
// the output frame can reach past the corner after scaling
// (pipeline/restoration/lens.ts).
const KNOTS_PER_HALF_DIAGONAL = 48;
const MANUAL_RADIUS = 1.5;

/**
 * Radial models: the lens moves a point at radius r to r (1 + k r^2) and
 * scales red and blue by a constant (lensfun's poly3 without its rescaling
 * term, and its linear TCA model); vignetting is corrected by a gain whose
 * logarithm grows with r^2.
 */
export function manualLensCorrection(manual: ManualLens): LensCorrection {
	const k = manual.distortion / 100;
	const radii = Array.from(
		{ length: MANUAL_RADIUS * KNOTS_PER_HALF_DIAGONAL + 1 },
		(_, i) => i / KNOTS_PER_HALF_DIAGONAL
	);
	return {
		geometry: radii.map((radius) => {
			const green = 1 + k * radius ** 2;
			return {
				radius,
				red: green * (1 + manual.red / 1000),
				green,
				blue: green * (1 + manual.blue / 1000)
			};
		}),
		vignetting: radii.map((radius) => ({ radius, gain: 2 ** (manual.vignetting * radius ** 2) }))
	};
}

export const noLensCorrection: LensCorrection = manualLensCorrection({
	distortion: 0,
	vignetting: 0,
	red: 0,
	blue: 0
});

// Sony tags, in the first SubIFD of an ARW (exiv2's Exif.SubImage1, which darktable
// reads in src/common/exif.cc:1385).
const SUB_IFDS = 0x014a;
const VIGNETTING = 0x7032;
const CHROMATIC_ABERRATION = 0x7035;
const DISTORTION = 0x7037;
const SSHORT = 8;
const LONG = 4;
const IFD = 13;
// Bytes per value of each TIFF field type (TIFF 6.0 section 2, and TIFF-EP for IFD).
const typeSize: Readonly<Record<number, number>> = {
	1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4
}; // prettier-ignore
// darktable: MAXKNOTS (src/iop/lens.cc:51) and dt_image_correction_data_t (src/common/image.h:171).
const MAX_KNOTS = 16;

interface Entry {
	readonly type: number;
	readonly count: number;
	/** Where the values are: inside the entry if they fit in 4 bytes. */
	readonly offset: number;
}

/** A TIFF reader that answers `undefined` for anything outside the file. */
function tiff(file: ArrayBuffer) {
	const view = new DataView(file);
	if (view.byteLength < 8) return undefined;
	const order = view.getUint16(0);
	if (order !== 0x4949 && order !== 0x4d4d) return undefined;
	const little = order === 0x4949;
	const inside = (offset: number, bytes: number) =>
		offset >= 0 && offset + bytes <= view.byteLength;
	const u16 = (offset: number) => view.getUint16(offset, little);
	const u32 = (offset: number) => view.getUint32(offset, little);
	if (u16(2) !== 42) return undefined;

	const ifd = (offset: number): ReadonlyMap<number, Entry> | undefined => {
		if (!inside(offset, 2) || !inside(offset + 2, 12 * u16(offset))) return undefined;
		const entries = new Map<number, Entry>();
		for (let i = 0; i < u16(offset); i++) {
			const at = offset + 2 + 12 * i;
			const [type, count] = [u16(at + 2), u32(at + 4)];
			const bytes = (typeSize[type] ?? 1) * count;
			entries.set(u16(at), { type, count, offset: bytes > 4 ? u32(at + 8) : at + 8 });
		}
		return entries;
	};
	const shorts = (entry: Entry): readonly number[] | undefined =>
		entry.type === SSHORT && inside(entry.offset, 2 * entry.count)
			? Array.from({ length: entry.count }, (_, i) => view.getInt16(entry.offset + 2 * i, little))
			: undefined;
	const firstLong = (entry: Entry) =>
		(entry.type === LONG || entry.type === IFD) && entry.count > 0 && inside(entry.offset, 4)
			? u32(entry.offset)
			: undefined;
	return { ifd, shorts, firstLong, root: u32(4) };
}

/**
 * A Sony knot table: `[n, v0, ..., v(n-1)]`, or for chromatic aberration
 * `[2n, red..., blue...]`. Accepted when it has 2 to MAX_KNOTS knots and as
 * many values as its first one announces (src/common/exif.cc:1395); trailing
 * values are padding.
 */
function knotTable(values: readonly number[] | undefined, planes: 1 | 2) {
	if (!values) return undefined;
	const n = values[0] / planes;
	if (!Number.isInteger(n) || n < 2 || n > MAX_KNOTS || values.length < 1 + planes * n) {
		return undefined;
	}
	return {
		// Knot positions: src/iop/lens.cc:2514.
		radii: Array.from({ length: n }, (_, i) => (i + 0.5) / (n - 1)),
		planes: Array.from({ length: planes }, (_, p) => values.slice(1 + p * n, 1 + (p + 1) * n))
	};
}

/**
 * Boundary to the lens correction the camera wrote into the file. Reads the
 * Sony ARW tags and converts them as darktable's embedded-metadata method
 * (version 2) does, at fine-tune 1. Anything else, including a file that is
 * not TIFF or whose TIFF structure points outside the file, has no correction.
 *
 * Validated here: the TIFF structure stays inside the file; each tag is
 * int16s with a knot count in range and enough values; distortion scales are
 * positive (a value of -2^14 or less would turn the image inside out).
 * Distortion and chromatic aberration share their knots, so chromatic
 * aberration is used only with a distortion table of the same length.
 *
 * Deviation from darktable: it also requires the vignetting table to have the
 * distortion's knot count (exif.cc:1395). The DSC-RX100M3 writes 11
 * distortion knots and 16 vignetting knots, and each table locates its own
 * knots, so here each is read on its own.
 */
export function embeddedLensCorrection(file: ArrayBuffer): LensCorrection {
	const reader = tiff(file);
	const subIfdEntry = reader?.ifd(reader.root)?.get(SUB_IFDS);
	const subIfdOffset = subIfdEntry && reader?.firstLong(subIfdEntry);
	const tags = subIfdOffset === undefined ? undefined : reader?.ifd(subIfdOffset);
	const table = (tag: number, planes: 1 | 2) => {
		const entry = tags?.get(tag);
		return knotTable(entry && reader?.shorts(entry), planes);
	};

	const distortion = table(DISTORTION, 1);
	const ca = table(CHROMATIC_ABERRATION, 2);
	const vignetting = table(VIGNETTING, 1);
	const validDistortion = distortion?.planes[0].every((d) => d > -(2 ** 14))
		? distortion
		: undefined;
	const sharedCa =
		ca && (!validDistortion || ca.radii.length === validDistortion.radii.length) ? ca : undefined;
	const grid = validDistortion ?? sharedCa;

	return {
		// src/iop/lens.cc:2516-2531 (_init_coeffs_md_v2): distortion d scales the radius
		// by 1 + d 2^-14; chromatic aberration c scales red or blue further by 1 + c 2^-21.
		geometry: grid
			? grid.radii.map((radius, i) => {
					const green = 1 + (validDistortion?.planes[0][i] ?? 0) * 2 ** -14;
					const red = 1 + (sharedCa?.planes[0][i] ?? 0) * 2 ** -21;
					const blue = 1 + (sharedCa?.planes[1][i] ?? 0) * 2 ** -21;
					return { radius, red: green * red, green, blue: green * blue };
				})
			: noLensCorrection.geometry,
		// src/iop/lens.cc:2534-2536 gives the falloff 2^(0.5 - 2^(v 2^-13 - 1)), which
		// _process_md divides by (lens.cc:3140); its 1e-4 floor is never reached,
		// since the falloff of any int16 v is above 2^-7.5.
		vignetting: vignetting
			? vignetting.radii.map((radius, i) => ({
					radius,
					gain: 2 ** (2 ** (vignetting.planes[0][i] * 2 ** -13 - 1) - 0.5)
				}))
			: noLensCorrection.vignetting
	};
}
