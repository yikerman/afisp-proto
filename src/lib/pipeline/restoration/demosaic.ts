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
import type { Format, Image, Texture } from '../../gpu/image';
import { run } from '../../gpu/pass';
import type { BayerPattern } from '../../raw/bayer';

/** Pixels this close to an edge take PPG instead of RCD (rcd.c RCD_MARGIN, rcd_write_output). */
const RCD_MARGIN = 9;

function prelude(pattern: BayerPattern): string {
	return /* glsl */ `
const int RED = 0;
const int GREEN = 1;
const int BLUE = 2;
const int pattern[4] = int[4](${pattern.join(', ')});
const float eps = 1e-5;
const float epssq = 1e-10;

int fc(ivec2 p) {
	return pattern[(p.y & 1) * 2 + (p.x & 1)];
}

bool inside(ivec2 p, ivec2 size, int margin) {
	return all(greaterThanEqual(p, ivec2(margin))) && all(lessThan(p, size - margin));
}

float at(sampler2D t, ivec2 p) {
	return texelFetch(t, p, 0).r;
}

// Squared colour difference high pass along d (rcd_vdiff_local, rcd_hdiff_local, step 4.0).
float rcd_diff(sampler2D t, ivec2 p, ivec2 d) {
	float v = at(t, p - 3 * d) - at(t, p - d) - at(t, p + d) + at(t, p + 3 * d)
		- 3.0 * (at(t, p - 2 * d) + at(t, p + 2 * d)) + 6.0 * at(t, p);
	return v * v;
}

// Refined local discrimination: the diagonal neighbourhood wins when it is further from 0.5.
float refined(sampler2D dir, ivec2 p) {
	float central = at(dir, p);
	float neighbourhood = 0.25 * (at(dir, p + ivec2(-1, -1)) + at(dir, p + ivec2(1, -1))
		+ at(dir, p + ivec2(-1, 1)) + at(dir, p + ivec2(1, 1)));
	return abs(0.5 - central) < abs(0.5 - neighbourhood) ? neighbourhood : central;
}
`;
}

// PPG border, pass 1: demosaic_ppg.cl border_interpolate (outer 3 pixels) and
// ppg_demosaic_green (elsewhere). Unmeasured red and blue are left 0 for pass 2.
const ppgDemosaicGreen = /* glsl */ `
vec4 border_interpolate(ivec2 p, ivec2 size) {
	vec3 sum = vec3(0);
	vec3 count = vec3(0);
	for (int y = p.y - 1; y <= p.y + 1; y++) {
		for (int x = p.x - 1; x <= p.x + 1; x++) {
			ivec2 q = ivec2(x, y);
			if (all(greaterThanEqual(q, ivec2(0))) && all(lessThan(q, size))) {
				sum[fc(q)] += at(cfa, q);
				count[fc(q)] += 1.0;
			}
		}
	}
	float i = at(cfa, p);
	vec3 o = mix(vec3(i), sum / count, greaterThan(count, vec3(0)));
	o[fc(p)] = i;
	return vec4(o, 0);
}

vec4 ppg_demosaic_green(ivec2 p) {
	int c = fc(p);
	float pc = at(cfa, p);
	vec4 color = vec4(0);
	color[c] = pc;
	if (c != GREEN) {
		float pym = at(cfa, p + ivec2(0, -1));
		float pym2 = at(cfa, p + ivec2(0, -2));
		float pym3 = at(cfa, p + ivec2(0, -3));
		float pyM = at(cfa, p + ivec2(0, 1));
		float pyM2 = at(cfa, p + ivec2(0, 2));
		float pyM3 = at(cfa, p + ivec2(0, 3));
		float pxm = at(cfa, p + ivec2(-1, 0));
		float pxm2 = at(cfa, p + ivec2(-2, 0));
		float pxm3 = at(cfa, p + ivec2(-3, 0));
		float pxM = at(cfa, p + ivec2(1, 0));
		float pxM2 = at(cfa, p + ivec2(2, 0));
		float pxM3 = at(cfa, p + ivec2(3, 0));
		float guessx = (pxm + pc + pxM) * 2.0 - pxM2 - pxm2;
		float diffx = (abs(pxm2 - pc) + abs(pxM2 - pc) + abs(pxm - pxM)) * 3.0
			+ (abs(pxM3 - pxM) + abs(pxm3 - pxm)) * 2.0;
		float guessy = (pym + pc + pyM) * 2.0 - pyM2 - pym2;
		float diffy = (abs(pym2 - pc) + abs(pyM2 - pc) + abs(pym - pyM)) * 3.0
			+ (abs(pyM3 - pyM) + abs(pym3 - pym)) * 2.0;
		if (diffx > diffy) {
			color.g = clamp(guessy * 0.25, min(pym, pyM), max(pym, pyM));
		} else {
			color.g = clamp(guessx * 0.25, min(pxm, pxM), max(pxm, pxM));
		}
	}
	return color;
}

vec4 pixel(ivec2 p) {
	ivec2 size = textureSize(cfa, 0);
	if (!inside(p, size, 3)) {
		return border_interpolate(p, size);
	}
	return ppg_demosaic_green(p);
}
`;

