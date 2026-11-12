import type { Gpu } from '../gpu/gpu';
import { download, type Image } from '../gpu/image';
import { srgbProfile } from './icc';
import { encodeTiff } from './tiff';

/** The display image as a file: the pixels that were previewed, at 16 bits, tagged sRGB. */
export async function exportTiff(gpu: Gpu, display: Image<'display'>): Promise<Blob> {
	const rgba = new Float16Array(await download(gpu, display));
	const rgb = new Uint16Array((rgba.length / 4) * 3);
	for (let from = 0, to = 0; from < rgba.length; from += 4, to += 3) {
		rgb[to] = Math.round(rgba[from] * 65535);
		rgb[to + 1] = Math.round(rgba[from + 1] * 65535);
		rgb[to + 2] = Math.round(rgba[from + 2] * 65535);
	}
	return encodeTiff(rgb, display, srgbProfile());
}
