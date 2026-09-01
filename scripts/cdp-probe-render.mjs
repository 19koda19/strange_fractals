import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const port = Number(process.argv[2] || 9333);
const outputPath = process.argv[3] || '/private/tmp/noema-render-probe.png';
const ink = Number(process.argv[4] || 0.12);
const brain = Number(process.argv[5] || 0);
const depth = Number(process.argv[6] || 0);
const spine = Number(process.argv[7] || 9);
const phraseArguments = process.argv.slice(8);
const waveOption = phraseArguments.find((argument) => argument.startsWith('--wave='));
const neuralWave = Math.max(0, Number(waveOption?.slice('--wave='.length) || 0));
const phrase = phraseArguments
  .filter((argument) => argument !== waveOption)
  .join(' ')
  .replace(/\s+/gu, ' ')
  .trim();

await mkdir(dirname(outputPath), { recursive: true });
const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
const page = pages.find((candidate) => candidate.type === 'page');
if (!page) throw new Error('No Electron renderer page was exposed.');

const socket = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let sequence = 0;

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const { resolve, reject } = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) reject(new Error(message.error.message));
  else resolve(message.result);
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

await call('Runtime.enable');
await call('Page.enable');
if (phrase) {
  const specimenId = 'qa-octave-boundary-v1-7f23c81a';
  const fragment = Buffer.from(JSON.stringify([2, specimenId, phrase]), 'utf8').toString('base64url');
  const captureUrl = new URL(page.url);
  captureUrl.hash = `#s=${fragment}`;
  await call('Page.navigate', { url: captureUrl.href });
  await new Promise((resolve) => setTimeout(resolve, 2600));
}
const original = await evaluate(`(() => {
  const renderer = window.__noemaDev.renderer;
  const state = {
    ink: renderer.filamentInk,
    spineInk: renderer.spineInk,
    sceneBrain: renderer.scene.brainCoupling,
    targetBrain: renderer.targetScene.brainCoupling,
    neuralWaveAge: renderer.neuralWaveAge,
    neuralWaveStrength: renderer.neuralWaveStrength,
  };
  renderer.resetView();
  renderer.filamentInk = ${JSON.stringify(ink)};
  renderer.spineInk = ${JSON.stringify(spine)};
  renderer.scene.brainCoupling = ${JSON.stringify(brain)};
  renderer.targetScene.brainCoupling = ${JSON.stringify(brain)};
  renderer.neuralWaveStrength = 0;
  renderer.clearTrails();
  return state;
})()`);

await evaluate(`(async () => {
  const renderer = window.__noemaDev.renderer;
  while (Math.abs(renderer.logZoom - ${JSON.stringify(depth)}) > 0.00001) {
    const remaining = ${JSON.stringify(depth)} - renderer.logZoom;
    renderer.zoomBy(Math.sign(remaining) * Math.min(0.2, Math.abs(remaining)), 0.5, 0.5);
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  return true;
})()`, true);
await new Promise((resolve) => setTimeout(resolve, 1100));

if (neuralWave > 0) {
  await evaluate(`(() => {
    const renderer = window.__noemaDev.renderer;
    renderer.neuralWaveAge = 0.34;
    renderer.neuralWaveStrength = ${JSON.stringify(neuralWave)};
    renderer.brainPulse = Math.max(renderer.brainPulse, ${JSON.stringify(neuralWave)});
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 90));
}

const telemetry = await evaluate(`(() => {
  const renderer = window.__noemaDev.renderer;
  return {
    family: renderer.scene.familyName,
    particleCount: renderer.particleCount,
    ink: renderer.filamentInk,
    spineInk: renderer.spineInk,
    brain: renderer.scene.brainCoupling,
    neuralWaveAge: renderer.neuralWaveAge,
    neuralWaveStrength: renderer.neuralWaveStrength,
    depth: renderer.logZoom,
    frameAverage: renderer.frameAverage,
    error: window.__noemaLastError ?? null,
  };
})()`);
const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
await writeFile(outputPath, Buffer.from(screenshot.data, 'base64'));

await evaluate(`(() => {
  const renderer = window.__noemaDev.renderer;
  renderer.filamentInk = ${JSON.stringify(original.ink)};
  renderer.spineInk = ${JSON.stringify(original.spineInk)};
  renderer.scene.brainCoupling = ${JSON.stringify(original.sceneBrain)};
  renderer.targetScene.brainCoupling = ${JSON.stringify(original.targetBrain)};
  renderer.neuralWaveAge = ${JSON.stringify(original.neuralWaveAge)};
  renderer.neuralWaveStrength = ${JSON.stringify(original.neuralWaveStrength)};
  renderer.resetView();
  renderer.clearTrails();
  return true;
})()`);
socket.close();

console.log(JSON.stringify({ outputPath, ...telemetry }, null, 2));
