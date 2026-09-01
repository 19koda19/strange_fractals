import p5 from 'p5';

import './styles.css';
import {
  createSpecimenId,
  decodeSession,
  deriveScene,
  encodeSession,
  fallbackEmbedding,
  hashString,
} from './core/seed.js';
import { GestureController } from './input/GestureController.js';
import { SemanticEngine } from './neural/SemanticEngine.js';
import { GpuAttractor } from './render/GpuAttractor.js';

const $ = (selector) => document.querySelector(selector);
const CANONICAL_WEB_URL = import.meta.env.VITE_PUBLIC_URL || 'https://19koda19.github.io/strange_fractals/';
const SCREENSAVER_ROOTS = [
  'a violet ocean remembers the moon',
  'quiet thunder beneath sleeping glass',
  'the patient orchid dreams in silver',
  'velvet memory crossing a tidal synapse',
  'an ancient echo blooms beyond the horizon',
  'soft gravity listening to the winter stars',
  'the hollow comet carries a lucid shadow',
  'moonlit currents inside a dreaming labyrinth',
  'a rose-gold ghost hums beneath the ice',
  'slow lightning through the cathedral of sleep',
];
const SCREENSAVER_MUTATIONS = [
  'fold the violet current into a quieter spiral',
  'let memory breathe through the sleeping wave',
  'loosen symmetry and bloom toward the horizon',
  'turn the cold synapse through a graceful phase',
  'remember the ghost inside the silver tide',
  'open the calm labyrinth beneath moonlight',
  'comb the ancient current into soft thunder',
  'dissolve the mirror and release the ember',
  'braid a patient storm through the hollow',
  'float outward until the shadow begins to sing',
  'draw the distant pulse into a lucid knot',
  'let the quiet geometry forget its name',
  'bloom slowly through cobalt memory',
  'unspool the tidal dream across the void',
  'balance the fracture with a breath of gold',
  'carry the neural echo into winter light',
];

function randomUnit() {
  if (globalThis.crypto?.getRandomValues) {
    const word = new Uint32Array(1);
    globalThis.crypto.getRandomValues(word);
    return word[0] / 4294967296;
  }
  return Math.random();
}

function randomChoice(values) {
  return values[Math.floor(randomUnit() * values.length)];
}

class Noema {
  constructor() {
    this.dom = {
      stage: $('#stage'),
      threshold: $('#threshold'),
      form: $('#phrase-form'),
      input: $('#phrase-input'),
      invitation: $('#invitation'),
      whisper: $('#whisper'),
      status: $('#status'),
      depth: $('#depth-readout'),
      guide: $('#choreography'),
      closeHelp: $('#close-help'),
      description: $('#canvas-description'),
      help: $('#help-button'),
      pause: $('#pause-button'),
      reset: $('#reset-button'),
      export: $('#export-button'),
    };
    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.semantic = new SemanticEngine();
    this.renderer = null;
    this.p5 = null;
    this.gestures = null;
    this.rootSeed = null;
    this.specimenId = '';
    this.mutations = [];
    this.historyIndex = 0;
    this.committedScene = null;
    this.revision = 0;
    this.previewTimer = 0;
    this.previewToken = 0;
    this.statusTimer = 0;
    this.whisperTimer = 0;
    this.depthTimer = 0;
    this.hasRenderedError = false;
    this.visibilityPaused = false;
    this.screensaverRequested = new URLSearchParams(location.search).get('screensaver') === '1';
    this.screensaverActive = this.screensaverRequested;
    this.screensaverTimer = 0;
    this.lastScreensaverPhrase = '';

    document.body.classList.toggle('is-screensaver', this.screensaverActive);

    this.bindInterface();
    this.createCanvas();
  }

