import { mkdir, writeFile } from 'node:fs/promises';

const port = Number(process.argv[2] || 9333);
const outputDirectory = process.argv[3] || '/private/tmp/noema-zoom-sequence';
const rawPhrase = process.argv.slice(4).join(' ') || 'black hole eclipse remembers violet thunder';
const phrase = rawPhrase.replace(/\s+/gu, ' ').trim();

function captureAnchorFromEnvironment(name) {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue === '') return 0.5;
  const value = Number(rawValue);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number between 0 and 1.`);
  return Math.min(1, Math.max(0, value));
}

const captureAnchor = {
  x: captureAnchorFromEnvironment('NOEMA_CAPTURE_ANCHOR_X'),
  y: captureAnchorFromEnvironment('NOEMA_CAPTURE_ANCHOR_Y'),
};
const depthStops = [
  ...[0, 2.6, 2.9, 3, 7, 12, 20].map((targetDepth) => ({ leg: 'zoom-in', targetDepth })),
  ...[12, 7, 3, 0].map((targetDepth) => ({ leg: 'return-to-zero', targetDepth })),
  ...[-2.6, -2.9, -3, -7, -12, -20].map((targetDepth) => ({ leg: 'zoom-out', targetDepth })),
];
await mkdir(outputDirectory, { recursive: true });

const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
const page = pages.find((candidate) => candidate.type === 'page');
if (!page) throw new Error('No Electron renderer page was exposed.');

const socket = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
const diagnostics = [];
const contamination = [];
let sequence = 0;

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
    return;
  }
  if (message.method === 'Runtime.exceptionThrown') diagnostics.push(message.params.exceptionDetails);
  if (message.method === 'Log.entryAdded' && ['error', 'warning'].includes(message.params.entry.level)) diagnostics.push(message.params.entry);
});

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

function call(method, params = {}) {
  const id = ++sequence;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression, awaitPromise = false) {
  const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

const frames = [];
let baseline = null;
let interactionGuard = null;
let guardRelease = null;
let captureLockInstalled = false;
let expectedSessionHash = '';
let expectedSpecimenId = '';

function inspectStability(state) {
  const issues = [];
  if (!state || typeof state !== 'object') {
    issues.push('capture guard returned no state');
  } else {
    if (!state.locked) issues.push('capture-phase interaction lock is not active');
    if (state.expectedPhrase !== phrase) issues.push('capture guard expected phrase changed');
    if (state.sessionHash !== expectedSessionHash) issues.push('session fragment changed');
    if (state.specimenId !== expectedSpecimenId) issues.push('specimen ID changed');
    if (state.sessionVersion === 2 && !state.specimenId) issues.push('v2 session has no specimen ID');
    if (state.rootSeed !== phrase) issues.push(`root seed changed to ${JSON.stringify(state.rootSeed)}`);
    if (state.committedPhrase !== phrase) {
      issues.push(`committed phrase changed to ${JSON.stringify(state.committedPhrase)}`);
    }
    if (!Array.isArray(state.mutations) || state.mutations.length !== 0) {
      issues.push('mutation history changed');
    }
    if (state.inputValue !== '') issues.push('uncommitted text appeared in the phrase input');
    if (!state.awake) issues.push('renderer returned to its dormant state');
  }

  return {
    stable: issues.length === 0,
    expectedPhrase: phrase,
    rootSeed: state?.rootSeed ?? null,
    committedPhrase: state?.committedPhrase ?? null,
    specimenId: state?.specimenId ?? null,
    specimenIdStable: state?.specimenId === expectedSpecimenId,
    sessionHashStable: state?.sessionHash === expectedSessionHash,
    inputEmpty: state?.inputValue === '',
    issues,
  };
}

function depthSlug(depth) {
  const magnitude = String(Math.abs(depth)).replace('.', '_');
  return depth < 0 ? `minus-${magnitude}` : magnitude;
}

function expectedDepthLabel(depth) {
  const direction = depth >= 0 ? 'within' : 'without';
  const precision = Math.abs(depth) > 99 ? 0 : 1;
  return `${direction} · 2^${Math.abs(depth).toFixed(precision)}`;
}

try {
  await call('Runtime.enable');
  await call('Log.enable');
  await call('Page.enable');
  await evaluate(`history.replaceState(null, '', location.pathname); location.reload();`);
  await new Promise((resolve) => setTimeout(resolve, 2200));

  const committedState = await evaluate(`(() => {
    const expectedPhrase = ${JSON.stringify(phrase)};
    const input = document.querySelector('#phrase-input');
    input.value = expectedPhrase;
    input.dispatchEvent(new InputEvent('input', {
      data: expectedPhrase.at(-1) || '',
      inputType: 'insertText',
      bubbles: true,
    }));
    document.querySelector('#phrase-form').requestSubmit();

    const expectedHash = location.hash;
    const authorizedEvents = new WeakSet();
    const attempts = Object.create(null);
    const samples = [];
    const eventTypes = [
      'pointerdown', 'pointermove', 'pointerup', 'pointercancel',
      'mousedown', 'mousemove', 'mouseup', 'touchstart', 'touchmove', 'touchend', 'touchcancel',
      'wheel', 'click', 'dblclick', 'auxclick', 'contextmenu',
      'keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'change',
      'compositionstart', 'compositionupdate', 'compositionend', 'paste', 'cut', 'drop', 'dragstart',
      'submit',
    ];
    let active = true;

    function decodeSession(fragment) {
      try {
        const source = String(fragment)
          .replace(/^#(?:s=)?/u, '')
          .replaceAll('-', '+')
          .replaceAll('_', '/');
        if (!source) return null;
        const padded = source.padEnd(Math.ceil(source.length / 4) * 4, '=');
        const binary = atob(padded);
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        const parsed = JSON.parse(new TextDecoder().decode(bytes));
        if (!Array.isArray(parsed) || !parsed.length) return null;

        if (parsed[0] === 2) {
          const [, specimenId, rootSeed, ...mutations] = parsed;
          if (
            typeof specimenId !== 'string'
            || typeof rootSeed !== 'string'
            || mutations.some((item) => typeof item !== 'string')
          ) {
            return null;
          }
          return {
            version: 2,
            rootSeed: rootSeed.slice(0, 280),
            specimenId: specimenId.slice(0, 96),
            mutations: mutations.slice(0, 63).map((item) => item.slice(0, 280)),
          };
        }

        if (parsed.some((item) => typeof item !== 'string')) return null;
        return {
          version: 1,
          rootSeed: parsed[0].slice(0, 280),
          specimenId: '',
          mutations: parsed.slice(1, 64).map((item) => item.slice(0, 280)),
        };
      } catch {
        return null;
      }
    }

    function blockInteraction(event) {
      if (!active || authorizedEvents.has(event)) return;
      attempts[event.type] = (attempts[event.type] || 0) + 1;
      if (samples.length < 24) {
        samples.push({
          type: event.type,
          key: typeof event.key === 'string' ? event.key : '',
          target: event.target?.id || event.target?.nodeName || '',
          trusted: event.isTrusted,
          atMs: performance.now(),
        });
      }
      if (event.cancelable) event.preventDefault();
      event.stopImmediatePropagation();
    }

    for (const type of eventTypes) {
      window.addEventListener(type, blockInteraction, { capture: true, passive: false });
    }

    function inspect() {
      const session = decodeSession(location.hash);
      const mutations = session?.mutations ?? null;
      return {
        locked: active,
        expectedPhrase,
        expectedHash,
        sessionHash: location.hash,
        sessionVersion: session?.version ?? null,
        rootSeed: session?.rootSeed ?? null,
        specimenId: session?.specimenId ?? null,
        mutations,
        committedPhrase: session
          ? (mutations.length ? mutations[mutations.length - 1] : session.rootSeed)
          : null,
        inputValue: document.querySelector('#phrase-input')?.value ?? null,
        awake: document.body.classList.contains('is-awake'),
        interactionAttempts: { ...attempts },
        interactionSamples: samples.slice(),
      };
    }

    async function zoomBy(change) {
      if (!active) throw new Error('The capture interaction lock has been released.');
      const canvas = document.querySelector('#stage canvas');
      if (!canvas) throw new Error('No renderer canvas is available for the zoom sequence.');
      const bounds = canvas.getBoundingClientRect();
      const direction = Math.sign(change);
      let remaining = Math.abs(change);
      let dispatchCount = 0;

      do {
        // Pace the synthetic gesture across rendered frames. Dispatching an entire
        // 2^20 move in one JavaScript task measures a camera cut, not the wheel or
        // trackpad interaction a person actually experiences.
        const step = Math.min(0.5, remaining);
        const event = new WheelEvent('wheel', {
          deltaY: direction === 0 ? 0 : -direction * step / 0.0024,
          clientX: bounds.left + bounds.width * ${JSON.stringify(captureAnchor.x)},
          clientY: bounds.top + bounds.height * ${JSON.stringify(captureAnchor.y)},
          bubbles: true,
          cancelable: true,
        });
        authorizedEvents.add(event);
        canvas.dispatchEvent(event);
        dispatchCount += 1;
        remaining -= step;
        await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      } while (remaining > 0.0001);

      return {
        change,
        dispatchCount,
        depthLabel: document.querySelector('#depth-readout')?.textContent ?? '',
      };
    }

    function release() {
      if (active) {
        active = false;
        for (const type of eventTypes) window.removeEventListener(type, blockInteraction, true);
      }
      return inspect();
    }

    const guard = Object.freeze({ inspect, release, zoomBy });
    Object.defineProperty(window, '__noemaCdpCaptureGuard', {
      configurable: true,
      enumerable: false,
      writable: false,
      value: guard,
    });
    return inspect();
  })()`);

  captureLockInstalled = Boolean(committedState?.locked);
  expectedSessionHash = committedState?.expectedHash || '';
  expectedSpecimenId = committedState?.specimenId || '';
  const baselineStability = inspectStability(committedState);
  baseline = { state: committedState, stability: baselineStability };
  if (!baselineStability.stable) {
    contamination.push({ stage: 'post-commit', issues: baselineStability.issues });
  }

  await new Promise((resolve) => setTimeout(resolve, 5200));

  let previousDepth = 0;
  for (let index = 0; index < depthStops.length; index += 1) {
    const { leg, targetDepth } = depthStops[index];
    const change = targetDepth - previousDepth;
    const zoomDispatch = await evaluate(
      `window.__noemaCdpCaptureGuard.zoomBy(${JSON.stringify(change)})`,
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, change === 0 ? 180 : 1400));

    const timing = await evaluate(`new Promise((resolve) => {
      const samples = [];
      let previous = performance.now();
      function frame(now) {
        samples.push(now - previous);
        previous = now;
        if (samples.length < 36) requestAnimationFrame(frame);
        else {
          samples.shift();
          samples.sort((a, b) => a - b);
          resolve({
            averageMs: samples.reduce((sum, value) => sum + value, 0) / samples.length,
            p95Ms: samples[Math.floor(samples.length * 0.95)],
          });
        }
      }
      requestAnimationFrame(frame);
    })`, true);
    const inspection = await evaluate(`(() => ({
      depthLabel: document.querySelector('#depth-readout').textContent,
      canvasCount: document.querySelectorAll('#stage canvas').length,
      status: document.querySelector('#status').textContent,
      renderer: window.__noemaDev?.renderer ? {
        logZoom: window.__noemaDev.renderer.logZoom,
        cameraOffset: Array.from(window.__noemaDev.renderer.cameraOffset),
        focus: Array.from(window.__noemaDev.renderer.focus),
        trailZoom: window.__noemaDev.renderer.trailZoom,
        trailOffset: Array.from(window.__noemaDev.renderer.trailOffset),
        zoomFreshness: window.__noemaDev.renderer.zoomFreshness,
        elapsed: window.__noemaDev.renderer.elapsed,
        family: window.__noemaDev.renderer.scene?.familyName ?? null,
      } : null,
      captureState: window.__noemaCdpCaptureGuard?.inspect() ?? null,
    }))()`);
    const stability = inspectStability(inspection.captureState);
    const targetDepthLabel = expectedDepthLabel(targetDepth);
    stability.depthLabelStable = inspection.depthLabel === targetDepthLabel;
    if (!stability.depthLabelStable) {
      stability.stable = false;
      stability.issues.push(
        `depth label was ${JSON.stringify(inspection.depthLabel)}; expected ${JSON.stringify(targetDepthLabel)}`,
      );
    }
    if (!stability.stable) {
      contamination.push({
        stage: `frame-${String(index).padStart(2, '0')}`,
        leg,
        targetDepth,
        issues: stability.issues,
      });
    }

    const capture = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const name = [
      'frame',
      String(index).padStart(2, '0'),
      leg,
      `depth-${depthSlug(targetDepth)}.png`,
    ].join('-');
    await writeFile(`${outputDirectory}/${name}`, Buffer.from(capture.data, 'base64'));
    frames.push({
      index,
      leg,
      targetDepth,
      change,
      name,
      zoomDispatch,
      timing,
      inspection: {
        depthLabel: inspection.depthLabel,
        canvasCount: inspection.canvasCount,
        status: inspection.status,
        renderer: inspection.renderer,
        interactionAttempts: inspection.captureState?.interactionAttempts ?? null,
      },
      stability,
    });
    previousDepth = targetDepth;
  }

  interactionGuard = await evaluate('window.__noemaCdpCaptureGuard?.inspect() ?? null');
} finally {
  if (captureLockInstalled) {
    try {
      guardRelease = await evaluate('window.__noemaCdpCaptureGuard?.release() ?? null');
    } catch (error) {
      diagnostics.push({ source: 'capture-guard-release', text: error.message });
    }
  }
  socket.close();
}

console.log(JSON.stringify({
  phrase,
  captureAnchor,
  depthPlan: depthStops,
  baseline,
  frames,
  interactionGuard,
  guardRelease,
  contamination,
  diagnostics,
  outputDirectory,
}, null, 2));
if (diagnostics.length || contamination.length) process.exitCode = 1;