// PPG border, pass 2: ppg_demosaic_redblue. The outermost ring keeps the box average.
const ppgDemosaicRedblue = /* glsl */ `
vec4 pixel(ivec2 p) {
	vec4 color = texelFetch(ppg, p, 0);
	if (!inside(p, textureSize(ppg, 0), 1)) {
		return color;
	}
	int c = fc(p);
	if (c == GREEN) {
		// ppg.c tests whether red is in the same row; naming both neighbours' colours is the same.
		int h = fc(p + ivec2(1, 0));
		int v = fc(p + ivec2(0, 1));
		vec4 nt = texelFetch(ppg, p + ivec2(0, -1), 0);
		vec4 nb = texelFetch(ppg, p + ivec2(0, 1), 0);
		vec4 nl = texelFetch(ppg, p + ivec2(-1, 0), 0);
		vec4 nr = texelFetch(ppg, p + ivec2(1, 0), 0);
		color[v] = (nt[v] + nb[v] + 2.0 * color.g - nt.g - nb.g) * 0.5;
		color[h] = (nl[h] + nr[h] + 2.0 * color.g - nl.g - nr.g) * 0.5;
	} else {
		int o = 2 - c;
		vec4 ntl = texelFetch(ppg, p + ivec2(-1, -1), 0);
		vec4 ntr = texelFetch(ppg, p + ivec2(1, -1), 0);
		vec4 nbl = texelFetch(ppg, p + ivec2(-1, 1), 0);
		vec4 nbr = texelFetch(ppg, p + ivec2(1, 1), 0);
		float diff1 = abs(ntl[o] - nbr[o]) + abs(ntl.g - color.g) + abs(nbr.g - color.g);
		float guess1 = ntl[o] + nbr[o] + 2.0 * color.g - ntl.g - nbr.g;
		float diff2 = abs(ntr[o] - nbl[o]) + abs(ntr.g - color.g) + abs(nbl.g - color.g);
		float guess2 = ntr[o] + nbl[o] + 2.0 * color.g - ntr.g - nbl.g;
		if (diff1 > diff2) {
			color[o] = guess2 * 0.5;
		} else if (diff1 < diff2) {
			color[o] = guess1 * 0.5;
		} else {
			color[o] = (guess1 + guess2) * 0.25;
		}
	}
	return max(color, vec4(0));
}
`;

// Step 1.1 + 1.2: vertical and horizontal directional discrimination, fused as in
// demosaic_rcd.cl rcd_step_1. VH_Dir is 0 within 4 pixels of the edge as in both references,
// and step 3 reads that ring.
const rcdStep1 = /* glsl */ `
vec4 pixel(ivec2 p) {
	if (!inside(p, textureSize(cfa, 0), 4)) {
		return vec4(0);
	}
	ivec2 V = ivec2(0, 1);
	ivec2 H = ivec2(1, 0);
	float V_Stat = max(epssq, rcd_diff(cfa, p - V, V) + rcd_diff(cfa, p, V) + rcd_diff(cfa, p + V, V));
	float H_Stat = max(epssq, rcd_diff(cfa, p - H, H) + rcd_diff(cfa, p, H) + rcd_diff(cfa, p + H, H));
	return vec4(V_Stat / (V_Stat + H_Stat), 0, 0, 0);
}
`;