  createCanvas() {
    const app = this;
    this.p5 = new p5((p) => {
      p.setup = () => {
        const targetDensity = Math.min(window.devicePixelRatio || 1, app.reducedMotion ? 1 : 1.35);
        p.createCanvas(window.innerWidth, window.innerHeight, p.WEBGL);
        p.setAttributes({ version: 2, alpha: false, antialias: false, depth: false, stencil: false });
        p.pixelDensity(targetDensity);
        const canvas = p.canvas;
        for (const staleCanvas of app.dom.stage.querySelectorAll('canvas')) {
          if (staleCanvas !== canvas) staleCanvas.remove();
        }
        app.dom.stage.append(canvas);
        canvas.tabIndex = -1;
        canvas.setAttribute('role', 'img');
        canvas.setAttribute('aria-describedby', 'canvas-description');
        app.dom.stage.removeAttribute('aria-hidden');

        try {
          app.renderer = app.makeRenderer(p);
          const dormant = deriveScene('the unspoken noema', 'sleeping neural eclipse', fallbackEmbedding('sleeping neural eclipse'), 0);
          app.renderer.setDormant(dormant);
          app.gestures = new GestureController(canvas, app.renderer, (gesture) => app.onGesture(gesture));
          app.bindContextRecovery(canvas, p);
          app.restoreSession();
          if (app.screensaverActive) requestAnimationFrame(() => app.startScreensaver());
          else requestAnimationFrame(() => app.dom.input.focus({ preventScroll: true }));
        } catch (error) {
          app.renderError(error);
          p.noLoop();
        }
      };

      p.draw = () => {
        if (!app.renderer || app.hasRenderedError) return;
        try {
          app.renderer.draw();
        } catch (error) {
          app.renderError(error);
          p.noLoop();
        }
      };

      p.windowResized = () => {
        p.resizeCanvas(window.innerWidth, window.innerHeight);
        app.renderer?.resize();
      };
    }, this.dom.stage);
  }

  makeRenderer(p) {
    return new GpuAttractor(p, {
      reducedMotion: this.reducedMotion,
      onDepthChange: (depth) => this.showDepth(depth),
      onError: (error) => this.renderError(error),
    });
  }

