import { glslMatrix, inverse, multiply, type Matrix3 } from '../math/matrix';
import { rec2020ToXyz } from './spaces';

// B. Ottosson, "A perceptual color space for image processing", 2020.
const xyzToLms: Matrix3 = [
	[0.8189330101, 0.3618667424, -0.1288597137],
	[0.0329845436, 0.9293118715, 0.0361456387],
	[0.0482003018, 0.2643662691, 0.633851707]
];
const lmsToLab: Matrix3 = [
	[0.2104542553, 0.793617785, -0.0040720468],
	[1.9779984951, -2.428592205, 0.4505937099],
	[0.0259040371, 0.7827717662, -0.808675766]
];

const sceneToLms = multiply(xyzToLms, rec2020ToXyz);

/**
 * Scene-linear Rec.2020 to and from Oklab (lightness, a, b). Both directions
 * are homogeneous: scaling the scene colour scales lightness and chroma alike,
 * so an operation written on these coordinates behaves the same at any exposure.
 *
 * Oklab is a placeholder for a colour space built for scene-referred data.
 */
export const oklabGlsl = /* glsl */ `
vec3 oklab_from_scene(vec3 rgb) {
	vec3 lms = ${glslMatrix(sceneToLms)} * rgb;
	return ${glslMatrix(lmsToLab)} * (sign(lms) * pow(abs(lms), vec3(1.0 / 3.0)));
}

vec3 scene_from_oklab(vec3 lab) {
	vec3 root = ${glslMatrix(inverse(lmsToLab))} * lab;
	return ${glslMatrix(inverse(sceneToLms))} * (root * root * root);
}`;
