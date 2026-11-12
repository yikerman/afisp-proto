# Art-people Friendly Image Signal Processing: prototype

A RAW photo editor built to test one idea. Licence: AGPL-3.0-or-later.

## Goal

A photographer goes back and forth between controls for two reasons:

- **Deciding.** They are still working out what the picture should look like.
  This is the creative work and must stay.
- **Translating.** They know what they want, but changing one control disturbed
  what another had already achieved, so they return to fix it. This is pure
  cost.

The goal is to remove the second kind without restricting the first: for a
given intent there should be one obvious way to express it, and expressing it
should not undo earlier work.

The claim under test is that existing editors fail at this because of how
their pipelines are structured, not because of their controls. The controls
here are therefore borrowed from darktable and from film colour grading
practice; the structure is what is new.

## Method

The pipeline is one pure function of the RAW file and a single immutable edit
state, in three stages with fixed contracts between them:

```
raw --restoration--> scene --adjustments--> graded scene --display transform--> output
```

1. **Restoration** recovers the scene as it was. Some of its parameters have
   a measurable answer (demosaicing, lens correction, colour calibration) and
   are automatic. The others say how the scene looked to someone standing
   there: white balance is what looked white, exposure is what looked middle
   grey. Those are judgements only the photographer can make, but they are
   judgements of fact, not of taste. Its output is a scene-linear image that
   is then frozen as the reference.
2. **Adjustments** are the look: purely aesthetic choices. Every tonal zone and mask is
   computed from the reference image only, never from the result of another
   adjustment, so adjustments cannot move each other's targets. Tone changes
   are exposure offsets in stops that add up, so their order does not matter.
3. **Display transform** is fixed and has no parameters. Preview and export
   use the same transform, so the export is what was seen.

The interface shows these stages as separate screens. The image and scopes
always show display output for the pipeline up to the current screen.

Every control change and screen change is logged. With a fixed target
rendering to reproduce, each return to a control that was already set counts
as translation cost, and can be compared with other editors on the same
images. Frequent movement back to an earlier stage indicates that either the
user's model or the stage split is wrong.

## Development

```
npm install
npm run dev
CHROMIUM=/usr/bin/chromium-browser npm test   # CHROMIUM is optional
```

Tests run in a browser because the shaders need WebGPU.

## Deployment

Each push to `master` is built and published to GitHub Pages by
`.github/workflows/deploy.yml`, at https://yikerman.github.io/afisp-proto/.
`BASE_PATH` sets the path the site is served under; unset, it is `/`.

## References

Problem and method

- D. Schön, _The Reflective Practitioner_, 1983 (reflection-in-action).
- E. Hutchins, J. Hollan, D. Norman, "Direct Manipulation Interfaces", 1985
  (gulfs of execution and evaluation).
- T. Green, M. Petre, "Usability Analysis of Visual Programming Environments:
  A 'Cognitive Dimensions' Framework", 1996 (hidden dependencies).
- M. Terry, E. Mynatt, "Recognizing Creative Needs in User Interface Design", 2002.
- D. Nichols, M. Twidale, "The Usability of Open Source Software", 2003.
- A. Pierre, "Who are the darktable users in 2022?",
  https://eng.aurelienpierre.com/2026/07/who-are-the-darktable-users-in-2022/

Controls and grading practice

- A. Van Hurkman, _Color Correction Handbook_ and _Color Correction Look
  Book_, 2013.
- Reading list at https://ansel.photos/en/resources/readings/
- darktable user manual (tone equalizer, color balance rgb, AgX),
  https://docs.darktable.org/

Image processing

- E. Reinhard et al., "Photographic Tone Reproduction for Digital Images", 2002.
- L. Sanz Rodríguez, Ratio Corrected Demosaicing (RCD),
  https://github.com/LuisSR/RCD-Demosaicing
- C. Li et al., "Comprehensive color solutions: CAM16, CAT16, and CAM16-UCS", 2017.
- T. Sobotka, AgX, https://github.com/sobotka/AgX
- B. Ottosson, "A perceptual color space for image processing" (Oklab), 2020.

Code this project ports from or checks against

- darktable (GPL-3.0-or-later), https://github.com/darktable-org/darktable
- LibRaw (LGPL-2.1), through https://github.com/colorhythm/libraw-wasm
