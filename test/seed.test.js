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
  makeNestedParticles,
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

test('nested particle births stay deterministic and finite across every attractor family', () => {
  const fixtures = [
    ['family-fixture-0', 0, 'Thomas'],
    ['family-fixture-3', 1, 'Halvorsen'],
    ['family-fixture-2', 2, 'Aizawa'],
    ['family-fixture-6', 3, 'Dadras'],
  ];
  const radix = 11;

  for (const [rootSeed, family, familyName] of fixtures) {
    const scene = deriveScene(rootSeed, rootSeed, fallbackEmbedding(rootSeed), 0);
    assert.equal(scene.family, family, `${rootSeed} must continue to exercise ${familyName}`);
    assert.equal(scene.familyName, familyName);

    const particles = makeNestedParticles(scene.root, scene.family, radix, scene);
    const replay = makeNestedParticles(scene.root, scene.family, radix, scene);
    const expectedSpine = makeInitialParticles(scene.root, scene.family, radix * radix, scene);

    assert.ok(particles instanceof Float32Array);
    assert.deepEqual(particles, replay, `${familyName} births must replay exactly`);
    assert.equal(particles.length, radix * radix * 4 * 4);
    assert.ok(particles.every(Number.isFinite), `${familyName} births must remain finite`);

    for (let vertex = 0; vertex < radix * radix; vertex += 1) {
      const nestedOffset = vertex * 16 + 12;
      const spineOffset = vertex * 4;
      assert.deepEqual(
        particles.slice(nestedOffset, nestedOffset + 4),
        expectedSpine.slice(spineOffset, spineOffset + 4),
        `${familyName} must retain its exact full-density primary orbit`,
      );
    }

    for (let offset = 3; offset < particles.length; offset += 4) {
      assert.ok(
        particles[offset] >= 0 && particles[offset] < 2,
        `${familyName} identities must contain only a phase and a binary selection flag`,
      );
    }
  }
});

test('nested Latin sheet preserves complete whole fibers under cyclic role changes', () => {
  const rootSeed = 'strange fibers within strange fibers';
  const scene = deriveScene(rootSeed, rootSeed, fallbackEmbedding(rootSeed), 0);
  const radix = 29;
  const particles = makeNestedParticles(scene.root, scene.family, radix, scene);
  const stateAt = (outer, inner, layer) => {
    const vertex = outer * radix + inner;
    const offset = vertex * 16 + layer * 4;
    return particles.slice(offset, offset + 4);
  };
  const decodeIndex = (identity, layer) => {
    const phase = ((identity % 1) - layer * 0.271828 + 2) % 1;
    return Math.floor(phase * radix + 0.00001);
  };
  const triples = new Set();
  const samplesByLayer = [new Map(), new Map(), new Map()];
  let latinSalt = null;

  for (let outer = 0; outer < radix; outer += 1) {
    const completeChild = new Set();
    const completeGrandchild = new Set();
    for (let inner = 0; inner < radix; inner += 1) {
      const tuple = [0, 1, 2].map((layer) => decodeIndex(stateAt(outer, inner, layer)[3], layer));
      completeChild.add(tuple[1]);
      completeGrandchild.add(tuple[2]);
      triples.add(tuple.join(','));
      const sum = tuple.reduce((total, value) => total + value, 0) % radix;
      latinSalt ??= sum;
      assert.equal(sum, latinSalt);

      for (let layer = 0; layer < 3; layer += 1) {
        const state = stateAt(outer, inner, layer);
        const identity = state[3];
        const previous = samplesByLayer[layer].get(tuple[layer]);
        const flag = Math.floor(identity);
        assert.ok(flag === 0 || flag === 1);
        if (previous) {
          assert.deepEqual(state, previous.state);
          previous.uses += 1;
        } else {
          samplesByLayer[layer].set(tuple[layer], { state, flag, uses: 1 });
        }
      }
    }
    assert.equal(completeChild.size, radix);
    assert.equal(completeGrandchild.size, radix);
  }

  assert.equal(triples.size, radix * radix);
  for (const encoded of triples) {
    const [outer, inner, deep] = encoded.split(',').map(Number);
    assert.ok(triples.has(`${inner},${deep},${outer}`));
    assert.ok(triples.has(`${deep},${outer},${inner}`));
  }

  const selectedCount = Math.round(radix * (45 / 320));
  for (const samples of samplesByLayer) {
    assert.equal(samples.size, radix);
    assert.ok([...samples.values()].every(({ uses }) => uses === radix));
    assert.equal([...samples.values()].filter(({ flag }) => flag === 1).length, selectedCount);
  }
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
