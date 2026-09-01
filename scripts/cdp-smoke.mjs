import { writeFile } from 'node:fs/promises';

const port = Number(process.argv[2] || 9333);
const output = process.argv[3] || '/private/tmp/noema-smoke.png';
const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
const page = pages.find((candidate) => candidate.type === 'page');
if (!page) throw new Error('No Electron renderer page was exposed.');

const socket = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
const diagnostics = [];
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

await call('Runtime.enable');
await call('Log.enable');
await call('Page.enable');
await call('Runtime.evaluate', {
  expression: `history.replaceState(null, '', location.pathname); location.reload();`,
});
await new Promise((resolve) => setTimeout(resolve, 2200));
await call('Runtime.evaluate', {
  expression: `(() => {
    const input = document.querySelector('#phrase-input');
    input.value = 'black hole eclipse remembers violet thunder';
    input.dispatchEvent(new InputEvent('input', { data: 'r', inputType: 'insertText', bubbles: true }));
    document.querySelector('#phrase-form').requestSubmit();
    return true;
  })()`,
  awaitPromise: true,
});

await new Promise((resolve) => setTimeout(resolve, 6500));
await call('Runtime.evaluate', {
  expression: `(() => {
    const canvas = document.querySelector('canvas');
    const bounds = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new WheelEvent('wheel', {
      deltaY: -240,
      clientX: bounds.left + bounds.width * 0.58,
      clientY: bounds.top + bounds.height * 0.47,
      bubbles: true,
      cancelable: true,
    }));
    return true;
  })()`,
});
await new Promise((resolve) => setTimeout(resolve, 1800));

const inspection = await call('Runtime.evaluate', {
  expression: `(() => {
    const canvas = document.querySelector('canvas');
    const gl = canvas?.getContext('webgl2');
    return {
      title: document.title,
      awake: document.body.classList.contains('is-awake'),
      inputDisabled: document.querySelector('#phrase-input').disabled,
      status: document.querySelector('#status').textContent,
      canvas: canvas ? [canvas.width, canvas.height] : null,
      canvasCount: document.querySelectorAll('#stage canvas').length,
      cssSize: canvas ? [canvas.clientWidth, canvas.clientHeight] : null,
      webgl2: Boolean(gl),
      gpu: gl ? gl.getParameter(gl.RENDERER) : null,
      errorText: document.querySelector('#invitation').textContent,
      rendererError: window.__noemaLastError ?? null,
    };
  })()`,
  returnByValue: true,
});
const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
await writeFile(output, Buffer.from(screenshot.data, 'base64'));
socket.close();

console.log(JSON.stringify({ inspection: inspection.result.value, diagnostics, screenshot: output }, null, 2));
if (diagnostics.length) process.exitCode = 1;
