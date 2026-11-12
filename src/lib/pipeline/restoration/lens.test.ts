import { expect, test } from 'vitest';
import { acquireGpu, type Gpu } from '../../gpu/gpu';
import { download, upload, type Size } from '../../gpu/image';
import {
	embeddedLensCorrection,
	manualLensCorrection,
	noLensCorrection,
	type LensCorrection
} from '../../raw/lensData';
import { autoscale, correctLens } from './lens';

type Pixel = (x: number, y: number) => readonly [number, number, number];

async function corrected(gpu: Gpu, size: Size, image: Pixel, correction: LensCorrection) {
	const pixels = new Float16Array(size.width * size.height * 4);
	for (let y = 0; y < size.height; y++) {
		for (let x = 0; x < size.width; x++) {
			pixels.set([...image(x, y), 1], 4 * (y * size.width + x));
		}
	}
	const camera = upload<'camera'>(gpu, 'camera', size, 'rgba16float', pixels);
	const result = correctLens(gpu, camera, correction);
	const out = new Float16Array(await download(gpu, result));
	const input = new Float16Array(await download(gpu, camera));
	camera.destroy();
	result.destroy();
	return {
		input,
		out,
		at: (x: number, y: number) => {
			const i = 4 * (y * size.width + x);
			return [out[i], out[i + 1], out[i + 2]] as const;
		}
	};
}

/** Where each channel of output pixel (x, y) was read from, without vignetting, in pixel coordinates (centres at i + 0.5). */
async function sources(gpu: Gpu, size: Size, { geometry }: LensCorrection) {
	// Interpolation reproduces a linear ramp exactly away from the border.
	const correction = { geometry, vignetting: noLensCorrection.vignetting };
	const grey = (v: number) => [v, v, v] as const;
	const across = await corrected(gpu, size, (x) => grey((x + 0.5) / size.width), correction);
	const down = await corrected(gpu, size, (_, y) => grey((y + 0.5) / size.height), correction);
	return (x: number, y: number, c: number) =>
		[across.at(x, y)[c] * size.width, down.at(x, y)[c] * size.height] as const;
}

const size: Size = { width: 96, height: 64 };
const centre = [size.width / 2, size.height / 2] as const;
const halfDiagonal = Math.hypot(size.width, size.height) / 2;
// Half-float steps of a ramp ending at 1 are 2^-11 of the frame, under 0.05 px here.
const pixelTolerance = 0.06;
// Probe pixels whose sources stay clear of the border, where the ramp is mirrored.
const probes = [
	[48, 32],
	[60, 40],
	[80, 50],
	[20, 10],
	[88, 8],
	[6, 56]
] as const;

test('no correction leaves the image unchanged', async () => {
	const gpu = await acquireGpu('accept');
	const { input, out } = await corrected(
		gpu,
		{ width: 37, height: 23 },
		(x, y) => [Math.sin(x * 1.7 + y) ** 2, ((x * 7 + y * 3) % 11) / 10, (x * y) / 851],
		noLensCorrection
	);
	expect(Array.from(out)).toEqual(Array.from(input));
});

test('distortion moves each pixel along its radius as predicted', async () => {
	const gpu = await acquireGpu('accept');
	const k = -0.1; // barrel, 10 % at the corner
	const correction = manualLensCorrection({ distortion: 100 * k, vignetting: 0, red: 0, blue: 0 });
	const s = autoscale(correction.geometry, size);
	expect(s).toBeLessThan(1); // barrel correction stretches the edges, so the frame is magnified
	const source = await sources(gpu, size, correction);
	for (const [x, y] of probes) {
		const offset = [(x + 0.5 - centre[0]) / s, (y + 0.5 - centre[1]) / s];
		const g = 1 + k * (Math.hypot(...offset) / halfDiagonal) ** 2;
		for (let c = 0; c < 3; c++) {
			const [sx, sy] = source(x, y, c);
			expect(Math.abs(sx - (centre[0] + offset[0] * g))).toBeLessThan(pixelTolerance);
			expect(Math.abs(sy - (centre[1] + offset[1] * g))).toBeLessThan(pixelTolerance);
		}
	}
});

