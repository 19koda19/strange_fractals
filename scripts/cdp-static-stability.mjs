import { mkdir, writeFile } from 'node:fs/promises';

const port = Number(process.argv[2] || 9333);
const outputDirectory = process.argv[3] || '/private/tmp/noema-static-stability';
const phrase = process.argv.slice(4).join(' ') || 'black hole eclipse remembers violet thunder';
const captureAges = [3, 8, 13, 18, 23];
await mkdir(outputDirectory, { recursive: true });

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

async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

const frames = [];
try {
  await call('Runtime.enable');
  await call('Page.enable');
  await evaluate(`history.replaceState(null, '', location.pathname); location.reload();`);
  await new Promise((resolve) => setTimeout(resolve, 2200));
  const baseline = await evaluate(`(() => {
    const phrase = ${JSON.stringify(phrase)};
    const input = document.querySelector('#phrase-input');
    input.value = phrase;
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    document.querySelector('#phrase-form').requestSubmit();
    const blocked = ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'keydown', 'beforeinput', 'input'];
    const stop = (event) => {
      if (event.cancelable) event.preventDefault();
      event.stopImmediatePropagation();
    };
    for (const type of blocked) window.addEventListener(type, stop, { capture: true, passive: false });
    return { hash: location.hash, phrase, startedAt: performance.now() };
  })()`);

  let previousAge = 0;
  for (const age of captureAges) {
    await new Promise((resolve) => setTimeout(resolve, (age - previousAge) * 1000));
    const state = await evaluate(`({
      hash: location.hash,
      depth: document.querySelector('#depth-readout')?.textContent ?? '',
      status: document.querySelector('#status')?.textContent ?? '',
      input: document.querySelector('#phrase-input')?.value ?? '',
    })`);
    const capture = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const name = `static-age-${String(age).padStart(2, '0')}s.png`;
    await writeFile(`${outputDirectory}/${name}`, Buffer.from(capture.data, 'base64'));
    frames.push({ age, name, state, stableHash: state.hash === baseline.hash, inputEmpty: state.input === '' });
    previousAge = age;
  }
  console.log(JSON.stringify({ phrase, baseline, frames, outputDirectory }, null, 2));
} finally {
  socket.close();
}
