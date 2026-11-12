import { bradfordAdaptation } from '../colour/adaptation';
import { D65, srgbToXyz, whiteXyz } from '../colour/spaces';
import { multiply, transpose, type Vec3 } from '../math/matrix';

// ICC.1:2010 (profile version 4.3). All numbers are big-endian.

const PCS_WHITE: Vec3 = [0.9642, 1, 0.8249]; // D50 as the specification encodes it

const ascii = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));

function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

function u32(...values: readonly number[]): Uint8Array {
	const out = new DataView(new ArrayBuffer(values.length * 4));
	values.forEach((v, i) => out.setUint32(i * 4, v));
	return new Uint8Array(out.buffer);
}

function s15Fixed16(...values: readonly number[]): Uint8Array {
	const out = new DataView(new ArrayBuffer(values.length * 4));
	values.forEach((v, i) => out.setInt32(i * 4, Math.round(v * 65536)));
	return new Uint8Array(out.buffer);
}

const typed = (signature: string, ...data: readonly Uint8Array[]) =>
	concat([ascii(signature), u32(0), ...data]);

const xyz = (value: Vec3) => typed('XYZ ', s15Fixed16(...value));

function text(value: string) {
	const utf16 = new DataView(new ArrayBuffer(value.length * 2));
	[...value].forEach((c, i) => utf16.setUint16(i * 2, c.charCodeAt(0)));
	return typed(
		'mluc',
		u32(1, 12),
		ascii('enUS'),
		u32(utf16.byteLength, 28),
		new Uint8Array(utf16.buffer)
	);
}

/** An ICC profile for sRGB (IEC 61966-2-1): its primaries and its exact transfer function. */
export function srgbProfile(): Uint8Array<ArrayBuffer> {
	const toPcs = bradfordAdaptation(whiteXyz(D65), PCS_WHITE);
	const [red, green, blue] = transpose(multiply(toPcs, srgbToXyz));
	// parametricCurveType 3: Y = (aX + b)^g above d, cX below.
	const curve = typed(
		'para',
		Uint8Array.of(0, 3, 0, 0),
		s15Fixed16(2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045)
	);
	const tags: readonly (readonly [string, Uint8Array])[] = [
		['desc', text('sRGB IEC61966-2.1')],
		['cprt', text('No copyright, use freely')],
		['wtpt', xyz(PCS_WHITE)],
		['chad', typed('sf32', s15Fixed16(...toPcs.flat()))],
		['rXYZ', xyz(red)],
		['gXYZ', xyz(green)],
		['bXYZ', xyz(blue)],
		['rTRC', curve],
		['gTRC', curve],
		['bTRC', curve]
	];

	// Identical tag data is stored once and shared.
	const blocks = [...new Set(tags.map(([, data]) => data))];
	const padded = (length: number) => Math.ceil(length / 4) * 4;
	const tableEnd = 128 + 4 + tags.length * 12;
	const offsets = new Map<Uint8Array, number>();
	let end = tableEnd;
	for (const block of blocks) {
		offsets.set(block, end);
		end += padded(block.length);
	}

	const profile = new Uint8Array(end);
	profile.set(
		concat([
			u32(end, 0, 0x04300000),
			ascii('mntrRGB XYZ '),
			new Uint8Array(12), // creation date, left unset so the profile is reproducible
			ascii('acsp'),
			new Uint8Array(28), // platform, flags, device, attributes, perceptual intent
			s15Fixed16(...PCS_WHITE)
		])
	);
	profile.set(
		concat([
			u32(tags.length),
			...tags.map(([signature, data]) =>
				concat([ascii(signature), u32(offsets.get(data)!, data.length)])
			)
		]),
		128
	);
	for (const block of blocks) profile.set(block, offsets.get(block)!);
	return profile;
}
