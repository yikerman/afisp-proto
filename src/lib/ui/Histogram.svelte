<script lang="ts">
	import { BINS, type Histogram } from '../view/histogram';

	let { histogram }: { histogram: Histogram | null } = $props();

	const [WIDTH, HEIGHT] = [BINS * 2, 180];
	const CHANNELS = ['#b04a4a', '#4a9a4a', '#4a6ab8'];
	let canvas: HTMLCanvasElement;

	$effect(() => {
		const context = canvas.getContext('2d')!;
		context.globalCompositeOperation = 'source-over';
		context.clearRect(0, 0, WIDTH, HEIGHT);
		if (!histogram) return;
		// The end bins hold clipped pixels and would flatten everything else.
		const peak = Math.max(...histogram.flatMap((channel) => [...channel.subarray(1, BINS - 1)]));
		context.globalCompositeOperation = 'lighter';
		histogram.forEach((channel, c) => {
			context.fillStyle = CHANNELS[c];
			channel.forEach((count, bin) => {
				const height = Math.min(1, count / peak) * HEIGHT;
				context.fillRect((bin * WIDTH) / BINS, HEIGHT - height, WIDTH / BINS, height);
			});
		});
	});
</script>

<canvas bind:this={canvas} width={WIDTH} height={HEIGHT} aria-label="Histogram"></canvas>

<style>
	canvas {
		display: block;
		width: 100%;
		height: 90px;
		background: var(--well);
		border: 1px solid var(--edge);
		box-sizing: border-box;
	}
</style>
