<script lang="ts">
	import type { Choice } from '../edit/controls';

	interface Props {
		spec: Choice;
		value: string;
		onchange: (value: string) => void;
	}
	let { spec, value, onchange }: Props = $props();
</script>

<label class="choice">
	<span>{spec.label}</span>
	<select {value} onchange={(event) => onchange(event.currentTarget.value)}>
		{#each spec.options as option (option.value)}
			<option value={option.value}>{option.label}</option>
		{/each}
	</select>
</label>

<style>
	.choice {
		display: grid;
		grid-template-columns: 84px 1fr;
		align-items: center;
		gap: 6px;
		height: var(--row);
	}
	select {
		height: 18px;
		padding: 0 2px;
		font: inherit;
		color: inherit;
		background: var(--field);
		border: 1px solid var(--edge);
		border-radius: 0;
	}
</style>
