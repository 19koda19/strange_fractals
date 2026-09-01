import { mkdir, writeFile } from 'node:fs/promises';

const port = Number(process.argv[2] || 9333);
const outputDirectory = process.argv[3] || 'qa-captures/fast-corner';
const phrase = (process.argv.slice(4).join(' ') || 'fast corner follows a violet recursive fiber')
  .replace(/\s+/gu, ' ')
  .trim();
const specimenId = 'qa-fast-corner-v2-4c918b27';
const sessionFragment = Buffer.from(JSON.stringify([2, specimenId, phrase]), 'utf8').toString('base64url');
const expectedHash = `#s=${sessionFragment}`;
const expectedBandOctaves = -Math.log2(0.18);
const boundaryOffset = 0.05;
const anchor = Object.freeze({ x: 0.78, y: 0.28 });

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
  if (message.method === 'Runtime.exceptionThrown') {
    diagnostics.push({ type: 'exception', details: message.params.exceptionDetails });
  }
  if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
    diagnostics.push({ type: 'log', details: message.params.entry });
  }
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
  const response = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
  return response.result.value;
}

function positiveModulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function depthSlug(depth) {
  const magnitude = Math.abs(depth).toFixed(4).replace('.', '_');
  return depth < 0 ? `minus-${magnitude}` : magnitude;
}

function viewSnapshot(renderer) {
  return [...(renderer?.focus || []), ...(renderer?.cameraOffset || [])];
}

function maximumViewDelta(left, right) {
  if (left.length !== 4 || right.length !== 4) return Infinity;
  return Math.max(...left.map((value, index) => Math.abs(value - right[index])));
}

function makeDepthPlan(bandOctaves) {
  return [
    { leg: 'baseline', targetDepth: 0 },
    { leg: 'positive-in', targetDepth: bandOctaves * 0.5 },
    { leg: 'positive-in', targetDepth: bandOctaves + boundaryOffset },
    { leg: 'positive-in', targetDepth: bandOctaves * 2 + boundaryOffset },
    { leg: 'positive-in', targetDepth: bandOctaves * 3 + boundaryOffset },
    { leg: 'positive-return', targetDepth: bandOctaves * 2 + boundaryOffset },
    { leg: 'positive-return', targetDepth: bandOctaves + boundaryOffset },
    { leg: 'positive-round-trip', targetDepth: 0 },
    { leg: 'negative-out', targetDepth: bandOctaves * -0.5 },
    { leg: 'negative-out', targetDepth: -bandOctaves - boundaryOffset },
    { leg: 'negative-out', targetDepth: -bandOctaves * 2 - boundaryOffset },
    { leg: 'negative-out', targetDepth: -bandOctaves * 3 - boundaryOffset },
    { leg: 'negative-return', targetDepth: -bandOctaves * 2 - boundaryOffset },
    { leg: 'negative-return', targetDepth: -bandOctaves - boundaryOffset },
    { leg: 'negative-return', targetDepth: -bandOctaves * 0.5 },
    { leg: 'negative-round-trip', targetDepth: 0 },
  ].map((stop) => ({
    ...stop,
    expectedEpoch: Math.floor(stop.targetDepth / bandOctaves),
  }));
}

function updateExpectedHistory(keys, previousEpoch, nextEpoch) {
  if (nextEpoch > previousEpoch) {
    for (let epoch = previousEpoch; epoch < nextEpoch; epoch += 1) keys.add(epoch);
  } else {
    for (let epoch = previousEpoch; epoch > nextEpoch; epoch -= 1) keys.delete(epoch - 1);
  }
}

function inspectFixture(state) {
  const issues = [];
  if (!state || typeof state !== 'object') return ['capture guard returned no state'];
  if (!state.locked) issues.push('capture-phase interaction lock is not active');
  if (state.hash !== expectedHash) issues.push('deterministic session fragment changed');
  if (state.rootSeed !== phrase) issues.push(`root seed changed to ${JSON.stringify(state.rootSeed)}`);
  if (state.specimenId !== specimenId) issues.push(`specimen ID changed to ${JSON.stringify(state.specimenId)}`);
  if (!Array.isArray(state.mutations) || state.mutations.length !== 0) issues.push('mutation history changed');
  if (state.inputValue !== '') issues.push('uncommitted text appeared in the phrase input');
  if (!state.awake) issues.push('renderer returned to its dormant state');
  if (Object.values(state.interactionAttempts || {}).some((count) => count > 0)) {
    issues.push('outside interaction was blocked during the capture');
  }
  return issues;
}