test('chromatic aberration moves red and blue differently from green', async () => {
	const gpu = await acquireGpu('accept');
	const correction: LensCorrection = {
		geometry: [{ radius: 0, red: 1.02, green: 1, blue: 0.98 }],
		vignetting: noLensCorrection.vignetting
	};
	const s = autoscale(correction.geometry, size);
	expect(s).toBeCloseTo(1.02, 6); // red, read furthest out, sets the magnification
	const source = await sources(gpu, size, correction);
	const scales = [1.02, 1, 0.98];
	for (const [x, y] of probes) {
		for (let c = 0; c < 3; c++) {
			const [sx, sy] = source(x, y, c);
			const f = scales[c] / s;
			expect(Math.abs(sx - (centre[0] + (x + 0.5 - centre[0]) * f))).toBeLessThan(pixelTolerance);
			expect(Math.abs(sy - (centre[1] + (y + 0.5 - centre[1]) * f))).toBeLessThan(pixelTolerance);
		}
	}
	// At the right edge, red is read from the edge and blue from 4 % further in.
	const [red] = source(95, 32, 0);
	const [blue] = source(95, 32, 2);
	expect(red - blue).toBeCloseTo(47.5 * (0.04 / 1.02), 1);
});

test('vignetting multiplies by the predicted gain at the centre and the corner', async () => {
	const gpu = await acquireGpu('accept');
	const correction = manualLensCorrection({ distortion: 0, vignetting: 1, red: 0, blue: 0 });
	const { at } = await corrected(gpu, size, () => [0.25, 0.25, 0.25], correction);
	for (const [x, y] of [
		[48, 32],
		[0, 0],
		[95, 63]
	]) {
		const r = Math.hypot(x + 0.5 - centre[0], y + 0.5 - centre[1]) / halfDiagonal;
		for (const v of at(x, y)) expect(v / 0.25).toBeCloseTo(2 ** (r * r), 2);
	}
	expect(at(0, 0)[1] / 0.25).toBeGreaterThan(1.9);
});

/*
 * Oracle: darktable's embedded-metadata method, version 2, for Sony data, transcribed from
 * src/iop/lens.cc at darktable master bdce4fed98499b90077946e323f08069b979ee79
 * (GPL-3.0-or-later): _init_coeffs_md_v2 (Sony branch 2509-2539, autoscale 2783-2819), _interpolate_linear_spline
 * (2319) and _process_md (3093-3178), at fine-tune 1 and image scale 1. Pixel x is taken at
 * its centre x + 0.5, where darktable uses x, so both measure from the frame's geometric centre.
 */
function darktable(raw: { distortion: number[]; ca: number[]; vignetting: number[] }, sz: Size) {
	const spline = (xi: number[], yi: number[], x: number) => {
		if (x < xi[0]) return yi[0];
		for (let i = 1; i < xi.length; i++) {
			if (x >= xi[i - 1] && x <= xi[i]) {
				return yi[i - 1] + (x - xi[i - 1]) * ((yi[i] - yi[i - 1]) / (xi[i] - xi[i - 1]));
			}
		}
		return yi[yi.length - 1];
	};
	const nc = raw.distortion[0];
	const knots = Array.from({ length: nc }, (_, i) => (i + 0.5) / (nc - 1));
	const dist = knots.map((_, i) => raw.distortion[i + 1] * 2 ** -14 + 1);
	const cor = [
		dist.map((d, i) => d * (raw.ca[i + 1] * 2 ** -21 + 1)),
		dist,
		dist.map((d, i) => d * (raw.ca[nc + i + 1] * 2 ** -21 + 1))
	];
	const vig = knots.map((_, i) => 2 ** (0.5 - 2 ** (raw.vignetting[i + 1] * 2 ** -13 - 1)));

	const [w2, h2] = [0.5 * sz.width, 0.5 * sz.height];
	const r = 1 / Math.hypot(w2, h2);
	const srr = Math.min(w2, h2) * r;
	let dtScale = 0;
	for (let i = 0; i < 200; i++) {
		for (let j = 0; j < 3; j++) {
			dtScale = Math.max(dtScale, spline(knots, cor[j], srr + ((1 - srr) * i) / 199));
		}
	}
	return {
		dtScale,
		/** Source position of channel c for output pixel (x, y), with darktable's spline scaled by `scale`. */
		source(x: number, y: number, c: number, scale: number) {
			const [cx, cy] = [x + 0.5 - w2, y + 0.5 - h2];
			const dr = spline(
				knots.map((k) => k * scale),
				cor[c].map((v) => v / scale),
				r * Math.hypot(cx, cy)
			);
			return [dr * cx + w2, dr * cy + h2] as const;
		},
		/** Factor applied to the input pixel (x, y). */
		gain: (x: number, y: number) =>
			1 / Math.max(1e-4, spline(knots, vig, r * Math.hypot(x + 0.5 - w2, y + 0.5 - h2)))
	};
}