  bindContextRecovery(canvas, p) {
    let viewBeforeLoss = null;
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      if (this.renderer) {
        viewBeforeLoss = {
          scene: this.renderer.scene ? structuredClone(this.renderer.scene) : null,
          targetScene: this.renderer.targetScene ? structuredClone(this.renderer.targetScene) : null,
          stateCenters: Float32Array.from(this.renderer.stateCenters),
          portalStates: Float32Array.from(this.renderer.portalStates),
          logZoom: this.renderer.logZoom,
          cameraOffset: Float32Array.from(this.renderer.cameraOffset),
          focus: Float32Array.from(this.renderer.focus),
          focusHistory: Array.from(this.renderer.focusHistory, ([epoch, focus]) => [epoch, [...focus]]),
          navigationChoices: Array.from(this.renderer.navigationChoices),
          portalBandViews: Array.from(this.renderer.portalBandViews, ([epoch, view]) => [epoch, [...view]]),
          outwardParentViews: Array.from(this.renderer.outwardParentViews, ([epoch, view]) => [epoch, [...view]]),
          portalBranch: this.renderer.portalBranch,
          zoomIntent: this.renderer.zoomIntent,
          zoomIntentTarget: this.renderer.zoomIntentTarget,
          phaseOffset: this.renderer.phaseOffset,
          phaseOffsetTarget: this.renderer.phaseOffsetTarget,
          waveDepth: this.renderer.waveDepth,
          waveDepthTarget: this.renderer.waveDepthTarget,
          pointer: Float32Array.from(this.renderer.pointer),
          pointerTarget: Float32Array.from(this.renderer.pointerTarget),
          morphSpeed: this.renderer.morphSpeed,
          elapsed: this.renderer.elapsed,
        };
      }
      p.noLoop();
      this.showStatus('the field slipped from the graphics memory · restoring', 5000);
    });

    canvas.addEventListener('webglcontextrestored', () => {
      requestAnimationFrame(() => {
        try {
          const restored = this.makeRenderer(p);
          if (this.committedScene && this.rootSeed) {
            restored.seed(viewBeforeLoss?.scene ?? this.committedScene);
          } else {
            const dormant = deriveScene('the unspoken noema', 'sleeping neural eclipse', fallbackEmbedding('sleeping neural eclipse'), 0);
            restored.setDormant(dormant);
          }
          if (viewBeforeLoss) {
            if (viewBeforeLoss.scene) restored.scene = structuredClone(viewBeforeLoss.scene);
            if (viewBeforeLoss.targetScene) restored.targetScene = structuredClone(viewBeforeLoss.targetScene);
            restored.stateCenters.set(viewBeforeLoss.stateCenters);
            restored.portalStates.set(viewBeforeLoss.portalStates);
            restored.logZoom = restored.zoomPosition(viewBeforeLoss.logZoom).logZoom;
            restored.cameraOffset.set(viewBeforeLoss.cameraOffset);
            restored.focus.set(viewBeforeLoss.focus);
            restored.focusHistory = new Map(viewBeforeLoss.focusHistory);
            restored.navigationChoices = new Map(viewBeforeLoss.navigationChoices);
            restored.portalBandViews = new Map(viewBeforeLoss.portalBandViews);
            restored.outwardParentViews = new Map(viewBeforeLoss.outwardParentViews);
            restored.portalBranch = viewBeforeLoss.portalBranch;
            restored.zoomIntent = viewBeforeLoss.zoomIntent ?? 0;
            restored.zoomIntentTarget = viewBeforeLoss.zoomIntentTarget ?? restored.zoomIntent;
            const { epoch } = restored.zoomPosition();
            restored.activeBranch = ((epoch % 3) + 3) % 3;
            restored.phaseOffset = viewBeforeLoss.phaseOffset;
            restored.phaseOffsetTarget = viewBeforeLoss.phaseOffsetTarget;
            restored.waveDepth = viewBeforeLoss.waveDepth;
            restored.waveDepthTarget = viewBeforeLoss.waveDepthTarget;
            restored.pointer.set(viewBeforeLoss.pointer);
            restored.pointerTarget.set(viewBeforeLoss.pointerTarget);
            restored.morphSpeed = viewBeforeLoss.morphSpeed;
            restored.elapsed = viewBeforeLoss.elapsed;
          }
          this.renderer = restored;
          if (this.gestures) this.gestures.renderer = restored;
          this.hasRenderedError = false;
          if (import.meta.env.DEV) window.__noemaLastError = null;
          this.dom.input.disabled = false;
          this.dom.invitation.textContent = this.rootSeed
            ? 'keep speaking; each phrase becomes a mutation'
            : 'give the void a phrase';
          p.loop();
          this.showStatus('the field has returned', 1800);
        } catch (error) {
          this.renderError(error);
        }
      });
    });
  }

  bindInterface() {
    this.dom.form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.commit(this.dom.input.value);
    });

    this.dom.input.addEventListener('focus', () => document.body.classList.add('is-typing'));
    this.dom.input.addEventListener('blur', () => {
      if (!this.dom.input.value) document.body.classList.remove('is-typing');
    });
    this.dom.input.addEventListener('input', (event) => this.preview(event));
    this.dom.input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (this.dom.input.value) this.cancelPreview();
        else this.dom.input.blur();
      } else if (event.key === 'Backspace' && !this.dom.input.value && this.rootSeed) {
        event.preventDefault();
        this.undo();
      }
    });

    window.addEventListener('keydown', (event) => this.onKeyDown(event));
    window.addEventListener('hashchange', () => this.restoreSession());
    const leaveScreensaver = (event) => {
      if (this.screensaverActive && event.isTrusted) this.stopScreensaver();
    };
    window.addEventListener('pointerdown', leaveScreensaver, { capture: true, passive: true });
    window.addEventListener('wheel', leaveScreensaver, { capture: true, passive: true });
    window.addEventListener('keydown', leaveScreensaver, { capture: true });
    document.addEventListener('visibilitychange', () => {
      if (!this.renderer) return;
      if (document.hidden) {
        window.clearTimeout(this.screensaverTimer);
        this.visibilityPaused = this.renderer.paused;
        this.renderer.setPaused(true);
      } else {
        this.renderer.setPaused(this.visibilityPaused);
        if (this.screensaverActive) this.scheduleScreensaverMutation();
      }
    });

    this.dom.help.addEventListener('click', () => this.toggleHelp(true));
    this.dom.closeHelp.addEventListener('click', () => this.toggleHelp(false));
    this.dom.pause.addEventListener('click', () => this.togglePause());
    this.dom.reset.addEventListener('click', () => this.resetView());
    this.dom.export.addEventListener('click', () => this.exportStill());

    this.semantic.addEventListener('state', (event) => {
      if (event.detail.message && this.rootSeed) this.showStatus(event.detail.message, 2500, false);
      if (event.detail.mode === 'webgpu' || event.detail.mode === 'wasm') this.renderer?.pulse(0.65);
    });

    window.noemaDesktop?.onCommand((command) => {
      const commands = {
        'new-seed': () => this.newSeed(),
        'copy-link': () => this.copyLink(),
        export: () => this.exportStill(),
        pause: () => this.togglePause(),
        'reset-view': () => this.resetView(),
        help: () => this.toggleHelp(true),
      };
      commands[command]?.();
    });
  }

  preview(event) {
    const value = this.dom.input.value;
    this.dom.threshold.classList.toggle('has-text', Boolean(value));
    document.body.classList.toggle('is-typing', document.activeElement === this.dom.input || Boolean(value));
    const inserted = event?.data || value.at(-1) || '';
    if (inserted) this.renderer?.typingPulse(inserted);
    if (!this.rootSeed || !this.renderer) return;

    window.clearTimeout(this.previewTimer);
    const previewToken = ++this.previewToken;
    if (!value.trim()) {
      this.renderer.morph(this.committedScene, 1.1);
      return;
    }

    this.previewTimer = window.setTimeout(() => {
      if (previewToken !== this.previewToken || !this.rootSeed) return;
      const phrase = value.trim();
      const scene = deriveScene(
        this.rootSeed,
        phrase,
        this.semantic.immediate(phrase),
        this.historyIndex + 0.45,
        this.specimenId,
      );
      this.renderer.morph(scene, 1.35);
    }, 70);
  }

  commit(rawPhrase, { automated = false } = {}) {
    if (!this.renderer) return;
    const phrase = String(rawPhrase).replace(/\s+/gu, ' ').trim();
    if (!phrase) {
      if (this.rootSeed) {
        this.renderer.pulse(0.72);
        this.showStatus('the field takes one deliberate breath', 1800);
      }
      return;
    }

    this.invalidatePreview();

    if (!automated) this.animateSwallow(phrase);
    this.revision += 1;
    const revision = this.revision;

    if (!this.rootSeed) {
      this.rootSeed = phrase;
      this.specimenId = createSpecimenId();
      this.mutations = [];
      this.historyIndex = 0;
      this.committedScene = deriveScene(phrase, phrase, this.semantic.immediate(phrase), 0, this.specimenId);
      this.renderer.seed(this.committedScene);
      document.body.classList.add('is-awake');
      this.dom.invitation.textContent = 'keep speaking; each phrase becomes a mutation';
      this.dom.description.textContent = `A ${this.committedScene.familyName} strange attractor born from ${phrase}, orbiting a black eclipse over a neural field.`;
      if (!automated) {
        this.showStatus(`${this.committedScene.familyName.toLocaleLowerCase()} current born from “${phrase}”`, 2600);
        this.showWhisper('scroll or pinch to fall inward', 'birth');
      }
      this.semantic.warmup();
    } else {
      this.mutations = this.mutations.slice(0, this.historyIndex);
      this.mutations.push(phrase);
      this.historyIndex = this.mutations.length;
      this.committedScene = deriveScene(
        this.rootSeed,
        phrase,
        this.semantic.immediate(phrase),
        this.historyIndex,
        this.specimenId,
      );
      this.renderer.morph(this.committedScene, 2.35);
      this.dom.description.textContent = `The ${this.committedScene.familyName} attractor now carries ${this.historyIndex} language mutations. Latest: ${phrase}.`;
      if (!automated) this.showStatus(`mutation ${this.historyIndex} absorbed · “${phrase}”`, 2200);
    }

    this.updateSessionFragment();
    this.dom.input.value = '';
    this.dom.threshold.classList.remove('has-text');
    if (!automated) this.dom.input.blur();
    document.body.classList.remove('is-typing');
    this.enhanceWithDeepLanguage(phrase, revision, this.historyIndex);
  }

  async enhanceWithDeepLanguage(phrase, revision, depth) {
    const embedding = await this.semantic.embed(phrase);
    if (revision !== this.revision || !this.rootSeed || depth !== this.historyIndex) return;
    const scene = deriveScene(this.rootSeed, phrase, embedding, depth, this.specimenId);
    this.committedScene = scene;
    this.renderer?.assimilate(scene, 3.1);
  }

  cancelPreview() {
    this.invalidatePreview();
    this.dom.input.value = '';
    this.dom.threshold.classList.remove('has-text');
    document.body.classList.remove('is-typing');
    this.dom.input.blur();
    if (this.committedScene) this.renderer?.morph(this.committedScene, 1.2);
  }

  animateSwallow(phrase) {
    if (this.reducedMotion) return;
    const clone = document.createElement('div');
    const bounds = this.dom.input.getBoundingClientRect();
    clone.className = 'swallowed-phrase';
    clone.textContent = phrase;
    clone.style.top = `${bounds.top}px`;
    document.body.append(clone);
    clone.addEventListener('animationend', () => clone.remove(), { once: true });
  }

  currentPhrase() {
    return this.historyIndex > 0 ? this.mutations[this.historyIndex - 1] : this.rootSeed;
  }

  applyHistory(direction) {
    if (!this.rootSeed) return;
    const nextIndex = Math.max(0, Math.min(this.mutations.length, this.historyIndex + direction));
    if (nextIndex === this.historyIndex) {
      this.renderer?.pulse(0.25);
      return;
    }
    this.invalidatePreview();
    this.historyIndex = nextIndex;
    this.revision += 1;
    const phrase = this.currentPhrase();
    this.committedScene = deriveScene(
      this.rootSeed,
      phrase,
      this.semantic.immediate(phrase),
      this.historyIndex,
      this.specimenId,
    );
    this.renderer?.morph(this.committedScene, 1.8);
    this.updateSessionFragment();
    this.showStatus(this.historyIndex ? `memory ${this.historyIndex} restored` : 'returned to the root phrase', 1800);
    const revision = this.revision;
    this.enhanceWithDeepLanguage(phrase, revision, this.historyIndex);
  }

  undo() {
    this.applyHistory(-1);
  }

  redo() {
    this.applyHistory(1);
  }

  updateSessionFragment() {
    if (!this.rootSeed) {
      history.replaceState(null, '', `${location.pathname}${location.search}`);
      return;
    }
    const visibleMutations = this.mutations.slice(0, this.historyIndex);
    const fragment = encodeSession(this.rootSeed, visibleMutations, this.specimenId);
    history.replaceState(null, '', `#s=${fragment}`);
  }

  restoreSession() {
    const session = decodeSession(location.hash);
    if (!session || !session.rootSeed || !this.renderer) return false;
    this.invalidatePreview();
    this.rootSeed = session.rootSeed;
    this.specimenId = session.specimenId;
    this.mutations = session.mutations;
    this.historyIndex = session.mutations.length;
    const phrase = this.currentPhrase();
    this.committedScene = deriveScene(
      this.rootSeed,
      phrase,
      this.semantic.immediate(phrase),
      this.historyIndex,
      this.specimenId,
    );
    this.renderer.seed(this.committedScene);
    document.body.classList.add('is-awake');
    this.dom.invitation.textContent = 'keep speaking; each phrase becomes a mutation';
    this.dom.input.value = '';
    this.dom.threshold.classList.remove('has-text');
    document.body.classList.remove('is-typing');
    this.dom.description.textContent = `A restored ${this.committedScene.familyName} attractor with ${this.historyIndex} mutations.`;
    this.showStatus('the living link has remembered its form', 2400);
    this.semantic.warmup();
    const revision = ++this.revision;
    this.enhanceWithDeepLanguage(phrase, revision, this.historyIndex);
    return true;
  }

  startScreensaver() {
    if (!this.screensaverActive || !this.renderer) return;
    document.body.classList.add('is-screensaver');
    this.dom.input.blur();
    this.scheduleScreensaverMutation(this.rootSeed ? undefined : 320);
  }

  scheduleScreensaverMutation(delay) {
    window.clearTimeout(this.screensaverTimer);
    if (!this.screensaverActive || document.hidden) return;
    const minimum = this.reducedMotion ? 34_000 : 22_000;
    const spread = this.reducedMotion ? 18_000 : 16_000;
    const wait = delay ?? minimum + randomUnit() * spread;
    this.screensaverTimer = window.setTimeout(() => this.advanceScreensaver(), wait);
  }

  nextScreensaverPhrase(values) {
    let phrase = randomChoice(values);
    for (let attempt = 0; phrase === this.lastScreensaverPhrase && attempt < 4; attempt += 1) {
      phrase = randomChoice(values);
    }
    this.lastScreensaverPhrase = phrase;
    return phrase;
  }

  advanceScreensaver() {
    if (!this.screensaverActive || !this.renderer) return;

    if (this.mutations.length >= 48) {
      this.invalidatePreview();
      this.revision += 1;
      this.rootSeed = null;
      this.specimenId = '';
      this.mutations = [];
      this.historyIndex = 0;
      this.committedScene = null;
    }

    const phrase = this.nextScreensaverPhrase(this.rootSeed ? SCREENSAVER_MUTATIONS : SCREENSAVER_ROOTS);
    this.commit(phrase, { automated: true });
    this.scheduleScreensaverMutation();
  }

  stopScreensaver() {
    if (!this.screensaverActive) return;
    this.screensaverActive = false;
    this.screensaverRequested = false;
    window.clearTimeout(this.screensaverTimer);
    document.body.classList.remove('is-screensaver');

    const url = new URL(location.href);
    url.searchParams.delete('screensaver');
    history.replaceState(null, '', url.href);
  }

  onGesture(kind) {
    if (this.dom.guide.hidden === false) this.toggleHelp(false);
    if (!this.rootSeed) return;
    if (kind === 'zoom') {
      this.completeWhisper('birth');
      this.showWhisper('drag through the current', 'zoom');
    } else if (kind === 'drag') {
      this.completeWhisper('zoom');
      this.showWhisper('twist, or shift-drag, to turn its phase', 'drag');
    } else if (kind === 'phase') {
      this.completeWhisper('drag');
      this.showWhisper('keep typing; return makes it remember', 'phase');
    }
  }

  showWhisper(message, key) {
    try {
      if (localStorage.getItem(`noema:whisper:${key}`)) return;
    } catch {
      // Private browsing can deny storage; the whisper can still exist for this moment.
    }
    window.clearTimeout(this.whisperTimer);
    this.dom.whisper.textContent = message;
    this.dom.whisper.classList.add('is-visible');
    this.whisperTimer = window.setTimeout(() => this.dom.whisper.classList.remove('is-visible'), 6500);
  }

  completeWhisper(key) {
    try {
      localStorage.setItem(`noema:whisper:${key}`, '1');
    } catch {
      // Nothing essential depends on persistence.
    }
    this.dom.whisper.classList.remove('is-visible');
  }

  showStatus(message, duration = 2200, announce = true) {
    window.clearTimeout(this.statusTimer);
    this.dom.status.textContent = message;
    this.dom.status.classList.toggle('is-visible', Boolean(message));
    if (announce && message) this.dom.description.textContent = `${this.dom.description.textContent} ${message}.`;
    if (message) {
      this.statusTimer = window.setTimeout(() => this.dom.status.classList.remove('is-visible'), duration);
    }
  }

  showDepth(logZoom) {
    window.clearTimeout(this.depthTimer);
    const direction = logZoom >= 0 ? 'within' : 'without';
    this.dom.depth.textContent = `${direction} · 2^${Math.abs(logZoom).toFixed(Math.abs(logZoom) > 99 ? 0 : 1)}`;
    this.dom.depth.classList.add('is-visible');
    this.depthTimer = window.setTimeout(() => this.dom.depth.classList.remove('is-visible'), 1200);
  }

  toggleHelp(force) {
    const shouldOpen = force ?? this.dom.guide.hidden;
    this.dom.guide.hidden = !shouldOpen;
    if (shouldOpen) {
      this.dom.input.blur();
      this.dom.closeHelp.focus({ preventScroll: true });
    }
  }

  togglePause() {
    if (!this.renderer) return;
    const paused = this.renderer.togglePaused();
    this.dom.pause.textContent = paused ? 'Resume motion' : 'Pause motion';
    this.showStatus(paused ? 'the current is held' : 'the current breathes again', 1600);
  }

  resetView() {
    this.renderer?.resetView();
    this.showStatus('returned to the eclipse', 1500);
  }

  newSeed() {
    if (!this.renderer) return;
    this.stopScreensaver();
    this.invalidatePreview();
    this.revision += 1;
    this.rootSeed = null;
    this.specimenId = '';
    this.mutations = [];
    this.historyIndex = 0;
    this.committedScene = null;
    const dormant = deriveScene('the unspoken noema', 'sleeping neural eclipse', fallbackEmbedding('sleeping neural eclipse'), 0);
    this.renderer.setDormant(dormant);
    this.renderer.clearTrails();
    this.renderer.resetView();
    document.body.classList.remove('is-awake');
    this.dom.invitation.textContent = 'give the void a phrase';
    this.dom.description.textContent = 'A dormant black eclipse and a faint neural field await a seed phrase.';
    this.updateSessionFragment();
    this.dom.input.value = '';
    this.dom.threshold.classList.remove('has-text');
    document.body.classList.remove('is-typing');
    this.dom.input.focus({ preventScroll: true });
  }

  async copyLink() {
    if (!this.rootSeed) return;
    try {
      const livingUrl = location.protocol === 'file:'
        ? new URL(location.hash, CANONICAL_WEB_URL).href
        : location.href;
      await navigator.clipboard.writeText(livingUrl);
      this.showStatus('living link copied', 1500);
    } catch {
      this.showStatus('the browser would not release the link', 2000);
    }
  }

  invalidatePreview() {
    window.clearTimeout(this.previewTimer);
    this.previewTimer = 0;
    this.previewToken += 1;
  }

  exportStill() {
    if (!this.renderer?.canvas) return;
    this.renderer.composite();
    this.renderer.gl.finish();
    this.renderer.canvas.toBlob((blob) => {
      if (!blob) {
        this.showStatus('the still could not leave the field', 2000);
        return;
      }
      const anchor = document.createElement('a');
      const id = hashString(`${this.rootSeed || 'unspoken'}\u241d${this.specimenId}`).toString(16).padStart(8, '0');
      anchor.download = `noema-${id}.png`;
      anchor.href = URL.createObjectURL(blob);
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
      this.showStatus('still released', 1500);
    }, 'image/png');
  }

  onKeyDown(event) {
    const modifier = event.metaKey || event.ctrlKey;
    const isInput = event.target === this.dom.input;

    if (event.key === 'F1') {
      event.preventDefault();
      this.toggleHelp();
      return;
    }

    if (event.key === 'Escape' && !isInput) {
      event.preventDefault();
      if (!this.dom.guide.hidden) this.toggleHelp(false);
      else this.togglePause();
      return;
    }

    if (modifier && event.key.toLocaleLowerCase() === 'z' && (!isInput || !this.dom.input.value)) {
      event.preventDefault();
      if (event.shiftKey) this.redo();
      else this.undo();
      return;
    }

    if (modifier && event.key === '0') {
      event.preventDefault();
      this.resetView();
      return;
    }

    if (modifier && event.key.toLocaleLowerCase() === 'n') {
      event.preventDefault();
      this.newSeed();
      return;
    }

    if (modifier && event.shiftKey && event.key.toLocaleLowerCase() === 's') {
      event.preventDefault();
      this.exportStill();
      return;
    }

    if (isInput || event.altKey || modifier) return;

    if (event.key === 'PageUp' || event.key === 'PageDown') {
      event.preventDefault();
      this.renderer?.zoomBy(event.key === 'PageUp' ? 0.72 : -0.72, 0.5, 0.5);
      this.onGesture('zoom');
      return;
    }

    if (event.key === 'Home') {
      event.preventDefault();
      this.resetView();
      return;
    }

    if (event.shiftKey && event.key.startsWith('Arrow')) {
      event.preventDefault();
      if (event.key === 'ArrowLeft') this.renderer?.shiftPhase(-0.18);
      if (event.key === 'ArrowRight') this.renderer?.shiftPhase(0.18);
      if (event.key === 'ArrowUp') this.renderer?.shiftPhase(0, 0.12);
      if (event.key === 'ArrowDown') this.renderer?.shiftPhase(0, -0.12);
      this.onGesture('phase');
      return;
    }

    if (event.key.length === 1 && !event.repeat) {
      event.preventDefault();
      this.dom.input.focus({ preventScroll: true });
      this.dom.input.value += event.key;
      this.dom.input.dispatchEvent(new InputEvent('input', { data: event.key, inputType: 'insertText', bubbles: true }));
    }
  }

  renderError(error) {
    if (this.hasRenderedError) return;
    this.hasRenderedError = true;
    if (import.meta.env.DEV) window.__noemaLastError = error?.stack || error?.message || String(error);
    console.error(error);
    this.dom.invitation.textContent = 'this machine could not open a WebGL2 dream';
    this.dom.status.textContent = 'hardware acceleration or WebGL2 may be unavailable';
    this.dom.status.classList.add('is-visible');
    this.dom.input.disabled = true;
  }
}

const noema = new Noema();
if (import.meta.env.DEV) {
  Object.defineProperty(window, '__noemaDev', {
    configurable: true,
    enumerable: false,
    value: noema,
  });
}
