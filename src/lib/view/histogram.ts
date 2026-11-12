import type { Gpu } from '../gpu/gpu';
import { download, type Image, type Size } from '../gpu/image';
import { run } from '../gpu/pass';
import { fit, resample } from './resample';

export const BINS = 256;

/** Counts per encoded value, for red, green and blue. */
export type Histogram = readonly [Uint32Array, Uint32Array, Uint32Array];

const SAMPLED_LONG_SIDE = 512;

/** Histogram of the display image, taken from an area-averaged reduction of it. */
export async function histogram(gpu: Gpu, display: Image<'display'>): Promise<Histogram> {
	const scale = SAMPLED_LONG_SIDE / Math.max(display.width, display.height);
	const size: Size = {
		width: Math.round(display.width * scale),
		height: Math.round(display.height * scale)
	};
	const reduced = run(gpu, resample(display, fit(display, size)));
	const pixels = new Uint8Array(await download(gpu, reduced));
	reduced.destroy();
	const counts: Histogram = [new Uint32Array(BINS), new Uint32Array(BINS), new Uint32Array(BINS)];
	for (let i = 0; i < pixels.length; i += 4) {
		counts[0][pixels[i]]++;
		counts[1][pixels[i + 1]]++;
		counts[2][pixels[i + 2]]++;
	}
	return counts;
}
