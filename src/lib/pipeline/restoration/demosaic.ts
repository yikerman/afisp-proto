/**
 * Ratio Corrected Demosaicing (RCD) for Bayer mosaics, with darktable's PPG border.
 *
 * Ported from darktable (GPL-3.0-or-later, compatible with this project's AGPL-3.0-or-later),
 * master at bdce4fed98499b90077946e323f08069b979ee79:
 * - data/kernels/demosaic_rcd.cl: the split into passes and their names,
 * - src/iop/demosaicing/rcd.c: the CPU version, which the tests port as their oracle,
 * - data/kernels/demosaic_ppg.cl and src/iop/demosaicing/ppg.c: the border interpolation.
 * The algorithm is L. Sanz Rodríguez, RCD 2.3, https://github.com/LuisSR/RCD-Demosaicing.
 *
 * darktable divides the mosaic by the processed maximum before RCD and multiplies back after
 * (process_rcd_cl, rcd_populate), so that 1 is clipping. A 'mosaic' image is already on that
 * scale, so both factors are 1 here. Inputs are non-negative, so `_safe_in` is the identity.
 *
 * Every pass is defined at every pixel. Each RCD step computes its quantity on the same region
 * as darktable and passes through (or zeroes) elsewhere, which keeps all reads in bounds and
 * reproduces darktable's boundary values where they reach the output.
 */
import type { Gpu } from '../../gpu/gpu';
import type { Format, Image } from '../../gpu/image';
import { run } from '../../gpu/pass';
import type { BayerPattern } from '../../raw/bayer';

/** Pixels this close to an edge take PPG instead of RCD (rcd.c RCD_MARGIN, rcd_write_output). */
const RCD_MARGIN = 9;

function prelude(pattern: BayerPattern): string {
	return /* wgsl */ `
const RED = 0u;
const GREEN = 1u;
const BLUE = 2u;
const pattern = array<u32, 4>(${pattern.map((c) => `${c}u`).join(', ')});
const eps = 1e-5;
const epssq = 1e-10;

fn fc(p: vec2i) -> u32 {
	return pattern[(p.y & 1) * 2 + (p.x & 1)];
}

fn inside(p: vec2i, size: vec2i, margin: i32) -> bool {
	return all(p >= vec2i(margin)) && all(p < size - margin);
}

fn at(t: texture_2d<f32>, p: vec2i) -> f32 {
	return textureLoad(t, p, 0).r;
}

// Squared colour difference high pass along d (rcd_vdiff_local, rcd_hdiff_local, step 4.0).
fn rcd_diff(t: texture_2d<f32>, p: vec2i, d: vec2i) -> f32 {
	let v = at(t, p - 3 * d) - at(t, p - d) - at(t, p + d) + at(t, p + 3 * d)
		- 3.0 * (at(t, p - 2 * d) + at(t, p + 2 * d)) + 6.0 * at(t, p);
	return v * v;
}

// Refined local discrimination: the diagonal neighbourhood wins when it is further from 0.5.
fn refined(dir: texture_2d<f32>, p: vec2i) -> f32 {
	let central = at(dir, p);
	let neighbourhood = 0.25 * (at(dir, p + vec2i(-1, -1)) + at(dir, p + vec2i(1, -1))
		+ at(dir, p + vec2i(-1, 1)) + at(dir, p + vec2i(1, 1)));
	return select(central, neighbourhood, abs(0.5 - central) < abs(0.5 - neighbourhood));
}
`;
}

