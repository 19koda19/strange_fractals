const port = Number(process.argv[2] || 9333);
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

const result = await call('Runtime.evaluate', {
  expression: `(() => ({
    renderer: Boolean(window.__noemaDev?.renderer),
    error: window.__noemaLastError ?? null,
    invitation: document.querySelector('#invitation')?.textContent ?? null,
    status: document.querySelector('#status')?.textContent ?? null,
    hash: location.hash,
    awake: document.body.classList.contains('is-awake'),
    logZoom: window.__noemaDev?.renderer?.logZoom ?? null,
    family: window.__noemaDev?.renderer?.scene?.familyName ?? null,
    semanticMode: window.__noemaDev?.semantic?.mode ?? null,
    semanticA: Array.from(window.__noemaDev?.renderer?.scene?.semanticA ?? []),
    semanticB: Array.from(window.__noemaDev?.renderer?.scene?.semanticB ?? []),
    neuralWaveAge: window.__noemaDev?.renderer?.neuralWaveAge ?? null,
    neuralWaveStrength: window.__noemaDev?.renderer?.neuralWaveStrength ?? null,
  }))()`,
  returnByValue: true,
});
socket.close();
console.log(JSON.stringify(result.result.value, null, 2));
