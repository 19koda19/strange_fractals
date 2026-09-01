import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveZoomPosition,
  ZOOM_BAND_OCTAVES,
} from '../src/render/GpuAttractor.js';

test('zoom boundaries absorb floating-point residue without changing real nearby depths', () => {
  const residue = resolveZoomPosition(-2.7755575615628914e-17);
  assert.equal(residue.logZoom, 0);
  assert.equal(residue.epoch, 0);
  assert.equal(residue.phase, 0);

  const upperBoundary = resolveZoomPosition(ZOOM_BAND_OCTAVES + 5e-12);
  assert.equal(upperBoundary.logZoom, ZOOM_BAND_OCTAVES);
  assert.equal(upperBoundary.epoch, 1);
  assert.equal(upperBoundary.phase, 0);

  const realNegativeDepth = resolveZoomPosition(-1e-7);
  assert.equal(realNegativeDepth.logZoom, -1e-7);
  assert.equal(realNegativeDepth.epoch, -1);
  assert.ok(realNegativeDepth.phase > 0);

  for (const epoch of [-409, -29, -1, 0, 1, 15, 30, 409]) {
    const exactBoundary = resolveZoomPosition(epoch * ZOOM_BAND_OCTAVES);
    assert.equal(exactBoundary.epoch, epoch);
    assert.equal(exactBoundary.phase, 0);
  }
});

test('small symmetric zoom steps return to the exact root epoch', () => {
  let logZoom = 0;
  for (let step = 0; step < 10; step += 1) {
    logZoom = resolveZoomPosition(logZoom - 0.1).logZoom;
  }
  for (let step = 0; step < 10; step += 1) {
    logZoom = resolveZoomPosition(logZoom + 0.1).logZoom;
  }

  assert.deepEqual(resolveZoomPosition(logZoom), {
    logZoom: 0,
    epoch: 0,
    phase: 0,
  });
});