// PPG border, pass 1: demosaic_ppg.cl border_interpolate (outer 3 pixels) and
// ppg_demosaic_green (elsewhere). Unmeasured red and blue are left 0 for pass 2.
const ppgDemosaicGreen = /* wgsl */ `
fn border_interpolate(p: vec2i, size: vec2i) -> vec4f {
	var sum = vec3f(0);
	var count = vec3f(0);
	for (var y = p.y - 1; y <= p.y + 1; y++) {
		for (var x = p.x - 1; x <= p.x + 1; x++) {
			let q = vec2i(x, y);
			if (all(q >= vec2i(0)) && all(q < size)) {
				sum[fc(q)] += at(cfa, q);
				count[fc(q)] += 1.0;
			}
		}
	}
	let i = at(cfa, p);
	var o = select(vec3f(i), sum / count, count > vec3f(0));
	o[fc(p)] = i;
	return vec4f(o, 0);
}

fn ppg_demosaic_green(p: vec2i) -> vec4f {
	let c = fc(p);
	let pc = at(cfa, p);
	var color = vec4f(0);
	color[c] = pc;
	if (c != GREEN) {
		let pym = at(cfa, p + vec2i(0, -1));
		let pym2 = at(cfa, p + vec2i(0, -2));
		let pym3 = at(cfa, p + vec2i(0, -3));
		let pyM = at(cfa, p + vec2i(0, 1));
		let pyM2 = at(cfa, p + vec2i(0, 2));
		let pyM3 = at(cfa, p + vec2i(0, 3));
		let pxm = at(cfa, p + vec2i(-1, 0));
		let pxm2 = at(cfa, p + vec2i(-2, 0));
		let pxm3 = at(cfa, p + vec2i(-3, 0));
		let pxM = at(cfa, p + vec2i(1, 0));
		let pxM2 = at(cfa, p + vec2i(2, 0));
		let pxM3 = at(cfa, p + vec2i(3, 0));
		let guessx = (pxm + pc + pxM) * 2.0 - pxM2 - pxm2;
		let diffx = (abs(pxm2 - pc) + abs(pxM2 - pc) + abs(pxm - pxM)) * 3.0
			+ (abs(pxM3 - pxM) + abs(pxm3 - pxm)) * 2.0;
		let guessy = (pym + pc + pyM) * 2.0 - pyM2 - pym2;
		let diffy = (abs(pym2 - pc) + abs(pyM2 - pc) + abs(pym - pyM)) * 3.0
			+ (abs(pyM3 - pyM) + abs(pym3 - pym)) * 2.0;
		if (diffx > diffy) {
			color.g = clamp(guessy * 0.25, min(pym, pyM), max(pym, pyM));
		} else {
			color.g = clamp(guessx * 0.25, min(pxm, pxM), max(pxm, pxM));
		}
	}
	return color;
}

fn pixel(p: vec2i) -> vec4f {
	let size = vec2i(textureDimensions(cfa));
	if (!inside(p, size, 3)) {
		return border_interpolate(p, size);
	}
	return ppg_demosaic_green(p);
}
`;

// PPG border, pass 2: ppg_demosaic_redblue. The outermost ring keeps the box average.
const ppgDemosaicRedblue = /* wgsl */ `
fn pixel(p: vec2i) -> vec4f {
	var color = textureLoad(ppg, p, 0);
	if (!inside(p, vec2i(textureDimensions(ppg)), 1)) {
		return color;
	}
	let c = fc(p);
	if (c == GREEN) {
		// ppg.c tests whether red is in the same row; naming both neighbours' colours is the same.
		let h = fc(p + vec2i(1, 0));
		let v = fc(p + vec2i(0, 1));
		let nt = textureLoad(ppg, p + vec2i(0, -1), 0);
		let nb = textureLoad(ppg, p + vec2i(0, 1), 0);
		let nl = textureLoad(ppg, p + vec2i(-1, 0), 0);
		let nr = textureLoad(ppg, p + vec2i(1, 0), 0);
		color[v] = (nt[v] + nb[v] + 2.0 * color.g - nt.g - nb.g) * 0.5;
		color[h] = (nl[h] + nr[h] + 2.0 * color.g - nl.g - nr.g) * 0.5;
	} else {
		let o = 2u - c;
		let ntl = textureLoad(ppg, p + vec2i(-1, -1), 0);
		let ntr = textureLoad(ppg, p + vec2i(1, -1), 0);
		let nbl = textureLoad(ppg, p + vec2i(-1, 1), 0);
		let nbr = textureLoad(ppg, p + vec2i(1, 1), 0);
		let diff1 = abs(ntl[o] - nbr[o]) + abs(ntl.g - color.g) + abs(nbr.g - color.g);
		let guess1 = ntl[o] + nbr[o] + 2.0 * color.g - ntl.g - nbr.g;
		let diff2 = abs(ntr[o] - nbl[o]) + abs(ntr.g - color.g) + abs(nbl.g - color.g);
		let guess2 = ntr[o] + nbl[o] + 2.0 * color.g - ntr.g - nbl.g;
		if (diff1 > diff2) {
			color[o] = guess2 * 0.5;
		} else if (diff1 < diff2) {
			color[o] = guess1 * 0.5;
		} else {
			color[o] = (guess1 + guess2) * 0.25;
		}
	}
	return max(color, vec4f(0));
}
`;