// Step 2: low pass filter of the raw data, at red and blue sites.
const rcdStep2 = /* glsl */ `
vec4 pixel(ivec2 p) {
	if (fc(p) == GREEN || !inside(p, textureSize(cfa, 0), 2)) {
		return vec4(0);
	}
	float lpf = at(cfa, p)
		+ 0.5 * (at(cfa, p + ivec2(0, -1)) + at(cfa, p + ivec2(0, 1))
			+ at(cfa, p + ivec2(-1, 0)) + at(cfa, p + ivec2(1, 0)))
		+ 0.25 * (at(cfa, p + ivec2(-1, -1)) + at(cfa, p + ivec2(1, -1))
			+ at(cfa, p + ivec2(-1, 1)) + at(cfa, p + ivec2(1, 1)));
	return vec4(lpf, 0, 0, 0);
}
`;

// Step 3: green at red and blue sites. The result is the rgb state of rcd.c after step 3:
// measured samples in their channel, green interpolated, unknown red and blue 0. Outside the
// region green is the raw sample, as rcd.c's step 0 fills rgb[1] with cfa on every row.
const rcdStep3 = /* glsl */ `
vec4 pixel(ivec2 p) {
	int c = fc(p);
	float cfai = at(cfa, p);
	vec4 rgb = vec4(0, cfai, 0, 0);
	rgb[c] = cfai;
	if (c == GREEN || !inside(p, textureSize(cfa, 0), 4)) {
		return rgb;
	}
	float VH_Disc = refined(VH_Dir, p);

	float n = at(cfa, p + ivec2(0, -1));
	float n2 = at(cfa, p + ivec2(0, -2));
	float s = at(cfa, p + ivec2(0, 1));
	float s2 = at(cfa, p + ivec2(0, 2));
	float w = at(cfa, p + ivec2(-1, 0));
	float w2 = at(cfa, p + ivec2(-2, 0));
	float e = at(cfa, p + ivec2(1, 0));
	float e2 = at(cfa, p + ivec2(2, 0));

	// Cardinal gradients
	float N_Grad = eps + abs(n - s) + abs(cfai - n2) + abs(n - at(cfa, p + ivec2(0, -3)))
		+ abs(n2 - at(cfa, p + ivec2(0, -4)));
	float S_Grad = eps + abs(s - n) + abs(cfai - s2) + abs(s - at(cfa, p + ivec2(0, 3)))
		+ abs(s2 - at(cfa, p + ivec2(0, 4)));
	float W_Grad = eps + abs(w - e) + abs(cfai - w2) + abs(w - at(cfa, p + ivec2(-3, 0)))
		+ abs(w2 - at(cfa, p + ivec2(-4, 0)));
	float E_Grad = eps + abs(e - w) + abs(cfai - e2) + abs(e - at(cfa, p + ivec2(3, 0)))
		+ abs(e2 - at(cfa, p + ivec2(4, 0)));

	// Cardinal pixel estimations; lpf exists at the same colour two pixels away.
	float lpfi = at(lpf, p);
	float N_Est = n * (lpfi + lpfi) / (eps + lpfi + at(lpf, p + ivec2(0, -2)));
	float S_Est = s * (lpfi + lpfi) / (eps + lpfi + at(lpf, p + ivec2(0, 2)));
	float W_Est = w * (lpfi + lpfi) / (eps + lpfi + at(lpf, p + ivec2(-2, 0)));
	float E_Est = e * (lpfi + lpfi) / (eps + lpfi + at(lpf, p + ivec2(2, 0)));

	// Vertical and horizontal estimations
	float V_Est = (S_Grad * N_Est + N_Grad * S_Est) / (N_Grad + S_Grad);
	float H_Est = (W_Grad * E_Est + E_Grad * W_Est) / (E_Grad + W_Grad);

	rgb.g = mix(V_Est, H_Est, clamp(VH_Disc, 0.0, 1.0));
	return rgb;
}
`;

