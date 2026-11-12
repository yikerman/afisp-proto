import { expect, test } from 'vitest';
import {
	embeddedLensCorrection,
	manualLensCorrection,
	noLensCorrection,
	type LensCorrection
} from './lensData';

/**
 * A minimal ARW-shaped TIFF: IFD0 holds only SubIFDs (0x014a), which points to
 * one IFD with the given int16s tags, as the ILCE-7RM3 files are laid out.
 */
function arw(tags: readonly (readonly [number, readonly number[]])[], little = true): ArrayBuffer {
	const subIfd = 8 + 2 + 12 + 4;
	const valuesStart = subIfd + 2 + 12 * tags.length + 4;
	const valueBytes = tags.reduce((n, [, values]) => n + 2 * values.length, 0);
	const view = new DataView(new ArrayBuffer(valuesStart + valueBytes));
	view.setUint16(0, little ? 0x4949 : 0x4d4d);
	view.setUint16(2, 42, little);
	view.setUint32(4, 8, little);
	view.setUint16(8, 1, little);
	view.setUint16(10, 0x014a, little);
	view.setUint16(12, 4, little); // LONG
	view.setUint32(14, 1, little);
	view.setUint32(18, subIfd, little);
	view.setUint16(subIfd, tags.length, little);
	let at = valuesStart;
	tags.forEach(([tag, values], i) => {
		const entry = subIfd + 2 + 12 * i;
		view.setUint16(entry, tag, little);
		view.setUint16(entry + 2, 8, little); // SSHORT
		view.setUint32(entry + 4, values.length, little);
		view.setUint32(entry + 8, at, little);
		values.forEach((v, j) => view.setInt16(at + 2 * j, v, little));
		at += 2 * values.length;
	});
	return view.buffer;
}

// ILCE-7RM3 with Tamron 28-200 at 28 mm, 20260412_0001.ARW, as exiftool prints them.
const distortion = [
	16, 6, 0, -10, -22, -37, -54, -75, -97, -120, -142, -163, -181, -196, -206, -211, -208
];
const vignetting = [
	16, 0, 32, 128, 288, 512, 832, 1184, 1568, 2048, 2624, 3360, 4320, 5408, 6560, 7680, 8800
];
const ca = [
	32, 1280, 1280, 1152, 1152, 1152, 1152, 1024, 1024, 1024, 1024, 1024, 1024, 1024, 896, 896, 896,
	0, 0, 0, 0, 0, 128, 128, 128, 256, 256, 384, 512, 640, 768, 768, 768
]; // prettier-ignore
const sony = [
	[0x7032, vignetting],
	[0x7035, ca],
	[0x7037, distortion]
] as const;

function expectClose(actual: LensCorrection, expected: LensCorrection) {
	const numbers = (c: LensCorrection) => [
		...c.geometry.flatMap((k) => [k.radius, k.red, k.green, k.blue]),
		...c.vignetting.flatMap((k) => [k.radius, k.gain])
	];
	const [a, e] = [numbers(actual), numbers(expected)];
	expect(a.length).toBe(e.length);
	a.forEach((x, i) => expect(x).toBeCloseTo(e[i], 12));
}

test('Sony tags become knots as darktable reads them', () => {
	for (const little of [true, false]) {
		const c = embeddedLensCorrection(arw(sony, little));
		expect(c.geometry).toHaveLength(16);
		expect(c.vignetting).toHaveLength(16);
		// Knot 0 at 0.5 / 15: distortion 6, CA red 1280, blue 0, vignetting 0.
		expect(c.geometry[0].radius).toBeCloseTo(0.5 / 15, 12);
		expect(c.geometry[0].green).toBeCloseTo(1 + 6 / 16384, 12);
		expect(c.geometry[0].red).toBeCloseTo((1 + 6 / 16384) * (1 + 1280 / 2097152), 12);
		expect(c.geometry[0].blue).toBeCloseTo(1 + 6 / 16384, 12);
		expect(c.vignetting[0].gain).toBeCloseTo(1, 12);
		// Knot 15 at 15.5 / 15: distortion -208, CA blue 768, vignetting 8800.
		expect(c.geometry[15].radius).toBeCloseTo(15.5 / 15, 12);
		expect(c.geometry[15].green).toBeCloseTo(1 - 208 / 16384, 12);
		expect(c.geometry[15].blue).toBeCloseTo((1 - 208 / 16384) * (1 + 768 / 2097152), 12);
		expect(c.vignetting[15].gain).toBeCloseTo(1 / 2 ** (0.5 - 2 ** (8800 / 8192 - 1)), 12);
	}
});