function inspectRendererState(renderer, stop, expectedHistoryKeys, bandOctaves) {
  const issues = [];
  if (!renderer || typeof renderer !== 'object') return ['renderer telemetry is unavailable'];
  if (!Number.isFinite(renderer.logZoom)) issues.push('log zoom is not finite');
  if (Math.abs(renderer.logZoom - stop.targetDepth) > 0.001) {
    issues.push(`renderer missed target depth by ${Math.abs(renderer.logZoom - stop.targetDepth)}`);
  }
  if (!Number.isFinite(renderer.bandOctaves) || Math.abs(renderer.bandOctaves - bandOctaves) > 1e-9) {
    issues.push('zoom band size changed during capture');
  }
  if (renderer.zoomEpoch !== stop.expectedEpoch) {
    issues.push(`zoom epoch was ${renderer.zoomEpoch}; expected ${stop.expectedEpoch}`);
  }
  const expectedBranch = positiveModulo(stop.expectedEpoch, 3);
  if (renderer.activeBranch !== expectedBranch) {
    issues.push(`active branch was ${renderer.activeBranch}; expected ${expectedBranch}`);
  }
  if (!Number.isInteger(renderer.portalBranch) || renderer.portalBranch < 0 || renderer.portalBranch > 2) {
    issues.push(`portal branch was invalid: ${JSON.stringify(renderer.portalBranch)}`);
  }

  const expectedKeys = [...expectedHistoryKeys].sort((left, right) => left - right);
  const navigation = Array.isArray(renderer.navigationChoices) ? renderer.navigationChoices : [];
  const history = Array.isArray(renderer.focusHistory) ? renderer.focusHistory : [];
  const navigationKeys = navigation.map(([epoch]) => epoch).sort((left, right) => left - right);
  const historyKeys = history.map(([epoch]) => epoch).sort((left, right) => left - right);
  if (JSON.stringify(navigationKeys) !== JSON.stringify(expectedKeys)) {
    issues.push(`navigation keys were ${JSON.stringify(navigationKeys)}; expected ${JSON.stringify(expectedKeys)}`);
  }
  if (JSON.stringify(historyKeys) !== JSON.stringify(expectedKeys)) {
    issues.push(`focus-history keys were ${JSON.stringify(historyKeys)}; expected ${JSON.stringify(expectedKeys)}`);
  }
  for (const [epoch, choice] of navigation) {
    const [branch, anchorX, anchorY] = Array.isArray(choice) ? choice : [];
    if (!Number.isInteger(branch) || branch < 0 || branch > 2) {
      issues.push(`navigation choice ${epoch} had invalid portal branch ${JSON.stringify(branch)}`);
    }
    if (![anchorX, anchorY].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) {
      issues.push(`navigation choice ${epoch} had invalid entry anchor ${JSON.stringify([anchorX, anchorY])}`);
    }
  }
  for (const [epoch, focus] of history) {
    if (!Number.isInteger(epoch) || !Array.isArray(focus) || !focus.every(Number.isFinite)) {
      issues.push(`focus-history entry ${JSON.stringify([epoch, focus])} is invalid`);
    }
  }
  for (const [label, values] of [
    ['focus', renderer.focus],
    ['camera offset', renderer.cameraOffset],
    ['trail offset', renderer.trailOffset],
  ]) {
    if (!Array.isArray(values) || !values.every(Number.isFinite)) issues.push(`${label} is not finite`);
  }
  if (!Number.isFinite(renderer.trailZoom)) issues.push('trail zoom is not finite');
  if (renderer.error) issues.push(`renderer reported ${renderer.error}`);
  return issues;
}