// Step 1.1 + 1.2: vertical and horizontal directional discrimination, fused as in
// demosaic_rcd.cl rcd_step_1. VH_Dir is 0 within 4 pixels of the edge as in both references,
// and step 3 reads that ring.
const rcdStep1 = /* wgsl */ `
fn pixel(p: vec2i) -> vec4f {
	if (!inside(p, vec2i(textureDimensions(cfa)), 4)) {
		return vec4f(0);
	}
	let V = vec2i(0, 1);
	let H = vec2i(1, 0);
	let V_Stat = max(epssq, rcd_diff(cfa, p - V, V) + rcd_diff(cfa, p, V) + rcd_diff(cfa, p + V, V));
	let H_Stat = max(epssq, rcd_diff(cfa, p - H, H) + rcd_diff(cfa, p, H) + rcd_diff(cfa, p + H, H));
	return vec4f(V_Stat / (V_Stat + H_Stat), 0, 0, 0);
}
`;

// Step 2: low pass filter of the raw data, at red and blue sites.
const rcdStep2 = /* wgsl */ `
fn pixel(p: vec2i) -> vec4f {
	if (fc(p) == GREEN || !inside(p, vec2i(textureDimensions(cfa)), 2)) {
		return vec4f(0);
	}
	let lpf = at(cfa, p)
		+ 0.5 * (at(cfa, p + vec2i(0, -1)) + at(cfa, p + vec2i(0, 1))
			+ at(cfa, p + vec2i(-1, 0)) + at(cfa, p + vec2i(1, 0)))
		+ 0.25 * (at(cfa, p + vec2i(-1, -1)) + at(cfa, p + vec2i(1, -1))
			+ at(cfa, p + vec2i(-1, 1)) + at(cfa, p + vec2i(1, 1)));
	return vec4f(lpf, 0, 0, 0);
}
`;

// Step 3: green at red and blue sites. The result is the rgb state of rcd.c after step 3:
// measured samples in their channel, green interpolated, unknown red and blue 0. Outside the
// region green is the raw sample, as rcd.c's step 0 fills rgb[1] with cfa on every row.
const rcdStep3 = /* wgsl */ `
fn pixel(p: vec2i) -> vec4f {
	let c = fc(p);
	let cfai = at(cfa, p);
	var rgb = vec4f(0, cfai, 0, 0);
	rgb[c] = cfai;
	if (c == GREEN || !inside(p, vec2i(textureDimensions(cfa)), 4)) {
		return rgb;
	}
	let VH_Disc = refined(VH_Dir, p);

	let n = at(cfa, p + vec2i(0, -1));
	let n2 = at(cfa, p + vec2i(0, -2));
	let s = at(cfa, p + vec2i(0, 1));
	let s2 = at(cfa, p + vec2i(0, 2));
	let w = at(cfa, p + vec2i(-1, 0));
	let w2 = at(cfa, p + vec2i(-2, 0));
	let e = at(cfa, p + vec2i(1, 0));
	let e2 = at(cfa, p + vec2i(2, 0));

	// Cardinal gradients
	let N_Grad = eps + abs(n - s) + abs(cfai - n2) + abs(n - at(cfa, p + vec2i(0, -3)))
		+ abs(n2 - at(cfa, p + vec2i(0, -4)));
	let S_Grad = eps + abs(s - n) + abs(cfai - s2) + abs(s - at(cfa, p + vec2i(0, 3)))
		+ abs(s2 - at(cfa, p + vec2i(0, 4)));
	let W_Grad = eps + abs(w - e) + abs(cfai - w2) + abs(w - at(cfa, p + vec2i(-3, 0)))
		+ abs(w2 - at(cfa, p + vec2i(-4, 0)));
	let E_Grad = eps + abs(e - w) + abs(cfai - e2) + abs(e - at(cfa, p + vec2i(3, 0)))
		+ abs(e2 - at(cfa, p + vec2i(4, 0)));

	// Cardinal pixel estimations; lpf exists at the same colour two pixels away.
	let lpfi = at(lpf, p);
	let N_Est = n * (lpfi + lpfi) / (eps + lpfi + at(lpf, p + vec2i(0, -2)));
	let S_Est = s * (lpfi + lpfi) / (eps + lpfi + at(lpf, p + vec2i(0, 2)));
	let W_Est = w * (lpfi + lpfi) / (eps + lpfi + at(lpf, p + vec2i(-2, 0)));
	let E_Est = e * (lpfi + lpfi) / (eps + lpfi + at(lpf, p + vec2i(2, 0)));

	// Vertical and horizontal estimations
	let V_Est = (S_Grad * N_Est + N_Grad * S_Est) / (N_Grad + S_Grad);
	let H_Est = (W_Grad * E_Est + E_Grad * W_Est) / (E_Grad + W_Grad);

	rgb.g = mix(V_Est, H_Est, clamp(VH_Disc, 0.0, 1.0));
	return rgb;
}
`;

