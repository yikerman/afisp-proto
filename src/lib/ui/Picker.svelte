<script lang="ts">
	import type { Picker } from '../edit/controls';

	interface Props {
		spec: Picker;
		/** Whether the next click on the picture goes to this picker. */
		armed: boolean;
		onarm: (armed: boolean) => void;
	}
	let { spec, armed, onarm }: Props = $props();
</script>

<button class="picker" aria-pressed={armed} onclick={() => onarm(!armed)}>{spec.label}</button>

<style>
	.picker {
		justify-self: start;
		margin: 2px 0 2px 90px;
	}
	.picker[aria-pressed='true'] {
		color: var(--bright);
		border-color: var(--bright);
	}
</style>
