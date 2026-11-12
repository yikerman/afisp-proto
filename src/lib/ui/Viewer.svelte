<script lang="ts">
	import type { Gpu } from '../gpu/gpu';
	import type { Size } from '../gpu/image';
	import { runInto } from '../gpu/pass';
	import type { Edit, Renderer } from '../pipeline/render';
	import { histogram, type Histogram } from '../view/histogram';
	import { resample } from '../view/resample';

	interface Props {
		gpu: Gpu;
		renderer: Renderer;
		edit: Edit;
		/** Size of the image the renderer produces. */
		image: Size;
		onhistogram: (histogram: Histogram) => void;
	}
	let { gpu, renderer, edit, image, onhistogram }: Props = $props();

	const format = navigator.gpu.getPreferredCanvasFormat() as 'rgba8unorm' | 'bgra8unorm';
	let frame: HTMLDivElement;
	let canvas: HTMLCanvasElement;
	/** Space for the image in CSS pixels; unknown until the frame has been laid out. */
	let available = $state.raw<Size | null>(null);

	// The largest size of the image's shape that fits, in device pixels, never enlarged.
	const fitted = $derived.by((): Size | null => {
		if (!available) return null;
		const scale = Math.min(
			(available.width * devicePixelRatio) / image.width,
			(available.height * devicePixelRatio) / image.height,
			1
		);
		return { width: Math.round(image.width * scale), height: Math.round(image.height * scale) };
	});

	$effect(() => {
		const observer = new ResizeObserver(([entry]) => {
			available = { width: entry.contentRect.width, height: entry.contentRect.height };
		});
		observer.observe(frame);
		return () => observer.disconnect();
	});

	$effect(() => {
		canvas.getContext('webgpu')!.configure({ device: gpu.device, format, alphaMode: 'opaque' });
	});

	$effect(() => {
		const [size, current] = [fitted, edit];
		if (!size) return;
		const request = requestAnimationFrame(() => {
			canvas.width = size.width;
			canvas.height = size.height;
			const display = renderer.render(current);
			const target = canvas.getContext('webgpu')!.getCurrentTexture();
			runInto(gpu, resample(display, size, format), target);
			void histogram(gpu, display).then(onhistogram);
		});
		return () => cancelAnimationFrame(request);
	});
</script>

<div class="frame" bind:this={frame}>
	<canvas
		bind:this={canvas}
		style:width="{(fitted?.width ?? 0) / devicePixelRatio}px"
		style:height="{(fitted?.height ?? 0) / devicePixelRatio}px"
	></canvas>
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
		margin: auto;
	}
</style>
