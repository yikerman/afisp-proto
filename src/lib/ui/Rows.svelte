<script lang="ts">
	import {
		added,
		colour,
		describe,
		atoms,
		presets,
		started,
		feather,
		hows,
		isShape,
		named,
		removed,
		renamed,
		settings,
		toneRange,
		usable,
		withStep,
		withTone,
		withWhat,
		withWhere,
		type Atom,
		type Preset,
		type Start
	} from '../edit/rows';
	import {
		UNCHANGED,
		type Element,
		type How,
		type Rows,
		type Tones,
		type What,
		type Where
	} from '../pipeline/adjustments/row';
	import Slider from './Slider.svelte';
	import Wheel from './Wheel.svelte';

	interface Props {
		rows: Rows;
		/** Id of the modification being edited. */
		selected: number;
		onselect: (id: number) => void;
		/** `action` names what the user did, for the log. */
		onchange: (action: string, value: unknown, rows: Rows) => void;
		/** Whether the selected modification's area is marked on the picture. */
		marking: boolean;
		onmark: (marking: boolean) => void;
		/** The element of the selected modification that a drag on the picture draws, if any. */
		drawing: number | null;
		ondrawing: (element: number | null) => void;
	}
	let { rows, selected, onselect, onchange, marking, onmark, drawing, ondrawing }: Props = $props();

	const row = $derived(rows.find((r) => r.id === selected) ?? rows[0]);
	const whole = $derived(row.id === rows[0].id);
	/** The element whose own settings are shown. */
	let open = $state(0);
	const step = $derived(row.where[Math.min(open, row.where.length - 1)]);

	interface Group {
		readonly label: string;
		readonly options: readonly (readonly [string, string])[];
	}
	// The menus keep the two apart: what a selection is made of, and ready-made selections.
	const starts: readonly Group[] = [
		{
			label: 'Elements',
			options: Object.entries(atoms).map(([kind, atom]) => [`atom:${kind}`, atom.name] as const)
		},
		{
			label: 'Presets',
			options: Object.entries(presets).map(
				([name, preset]) => [`preset:${name}`, preset.name] as const
			)
		}
	];

	const sliders = Object.entries(settings) as [
		keyof typeof settings,
		(typeof settings)['lightness']
	][];
	const edges = Object.entries(toneRange) as [keyof Tones, (typeof toneRange)['low']][];

	const what = (change: Partial<What>) =>
		onchange(
			`${row.name}: ${Object.keys(change)[0]}`,
			Object.values(change)[0],
			withWhat(rows, row.id, change)
		);
	const where = (action: string, value: unknown, change: (where: Where) => Where) =>
		onchange(`${row.name}: ${action}`, value, withWhere(rows, row.id, change));
	const element = (index: number, action: string, value: unknown, changed: Element) =>
		where(action, value, (current) => withStep(current, index, { element: changed }));

	function select(id: number) {
		open = 0;
		ondrawing(null);
		onselect(id);
	}

	/** A menu choice as a start: `nothing`, `atom:<kind>` or `preset:<name>`. */
	const startOf = (choice: string): Start =>
		choice.startsWith('atom:')
			? { from: 'atom', atom: choice.slice(5) as Atom }
			: choice.startsWith('preset:')
				? { from: 'preset', preset: choice.slice(7) as Preset }
				: { from: 'nothing' };

	const drawable = (steps: Where) => steps.findIndex((each) => isShape(each.element));

	function add(choice: string) {
		const next = added(rows, startOf(choice));
		const fresh = next.at(-1)!;
		onchange(`add modification`, fresh.name, next);
		select(fresh.id);
		// A shape is useless until it has been put somewhere.
		ondrawing(drawable(fresh.where) < 0 ? null : drawable(fresh.where));
	}

	function remove(id: number) {
		onchange(`remove ${rows.find((r) => r.id === id)!.name}`, id, removed(rows, id));
		select(rows[0].id);
	}

	/** `choice` is as for `startOf`, or `area:<row id>`. */
	function addElement(choice: string) {
		const steps: Where = choice.startsWith('area:')
			? [{ how: 'intersect', element: { kind: 'area', row: Number(choice.slice(5)) } }]
			: started(startOf(choice)).where;
		const first = row.where.length;
		open = first;
		where('add element', describe(steps, rows), (current) => [...current, ...steps]);
		ondrawing(drawable(steps) < 0 ? null : first + drawable(steps));
	}

	function removeElement(index: number) {
		where('remove element', named(row.where[index].element, rows), (current) =>
			current.filter((_, i) => i !== index)
		);
		open = 0;
		ondrawing(null);
	}
</script>

