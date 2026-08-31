import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createRng,
  createSpecimenId,
  decodeSession,
  deriveScene,
  encodeSession,
  fallbackEmbedding,
  hashString,
  makeInitialParticles,
} from '../src/core/seed.js';

test('hashing and random streams are deterministic', () => {
  assert.equal(hashString('black hole eclipse'), hashString('black hole eclipse'));
  assert.notEqual(hashString('black hole eclipse'), hashString('brain eclipse'));
  const first = createRng('violet memory');
  const second = createRng('violet memory');
  assert.deepEqual(Array.from({ length: 8 }, first), Array.from({ length: 8 }, second));
});

test('scene derivation stays deterministic and inside curated stability ranges', () => {
  const embedding = fallbackEmbedding('graceful wave undulation');
  const first = deriveScene('event horizon', 'graceful wave undulation', embedding, 2);
  const second = deriveScene('event horizon', 'graceful wave undulation', embedding, 2);
  assert.equal(first.family, second.family);
  assert.deepEqual([...first.coeffA], [...second.coeffA]);
  assert.deepEqual([...first.palette], [...second.palette]);
  assert.ok(first.dt > 0 && first.dt < 0.03);
  assert.ok(first.warp >= 0.018 && first.warp <= 0.15);
  assert.ok(first.trailHalfLife >= 0.35 && first.trailHalfLife <= 1.95);
});

test('specimen identities create fresh roots while remaining exactly replayable', () => {
  const embedding = fallbackEmbedding('the same words, another life');
  const specimenId = createSpecimenId();
  const siblingId = specimenId === '00000000000000000000000000000000'
    ? '11111111111111111111111111111111'
    : '00000000000000000000000000000000';
  const first = deriveScene('event horizon', 'the same words, another life', embedding, 0, specimenId);
  const replay = deriveScene('event horizon', 'the same words, another life', embedding, 0, specimenId);
  const sibling = deriveScene('event horizon', 'the same words, another life', embedding, 0, siblingId);

  assert.match(specimenId, /^[0-9a-f]{32}$/u);
  assert.equal(first.root, replay.root);
  assert.deepEqual(first.seedVector, replay.seedVector);
  assert.notEqual(first.root, sibling.root);
  assert.notDeepEqual(first.seedVector, sibling.seedVector);
});

test('particle births are reproducible and finite', () => {
  const particles = makeInitialParticles('synaptic dusk', 2, 512);
  const again = makeInitialParticles('synaptic dusk', 2, 512);
  assert.deepEqual(particles, again);
  assert.equal(particles.length, 2048);
  assert.ok(particles.every(Number.isFinite));
});

test('session fragments round trip unicode phrases', () => {
  const specimenId = '3ed21a903950496f941271d7d32b032d';
  const encoded = encodeSession('éclipse / 脳', ['fold softly', 'remember ∴ violet'], specimenId);
  assert.deepEqual(decodeSession(`#s=${encoded}`), {
    rootSeed: 'éclipse / 脳',
    specimenId,
    mutations: ['fold softly', 'remember ∴ violet'],
  });
});

test('legacy all-string session fragments remain readable', () => {
  const legacy = Buffer.from(JSON.stringify(['old moon', 'fold softly']), 'utf8').toString('base64url');
  assert.deepEqual(decodeSession(`#s=${legacy}`), {
    rootSeed: 'old moon',
    specimenId: '',
    mutations: ['fold softly'],
  });
});
