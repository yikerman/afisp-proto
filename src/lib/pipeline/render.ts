import type { Gpu } from '../gpu/gpu';
import { download, upload, type Image } from '../gpu/image';
import type { Vec2, Vec3 } from '../math/matrix';
import type { RawFile } from '../raw/decode';
import { adjust } from './adjustments/adjust';
import type { Instance } from './adjustments/module';
import { displayTransform } from './display/transform';
import { destroyReference, measure } from './reference';
import { calibrate, type Calibration } from './restoration/calibrate';
import { demosaic } from './restoration/demosaic';
import { linearise } from './restoration/linearise';

/** Everything the picture depends on besides the RAW file. */
export interface Edit {
	readonly calibration: Calibration;
	readonly adjustments: readonly Instance[];
}

/**
 * `display = transform(adjust(restore(raw, calibration), adjustments))`.
 *
 * The result is a pure function of the file and the edit. A renderer only
 * remembers the parts that did not change between calls: the demosaiced image
 * for the file's lifetime and the reference for the last calibration.
 */
export interface Renderer {
	/** The returned image is valid until the next call. */
	render(edit: Edit): Image<'display'>;
	/** Mean scene colour of the restored image over a square of `radius` pixels around `at`. */
	sample(calibration: Calibration, at: Vec2, radius: number): Promise<Vec3>;
	destroy(): void;
}

/** Remembers the value for the most recent key and frees the one it replaces. */
function latest<K, V>(make: (key: K) => V, free: (value: V) => void) {
	let held: { readonly id: string; readonly value: V } | undefined;
	const release = () => held && free(held.value);
	return {
		get(key: K): V {
			const id = JSON.stringify(key);
			if (held?.id !== id) {
				release();
				held = { id, value: make(key) };
			}
			return held.value;
		},
		release
	};
}

export function createRenderer(gpu: Gpu, raw: RawFile): Renderer {
	const sensor = upload<'sensor'>(gpu, 'sensor', raw.sensorSize, 'r16uint', raw.sensor);
	const mosaic = linearise(gpu, sensor, raw.meta);
	const camera = demosaic(gpu, mosaic, raw.meta.pattern);
	sensor.destroy();
	mosaic.destroy();

	const reference = latest(
		(calibration: Calibration) => measure(gpu, calibrate(gpu, camera, raw.meta, calibration)),
		destroyReference
	);
	let display: Image<'display'> | undefined;

	return {
		render(edit) {
			const graded = adjust(gpu, reference.get(edit.calibration), edit.adjustments);
			display?.destroy();
			display = displayTransform(gpu, graded);
			graded.destroy();
			return display;
		},
		async sample(calibration, [x, y], radius) {
			const { scene } = reference.get(calibration);
			const left = Math.max(0, Math.round(x) - radius);
			const top = Math.max(0, Math.round(y) - radius);
			const region = {
				x: left,
				y: top,
				width: Math.min(scene.width, Math.round(x) + radius + 1) - left,
				height: Math.min(scene.height, Math.round(y) + radius + 1) - top
			};
			const pixels = new Float16Array(await download(gpu, scene, region));
			const sum = [0, 0, 0];
			for (let i = 0; i < pixels.length; i += 4) {
				sum[0] += pixels[i];
				sum[1] += pixels[i + 1];
				sum[2] += pixels[i + 2];
			}
			const count = pixels.length / 4;
			return [sum[0] / count, sum[1] / count, sum[2] / count];
		},
		destroy() {
			camera.destroy();
			reference.release();
			display?.destroy();
		}
	};
}