// Step 4.0 + 4.1: diagonal directional discrimination, fused like rcd_step_1. Deliberate
// deviation: darktable (and RawTherapee) store the step 4.0 high pass in half-width buffers
// filled at odd columns only, so on every row step 4.1 reads some samples at green sites one
// column off the diagonal. This takes them at the diagonal red/blue sites, as RCD 2.3's
// closed-form P_Stat and Q_Stat (rcd_demosaicing.c, step 4.1) do.
const rcdStep4_1 = /* glsl */ `
vec4 pixel(ivec2 p) {
	if (fc(p) == GREEN || !inside(p, textureSize(cfa, 0), 4)) {
		return vec4(0);
	}
	ivec2 P = ivec2(1, 1);
	ivec2 Q = ivec2(1, -1);
	float P_Stat = max(epssq, rcd_diff(cfa, p - P, P) + rcd_diff(cfa, p, P) + rcd_diff(cfa, p + P, P));
	float Q_Stat = max(epssq, rcd_diff(cfa, p - Q, Q) + rcd_diff(cfa, p, Q) + rcd_diff(cfa, p + Q, Q));
	return vec4(P_Stat / (P_Stat + Q_Stat), 0, 0, 0);
}
`;

// Step 4.2: red at blue sites and blue at red sites.
const rcdStep4_2 = /* glsl */ `
vec4 pixel(ivec2 p) {
	vec4 result = texelFetch(rgb, p, 0);
	int c = fc(p);
	if (c == GREEN || !inside(p, textureSize(rgb, 0), 4)) {
		return result;
	}
	int color = 2 - c;
	float PQ_Disc = refined(PQ_Dir, p);

	vec4 nw = texelFetch(rgb, p + ivec2(-1, -1), 0);
	vec4 ne = texelFetch(rgb, p + ivec2(1, -1), 0);
	vec4 sw = texelFetch(rgb, p + ivec2(-1, 1), 0);
	vec4 se = texelFetch(rgb, p + ivec2(1, 1), 0);
	float g = result.g;

	// Diagonal gradients
	float NW_Grad = eps + abs(nw[color] - se[color])
		+ abs(nw[color] - texelFetch(rgb, p + ivec2(-3, -3), 0)[color])
		+ abs(g - texelFetch(rgb, p + ivec2(-2, -2), 0).g);
	float NE_Grad = eps + abs(ne[color] - sw[color])
		+ abs(ne[color] - texelFetch(rgb, p + ivec2(3, -3), 0)[color])
		+ abs(g - texelFetch(rgb, p + ivec2(2, -2), 0).g);
	float SW_Grad = eps + abs(ne[color] - sw[color])
		+ abs(sw[color] - texelFetch(rgb, p + ivec2(-3, 3), 0)[color])
		+ abs(g - texelFetch(rgb, p + ivec2(-2, 2), 0).g);
	float SE_Grad = eps + abs(nw[color] - se[color])
		+ abs(se[color] - texelFetch(rgb, p + ivec2(3, 3), 0)[color])
		+ abs(g - texelFetch(rgb, p + ivec2(2, 2), 0).g);

	// Diagonal colour differences
	float NW_Est = nw[color] - nw.g;
	float NE_Est = ne[color] - ne.g;
	float SW_Est = sw[color] - sw.g;
	float SE_Est = se[color] - se.g;

	// P/Q estimations
	float P_Est = (NW_Grad * SE_Est + SE_Grad * NW_Est) / (NW_Grad + SE_Grad);
	float Q_Est = (NE_Grad * SW_Est + SW_Grad * NE_Est) / (NE_Grad + SW_Grad);

	result[color] = g + mix(P_Est, Q_Est, clamp(PQ_Disc, 0.0, 1.0));
	return result;
}
`;