const frames = [];
let baseline = null;
let rendererConfiguration = null;
let depthPlan = [];
let floatingRoundTrip = null;
let finalGuard = null;
let finalReset = null;
let guardRelease = null;
let captureLockInstalled = false;

try {
  await call('Runtime.enable');
  await call('Log.enable');
  await call('Page.enable');

  const captureUrl = new URL(page.url);
  captureUrl.hash = expectedHash;
  await call('Page.navigate', { url: captureUrl.href });
  await new Promise((resolve) => setTimeout(resolve, 2600));

  baseline = await evaluate(`(() => {
    window.__noemaDev?.renderer?.resetView();
    const expectedPhrase = ${JSON.stringify(phrase)};
    const expectedSpecimenId = ${JSON.stringify(specimenId)};
    const expectedHash = ${JSON.stringify(expectedHash)};
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
        const padded = source.padEnd(Math.ceil(source.length / 4) * 4, '=');
        const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
        const parsed = JSON.parse(new TextDecoder().decode(bytes));
        if (!Array.isArray(parsed) || parsed[0] !== 2) return null;
        const [, parsedSpecimenId, rootSeed, ...mutations] = parsed;
        return { specimenId: parsedSpecimenId, rootSeed, mutations };
      } catch {
        return null;
      }
    }

    function blockInteraction(event) {
      if (!active) return;
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
      return {
        locked: active,
        expectedPhrase,
        expectedSpecimenId,
        expectedHash,
        hash: location.hash,
        rootSeed: session?.rootSeed ?? null,
        specimenId: session?.specimenId ?? null,
        mutations: session?.mutations ?? null,
        inputValue: document.querySelector('#phrase-input')?.value ?? null,
        awake: document.body.classList.contains('is-awake'),
        interactionAttempts: { ...attempts },
        interactionSamples: samples.slice(),
      };
    }

    async function zoomTo(targetDepth, anchorX, anchorY) {
      if (!active) throw new Error('The capture interaction lock has been released.');
      const renderer = window.__noemaDev?.renderer;
      if (!renderer) throw new Error('No development renderer is available for fast-corner capture.');
      let remaining = targetDepth - renderer.logZoom;
      let dispatchCount = 0;
      while (Math.abs(remaining) > 0.00001) {
        const change = Math.sign(remaining) * Math.min(1.25, Math.abs(remaining));
        renderer.zoomBy(change, anchorX, anchorY);
        dispatchCount += 1;
        await new Promise((resolve) => requestAnimationFrame(() => resolve()));
        remaining = targetDepth - renderer.logZoom;
        if (dispatchCount > 1000) throw new Error('Fast-corner zoom failed to converge.');
      }
      return { targetDepth, actualDepth: renderer.logZoom, dispatchCount };
    }

    function reset() {
      const renderer = window.__noemaDev?.renderer;
      if (!renderer) return null;
      renderer.resetView();
      return {
        logZoom: renderer.logZoom,
        activeBranch: renderer.activeBranch,
        portalBranch: renderer.portalBranch,
        navigationChoices: Array.from(renderer.navigationChoices.entries()),
        focusHistory: Array.from(renderer.focusHistory.entries()),
        portalBandViews: Array.from(renderer.portalBandViews.entries()),
        outwardParentViews: Array.from(renderer.outwardParentViews.entries()),
        cameraOffset: Array.from(renderer.cameraOffset),
        focus: Array.from(renderer.focus),
        error: window.__noemaLastError ?? null,
      };
    }

    function release() {
      if (active) {
        active = false;
        for (const type of eventTypes) window.removeEventListener(type, blockInteraction, true);
      }
      return inspect();
    }

    Object.defineProperty(window, '__noemaFastCornerGuard', {
      configurable: true,
      enumerable: false,
      writable: false,
      value: Object.freeze({ inspect, zoomTo, reset, release }),
    });
    return inspect();
  })()`);
  captureLockInstalled = Boolean(baseline?.locked);
  const baselineIssues = inspectFixture(baseline);
  if (baselineIssues.length) contamination.push({ stage: 'baseline', issues: baselineIssues });

  await new Promise((resolve) => setTimeout(resolve, 5200));
  rendererConfiguration = await evaluate(`(() => {
    const renderer = window.__noemaDev?.renderer;
    return renderer ? {
      bandOctaves: renderer.zoomBandOctaves,
      nestingRatio: renderer.nestingRatio,
      particleCount: renderer.particleCount,
      family: renderer.scene?.familyName ?? null,
      error: window.__noemaLastError ?? null,
    } : null;
  })()`);
  if (!rendererConfiguration) {
    diagnostics.push({ type: 'configuration', details: 'renderer telemetry is unavailable' });
  } else if (Math.abs(rendererConfiguration.bandOctaves - expectedBandOctaves) > 1e-9) {
    diagnostics.push({
      type: 'configuration',
      details: `zoom band was ${rendererConfiguration.bandOctaves}; expected ${expectedBandOctaves}`,
    });
  }
  if (rendererConfiguration?.error) diagnostics.push({ type: 'renderer', details: rendererConfiguration.error });

  const bandOctaves = rendererConfiguration?.bandOctaves ?? expectedBandOctaves;
  depthPlan = makeDepthPlan(bandOctaves);
  const expectedHistoryKeys = new Set();
  const firstViewsAtDepth = new Map();
  let expectedEpoch = 0;

  for (let index = 0; index < depthPlan.length; index += 1) {
    const stop = depthPlan[index];
    updateExpectedHistory(expectedHistoryKeys, expectedEpoch, stop.expectedEpoch);
    expectedEpoch = stop.expectedEpoch;
    const zoomDispatch = await evaluate(
      `window.__noemaFastCornerGuard.zoomTo(${JSON.stringify(stop.targetDepth)}, ${anchor.x}, ${anchor.y})`,
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, stop.targetDepth === 0 ? 220 : 650));

    const inspection = await evaluate(`(() => {
      const renderer = window.__noemaDev?.renderer;
      const logZoom = renderer?.logZoom ?? null;
      const bandOctaves = renderer?.zoomBandOctaves ?? 1;
      const zoomPosition = renderer?.zoomPosition();
      return {
        canvasCount: document.querySelectorAll('#stage canvas').length,
        depthLabel: document.querySelector('#depth-readout')?.textContent ?? '',
        renderer: renderer ? {
          logZoom,
          zoomEpoch: zoomPosition.epoch,
          bandOctaves,
          focus: Array.from(renderer.focus),
          cameraOffset: Array.from(renderer.cameraOffset),
          activeBranch: renderer.activeBranch,
          portalBranch: renderer.portalBranch,
          navigationChoices: Array.from(renderer.navigationChoices.entries()),
          focusHistory: Array.from(renderer.focusHistory, ([epoch, focus]) => [epoch, Array.from(focus)]),
          portalBandViews: Array.from(renderer.portalBandViews, ([epoch, view]) => [epoch, Array.from(view)]),
          outwardParentViews: Array.from(renderer.outwardParentViews, ([epoch, view]) => [epoch, Array.from(view)]),
          trailZoom: renderer.trailZoom,
          trailOffset: Array.from(renderer.trailOffset),
          frameAverage: renderer.frameAverage,
          error: window.__noemaLastError ?? null,
        } : null,
        captureState: window.__noemaFastCornerGuard?.inspect() ?? null,
      };
    })()`);

    const issues = [
      ...inspectFixture(inspection.captureState),
      ...inspectRendererState(inspection.renderer, stop, expectedHistoryKeys, bandOctaves),
    ];
    if (inspection.canvasCount !== 1) issues.push(`expected one canvas; found ${inspection.canvasCount}`);
    if (stop.leg === 'positive-round-trip' && expectedHistoryKeys.size !== 0) {
      issues.push('positive round trip did not consume its expected navigation history');
    }
    const viewKey = stop.targetDepth.toFixed(6);
    const currentView = viewSnapshot(inspection.renderer);
    const firstView = firstViewsAtDepth.get(viewKey);
    if (firstView) {
      const viewDelta = maximumViewDelta(firstView, currentView);
      if (viewDelta > 0.00002) issues.push(`repeated depth ${stop.targetDepth} drifted by ${viewDelta}`);
    } else {
      firstViewsAtDepth.set(viewKey, currentView);
    }
    const stability = { stable: issues.length === 0, issues };
    if (!stability.stable) {
      contamination.push({
        stage: `frame-${String(index).padStart(2, '0')}`,
        leg: stop.leg,
        targetDepth: stop.targetDepth,
        issues,
      });
    }

    const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const name = [
      'frame',
      String(index).padStart(2, '0'),
      stop.leg,
      `depth-${depthSlug(stop.targetDepth)}.png`,
    ].join('-');
    await writeFile(`${outputDirectory}/${name}`, Buffer.from(screenshot.data, 'base64'));
    frames.push({ index, ...stop, name, zoomDispatch, inspection, stability });
  }

  floatingRoundTrip = await evaluate(`(() => {
    const renderer = window.__noemaDev?.renderer;
    if (!renderer) return null;
    renderer.resetView();
    for (let step = 0; step < 10; step += 1) renderer.zoomBy(-0.1, 0.5, 0.5);
    for (let step = 0; step < 10; step += 1) renderer.zoomBy(0.1, 0.5, 0.5);
    const position = renderer.zoomPosition();
    return {
      logZoom: renderer.logZoom,
      zoomEpoch: position.epoch,
      zoomPhase: position.phase,
      activeBranch: renderer.activeBranch,
      portalBranch: renderer.portalBranch,
      cameraOffset: Array.from(renderer.cameraOffset),
      focus: Array.from(renderer.focus),
      trailZoom: renderer.trailZoom,
      trailOffset: Array.from(renderer.trailOffset),
      navigationChoices: Array.from(renderer.navigationChoices.entries()),
      focusHistory: Array.from(renderer.focusHistory.entries()),
      outwardParentViews: Array.from(renderer.outwardParentViews.entries()),
      error: window.__noemaLastError ?? null,
    };
  })()`);
  const floatingIssues = [];
  if (!floatingRoundTrip) floatingIssues.push('renderer was unavailable for the floating-step round trip');
  if (floatingRoundTrip?.logZoom !== 0) floatingIssues.push(`floating-step depth ended at ${floatingRoundTrip.logZoom}`);
  if (floatingRoundTrip?.zoomEpoch !== 0 || floatingRoundTrip?.zoomPhase !== 0) {
    floatingIssues.push(`floating-step zoom position was epoch ${floatingRoundTrip?.zoomEpoch}, phase ${floatingRoundTrip?.zoomPhase}`);
  }
  if (!Array.isArray(floatingRoundTrip?.cameraOffset) || floatingRoundTrip.cameraOffset.length !== 2
    || !floatingRoundTrip.cameraOffset.every(Number.isFinite)) {
    floatingIssues.push(`floating-step camera was invalid: ${JSON.stringify(floatingRoundTrip?.cameraOffset)}`);
  } else if (floatingRoundTrip.cameraOffset.some((value) => Math.abs(value) > 0.000001)) {
    floatingIssues.push(`floating-step camera ended at ${JSON.stringify(floatingRoundTrip.cameraOffset)}`);
  }
  if (!Array.isArray(floatingRoundTrip?.focus) || floatingRoundTrip.focus.length !== 2
    || !floatingRoundTrip.focus.every(Number.isFinite)) {
    floatingIssues.push(`floating-step focus was invalid: ${JSON.stringify(floatingRoundTrip?.focus)}`);
  } else if (floatingRoundTrip.focus.some((value) => Math.abs(value) > 0.000001)) {
    floatingIssues.push(`floating-step focus ended at ${JSON.stringify(floatingRoundTrip.focus)}`);
  }
  if (!Array.isArray(floatingRoundTrip?.trailOffset) || floatingRoundTrip.trailOffset.length !== 2
    || !floatingRoundTrip.trailOffset.every(Number.isFinite)) {
    floatingIssues.push(`floating-step trail offset was invalid: ${JSON.stringify(floatingRoundTrip?.trailOffset)}`);
  } else if (floatingRoundTrip.trailOffset.some((value) => Math.abs(value) > 0.000001)) {
    floatingIssues.push(`floating-step trail offset ended at ${JSON.stringify(floatingRoundTrip.trailOffset)}`);
  }
  if (!Number.isFinite(floatingRoundTrip?.trailZoom) || Math.abs(floatingRoundTrip.trailZoom - 1) > 0.000001) {
    floatingIssues.push(`floating-step trail zoom ended at ${floatingRoundTrip?.trailZoom}`);
  }
  if (floatingRoundTrip?.activeBranch !== 0) floatingIssues.push(`floating-step active branch ended at ${floatingRoundTrip?.activeBranch}`);
  if (!Number.isInteger(floatingRoundTrip?.portalBranch)
    || floatingRoundTrip.portalBranch < 0 || floatingRoundTrip.portalBranch > 2) {
    floatingIssues.push(`floating-step portal branch was invalid: ${floatingRoundTrip?.portalBranch}`);
  }
  const floatingNavigationKeys = floatingRoundTrip?.navigationChoices?.map(([epoch]) => epoch);
  const floatingFocusKeys = floatingRoundTrip?.focusHistory?.map(([epoch]) => epoch);
  if (JSON.stringify(floatingNavigationKeys) !== '[-1]' || JSON.stringify(floatingFocusKeys) !== '[-1]') {
    floatingIssues.push(`floating-step breadcrumbs were ${JSON.stringify([floatingNavigationKeys, floatingFocusKeys])}`);
  }
  if (floatingRoundTrip?.outwardParentViews?.length) floatingIssues.push('floating-step return retained an outward parent view');
  if (floatingRoundTrip?.error) floatingIssues.push(`renderer reported ${floatingRoundTrip.error}`);
  if (floatingIssues.length) contamination.push({ stage: 'floating-step-round-trip', issues: floatingIssues });

  finalGuard = await evaluate('window.__noemaFastCornerGuard?.inspect() ?? null');
  finalReset = await evaluate('window.__noemaFastCornerGuard?.reset() ?? null');
  const resetIssues = [];
  if (!finalReset) resetIssues.push('renderer was unavailable for final reset');
  if (finalReset?.logZoom !== 0) resetIssues.push('final reset did not restore depth zero');
  if (finalReset?.activeBranch !== 0) resetIssues.push('final reset did not restore branch zero');
  if (finalReset?.portalBranch !== 0) resetIssues.push('final reset did not restore portal branch zero');
  if (finalReset?.navigationChoices?.length) resetIssues.push('final reset retained navigation choices');
  if (finalReset?.focusHistory?.length) resetIssues.push('final reset retained focus history');
  if (finalReset?.portalBandViews?.length) resetIssues.push('final reset retained portal band views');
  if (finalReset?.outwardParentViews?.length) resetIssues.push('final reset retained outward parent views');
  if (finalReset?.cameraOffset?.some((value) => Math.abs(value) > 0.000001)) {
    resetIssues.push('final reset did not restore the camera origin');
  }
  if (finalReset?.focus?.some((value) => Math.abs(value) > 0.000001)) {
    resetIssues.push('final reset did not restore zero focus');
  }
  if (finalReset?.error) resetIssues.push(`renderer reported ${finalReset.error}`);
  if (resetIssues.length) contamination.push({ stage: 'final-reset', issues: resetIssues });
} finally {
  if (captureLockInstalled) {
    try {
      guardRelease = await evaluate('window.__noemaFastCornerGuard?.release() ?? null');
    } catch (error) {
      diagnostics.push({ type: 'capture-guard-release', details: error.message });
    }
  }
  socket.close();
}

const summary = {
  phrase,
  specimenId,
  expectedHash,
  expectedBandOctaves,
  rendererConfiguration,
  boundaryOffset,
  anchor,
  depthPlan,
  baseline,
  frames,
  floatingRoundTrip,
  finalGuard,
  finalReset,
  guardRelease,
  contamination,
  diagnostics,
  outputDirectory,
};
await writeFile(`${outputDirectory}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
if (diagnostics.length || contamination.length) process.exitCode = 1;
