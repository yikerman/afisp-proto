<script lang="ts">
	import type { Gpu } from '../gpu/gpu';
	import type { Size } from '../gpu/image';
	import { present } from '../gpu/pass';
	import type { Vec2 } from '../math/matrix';
	import type { Edit, Renderer } from '../pipeline/render';
	import { histogram, type Histogram } from '../view/histogram';
	import { fit, imagePoint, resample, type View } from '../view/resample';
	import { travel } from './travel';

	interface Props {
		gpu: Gpu;
		renderer: Renderer;
		edit: Edit;
		/** Size of the image the renderer produces. */
		image: Size;
		onhistogram: (histogram: Histogram) => void;
		/** When set, a click on the picture reports the image point instead of moving the view. */
		onpick: ((at: Vec2) => void) | null;
		/** When set, a drag on the picture reports its start and current image points. */
		ondraw: ((from: Vec2, to: Vec2) => void) | null;
		/** Id of the row whose area is marked on the picture, if any. */
		marked: number | null;
	}
	let { gpu, renderer, edit, image, onhistogram, onpick, ondraw, marked }: Props = $props();

	const MAX_SCALE = 8;
	let frame: HTMLDivElement;
	let canvas: HTMLCanvasElement;
	const pan = travel();

	/** The canvas in device pixels; unknown until the frame has been laid out. */
	let size = $state.raw<Size | null>(null);
	/** Scale and centre chosen by the user; null shows the whole picture. */
	let zoom = $state.raw<Pick<View, 'scale' | 'centre'> | null>(null);

	const view = $derived(size && (zoom ? { size, ...zoom } : fit(image, size)));
	const clamp = (v: number, low: number, high: number) => Math.min(Math.max(v, low), high);
	const within = ([x, y]: Vec2): Vec2 => [clamp(x, 0, image.width), clamp(y, 0, image.height)];
	const pointer = (event: MouseEvent): Vec2 => [
		event.offsetX * devicePixelRatio,
		event.offsetY * devicePixelRatio
	];

	/** Changes the scale, keeping the image point under `at` where it is. */
	function zoomTo(current: View, scale: number, at: Vec2) {
		const smallest = fit(image, current.size).scale;
		if (scale <= smallest) {
			zoom = null;
			return;
		}
		const [x, y] = imagePoint(current, at);
		const fromCentre: Vec2 = [at[0] - current.size.width / 2, at[1] - current.size.height / 2];
		zoom = { scale, centre: within([x - fromCentre[0] / scale, y - fromCentre[1] / scale]) };
	}

	function wheel(event: WheelEvent) {
		if (!view) return;
		event.preventDefault();
		zoomTo(view, Math.min(view.scale * 2 ** (-event.deltaY / 300), MAX_SCALE), pointer(event));
	}

	/** Where the drag that draws a place began, in image pixels. */
	let drawnFrom: Vec2 | null = null;

	function press(event: PointerEvent) {
		if (!view) return;
		if (onpick) {
			onpick(imagePoint(view, pointer(event)));
			return;
		}
		canvas.setPointerCapture(event.pointerId);
		pan.start(event);
		drawnFrom = ondraw && imagePoint(view, pointer(event));
	}

	function drag(event: PointerEvent) {
		if (!view || !canvas.hasPointerCapture(event.pointerId)) return;
		if (ondraw && drawnFrom) {
			ondraw(drawnFrom, imagePoint(view, pointer(event)));
			return;
		}
		if (!zoom) return;
		const perPixel = devicePixelRatio / zoom.scale;
		const [dx, dy] = pan.step(event);
		zoom = {
			scale: zoom.scale,
			centre: within([zoom.centre[0] - dx * perPixel, zoom.centre[1] - dy * perPixel])
		};
	}

	/** Between the whole picture and one image pixel per screen pixel. */
	function toggle(event: MouseEvent) {
		if (view) zoomTo(view, zoom ? 0 : 1, pointer(event));
	}

	$effect(() => {
		const observer = new ResizeObserver(([entry]) => {
			size = {
				width: Math.round(entry.contentRect.width * devicePixelRatio),
				height: Math.round(entry.contentRect.height * devicePixelRatio)
			};
		});
		observer.observe(frame);
		// A wheel listener must be registered as non-passive to keep the page from scrolling.
		canvas.addEventListener('wheel', wheel, { passive: false });
		return () => {
			observer.disconnect();
			canvas.removeEventListener('wheel', wheel);
		};
	});

	$effect(() => {
		const [shown, current, area] = [view, edit, marked];
		if (!shown) return;
		const request = requestAnimationFrame(() => {
			canvas.width = shown.size.width;
			canvas.height = shown.size.height;
			const display = renderer.render(current);
			canvas
				.getContext('bitmaprenderer')!
				.transferFromImageBitmap(
					present(gpu, resample(area === null ? display : renderer.markArea(current, area), shown))
				);
			void histogram(gpu, display).then(onhistogram);
		});
		return () => cancelAnimationFrame(request);
	});
</script>

<div class="frame" bind:this={frame}>
	<canvas
		bind:this={canvas}
		class:picking={onpick || ondraw}
		class:movable={zoom}
		onpointerdown={press}
		onpointermove={drag}
		ondblclick={toggle}
	></canvas>
	<span class="scale">{zoom ? `${Math.round(zoom.scale * 100)}%` : 'Fit'}</span>
</div>

<style>
	/* The canvas is sized from the frame, so it must not take part in sizing the frame. */
	.frame {
		position: relative;
		border: 12px solid var(--surround);
		background: var(--surround);
	}
	canvas {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		touch-action: none;
	}
	.movable {
		cursor: grab;
	}
	.picking {
		cursor: crosshair;
	}
	.scale {
		position: absolute;
		left: 0;
		bottom: 0;
		padding: 1px 5px;
		background: var(--panel);
		color: var(--text);
	}
</style>
