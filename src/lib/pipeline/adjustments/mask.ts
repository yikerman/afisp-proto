/**
 * Where an adjustment applies, as a weight in [0, 1] per pixel. A mask is a
 * function of the reference and the pixel position only.
 *
 * Only the whole image exists so far. Shapes, tonal ranges and their
 * combinations are further variants of this union and cases of `maskWgsl`.
 */
export type Mask = { readonly kind: 'everywhere' };

export const everywhere: Mask = { kind: 'everywhere' };

/** A WGSL expression of type f32, in a scope with `reference: Reference` and `p: vec2i`. */
export function maskWgsl(mask: Mask): string {
	switch (mask.kind) {
		case 'everywhere':
			return '1.0';
	}
}
