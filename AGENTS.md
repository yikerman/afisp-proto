# Working in this repository

Read `README.md` first. It states the goal, the method and the references.
The code is meant to be the record of the design; do not add planning or
design documents.

## What this is

A browser RAW editor prototype that tests one claim: translation rework comes
from pipeline structure, not from the controls. The controls are borrowed from
darktable and film grading; the structure is what is new. It is an experiment,
not a product. Performance, camera coverage and features that do not test the
claim are out of scope unless asked for.

## Commands

```
npm run dev                                   # development server
npm run check                                 # types (must report 0 errors)
npm run lint                                  # prettier and eslint
CHROMIUM=/usr/bin/chromium-browser npm test   # all tests, in a browser
```

## Layout

```
src/lib/
  gpu/         WebGL 2 boundary: context, typed images, the pass runner, uniforms
  math/        3x3 matrices
  colour/      colour spaces, adaptation, illuminants, Oklab, sRGB
  raw/         RAW decode boundary (LibRaw) and the Bayer pattern type
  pipeline/
    restoration/   linearise, demosaic (RCD), calibrate
    reference.ts   the frozen scene and its stops fields
    adjustments/   module kinds, mask, evaluator, tone equalizer, colour
    display/       fixed display transform (AgX)
    render.ts      the whole pipeline as one function of file and edit
  edit/        control table, edit state, panel items, logged session
  view/        display resampling and histogram
  export/      TIFF and ICC writers
  ui/          Svelte components
src/routes/    the single page
```

## Rules of the design

These are what the prototype exists to test. Do not weaken them to make a
feature easier; raise the conflict instead.

- **One pure function.** `display = transform(adjust(restore(raw)))`, of the
  file and one immutable edit value. Remembering a result is allowed only as
  an optimisation keyed on its full inputs.
- **Stage contracts are types.** An `Image<E>` carries what its numbers mean.
  A stage accepts and returns specific encodings.
- **Adjustments read only the reference.** Tone terms and masks receive the
  reference (scene, stops, smoothed stops) and their parameters, never the
  image being edited. The evaluator enforces this by what it binds.
- **Tone terms are exposure offsets in stops that add**, so their order does
  not matter. Tone works in log2 of scene-linear luminance, not in a
  perceptual space.
- **The display transform has no parameters.** Preview and export use it.
- **Exposure and white balance belong to restoration.** Exposure places
  middle grey. Chromatic adaptation is CAT16.
- **Every control is a row of the table in `edit/controls.ts`.** The edit
  state type, the panels and the log derive from it. A control that is
  another way to read values the edit already holds is a panel item in
  `edit/items.ts` and adds no state.
- **Advanced does not mean withheld.** Anything conceptually sound may be
  exposed. Controls whose default suits most pictures are marked `advanced`
  and sit folded under their section.
- **Every user action is logged** through `Session`. Do not change state
  anywhere else.
- **Modules are identity at their defaults**, and a missing mask is the
  constant 1. Prefer a representation that includes the degenerate case over
  a boolean that branches around it.

## Code

- TypeScript strict. Encode invariants in types; no `any`.
- Normalise untrusted input once at a boundary (`raw/decode.ts`,
  `gpu/gpu.ts`, the UI's value entry). Inside, trust the contract: no
  defensive checks, clamps or fallbacks.
- One source of truth for every value. When two things must agree, compute
  both through the same code.
- Constants derived from other constants are computed in TypeScript and
  injected into GLSL, not pasted.
- Shaders are plain GLSL ES 3.00 strings next to the TypeScript that runs
  them. A pass defines `vec4 pixel(ivec2 p)` and reads only what it is given.
- Comments say why, briefly, and cite the source. They do not narrate.
- Use the standard term for a thing. Do not coin names.
- Workarounds for browser or driver faults stay at the boundary, with a
  comment naming the fault and the condition for removing them.
- Commits are small and each compiles and passes on its own.

## Verification

- Reproduce a fault before fixing it, and find its cause.
- Ports from darktable are checked per module against the matching darktable
  code, not by comparing whole renders. `demosaic` deliberately differs from
  darktable in RCD step 4.0 (start column); see the comment there.
- Unit tests run in headless Chromium, which only offers a software GPU, so
  they use small images. A passing test says nothing about full-size
  behaviour. Check that in a visible browser with a real RAW file.

## Running in a browser

The app runs on WebGL 2 with float render targets (`EXT_color_buffer_float`)
in an ordinary Chromium as Linux distributions ship it, with no flags. It
refuses a software renderer (SwiftShader, llvmpipe), which would take seconds
per frame; `chrome://gpu` shows what WebGL runs on.

## Interface

Professional editing software is the model (DaVinci Resolve, darktable).
Neutral grey only, dense panels, plain nouns for labels, a number beside
every slider, double click to reset. No slogans, onboarding text, gradients,
decorative icons or animation.

## Borrowed code and licences

The project is AGPL-3.0-or-later. Code may be ported from GPL-3.0-or-later,
LGPL and permissive sources; check the licence first and cite the source
file and revision in the port.