// Step 4.0 + 4.1: diagonal directional discrimination, fused like rcd_step_1. Deliberate
// deviation: darktable (and RawTherapee) store the step 4.0 high pass in half-width buffers
// filled at odd columns only, so on every row step 4.1 reads some samples at green sites one
// column off the diagonal. This takes them at the diagonal red/blue sites, as RCD 2.3's
// closed-form P_Stat and Q_Stat (rcd_demosaicing.c, step 4.1) do.
const rcdStep4_1 = /* wgsl */ `
fn pixel(p: vec2i) -> vec4f {
	if (fc(p) == GREEN || !inside(p, vec2i(textureDimensions(cfa)), 4)) {
		return vec4f(0);
	}
	let P = vec2i(1, 1);
	let Q = vec2i(1, -1);
	let P_Stat = max(epssq, rcd_diff(cfa, p - P, P) + rcd_diff(cfa, p, P) + rcd_diff(cfa, p + P, P));
	let Q_Stat = max(epssq, rcd_diff(cfa, p - Q, Q) + rcd_diff(cfa, p, Q) + rcd_diff(cfa, p + Q, Q));
	return vec4f(P_Stat / (P_Stat + Q_Stat), 0, 0, 0);
}
`;

// Step 4.2: red at blue sites and blue at red sites.
const rcdStep4_2 = /* wgsl */ `
fn pixel(p: vec2i) -> vec4f {
	var result = textureLoad(rgb, p, 0);
	let c = fc(p);
	if (c == GREEN || !inside(p, vec2i(textureDimensions(rgb)), 4)) {
		return result;
	}
	let color = 2u - c;
	let PQ_Disc = refined(PQ_Dir, p);

	let nw = textureLoad(rgb, p + vec2i(-1, -1), 0);
	let ne = textureLoad(rgb, p + vec2i(1, -1), 0);
	let sw = textureLoad(rgb, p + vec2i(-1, 1), 0);
	let se = textureLoad(rgb, p + vec2i(1, 1), 0);
	let g = result.g;

	// Diagonal gradients
	let NW_Grad = eps + abs(nw[color] - se[color])
		+ abs(nw[color] - textureLoad(rgb, p + vec2i(-3, -3), 0)[color])
		+ abs(g - textureLoad(rgb, p + vec2i(-2, -2), 0).g);
	let NE_Grad = eps + abs(ne[color] - sw[color])
		+ abs(ne[color] - textureLoad(rgb, p + vec2i(3, -3), 0)[color])
		+ abs(g - textureLoad(rgb, p + vec2i(2, -2), 0).g);
	let SW_Grad = eps + abs(ne[color] - sw[color])
		+ abs(sw[color] - textureLoad(rgb, p + vec2i(-3, 3), 0)[color])
		+ abs(g - textureLoad(rgb, p + vec2i(-2, 2), 0).g);
	let SE_Grad = eps + abs(nw[color] - se[color])
		+ abs(se[color] - textureLoad(rgb, p + vec2i(3, 3), 0)[color])
		+ abs(g - textureLoad(rgb, p + vec2i(2, 2), 0).g);

	// Diagonal colour differences
	let NW_Est = nw[color] - nw.g;
	let NE_Est = ne[color] - ne.g;
	let SW_Est = sw[color] - sw.g;
	let SE_Est = se[color] - se.g;

	// P/Q estimations
	let P_Est = (NW_Grad * SE_Est + SE_Grad * NW_Est) / (NW_Grad + SE_Grad);
	let Q_Est = (NE_Grad * SW_Est + SW_Grad * NE_Est) / (NE_Grad + SW_Grad);

	result[color] = g + mix(P_Est, Q_Est, clamp(PQ_Disc, 0.0, 1.0));
	return result;
}
`;