{#snippet adder(label: string, groups: readonly Group[], pick: (value: string) => void)}
	<select
		class="adder"
		aria-label={label}
		value=""
		onchange={(event) => {
			pick(event.currentTarget.value);
			event.currentTarget.value = '';
		}}
	>
		<option value="" disabled>{label}</option>
		{#each groups as group (group.label)}
			<optgroup label={group.label}>
				{#each group.options as [value, name] (value)}
					<option {value}>{name}</option>
				{/each}
			</optgroup>
		{/each}
	</select>
{/snippet}

<section class="list">
	<header>
		<h2>Modifications</h2>
		{@render adder(
			'Add',
			[{ label: 'Whole picture', options: [['nothing', 'Whole picture']] }, ...starts],
			add
		)}
	</header>
	<ul>
		{#each rows as each (each.id)}
			<li aria-current={each.id === row.id}>
				<button class="name" onclick={() => select(each.id)}>
					<span>{each.name}</span>
					<span class="summary">{describe(each.where, rows)}</span>
				</button>
				{#if each.id !== rows[0].id}
					<button class="remove" aria-label="Remove {each.name}" onclick={() => remove(each.id)}>
						×
					</button>
				{/if}
			</li>
		{/each}
	</ul>
</section>

<section class="editor">
	<header>
		{#if whole}
			<h2>{row.name}</h2>
		{:else}
			<input
				class="title"
				aria-label="Name"
				value={row.name}
				onchange={(event) =>
					onchange(
						`rename ${row.name}`,
						event.currentTarget.value,
						renamed(rows, row.id, event.currentTarget.value)
					)}
			/>
		{/if}
	</header>

	{#if !whole}
		<h3>
			Where
			<button class="toggle" aria-pressed={marking} onclick={() => onmark(!marking)}
				>Show area</button
			>
		</h3>
		<div class="body">
			<p class="start">The whole picture{row.where.length ? ', then:' : '.'}</p>
			<ol class="steps">
				{#each row.where as each, index (index)}
					<li aria-current={each === step}>
						<select
							aria-label="How element {index + 1} combines"
							value={each.how}
							onchange={(event) =>
								where(`element ${index + 1} how`, event.currentTarget.value, (current) =>
									withStep(current, index, { how: event.currentTarget.value as How })
								)}
						>
							{#each Object.entries(hows) as [how, name] (how)}
								<option value={how}>{name}</option>
							{/each}
						</select>
						<button class="name" onclick={() => (open = index)}>{named(each.element, rows)}</button>
						<button
							class="remove"
							aria-label="Remove element {index + 1}"
							onclick={() => removeElement(index)}
						>
							×
						</button>
					</li>
				{/each}
			</ol>
			{@render adder(
				'Add element',
				[
					...starts,
					{
						label: 'Other modifications',
						options: usable(rows, row.id).map((r) => [`area:${r.id}`, `Area of ${r.name}`] as const)
					}
				],
				addElement
			)}

			{#if step}
				{@const index = row.where.indexOf(step)}
				{@const chosen = step.element}
				<div class="element">
					{#if chosen.kind === 'tones'}
						{#each edges as [edge, spec] (edge)}
							<Slider
								{spec}
								value={chosen[edge]}
								initial={spec.default}
								onchange={(value) =>
									element(index, `tones ${edge}`, value, withTone(chosen, edge, value))}
							/>
						{/each}
					{:else if chosen.kind === 'area'}
						<p class="start">Follows {named(chosen, rows)}.</p>
					{:else}
						<button
							class="toggle"
							aria-pressed={drawing === index}
							onclick={() => ondrawing(drawing === index ? null : index)}
						>
							Draw on the picture
						</button>
						{#if chosen.kind === 'ellipse'}
							<Slider
								spec={feather}
								value={chosen.feather}
								initial={feather.default}
								onchange={(value) =>
									element(index, 'feather', value, { ...chosen, feather: value })}
							/>
						{/if}
					{/if}
				</div>
			{/if}
		</div>
	{/if}

	<h3>What</h3>
	<div class="body">
		{#each sliders as [setting, spec] (setting)}
			<Slider
				{spec}
				value={row.what[setting]}
				initial={UNCHANGED[setting]}
				onchange={(value) => what({ [setting]: value })}
			/>
		{/each}
		<Wheel
			spec={colour}
			value={row.what.colour}
			initial={UNCHANGED.colour}
			onchange={(value) => what({ colour: value })}
		/>
	</div>
</section>

<style>
	/* Two blocks: the list of modifications, and the one being edited. */
	section {
		margin: 8px;
		border: 1px solid var(--edge);
	}
	.list {
		background: var(--well);
	}
	.editor {
		background: var(--panel);
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		height: 26px;
		padding: 0 8px;
		background: var(--field);
		border-bottom: 1px solid var(--edge);
	}
	h2 {
		margin: 0;
		font-size: inherit;
		font-weight: 600;
		color: var(--bright);
	}
	.title {
		flex: 1;
		min-width: 0;
		height: 20px;
		padding: 0 4px;
		font-weight: 600;
		color: var(--bright);
		background: var(--well);
		border: 1px solid var(--edge);
		user-select: text;
	}
	h3 {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin: 0;
		padding: 6px 8px 2px;
		font-size: inherit;
		font-weight: 600;
		color: var(--dim);
		border-top: 1px solid var(--edge);
	}
	header + h3 {
		border-top: none;
	}
	ul,
	ol {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	li {
		display: flex;
		align-items: center;
		border-left: 2px solid transparent;
	}
	li[aria-current='true'] {
		border-left-color: var(--bright);
		background: var(--field);
	}
	.name {
		flex: 1;
		min-width: 0;
		display: flex;
		justify-content: space-between;
		gap: 8px;
		align-items: center;
		height: 24px;
		background: none;
		border: none;
		text-align: left;
	}
	li[aria-current='true'] .name {
		color: var(--bright);
	}
	.summary {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--dim);
	}
	.remove {
		width: 24px;
		height: 24px;
		padding: 0;
		background: none;
		border: none;
		color: var(--dim);
	}
	select {
		height: 20px;
		font: inherit;
		color: inherit;
		background: var(--well);
		border: 1px solid var(--edge);
		border-radius: 0;
	}
	.adder {
		width: 110px;
	}
	.body {
		padding: 4px 8px 8px;
	}
	.start {
		margin: 2px 0 4px;
		color: var(--dim);
	}
	.steps {
		margin-bottom: 6px;
	}
	.steps select {
		width: 84px;
		margin-left: 4px;
	}
	.element {
		margin-top: 8px;
		padding-top: 6px;
		border-top: 1px solid var(--edge);
	}
	.toggle {
		height: 20px;
	}
	.toggle[aria-pressed='true'] {
		color: var(--bright);
		border-color: var(--bright);
	}
</style>
