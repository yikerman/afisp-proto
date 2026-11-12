import type { RawFile } from '../raw/decode';
import { defaults, type EditState, type Stage } from './controls';
import { initialState } from './edit';

export type Screen = 'select' | Stage | 'export';

/** One entry per user action. `state` is the edit after it, so the log can be replayed. */
export type LogEvent = { readonly time: number; readonly state: EditState } & (
	| { readonly type: 'open'; readonly file: string }
	| { readonly type: 'screen'; readonly screen: Screen }
	| { readonly type: 'control'; readonly control: string; readonly value: unknown }
);

type Action = LogEvent extends infer E
	? E extends unknown
		? Omit<E, 'time' | 'state'>
		: never
	: never;

export interface OpenFile {
	readonly name: string;
	readonly raw: RawFile;
	/** The edit this file opened with, which controls reset to. */
	readonly initial: EditState;
}

/**
 * The application state. Every change goes through `open`, `go` or `set`,
 * which is what lets each one be logged.
 */
export class Session {
	screen = $state.raw<Screen>('select');
	file = $state.raw<OpenFile | null>(null);
	edit = $state.raw<EditState>(defaults);
	readonly log: LogEvent[] = [];

	#record(action: Action) {
		this.log.push({ ...action, time: performance.now(), state: this.edit } as LogEvent);
	}

	open(name: string, raw: RawFile) {
		const initial = initialState(raw.meta);
		this.file = { name, raw, initial };
		this.edit = initial;
		this.#record({ type: 'open', file: name });
	}

	go(screen: Screen) {
		this.screen = screen;
		this.#record({ type: 'screen', screen });
	}

	/** `control` is the panel item the user moved to `value`; `change` is what that did to the edit. */
	set(control: string, value: unknown, change: Partial<EditState>) {
		this.edit = { ...this.edit, ...change };
		this.#record({ type: 'control', control, value });
	}
}