// Step 4.3: red and blue at green sites.
const rcdStep4_3 = /* wgsl */ `
fn pixel(p: vec2i) -> vec4f {
	var result = textureLoad(rgb, p, 0);
	if (fc(p) != GREEN || !inside(p, vec2i(textureDimensions(rgb)), 4)) {
		return result;
	}
	let VH_Disc = refined(VH_Dir, p);

	let n = textureLoad(rgb, p + vec2i(0, -1), 0);
	let s = textureLoad(rgb, p + vec2i(0, 1), 0);
	let w = textureLoad(rgb, p + vec2i(-1, 0), 0);
	let e = textureLoad(rgb, p + vec2i(1, 0), 0);
	let n3 = textureLoad(rgb, p + vec2i(0, -3), 0);
	let s3 = textureLoad(rgb, p + vec2i(0, 3), 0);
	let w3 = textureLoad(rgb, p + vec2i(-3, 0), 0);
	let e3 = textureLoad(rgb, p + vec2i(3, 0), 0);

	let rgb1 = result.g;
	let N1 = eps + abs(rgb1 - textureLoad(rgb, p + vec2i(0, -2), 0).g);
	let S1 = eps + abs(rgb1 - textureLoad(rgb, p + vec2i(0, 2), 0).g);
	let W1 = eps + abs(rgb1 - textureLoad(rgb, p + vec2i(-2, 0), 0).g);
	let E1 = eps + abs(rgb1 - textureLoad(rgb, p + vec2i(2, 0), 0).g);

	for (var c = RED; c <= BLUE; c += 2u) {
		let SNabs = abs(n[c] - s[c]);
		let EWabs = abs(w[c] - e[c]);

		// Cardinal gradients
		let N_Grad = N1 + SNabs + abs(n[c] - n3[c]);
		let S_Grad = S1 + SNabs + abs(s[c] - s3[c]);
		let W_Grad = W1 + EWabs + abs(w[c] - w3[c]);
		let E_Grad = E1 + EWabs + abs(e[c] - e3[c]);

		// Cardinal colour differences
		let N_Est = n[c] - n.g;
		let S_Est = s[c] - s.g;
		let W_Est = w[c] - w.g;
		let E_Est = e[c] - e.g;

		// Vertical and horizontal estimations
		let V_Est = (N_Grad * S_Est + S_Grad * N_Est) / (N_Grad + S_Grad);
		let H_Est = (E_Grad * W_Est + W_Grad * E_Est) / (E_Grad + W_Grad);

		result[c] = rgb1 + mix(V_Est, H_Est, clamp(VH_Disc, 0.0, 1.0));
	}
	return result;
}
`;

// rcd_write_output over the PPG result, as process_rcd_cl writes RCD into PPG's output.
const rcdWriteOutput = /* wgsl */ `
fn pixel(p: vec2i) -> vec4f {
	if (inside(p, vec2i(textureDimensions(rgb)), ${RCD_MARGIN})) {
		return vec4f(max(textureLoad(rgb, p, 0).rgb, vec3f(0)), 1);
	}
	return vec4f(textureLoad(ppg, p, 0).rgb, 1);
}
`;

export function demosaic(
	gpu: Gpu,
	mosaic: Image<'mosaic'>,
	pattern: BayerPattern
): Image<'camera'> {
	const size = { width: mosaic.width, height: mosaic.height };
	const common = prelude(pattern);
	const pass = (
		label: string,
		wgsl: string,
		textures: Record<string, GPUTexture>,
		format: Format
	) => ({ label, wgsl: common + wgsl, textures, uniforms: {}, size, format }) as const;
	// Intermediates have no pipeline encoding.
	const step = (...args: Parameters<typeof pass>): GPUTexture => run<never>(gpu, pass(...args));

	const cfa = mosaic;
	const green = step('ppg_demosaic_green', ppgDemosaicGreen, { cfa }, 'rgba32float');
	const ppg = step('ppg_demosaic_redblue', ppgDemosaicRedblue, { ppg: green }, 'rgba32float');
	const VH_Dir = step('rcd_step_1', rcdStep1, { cfa }, 'r32float');
	const lpf = step('rcd_step_2', rcdStep2, { cfa }, 'r32float');
	const rgb3 = step('rcd_step_3', rcdStep3, { cfa, lpf, VH_Dir }, 'rgba32float');
	const PQ_Dir = step('rcd_step_4_1', rcdStep4_1, { cfa }, 'r32float');
	const rgb42 = step('rcd_step_4_2', rcdStep4_2, { rgb: rgb3, PQ_Dir }, 'rgba32float');
	const rgb43 = step('rcd_step_4_3', rcdStep4_3, { rgb: rgb42, VH_Dir }, 'rgba32float');
	const out = run<'camera'>(
		gpu,
		pass('rcd_write_output', rcdWriteOutput, { rgb: rgb43, ppg }, 'rgba16float')
	);

	for (const texture of [green, ppg, VH_Dir, lpf, rgb3, PQ_Dir, rgb42, rgb43]) texture.destroy();
	return out;
}
