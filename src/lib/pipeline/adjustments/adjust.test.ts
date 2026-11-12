import { beforeAll, expect, test } from 'vitest';
import { MIDDLE_GREY } from '../../colour/spaces';
import { acquireGpu, type Gpu } from '../../gpu/gpu';
import { download, upload, type Image, type Size } from '../../gpu/image';
import { measure, type Reference } from '../reference';
import { adjust } from './adjust';
import {
	EVERYWHERE,
	HIGHLIGHTS,
	MIDTONES,
	SHADOWS,
	UNCHANGED,
	type Row,
	type Rows,
	type Tones,
	type What,
	type Where
} from './row';

const size = { width: 32, height: 24 };
let gpu: Gpu;
let reference: Reference;

/** A scene with smooth gradients, an edge and about ten stops of range. */
function scenePixels(): Float16Array {
	const pixels = new Float16Array(size.width * size.height * 4);
	for (let y = 0; y < size.height; y++) {
		for (let x = 0; x < size.width; x++) {
			const level = MIDDLE_GREY * 2 ** ((x / size.width) * 10 - 5) * (y < size.height / 2 ? 1 : 3);
			pixels.set(
				[level * 1.2, level, level * (0.5 + y / size.height), 1],
				(y * size.width + x) * 4
			);
		}
	}
	return pixels;
}

const sceneOf = (pixels: Float16Array, of: Size) =>
	measure(gpu, upload(gpu, of, 'RGBA16F', pixels));

beforeAll(async () => {
	gpu = await acquireGpu('accept');
	reference = sceneOf(scenePixels(), size);
});

let ids = 0;
const row = (where: Where, what: Partial<What>): Row => ({
	id: ids++,
	name: '',
	where,
	what: { ...UNCHANGED, ...what }
});
const whole = (what: Partial<What>) => row(EVERYWHERE, what);
const toned = (tones: Tones, what: Partial<What>) => row({ ...EVERYWHERE, tones }, what);

const read = async (image: Image<'scene'>) => new Float16Array(await download(gpu, image));
const graded = (rows: Rows, on = reference) => read(adjust(gpu, on, rows));
const stopsField = async (field: Image<'stops'>) => new Float32Array(await download(gpu, field));

function expectClose(actual: Float16Array, expected: ArrayLike<number>, relative: number) {
	const worst = actual.reduce(
		(max, value, i) =>
			Math.max(max, Math.abs(value - expected[i]) / (Math.abs(expected[i]) + 1e-4)),
		0
	);
	expect(worst).toBeLessThan(relative);
}

// Half-float storage plus a round trip through the colour space.
const ROUNDING = 2e-3;

test('a row left unchanged changes nothing', async () => {
	expectClose(await graded([whole({})]), await read(reference.scene), ROUNDING);
});

test('rows give the same result in any order, for tone and for colour', async () => {
	const a = toned(SHADOWS, { lightness: 1.2, colour: [0.03, -0.02] });
	const b = whole({ contrast: 1.4, saturation: 1.3, detail: 0.5 });
	const c = toned(HIGHLIGHTS, { lightness: -0.8, colour: [-0.02, 0.04], saturation: 0.7 });
	expect(await graded([a, b, c])).toEqual(await graded([c, a, b]));
});

test('lightness on the whole picture is the same gain everywhere', async () => {
	const scene = await read(reference.scene);
	expectClose(
		await graded([whole({ lightness: 1 })]),
		scene.map((value, i) => (i % 4 === 3 ? 1 : value * 2)),
		ROUNDING
	);
});

test('the three tone ranges together are the whole picture', async () => {
	const what = { lightness: 0.7, colour: [0.02, 0.01] as const, saturation: 1.2 };
	expectClose(
		await graded([toned(SHADOWS, what), toned(MIDTONES, what), toned(HIGHLIGHTS, what)]),
		await graded([whole(what)]),
		ROUNDING
	);
});

