import { beforeAll, expect, test } from 'vitest';
import { acquireGpu, type Gpu } from '../../gpu/gpu';
import { download, upload, type Image } from '../../gpu/image';
import { measure, type Reference } from '../reference';
import { adjust } from './adjust';
import { balance, saturation } from './colour';
import { everywhere } from './mask';
import { atIdentity, instance, type Instance } from './module';
import { toneCurve, toneEqualizer } from './toneEqualizer';

const size = { width: 32, height: 24 };
let gpu: Gpu;
let reference: Reference;

/** A scene with smooth gradients, an edge and about ten stops of range. */
function scenePixels(): Float16Array {
	const pixels = new Float16Array(size.width * size.height * 4);
	for (let y = 0; y < size.height; y++) {
		for (let x = 0; x < size.width; x++) {
			const level = 0.1845 * 2 ** ((x / size.width) * 10 - 5) * (y < size.height / 2 ? 1 : 3);
			pixels.set(
				[level * 1.2, level, level * (0.5 + y / size.height), 1],
				(y * size.width + x) * 4
			);
		}
	}
	return pixels;
}

beforeAll(async () => {
	gpu = await acquireGpu();
	reference = measure(gpu, upload(gpu, 'scene', size, 'rgba16float', scenePixels()));
});

const read = async (image: Image<'scene'>) => new Float16Array(await download(gpu, image));
const graded = (instances: readonly Instance[]) => read(adjust(gpu, reference, instances));

function expectClose(actual: Float16Array, expected: Float16Array, relative: number) {
	const worst = actual.reduce(
		(max, value, i) =>
			Math.max(max, Math.abs(value - expected[i]) / (Math.abs(expected[i]) + 1e-4)),
		0
	);
	expect(worst).toBeLessThan(relative);
}

test('every module changes nothing at its identity parameters', async () => {
	const scene = await read(reference.scene);
	const identities = [
		atIdentity(toneEqualizer, everywhere),
		atIdentity(saturation, everywhere),
		atIdentity(balance, everywhere)
	];
	for (const identity of identities) {
		// Half-float storage plus a round trip through the colour space.
		expectClose(await graded([identity]), scene, 2e-3);
	}
});

test('tone terms give the same result in any order', async () => {
	const a = instance(
		toneEqualizer,
		{ nodes: toneCurve({ shadows: 1.5, highlights: 0, contrast: 1 }) },
		everywhere
	);
	const b = instance(
		toneEqualizer,
		{ nodes: toneCurve({ shadows: 0, highlights: -1, contrast: 1.4 }) },
		everywhere
	);
	expect(await graded([a, b])).toEqual(await graded([b, a]));
});

test('contrast is a slope in stops about middle grey, applied to the smoothed image', async () => {
	const contrast = 1.5;
	const result = await graded([
		instance(
			toneEqualizer,
			{ nodes: toneCurve({ shadows: 0, highlights: 0, contrast }) },
			everywhere
		)
	]);
	const scene = await read(reference.scene);
	const smoothed = new Float32Array(await download(gpu, reference.smoothedStops));
	const expected = scene.map((value, i) =>
		i % 4 === 3 ? 1 : value * 2 ** ((contrast - 1) * smoothed[i >> 2])
	);
	expectClose(result, expected, 2e-3);
});

test('shadows leave middle grey and everything above it alone', async () => {
	const result = await graded([
		instance(
			toneEqualizer,
			{ nodes: toneCurve({ shadows: 2, highlights: 0, contrast: 1 }) },
			everywhere
		)
	]);
	const scene = await read(reference.scene);
	const smoothed = new Float32Array(await download(gpu, reference.smoothedStops));
	let lifted = 0;
	for (let i = 0; i < smoothed.length; i++) {
		const gain = result[i * 4 + 1] / scene[i * 4 + 1];
		if (smoothed[i] >= 0) expect(gain).toBeCloseTo(1, 2);
		else lifted += gain > 1.01 ? 1 : 0;
	}
	expect(lifted).toBeGreaterThan(0);
});

test('saturation zero gives neutral pixels of unchanged lightness', async () => {
	const result = await graded([instance(saturation, { amount: 0 }, everywhere)]);
	for (let i = 0; i < result.length; i += 4) {
		expect(result[i] / result[i + 1]).toBeCloseTo(1, 2);
		expect(result[i + 2] / result[i + 1]).toBeCloseTo(1, 2);
	}
});
