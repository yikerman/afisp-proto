import type { Vec2 } from '../math/matrix';

/**
 * Pointer travel between the events of one drag, in CSS pixels.
 *
 * `movementX` and `movementY` lose distance when the browser merges pointer
 * events, which it does whenever a frame takes long. Differences of position
 * always add up to where the pointer actually went.
 */
export function travel() {
	let last: Vec2 = [0, 0];
	return {
		start(event: PointerEvent) {
			last = [event.clientX, event.clientY];
		},
		step(event: PointerEvent): Vec2 {
			const moved: Vec2 = [event.clientX - last[0], event.clientY - last[1]];
			last = [event.clientX, event.clientY];
			return moved;
		}
	};
}