// Step 4.3: red and blue at green sites.
const rcdStep4_3 = /* glsl */ `
vec4 pixel(ivec2 p) {
	vec4 result = texelFetch(rgb, p, 0);
	if (fc(p) != GREEN || !inside(p, textureSize(rgb, 0), 4)) {
		return result;
	}
	float VH_Disc = refined(VH_Dir, p);

	vec4 n = texelFetch(rgb, p + ivec2(0, -1), 0);
	vec4 s = texelFetch(rgb, p + ivec2(0, 1), 0);
	vec4 w = texelFetch(rgb, p + ivec2(-1, 0), 0);
	vec4 e = texelFetch(rgb, p + ivec2(1, 0), 0);
	vec4 n3 = texelFetch(rgb, p + ivec2(0, -3), 0);
	vec4 s3 = texelFetch(rgb, p + ivec2(0, 3), 0);
	vec4 w3 = texelFetch(rgb, p + ivec2(-3, 0), 0);
	vec4 e3 = texelFetch(rgb, p + ivec2(3, 0), 0);

	float rgb1 = result.g;
	float N1 = eps + abs(rgb1 - texelFetch(rgb, p + ivec2(0, -2), 0).g);
	float S1 = eps + abs(rgb1 - texelFetch(rgb, p + ivec2(0, 2), 0).g);
	float W1 = eps + abs(rgb1 - texelFetch(rgb, p + ivec2(-2, 0), 0).g);
	float E1 = eps + abs(rgb1 - texelFetch(rgb, p + ivec2(2, 0), 0).g);

	for (int c = RED; c <= BLUE; c += 2) {
		float SNabs = abs(n[c] - s[c]);
		float EWabs = abs(w[c] - e[c]);

		// Cardinal gradients
		float N_Grad = N1 + SNabs + abs(n[c] - n3[c]);
		float S_Grad = S1 + SNabs + abs(s[c] - s3[c]);
		float W_Grad = W1 + EWabs + abs(w[c] - w3[c]);
		float E_Grad = E1 + EWabs + abs(e[c] - e3[c]);

		// Cardinal colour differences
		float N_Est = n[c] - n.g;
		float S_Est = s[c] - s.g;
		float W_Est = w[c] - w.g;
		float E_Est = e[c] - e.g;

		// Vertical and horizontal estimations
		float V_Est = (N_Grad * S_Est + S_Grad * N_Est) / (N_Grad + S_Grad);
		float H_Est = (E_Grad * W_Est + W_Grad * E_Est) / (E_Grad + W_Grad);

		result[c] = rgb1 + mix(V_Est, H_Est, clamp(VH_Disc, 0.0, 1.0));
	}
	return result;
}
`;

// rcd_write_output over the PPG result, as process_rcd_cl writes RCD into PPG's output.
const rcdWriteOutput = /* glsl */ `
vec4 pixel(ivec2 p) {
	if (inside(p, textureSize(rgb, 0), ${RCD_MARGIN})) {
		return vec4(max(texelFetch(rgb, p, 0).rgb, vec3(0)), 1);
	}
	return vec4(texelFetch(ppg, p, 0).rgb, 1);
}
`;

export function demosaic(
	gpu: Gpu,
	mosaic: Image<'mosaic'>,
	pattern: BayerPattern
): Image<'camera'> {
	const size = { width: mosaic.width, height: mosaic.height };
	const common = prelude(pattern);
	const pass = (label: string, glsl: string, textures: Record<string, Texture>, format: Format) =>
		({ label, glsl: common + glsl, textures, uniforms: {}, size, format }) as const;
	// Intermediates have no pipeline encoding.
	const step = (...args: Parameters<typeof pass>): Texture => run<never>(gpu, pass(...args));

	const cfa = mosaic;
	const green = step('ppg_demosaic_green', ppgDemosaicGreen, { cfa }, 'RGBA32F');
	const ppg = step('ppg_demosaic_redblue', ppgDemosaicRedblue, { ppg: green }, 'RGBA32F');
	const VH_Dir = step('rcd_step_1', rcdStep1, { cfa }, 'R32F');
	const lpf = step('rcd_step_2', rcdStep2, { cfa }, 'R32F');
	const rgb3 = step('rcd_step_3', rcdStep3, { cfa, lpf, VH_Dir }, 'RGBA32F');
	const PQ_Dir = step('rcd_step_4_1', rcdStep4_1, { cfa }, 'R32F');
	const rgb42 = step('rcd_step_4_2', rcdStep4_2, { rgb: rgb3, PQ_Dir }, 'RGBA32F');
	const rgb43 = step('rcd_step_4_3', rcdStep4_3, { rgb: rgb42, VH_Dir }, 'RGBA32F');
	const out = run<'camera'>(
		gpu,
		pass('rcd_write_output', rcdWriteOutput, { rgb: rgb43, ppg }, 'RGBA16F')
	);

	for (const texture of [green, ppg, VH_Dir, lpf, rgb3, PQ_Dir, rgb42, rgb43]) texture.destroy();
	return out;
}
