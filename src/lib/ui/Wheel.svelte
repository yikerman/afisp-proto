<script lang="ts">
	import type { Wheel } from '../edit/controls';
	import type { Vec2 } from '../math/matrix';

	interface Props {
		spec: Wheel;
		value: Vec2;
		initial: Vec2;
		onchange: (value: Vec2) => void;
	}
	let { spec, value, initial, onchange }: Props = $props();

	const RADIUS = 56; // of the drawn wheel, in CSS pixels
	let pad: SVGSVGElement;

	// The point moves with the pointer instead of jumping to it, as on a grading wheel.
	function drag(event: PointerEvent) {
		if (!pad.hasPointerCapture(event.pointerId)) return;
		const perPixel = (spec.radius / RADIUS) * (event.shiftKey ? 0.1 : 1);
		const x = value[0] + event.movementX * perPixel;
		const y = value[1] - event.movementY * perPixel;
		const overshoot = Math.max(1, Math.hypot(x, y) / spec.radius);
		onchange([x / overshoot, y / overshoot]);
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
			onpointerdown={(event) => pad.setPointerCapture(event.pointerId)}
			onpointermove={drag}
			ondblclick={() => onchange(initial)}
		>
			<circle r={RADIUS - 5} class="face" />
			<path d="M{-RADIUS + 5} 0H{RADIUS - 5}M0 {-RADIUS + 5}V{RADIUS - 5}" class="cross" />
			<circle
				cx={(value[0] / spec.radius) * (RADIUS - 5)}
				cy={(-value[1] / spec.radius) * (RADIUS - 5)}
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
		grid-template-columns: 84px 1fr;
		gap: 6px;
		padding: 6px 0;
	}
	.pad {
		position: relative;
		width: 112px;
		height: 112px;
		grid-row: span 2;
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
		grid-column: 1;
		align-self: end;
		color: var(--dim);
	}
</style>