/** The SubIFD layout of an ARW, with the three Sony tags (see lensData.test.ts). */
function arw(raw: { distortion: number[]; ca: number[]; vignetting: number[] }): ArrayBuffer {
	const tags = [
		[0x7032, raw.vignetting],
		[0x7035, raw.ca],
		[0x7037, raw.distortion]
	] as const;
	const subIfd = 26;
	let at = subIfd + 2 + 12 * tags.length + 4;
	const view = new DataView(new ArrayBuffer(at + 2 * tags.reduce((n, [, v]) => n + v.length, 0)));
	[0x4949, 42].forEach((v, i) => view.setUint16(2 * i, v, true));
	view.setUint32(4, 8, true);
	[1, 0x014a, 4].forEach((v, i) => view.setUint16(8 + 2 * i, v, true));
	view.setUint32(14, 1, true);
	view.setUint32(18, subIfd, true);
	view.setUint16(subIfd, tags.length, true);
	tags.forEach(([tag, values], i) => {
		const entry = subIfd + 2 + 12 * i;
		[tag, 8].forEach((v, j) => view.setUint16(entry + 2 * j, v, true));
		view.setUint32(entry + 4, values.length, true);
		view.setUint32(entry + 8, at, true);
		values.forEach((v, j) => view.setInt16(at + 2 * j, v, true));
		at += 2 * values.length;
	});
	return view.buffer;
}

// ILCE-7RM3, Tamron 28-200 at 28 mm (20260412_0001.ARW) and 49 mm (20260412_0005.ARW).
const files = {
	'28 mm': {
		distortion: [16, 6, 0, -10, -22, -37, -54, -75, -97, -120, -142, -163, -181, -196, -206, -211, -208],
		ca: [32, 1280, 1280, 1152, 1152, 1152, 1152, 1024, 1024, 1024, 1024, 1024, 1024, 1024, 896, 896, 896, 0, 0, 0, 0, 0, 128, 128, 128, 256, 256, 384, 512, 640, 768, 768, 768],
		vignetting: [16, 0, 32, 128, 288, 512, 832, 1184, 1568, 2048, 2624, 3360, 4320, 5408, 6560, 7680, 8800]
	},
	'49 mm': {
		distortion: [16, -5, 0, 9, 25, 45, 70, 102, 142, 190, 244, 307, 379, 460, 552, 652, 767],
		ca: [32, -128, -128, 0, 128, 128, 128, 128, 128, 128, 128, 256, 256, 256, 384, 384, 512, 768, 768, 768, 640, 640, 640, 640, 768, 768, 640, 640, 640, 640, 512, 384, 256],
		vignetting: [16, 0, 16, 80, 208, 384, 592, 848, 1136, 1472, 1824, 2208, 2624, 3072, 3568, 4128, 4704]
	}
}; // prettier-ignore

test('real Sony corrections agree with darktable', async () => {
	const gpu = await acquireGpu('accept');
	// The ILCE-7RM3's 3:2 frame, small enough for a software GPU.
	const frame: Size = { width: 240, height: 160 };
	for (const raw of Object.values(files)) {
		const correction = embeddedLensCorrection(arw(raw));
		const oracle = darktable(raw, frame);
		const s = autoscale(correction.geometry, frame);
		// darktable approximates the magnification (see autoscale); the exact one is close to
		// it and, through darktable's own mapping, reads every edge pixel from inside the frame.
		expect(Math.abs(s / oracle.dtScale - 1)).toBeLessThan(1e-2);
		for (let i = 0; i <= 240; i++) {
			const edge = [
				[Math.min(i, 239), 0],
				[Math.min(i, 239), 159],
				[0, Math.min(i, 159)],
				[239, Math.min(i, 159)]
			];
			for (const [x, y] of edge) {
				for (let c = 0; c < 3; c++) {
					const [ex, ey] = oracle.source(x, y, c, s);
					expect(ex).toBeGreaterThanOrEqual(0);
					expect(ex).toBeLessThanOrEqual(240);
					expect(ey).toBeGreaterThanOrEqual(0);
					expect(ey).toBeLessThanOrEqual(160);
				}
			}
		}

		const source = await sources(gpu, frame, correction);
		for (const [x, y] of [
			[120, 80],
			[150, 100],
			[200, 130],
			[230, 150],
			[10, 8],
			[230, 10],
			[60, 140]
		]) {
			for (let c = 0; c < 3; c++) {
				const [ex, ey] = oracle.source(x, y, c, s);
				const [sx, sy] = source(x, y, c);
				expect(Math.abs(sx - ex)).toBeLessThan(0.15);
				expect(Math.abs(sy - ey)).toBeLessThan(0.15);
			}
		}

		const flat = await corrected(gpu, frame, () => [0.25, 0.25, 0.25], {
			geometry: noLensCorrection.geometry,
			vignetting: correction.vignetting
		});
		for (const [x, y] of [
			[120, 80],
			[180, 120],
			[0, 0],
			[239, 159]
		]) {
			for (const v of flat.at(x, y)) expect(v / 0.25).toBeCloseTo(oracle.gain(x, y), 2);
		}
	}
});
