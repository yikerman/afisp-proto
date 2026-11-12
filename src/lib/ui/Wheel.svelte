<script lang="ts">
	import type { Wheel } from '../edit/controls';
	import type { Vec2 } from '../math/matrix';
	import { travel } from './travel';

	interface Props {
		spec: Wheel;
		value: Vec2;
		initial: Vec2;
		onchange: (value: Vec2) => void;
	}
	let { spec, value, initial, onchange }: Props = $props();

	const RADIUS = 56; // of the drawn wheel, in CSS pixels
	const FACE = RADIUS - 5;
	let pad: SVGSVGElement;
	const pointer = travel();

	// The point moves with the pointer instead of jumping to it, as on a grading wheel.
	// The position during a drag is kept here: several pointer events can arrive
	// before `value` reflects the first, and each must build on the one before.
	let dragged: Vec2 = [0, 0];

	function press(event: PointerEvent) {
		pad.setPointerCapture(event.pointerId);
		pointer.start(event);
		dragged = value;
	}

	function drag(event: PointerEvent) {
		if (!pad.hasPointerCapture(event.pointerId)) return;
		const perPixel = (spec.radius / FACE) * (event.shiftKey ? 0.1 : 1);
		const [dx, dy] = pointer.step(event);
		const x = dragged[0] + dx * perPixel;
		const y = dragged[1] - dy * perPixel;
		const overshoot = Math.max(1, Math.hypot(x, y) / spec.radius);
		dragged = [x / overshoot, y / overshoot];
		onchange(dragged);
	}
</script>

<div class="wheel">
	<span class="label">{spec.label}</span>
	<div class="pad">
		<!-- Hue increases anticlockwise from the right, as the angle of (a, b) does. -->
		<div class="rim"></div>
		<svg
			bind:this={pad}
			viewBox="{-RADIUS} {-RADIUS} {RADIUS * 2} {RADIUS * 2}"
			role="application"
			aria-label={spec.label}
			onpointerdown={press}
			onpointermove={drag}
			ondblclick={() => onchange(initial)}
		>
			<circle r={FACE} class="face" />
			<path d="M{-FACE} 0H{FACE}M0 {-FACE}V{FACE}" class="cross" />
			<circle
				cx={(value[0] / spec.radius) * FACE}
				cy={(-value[1] / spec.radius) * FACE}
				r="3.5"
				class="point"
			/>
		</svg>
	</div>
	<span class="readout">{value[0].toFixed(3)}&ensp;{value[1].toFixed(3)}</span>
</div>

<style>
	.wheel {
		display: grid;
		justify-items: center;
		gap: 3px;
		padding: 4px 0;
	}
	.label {
		justify-self: start;
	}
	.pad {
		position: relative;
		width: 112px;
		height: 112px;
	}
	.rim {
		position: absolute;
		inset: 0;
		border-radius: 50%;
		transform: scaleY(-1);
		background: conic-gradient(
			from 90deg in oklch longer hue,
			oklch(0.62 0.09 0deg),
			oklch(0.62 0.09 360deg)
		);
	}
	svg {
		position: absolute;
		inset: 0;
		cursor: crosshair;
		touch-action: none;
	}
	.face {
		fill: var(--field);
	}
	.cross {
		stroke: var(--track);
		stroke-width: 1;
	}
	.point {
		fill: none;
		stroke: var(--bright);
		stroke-width: 1.5;
	}
	.readout {
		color: var(--dim);
	}
</style>
