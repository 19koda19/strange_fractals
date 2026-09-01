# NOEMA

NOEMA is a full-screen incantation instrument: give it a phrase and it grows a strange attractor around a black eclipse. Every new root birth receives fresh specimen entropy, so entering the same phrase twice discovers a sibling rather than a duplicate. Keep speaking and each new phrase becomes a reversible transformation of the same living system.

The resting screen is deliberately generative art rather than a dashboard. Interface text appears only when it is useful, then dissolves.

## Enter the field

```bash
npm install
npm run dev
```

Open the Electron edition with:

```bash
npm run dev:desktop
```

Or build the exact production renderer first:

```bash
npm run desktop
```

The web build is produced by `npm run build` in `dist/`. The same artifact is used by Electron and GitHub Pages.

## Choreography

- **Type, then Return** — birth the root seed or commit a semantic mutation.
- **Keep typing** — characters immediately excite the neural field; the uncommitted phrase previews a smaller transformation.
- **Scroll / trackpad / pinch** — descend through the recursive zoom band. Zoom is anchored near the gesture.
- **Drag** — comb the current and inject a decaying phase wake.
- **Shift-drag / two-finger twist** — rotate global phase and wave depth.
- **Double-click / double-tap** — choose a new gravitational focus.
- **Cmd/Ctrl-Z / Cmd/Ctrl-Shift-Z** — move backward or forward through phrase memory.
- **Page Up / Page Down** — keyboard zoom; **Shift + arrows** turn phase; **Home** returns to the eclipse.
- **Escape** — pause or resume. **F1** reveals the temporary choreography.
- **Cmd/Ctrl-Shift-S** — export a still. The Electron menu can also copy a living web link.

The URL fragment stores the root phrase, specimen identity, and mutation history, so a copied link reconstructs that exact instrument without sending the phrase to a server. Links made by earlier versions, before specimen identities existed, remain readable.

## Screensaver drift

Append `?screensaver=1` to the web or Electron renderer URL for a silent exhibition mode. An empty session births a random poetic specimen, then absorbs another semantic transformation every 22–38 seconds (more slowly when reduced motion is preferred). All interface text and cursors disappear. A real key press, click/touch, or wheel gesture ends the automation, reveals the normal instrument, and preserves the specimen currently on screen.

## What is actually happening

The particle field is not a video or a pre-rendered texture. p5.js owns the lifecycle and canvas; its WebGL2 context evolves the field with GPU transform feedback. A root phrase and its specimen identity select one of four bounded chaotic systems—Thomas, Halvorsen, Aizawa, or Dadras—then pre-sample its orbit so the attractor arrives fully formed. The identity is random at birth but deterministic thereafter, including across a shared-link replay.

Every rendered particle carries a full-density primary orbit plus three independently evolved, coupled nesting states. The primary orbit keeps the phrase's strange attractor bold and legible. A cyclic Latin sheet gives each parent a complete child attractor and each child a complete grandchild relation; a seeded mask reveals sparse whole fibers around the luminous spine rather than replacing it with a cloud. Parent-conditioned rotation and scale keep those children from reading as stamped copies. Three faint candidate children already live inside the parent, while the chosen recursive child is rendered as that same attractor at full density. Zoom transfers visual weight to the existing child, then exactly rebases its geometry, size, and shading as the next root; reversible camera history keeps centered and off-center round trips continuous in either direction.

The background, brain silhouette, gyri, lensing, eclipse, corona, stars, trails, and bloom are procedural shaders. There are no image assets.

Language has two layers:

1. A synchronous deterministic n-gram/semantic mapper makes every keystroke and phrase respond immediately, including offline.
2. A lazy, pretrained MiniLM sentence transformer runs on-device through Transformers.js. It uses WebGPU when available and portable WASM otherwise, then eases the attractor coefficients, flow, warp, symmetry, palette, and neural backdrop toward a semantic embedding. The same inference pulse contracts through the brain and ignites the corresponding attractor filaments, making their connection visible rather than merely thematic. Similar phrases therefore create related moves while the root seed preserves the instrument's identity.

The model is fetched from Hugging Face on first use and cached by the browser. Phrase inference stays on the device. If the model or network is unavailable, the deterministic language field continues uninterrupted.

## Design constraints

- No persistent HUD, cards, traffic-light palette, settings rail, or loading bar.
- Curated obsidian, bone, ultraviolet, cobalt, bruised magenta, ember, and rose-gold spectra.
- Genuine DOM input for IME, paste, mobile keyboards, and screen readers.
- Keyboard parity for core gestures and a polite canvas description.
- Reduced-motion preference lowers pixel density and suppresses the aggressive birth transition.
- Electron runs with `nodeIntegration: false`, context isolation, and renderer sandboxing.

## Verification

```bash
npm run check
```

This runs deterministic seed/session tests and creates the production Vite build. `scripts/cdp-smoke.mjs` can exercise a running Electron window exposed with a local Chrome debugging port; it is the visual regression smoke harness used during development.

## Deployment

`.github/workflows/pages.yml` builds and publishes `dist/` whenever `main` is pushed. GitHub Pages must use **GitHub Actions** as its source.

## License

MIT
