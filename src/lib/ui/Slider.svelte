<script lang="ts">
	import { admit, type Slider } from '../edit/controls';

	interface Props {
		spec: Slider;
		value: number;
		/** Value restored by a double click. */
		initial: number;
		onchange: (value: number) => void;
	}
	let { spec, value, initial, onchange }: Props = $props();

	const decimals = $derived(Math.max(0, -Math.floor(Math.log10(spec.step))));
	const clamp = (v: number, low: number, high: number) => Math.min(Math.max(v, low), high);

	// Position along the track in [0, 1].
	const toTrack = (v: number) =>
		spec.scale === 'logarithmic'
			? Math.log(v / spec.min) / Math.log(spec.max / spec.min)
			: (v - spec.min) / (spec.max - spec.min);
	const fromTrack = (t: number) =>
		spec.scale === 'logarithmic'
			? spec.min * (spec.max / spec.min) ** t
			: spec.min + t * (spec.max - spec.min);
	const admitted = (v: number) => admit(spec, v);

	let track: HTMLDivElement;
	// Unrounded position while dragging, so fine movement accumulates.
	let dragged = 0;

	function press(event: PointerEvent) {
		track.setPointerCapture(event.pointerId);
		const box = track.getBoundingClientRect();
		dragged = event.shiftKey ? toTrack(value) : clamp((event.clientX - box.left) / box.width, 0, 1);
		onchange(admitted(fromTrack(dragged)));
	}

	function drag(event: PointerEvent) {
		if (!track.hasPointerCapture(event.pointerId)) return;
		const fine = event.shiftKey ? 0.1 : 1;
		dragged = clamp(dragged + (event.movementX / track.clientWidth) * fine, 0, 1);
		onchange(admitted(fromTrack(dragged)));
	}

	function key(event: KeyboardEvent) {
		const direction = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[event.key];
		if (!direction) return;
		event.preventDefault();
		onchange(admitted(value + direction * spec.step * (event.shiftKey ? 10 : 1)));
	}

	function typed(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const entered = Number(input.value);
		if (Number.isFinite(entered)) onchange(admitted(entered));
		input.value = value.toFixed(decimals);
	}
</script>

<div class="slider">
	<span class="label">{spec.label}</span>
	<div
		class="track"
		bind:this={track}
		role="slider"
		tabindex="0"
		aria-label={spec.label}
		aria-valuemin={spec.min}
		aria-valuemax={spec.max}
		aria-valuenow={value}
		onpointerdown={press}
		onpointermove={drag}
		ondblclick={() => onchange(initial)}
		onkeydown={key}
	>
		<div class="fill" style:width="{toTrack(value) * 100}%"></div>
	</div>
	<input
		class="value"
		value={value.toFixed(decimals)}
		onchange={typed}
		aria-label="{spec.label} value"
	/>
	<span class="unit">{spec.unit}</span>
</div>

<style>
	.slider {
		display: grid;
		grid-template-columns: 84px 1fr 52px 18px;
		align-items: center;
		gap: 6px;
		height: var(--row);
	}
	.label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.track {
		position: relative;
		height: 12px;
		background: var(--track);
		border: 1px solid var(--edge);
		cursor: ew-resize;
		touch-action: none;
	}
	.fill {
		height: 100%;
		background: var(--fill);
		border-right: 1px solid var(--bright);
		box-sizing: border-box;
	}
	.value {
		width: 100%;
		box-sizing: border-box;
		height: 18px;
		padding: 0 4px;
		text-align: right;
		background: var(--field);
		border: 1px solid var(--edge);
		user-select: text;
	}
	.unit {
		color: var(--dim);
	}
</style>
