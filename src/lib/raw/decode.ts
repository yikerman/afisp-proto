import { LibRaw } from '@colorhythm/libraw-wasm';
import wasmUrl from '@colorhythm/libraw-wasm/libraw.wasm?url';
import type { Matrix3, Vec3 } from '../math/matrix';
import type { Size } from '../gpu/image';
import { GREEN, type BayerPattern, type Channel } from './bayer';
import { embeddedLensCorrection, type LensCorrection } from './lensData';

/** Quarter turns clockwise that bring the sensor image upright. */
export type QuarterTurns = 0 | 1 | 2 | 3;

/** Everything the pipeline needs to interpret the sensor data. Holds for every decoded file. */
export interface RawMeta {
	readonly camera: string;
	readonly lens: string;
	readonly iso: number;
	readonly shutter: number;
	readonly aperture: number;
	readonly focalLength: number;
	/** The part of the sensor data that is image, in sensor pixels. */
	readonly active: Size & { readonly x: number; readonly y: number };
	/** Bayer pattern with its origin at the active area's top-left pixel. */
	readonly pattern: BayerPattern;
	/** Sensor counts for no light, per pattern site. */
	readonly black: readonly [number, number, number, number];
	/** Sensor counts at clipping. */
	readonly white: number;
	/** Gains that make a neutral surface R=G=B under the light the camera measured; green is 1. */
	readonly asShotGains: Vec3;
	/** CIE XYZ (D65 scene) to camera RGB. */
	readonly xyzToCamera: Matrix3;
	readonly orientation: QuarterTurns;
}

export interface RawFile {
	/** Sensor counts, row-major, `sensorSize.width` per row, including inactive margins. */
	readonly sensor: Uint16Array<ArrayBuffer>;
	readonly sensorSize: Size;
	readonly meta: RawMeta;
	/** The lens correction the camera wrote into the file; no correction if it wrote none. */
	readonly lens: LensCorrection;
}

const range = <N extends number>(n: N) => Array.from({ length: n }, (_, i) => i);
const sites = [
	[0, 0],
	[0, 1],
	[1, 0],
	[1, 1]
] as const;

// LibRaw encodes orientation as the dcraw `flip` code.
const quarterTurns: Record<number, QuarterTurns> = { 0: 0, 3: 2, 5: 3, 6: 1 };

/**
 * Boundary to the decoder: unpacks the sensor data and normalises LibRaw's
 * metadata into `RawMeta`. Throws for files the pipeline does not handle.
 */
export async function decode(file: ArrayBuffer): Promise<RawFile> {
	const lens = embeddedLensCorrection(file);
	await LibRaw.initialize(fetch(wasmUrl));
	using raw = new LibRaw();
	await raw.waitUntilReady();
	raw.open(file);
	raw.unpack();

	const sensor = raw.getRawImage();
	// LibRaw: `filters` is a 2-bit-per-site Bayer description above 1000, 9 for X-Trans, 0 for no mosaic.
	if (!sensor || raw.getFilters() >>> 0 < 1000 || raw.getColors() !== 3) {
		throw new Error('Only Bayer-sensor RAW files are supported.');
	}

	// LibRaw numbers the second green as colour 3.
	const libRawColour = sites.map(([row, column]) => raw.color(row, column));
	const pattern = libRawColour.map((c) => (c === 3 ? GREEN : c)) as readonly Channel[];

	// Black level is a global value, plus a per-colour offset, plus an optional repeating tile.
	const [tileRows, tileColumns] = [raw.getCblack(4), raw.getCblack(5)];
	const black = sites.map(([row, column], i) => {
		const tile =
			tileRows * tileColumns > 0
				? raw.getCblack(6 + (row % tileRows) * tileColumns + (column % tileColumns))
				: 0;
		return raw.getBlack() + raw.getCblack(libRawColour[i]) + tile;
	});

	// Some files carry no as-shot white balance; LibRaw's daylight gains stand in for it.
	const gains = range(3).map(
		raw.getCamMul(0) > 0 ? (i) => raw.getCamMul(i) : (i) => raw.getPreMul(i)
	);

	const other = raw.getImgOther();
	const maker = raw.getIParams();
	return {
		sensor,
		sensorSize: { width: raw.getRawWidth(), height: raw.getRawHeight() },
		lens,
		meta: {
			camera: `${maker.make} ${maker.model}`,
			lens: raw.getLensInfo().Lens,
			iso: other.iso_speed,
			shutter: other.shutter,
			aperture: other.aperture,
			focalLength: other.focal_len,
			active: {
				x: raw.getLeftMargin(),
				y: raw.getTopMargin(),
				width: raw.getIWidth(),
				height: raw.getIHeight()
			},
			pattern: pattern as unknown as BayerPattern,
			black: black as unknown as RawMeta['black'],
			white: raw.getColorMaximum(),
			asShotGains: gains.map((g) => g / gains[GREEN]) as unknown as Vec3,
			xyzToCamera: range(3).map((i) =>
				range(3).map((j) => raw.getCamXyz(i, j))
			) as unknown as Matrix3,
			orientation: quarterTurns[raw.getFlip()]
		}
	};
}