test('a TIFF without the tags, or not a TIFF, has no correction', () => {
	expectClose(embeddedLensCorrection(arw([[0x7000, [2]]])), noLensCorrection);
	expectClose(
		embeddedLensCorrection(new TextEncoder().encode('FUJIFILMCCD-RAW').buffer),
		noLensCorrection
	);
	expectClose(embeddedLensCorrection(new ArrayBuffer(0)), noLensCorrection);
});

test('a TIFF that points outside the file has no correction', () => {
	const file = arw(sony);
	new DataView(file).setUint32(18, file.byteLength, true);
	expectClose(embeddedLensCorrection(file), noLensCorrection);
	const truncated = arw(sony).slice(0, arw(sony).byteLength - 4);
	// The distortion table, last in the file, is cut; the other two remain.
	const c = embeddedLensCorrection(truncated);
	expect(c.vignetting).toHaveLength(16);
	expect(c.geometry).toHaveLength(16);
	expect(c.geometry[0].green).toBe(1);
	expect(c.geometry[0].red).toBeCloseTo(1 + 1280 / 2097152, 12);
});

test('tables with their own knot counts are read on their own (DSC-RX100M3)', () => {
	const c = embeddedLensCorrection(
		arw([
			[0x7032, [16, 0, 11, 95, 259, 504, 863, 1276, 1737, 2246, 2804, 3378, 3974, 4587, 5217, 5868, 6532]],
			[0x7035, [22, 0, 128, 256, 384, 384, 512, 640, 768, 1024, 1152, 1024, 0, 1024, 1152, 1024, 1024, 896, 640, 512, 512, 512, 640, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]],
			[0x7037, [11, 1265, 1218, 1083, 860, 562, 209, -179, -580, -972, -1353, -1725, 0, 0, 0, 0, 0]]
		])
	); // prettier-ignore
	expect(c.geometry).toHaveLength(11);
	expect(c.geometry[10].radius).toBeCloseTo(10.5 / 10, 12);
	expect(c.geometry[10].green).toBeCloseTo(1 - 1725 / 16384, 12);
	expect(c.geometry[10].blue).toBeCloseTo((1 - 1725 / 16384) * (1 + 640 / 2097152), 12);
	expect(c.vignetting).toHaveLength(16);
});

test('chromatic aberration on other knots than the distortion is not used', () => {
	const c = embeddedLensCorrection(arw([sony[2], [0x7035, [4, 100, 100, 200, 200]]]));
	expect(c.geometry.every((k) => k.red === k.green && k.blue === k.green)).toBe(true);
});

test('manual zeros are no correction', () => {
	expect(manualLensCorrection({ distortion: 0, vignetting: 0, red: 0, blue: 0 })).toEqual(
		noLensCorrection
	);
	for (const k of noLensCorrection.geometry) expect([k.red, k.green, k.blue]).toEqual([1, 1, 1]);
	for (const k of noLensCorrection.vignetting) expect(k.gain).toBe(1);
});

test('manual parameters act in their documented directions', () => {
	const at = <K extends { radius: number }>(knots: readonly K[], radius: number) =>
		knots.find((k) => Math.abs(k.radius - radius) < 1e-9)!;
	const zero = { distortion: 0, vignetting: 0, red: 0, blue: 0 };
	// Barrel: the lens pulls the corner in by 10 %, so the correction reads from 0.9 r.
	const barrel = manualLensCorrection({ ...zero, distortion: -10 });
	expect(at(barrel.geometry, 1).green).toBeCloseTo(0.9, 12);
	expect(at(barrel.geometry, 0).green).toBe(1);
	expect(at(manualLensCorrection({ ...zero, distortion: 10 }).geometry, 1).green).toBeCloseTo(
		1.1,
		12
	);
	// One stop at the corner, half way in a quarter stop.
	const vignette = manualLensCorrection({ ...zero, vignetting: 1 });
	expect(at(vignette.vignetting, 1).gain).toBeCloseTo(2, 12);
	expect(at(vignette.vignetting, 0.5).gain).toBeCloseTo(2 ** 0.25, 12);
	// Red magnified by 2 per mille, blue reduced by 1 per mille, green untouched.
	const ca = manualLensCorrection({ ...zero, red: 2, blue: -1 });
	expect(at(ca.geometry, 1).red).toBeCloseTo(1.002, 12);
	expect(at(ca.geometry, 1).blue).toBeCloseTo(0.999, 12);
	expect(at(ca.geometry, 1).green).toBe(1);
});