test('shadows leave middle grey and everything above it alone', async () => {
	const result = await graded([toned(SHADOWS, { lightness: 2 })]);
	const scene = await read(reference.scene);
	const smoothed = await stopsField(reference.smoothedStops);
	let lifted = 0;
	for (let i = 0; i < smoothed.length; i++) {
		const gain = result[i * 4 + 1] / scene[i * 4 + 1];
		if (smoothed[i] >= 0) expect(gain).toBeCloseTo(1, 2);
		else lifted += gain > 1.01 ? 1 : 0;
	}
	expect(lifted).toBeGreaterThan(0);
});

test('contrast spreads tones about the area’s average and leaves that average alone', async () => {
	const contrast = 1.5;
	const result = await graded([whole({ contrast })]);
	const scene = await read(reference.scene);
	const smoothed = await stopsField(reference.smoothedStops);
	const average = smoothed.reduce((sum, v) => sum + v, 0) / smoothed.length;
	const added = Array.from(smoothed, (_, i) => Math.log2(result[i * 4 + 1] / scene[i * 4 + 1]));
	added.forEach((stops, i) =>
		expect(stops).toBeCloseTo((contrast - 1) * (smoothed[i] - average), 1)
	);
	expect(added.reduce((sum, v) => sum + v, 0) / added.length).toBeCloseTo(0, 1);
});

test('saturation zero gives neutral pixels', async () => {
	const result = await graded([whole({ saturation: 0 })]);
	for (let i = 0; i < result.length; i += 4) {
		expect(result[i] / result[i + 1]).toBeCloseTo(1, 2);
		expect(result[i + 2] / result[i + 1]).toBeCloseTo(1, 2);
	}
});

test('a gradient applies fully at its start and not at all past its end', async () => {
	const where: Where = {
		...EVERYWHERE,
		place: { kind: 'gradient', from: [0.25, 0.5], to: [0.75, 0.5] }
	};
	const result = await graded([row(where, { lightness: 1 })]);
	const scene = await read(reference.scene);
	const gain = (x: number, y: number) => {
		const i = (y * size.width + x) * 4 + 1;
		return result[i] / scene[i];
	};
	expect(gain(2, 5)).toBeCloseTo(2, 2);
	expect(gain(29, 18)).toBeCloseTo(1, 2);
	expect(gain(16, 12)).toBeGreaterThan(1.2);
	expect(gain(16, 12)).toBeLessThan(1.8);
});

test('outside an ellipse is the rest of the picture', async () => {
	const place = {
		kind: 'ellipse',
		centre: [0.5, 0.5],
		radii: [0.2, 0.2],
		angle: 0,
		feather: 0.5
	} as const;
	const what = { lightness: 1 };
	const inside = row({ ...EVERYWHERE, place }, what);
	const outside = row({ ...EVERYWHERE, place, outside: true }, what);
	expectClose(await graded([inside, outside]), await graded([whole(what)]), ROUNDING);
});

test('detail scales fine variation and leaves flat areas alone', async () => {
	// Wide enough for the smoothing window to span several pixels.
	const wide = { width: 256, height: 16 };
	const pixels = new Float16Array(wide.width * wide.height * 4);
	for (let i = 0; i < wide.width * wide.height; i++) {
		const x = i % wide.width;
		// Left half flat, right half a fine ripple of a third of a stop.
		const level = MIDDLE_GREY * (x < wide.width / 2 ? 1 : 2 ** (Math.sin(x * 1.3) / 3));
		pixels.set([level, level, level, 1], i * 4);
	}
	const result = await graded([whole({ detail: 1 })], sceneOf(pixels, wide));
	const tones = (from: number, to: number, data: Float16Array) =>
		Array.from({ length: to - from }, (_, k) => Math.log2(data[(from + k) * 4] / MIDDLE_GREY));
	const spread = (values: number[]) => Math.max(...values) - Math.min(...values);

	expect(spread(tones(16, 96, result))).toBeLessThan(0.02);
	expect(spread(tones(160, 240, result))).toBeGreaterThan(1.5 * spread(tones(160, 240, pixels)));
});
