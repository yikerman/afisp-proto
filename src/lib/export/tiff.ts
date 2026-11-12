import type { Size } from '../gpu/image';

// TIFF 6.0, baseline RGB, one uncompressed strip, little-endian.
const [SHORT, LONG, UNDEFINED] = [3, 4, 7];

/**
 * A 16-bit RGB TIFF with an embedded ICC profile. `rgb` holds three samples
 * per pixel, row by row, in the profile's encoding.
 */
export function encodeTiff(
	rgb: Uint16Array<ArrayBuffer>,
	size: Size,
	profile: Uint8Array<ArrayBuffer>
): Blob {
	const pixelsAt = 8;
	const bitsAt = pixelsAt + rgb.byteLength;
	const profileAt = bitsAt + 6;
	const directoryAt = profileAt + profile.length + (profile.length % 2);

	const entries: readonly (readonly [tag: number, type: number, count: number, value: number])[] = [
		[256, LONG, 1, size.width],
		[257, LONG, 1, size.height],
		[258, SHORT, 3, bitsAt], // bits per sample
		[259, SHORT, 1, 1], // no compression
		[262, SHORT, 1, 2], // RGB
		[273, LONG, 1, pixelsAt], // strip offset
		[277, SHORT, 1, 3], // samples per pixel
		[278, LONG, 1, size.height], // rows per strip
		[279, LONG, 1, rgb.byteLength], // strip byte count
		[284, SHORT, 1, 1], // chunky
		[34675, UNDEFINED, profile.length, profileAt]
	];

	const header = new DataView(new ArrayBuffer(8));
	header.setUint16(0, 0x4949); // "II"
	header.setUint16(2, 42, true);
	header.setUint32(4, directoryAt, true);

	const tail = new DataView(new ArrayBuffer(directoryAt - bitsAt + 2 + entries.length * 12 + 4));
	[16, 16, 16].forEach((bits, i) => tail.setUint16(i * 2, bits, true));
	new Uint8Array(tail.buffer).set(profile, profileAt - bitsAt);
	let at = directoryAt - bitsAt;
	tail.setUint16(at, entries.length, true);
	at += 2;
	for (const [tag, type, count, value] of entries) {
		tail.setUint16(at, tag, true);
		tail.setUint16(at + 2, type, true);
		tail.setUint32(at + 4, count, true);
		// A single SHORT is stored in the low half of the value field.
		if (type === SHORT && count === 1) tail.setUint16(at + 8, value, true);
		else tail.setUint32(at + 8, value, true);
		at += 12;
	}

	return new Blob([header, rgb, tail], { type: 'image/tiff' });
}
