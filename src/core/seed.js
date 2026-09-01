const TAU = Math.PI * 2;

export function hashString(value, salt = 0) {
  let hash = (2166136261 ^ salt) >>> 0;
  for (const character of String(value).normalize('NFKC')) {
    const point = character.codePointAt(0);
    hash ^= point;
    hash = Math.imul(hash, 16777619);
    hash ^= hash >>> 13;
  }
  hash = Math.imul(hash ^ (hash >>> 16), 2246822507);
  hash = Math.imul(hash ^ (hash >>> 13), 3266489909);
  return (hash ^ (hash >>> 16)) >>> 0;
}

export function createRng(seed) {
  let a = hashString(seed, 0x9e3779b9);
  let b = hashString(seed, 0x243f6a88);
  let c = hashString(seed, 0xb7e15162);
  let d = hashString(seed, 0xdeadbeef);

  return () => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    const result = (a + b + d) >>> 0;
    d = (d + 1) >>> 0;
    a = (b ^ (b >>> 9)) >>> 0;
    b = (c + (c << 3)) >>> 0;
    c = ((c << 21) | (c >>> 11)) >>> 0;
    c = (c + result) >>> 0;
    return result / 4294967296;
  };
}

export function createSpecimenId() {
  const words = new Uint32Array(4);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(words);
  } else {
    const entropy = `${Date.now()}\u241f${globalThis.performance?.now?.() ?? 0}\u241f${Math.random()}`;
    for (let index = 0; index < words.length; index += 1) words[index] = hashString(entropy, index + 1);
  }
  return Array.from(words, (word) => word.toString(16).padStart(8, '0')).join('');
}

export function fallbackEmbedding(text, dimensions = 96) {
  const vector = new Float32Array(dimensions);
  const normalized = ` ${String(text).normalize('NFKC').toLocaleLowerCase()} `;
  const characters = [...normalized];

  for (let width = 1; width <= 4; width += 1) {
    for (let index = 0; index <= characters.length - width; index += 1) {
      const gram = characters.slice(index, index + width).join('');
      const hash = hashString(gram, width * 0x9e3779b9);
      const slot = hash % dimensions;
      const sign = hash & 0x80000000 ? -1 : 1;
      vector[slot] += sign / Math.sqrt(width);
    }
  }

  const cues = semanticCues(normalized);
  cues.forEach((value, index) => {
    vector[index % dimensions] += value * 2.4;
  });

  return normalizeVector(vector);
}

export function normalizeVector(input) {
  const output = Float32Array.from(input);
  let magnitude = 0;
  for (const value of output) magnitude += value * value;
  magnitude = Math.sqrt(magnitude) || 1;
  for (let index = 0; index < output.length; index += 1) output[index] /= magnitude;
  return output;
}

const CUE_SETS = [
  ['rush', 'violent', 'storm', 'shatter', 'fast', 'wild', 'thunder', 'explode', 'rage', 'fury'],
  ['calm', 'slow', 'still', 'quiet', 'soft', 'sleep', 'gentle', 'hush', 'breathe', 'float'],
  ['fold', 'knot', 'maze', 'inside', 'tangle', 'spiral', 'labyrinth', 'dense', 'closed'],
  ['open', 'wide', 'sky', 'space', 'expand', 'bloom', 'horizon', 'release', 'air'],
  ['warm', 'ember', 'sun', 'fire', 'gold', 'orange', 'heat', 'blood', 'rose'],
  ['cold', 'ice', 'moon', 'blue', 'violet', 'night', 'winter', 'silver', 'indigo'],
  ['mirror', 'balance', 'order', 'symmetry', 'crystal', 'precise', 'geometry'],
  ['chaos', 'strange', 'noise', 'broken', 'random', 'glitch', 'feral', 'fracture'],
  ['memory', 'echo', 'again', 'remember', 'ancient', 'ghost', 'after', 'trace'],
  ['forget', 'erase', 'vanish', 'empty', 'void', 'silence', 'dissolve', 'fade'],
  ['sing', 'music', 'rhythm', 'wave', 'dance', 'pulse', 'hum', 'choir', 'undulate'],
  ['brain', 'mind', 'dream', 'thought', 'neural', 'synapse', 'noema', 'conscious'],
];

export function semanticCues(text) {
  const source = String(text).toLocaleLowerCase();
  return CUE_SETS.map((words) => {
    let score = 0;
    for (const word of words) {
      if (source.includes(word)) score += 1;
    }
    return Math.tanh(score * 0.72);
  });
}

export function projectEmbedding(rootSeed, embedding, dimensions = 18) {
  const source = normalizeVector(embedding);
  const output = new Float32Array(dimensions);

  for (let row = 0; row < dimensions; row += 1) {
    const rng = createRng(`${rootSeed}\u241fprojection\u241f${row}`);
    let sum = 0;
    for (let column = 0; column < source.length; column += 1) {
      const weight = rng() * 2 - 1;
      sum += source[column] * weight;
    }
    output[row] = Math.tanh(sum * 2.1 + (rng() - 0.5) * 0.18);
  }

  return output;
}

const PALETTES = [
  [
    [0.025, 0.014, 0.048],
    [0.77, 0.66, 1.08],
    [1.12, 0.34, 0.68],
    [1.2, 0.78, 0.34],
  ],
  [
    [0.012, 0.018, 0.052],
    [0.42, 0.62, 1.2],
    [1.08, 0.49, 0.79],
    [1.16, 1.01, 0.82],
  ],
  [
    [0.045, 0.018, 0.025],
    [0.86, 0.78, 1.12],
    [1.17, 0.26, 0.42],
    [1.1, 0.82, 0.62],
  ],
  [
    [0.012, 0.014, 0.032],
    [0.34, 0.42, 1.14],
    [0.94, 0.37, 0.95],
    [1.2, 0.69, 0.48],
  ],
  [
    [0.035, 0.02, 0.014],
    [1.08, 0.78, 0.6],
    [0.72, 0.42, 1.14],
    [1.22, 0.43, 0.34],
  ],
];

const FAMILY_NAMES = ['Thomas', 'Halvorsen', 'Aizawa', 'Dadras'];

function mix(a, b, amount) {
  return a + (b - a) * amount;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function makeCoefficients(family, rng, projected) {
  const a = new Float32Array(4);
  const b = new Float32Array(4);
  let dt;
  let renderScale;

  if (family === 0) {
    a[0] = clamp(0.195 + (rng() - 0.5) * 0.025 + projected[0] * 0.006, 0.178, 0.218);
    dt = 0.018;
    renderScale = 0.29;
  } else if (family === 1) {
    a[0] = clamp(1.44 + (rng() - 0.5) * 0.14 + projected[0] * 0.035, 1.34, 1.56);
    dt = 0.0028;
    renderScale = 0.064;
  } else if (family === 2) {
    a.set([
      clamp(0.95 + projected[0] * 0.045, 0.88, 1.02),
      clamp(0.7 + projected[1] * 0.04, 0.63, 0.77),
      clamp(0.6 + projected[2] * 0.035, 0.54, 0.66),
      clamp(3.5 + projected[3] * 0.18, 3.2, 3.8),
    ]);
    b.set([
      clamp(0.25 + projected[4] * 0.025, 0.2, 0.3),
      clamp(0.1 + projected[5] * 0.018, 0.07, 0.13),
      0,
      0,
    ]);
    dt = 0.0065;
    renderScale = 0.41;
  } else {
    a.set([
      clamp(3 + projected[0] * 0.12, 2.78, 3.2),
      clamp(2.7 + projected[1] * 0.11, 2.5, 2.9),
      clamp(1.7 + projected[2] * 0.08, 1.55, 1.85),
      clamp(2 + projected[3] * 0.08, 1.86, 2.14),
    ]);
    b.set([clamp(9 + projected[4] * 0.3, 8.5, 9.5), 0, 0, 0]);
    dt = 0.0026;
    renderScale = 0.06;
  }

  return { a, b, dt, renderScale };
}

export function deriveScene(rootSeed, phrase = rootSeed, embedding = fallbackEmbedding(phrase), depth = 0, specimenId = '') {
  const rootPhrase = String(rootSeed || 'the unnamed void').normalize('NFKC');
  const specimen = String(specimenId || '').normalize('NFKC').slice(0, 96);
  const root = specimen ? `${rootPhrase}\u241d${specimen}` : rootPhrase;
  const words = String(phrase || rootPhrase).normalize('NFKC');
  const rootRng = createRng(root);
  const phraseRng = createRng(`${root}\u241e${words}\u241e${depth}`);
  const family = Math.floor(rootRng() * FAMILY_NAMES.length);
  const paletteIndex = Math.floor(rootRng() * PALETTES.length);
  const projection = projectEmbedding(root, embedding);
  const cues = semanticCues(words);

  for (let index = 0; index < Math.min(cues.length, projection.length); index += 1) {
    const polarity = index % 2 === 0 ? 1 : -1;
    projection[index] = clamp(projection[index] * 0.78 + cues[index] * polarity * 0.34, -1, 1);
  }

  const coefficients = makeCoefficients(family, rootRng, projection);
  const sourcePalette = PALETTES[paletteIndex];
  const palette = new Float32Array(12);
  const spectralTurn = clamp(0.5 + projection[8] * 0.22 + (cues[4] - cues[5]) * 0.12, 0.08, 0.92);

  sourcePalette.forEach((color, colorIndex) => {
    const neighbor = sourcePalette[(colorIndex + 1) % sourcePalette.length];
    color.forEach((channel, channelIndex) => {
      const shimmer = 0.95 + projection[(colorIndex * 3 + channelIndex + 6) % projection.length] * 0.08;
      palette[colorIndex * 3 + channelIndex] = mix(channel, neighbor[channelIndex], spectralTurn * 0.16) * shimmer;
    });
  });

  const rootAngle = rootRng() * TAU;
  const phraseAngle = phraseRng() * 0.4 - 0.2;

  return {
    root,
    rootPhrase,
    specimenId: specimen,
    phrase: words,
    depth,
    family,
    familyName: FAMILY_NAMES[family],
    coeffA: coefficients.a,
    coeffB: coefficients.b,
    dt: coefficients.dt * clamp(1 + projection[6] * 0.13 + (cues[0] - cues[1]) * 0.06, 0.78, 1.22),
    renderScale: coefficients.renderScale,
    phase: rootAngle + phraseAngle + projection[7] * 0.9 + depth * 0.11,
    flow: clamp(0.72 + projection[6] * 0.22 + (cues[0] - cues[1]) * 0.12, 0.34, 1.28),
    warp: clamp(0.045 + (projection[9] + 1) * 0.035 + cues[10] * 0.035, 0.018, 0.15),
    warpFrequency: clamp(1.8 + (projection[10] + 1) * 0.9 + cues[2] * 0.5, 1.1, 4.6),
    trailHalfLife: clamp(0.72 + (projection[11] + 1) * 0.44 + (cues[8] - cues[9]) * 0.32, 0.35, 1.95),
    pointSize: clamp(1.05 + projection[12] * 0.28, 0.7, 1.42),
    brainCoupling: clamp(0.62 + projection[13] * 0.2 + cues[11] * 0.24, 0.38, 1.0),
    eclipse: clamp(0.145 + projection[14] * 0.015 + cues[9] * 0.01, 0.122, 0.174),
    symmetry: clamp(0.5 + projection[15] * 0.35 + cues[6] * 0.25 - cues[7] * 0.2, 0.05, 0.95),
    pulse: clamp(0.42 + projection[16] * 0.32 + cues[10] * 0.23, 0.12, 0.94),
    semanticA: Float32Array.from(projection.subarray(0, 4)),
    semanticB: Float32Array.from(projection.subarray(4, 8)),
    palette,
    seedVector: new Float32Array([
      hashString(root, 1) / 4294967295,
      hashString(root, 2) / 4294967295,
      hashString(root, 3) / 4294967295,
      hashString(root, 4) / 4294967295,
    ]),
  };
}

function integratePoint(position, family, scene, step) {
  const derivative = ([x, y, z]) => {
    if (family === 0) {
      const damping = scene.coeffA[0];
      return [Math.sin(y) - damping * x, Math.sin(z) - damping * y, Math.sin(x) - damping * z];
    }
    if (family === 1) {
      const a = scene.coeffA[0];
      return [
        -a * x - 4 * y - 4 * z - y * y,
        -a * y - 4 * z - 4 * x - z * z,
        -a * z - 4 * x - 4 * y - x * x,
      ];
    }
    if (family === 2) {
      const [a, b, c, d] = scene.coeffA;
      const [e, f] = scene.coeffB;
      const radial = x * x + y * y;
      return [
        (z - b) * x - d * y,
        d * x + (z - b) * y,
        c + a * z - (z * z * z) / 3 - radial * (1 + e * z) + f * z * x * x * x,
      ];
    }
    const [p, q, r, s] = scene.coeffA;
    const t = scene.coeffB[0];
    return [y - p * x + q * y * z, r * y - x * z + z, s * x * y - t * z];
  };

  const first = derivative(position);
  const midpoint = position.map((value, index) => value + first[index] * step * 0.5);
  const second = derivative(midpoint);
  return position.map((value, index) => value + second[index] * step);
}

export function makeInitialParticles(rootSeed, family, count, scene = null) {
  const rng = createRng(`${rootSeed}\u241fparticles`);
  const data = new Float32Array(count * 4);
  const spreads = [1.8, 0.42, 0.56, 0.12];
  const spread = spreads[family] ?? 0.5;

  if (scene) {
    let position = [
      (rng() * 2 - 1) * spread,
      (rng() * 2 - 1) * spread,
      (rng() * 2 - 1) * spread,
    ];
    const burnIn = [2800, 6800, 3600, 14_000][family] ?? 4000;
    const stride = family === 0 ? 1 : 2;
    const step = scene.dt * scene.flow;
    const bound = family === 1 ? 38 : family === 3 ? 50 : 12;

    const advance = () => {
      position = integratePoint(position, family, scene, step);
      const lengthSquared = position[0] ** 2 + position[1] ** 2 + position[2] ** 2;
      if (!position.every(Number.isFinite) || lengthSquared > bound * bound) {
        position = [(rng() * 2 - 1) * spread, (rng() * 2 - 1) * spread, (rng() * 2 - 1) * spread];
      }
    };

    for (let index = 0; index < burnIn; index += 1) advance();
    for (let index = 0; index < count; index += 1) {
      for (let sample = 0; sample < stride; sample += 1) advance();
      const offset = index * 4;
      const dust = spread * 0.00008;
      data[offset] = position[0] + (rng() - 0.5) * dust;
      data[offset + 1] = position[1] + (rng() - 0.5) * dust;
      data[offset + 2] = position[2] + (rng() - 0.5) * dust;
      data[offset + 3] = rng();
    }
    return data;
  }

  for (let index = 0; index < count; index += 1) {
    const radius = Math.cbrt(rng()) * spread;
    const azimuth = rng() * TAU;
    const z = rng() * 2 - 1;
    const planar = Math.sqrt(Math.max(0, 1 - z * z));
    const offset = index * 4;
    data[offset] = Math.cos(azimuth) * planar * radius;
    data[offset + 1] = Math.sin(azimuth) * planar * radius;
    data[offset + 2] = z * radius;
    data[offset + 3] = rng();
  }

  return data;
}

function selectWholeFibers(rootSeed, layer, sampleCount) {
  const selectedCount = clamp(Math.round(sampleCount * (45 / 320)), 1, sampleCount);
  const ranked = Array.from({ length: sampleCount }, (_, index) => ({
    index,
    score: hashString(`${rootSeed}\u241fwhole-fiber:${layer}:${index}`),
  }));
  ranked.sort((left, right) => left.score - right.score || left.index - right.index);
  return new Set(ranked.slice(0, selectedCount).map(({ index }) => index));
}

function makeOrbitLayer(rootSeed, family, sampleCount, scene, layer) {
  const rng = createRng(`${rootSeed}\u241fnested-attractor:${layer}`);
  const selectedFibers = selectWholeFibers(rootSeed, layer, sampleCount);
  const samples = new Float32Array(sampleCount * 4);
  const spreads = [1.8, 0.42, 0.56, 0.12];
  const spread = spreads[family] ?? 0.5;
  const bound = family === 1 ? 38 : family === 3 ? 50 : 12;
  const burnIn = ([2800, 6800, 3600, 14_000][family] ?? 4000) + layer * 317;
  const orbitSpan = [3200, 5200, 4400, 7600][family] ?? 4200;
  const step = scene.dt * scene.flow * (0.965 + layer * 0.035);
  const sampleSpacing = orbitSpan / sampleCount;
  const wholeSampleSteps = Math.floor(sampleSpacing);
  const fractionalSampleStep = sampleSpacing - wholeSampleSteps;
  let position = [
    (rng() * 2 - 1) * spread,
    (rng() * 2 - 1) * spread,
    (rng() * 2 - 1) * spread,
  ];

  const advance = (stepScale = 1) => {
    position = integratePoint(position, family, scene, step * stepScale);
    const lengthSquared = position[0] ** 2 + position[1] ** 2 + position[2] ** 2;
    if (!position.every(Number.isFinite) || lengthSquared > bound * bound) {
      position = [
        (rng() * 2 - 1) * spread,
        (rng() * 2 - 1) * spread,
        (rng() * 2 - 1) * spread,
      ];
    }
  };

  for (let index = 0; index < burnIn; index += 1) advance();
  for (let index = 0; index < sampleCount; index += 1) {
    for (let sample = 0; sample < wholeSampleSteps; sample += 1) advance();
    if (fractionalSampleStep > 0.000001) advance(fractionalSampleStep);
    const offset = index * 4;
    const dust = spread * 0.00004;
    samples[offset] = position[0] + (rng() - 0.5) * dust;
    samples[offset + 1] = position[1] + (rng() - 0.5) * dust;
    samples[offset + 2] = position[2] + (rng() - 0.5) * dust;
    const phase = ((index + 0.5) / sampleCount + layer * 0.271828) % 1;
    // The integer bit is a stable, layer-specific whole-fiber selection flag.
    // Keeping it on the orbit sample means every copy of that parent either
    // reveals all of its child attractor or none of it.
    samples[offset + 3] = phase + (selectedFibers.has(index) ? 1 : 0);
  }

  return samples;
}

/**
 * Builds a balanced Latin sheet through three independently living attractors.
 * Every outer sample owns a complete child orbit, while the modular sum makes
 * the same sheet invariant under parent → child → grandchild role cycling.
 * The renderer reveals only a seeded subset of whole fibers at any one level,
 * retaining true child silhouettes without filling the product into a cloud.
 */
export function makeNestedParticles(rootSeed, family, requestedRadix, scene) {
  if (!scene) throw new TypeError('A derived scene is required to seed nested attractors.');
  const radix = Math.max(3, Math.floor(requestedRadix));
  const particleCount = radix * radix;
  const layers = [0, 1, 2].map((layer) => makeOrbitLayer(rootSeed, family, radix, scene, layer));
  const spine = makeInitialParticles(rootSeed, family, particleCount, scene);
  const data = new Float32Array(particleCount * 16);
  const latinSalt = hashString(`${rootSeed}\u241fnested-latin-sum`) % radix;
  let vertex = 0;

  for (let outer = 0; outer < radix; outer += 1) {
    for (let inner = 0; inner < radix; inner += 1) {
      const indices = [
        outer,
        inner,
        (latinSalt - outer - inner + radix * 2) % radix,
      ];
      const target = vertex * 16;
      for (let layer = 0; layer < 3; layer += 1) {
        const source = indices[layer] * 4;
        const offset = target + layer * 4;
        data[offset] = layers[layer][source];
        data[offset + 1] = layers[layer][source + 1];
        data[offset + 2] = layers[layer][source + 2];
        data[offset + 3] = layers[layer][source + 3];
      }
      const spineSource = vertex * 4;
      data[target + 12] = spine[spineSource];
      data[target + 13] = spine[spineSource + 1];
      data[target + 14] = spine[spineSource + 2];
      data[target + 15] = spine[spineSource + 3];
      vertex += 1;
    }
  }

  return data;
}

export function encodeSession(rootSeed, mutations, specimenId = '') {
  const root = String(rootSeed).slice(0, 280);
  const specimen = String(specimenId || '').slice(0, 96);
  const history = Array.from(mutations || [], (phrase) => String(phrase).slice(0, 280)).slice(0, 63);
  const payload = JSON.stringify([2, specimen, root, ...history]);
  const bytes = new TextEncoder().encode(payload);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

export function decodeSession(fragment) {
  try {
    const source = String(fragment).replace(/^#(?:s=)?/u, '').replaceAll('-', '+').replaceAll('_', '/');
    const padded = source.padEnd(Math.ceil(source.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(parsed) || !parsed.length) return null;

    if (parsed[0] === 2) {
      const [, specimenId, rootSeed, ...mutations] = parsed;
      if (typeof specimenId !== 'string' || typeof rootSeed !== 'string' || mutations.some((item) => typeof item !== 'string')) {
        return null;
      }
      return {
        rootSeed: rootSeed.slice(0, 280),
        specimenId: specimenId.slice(0, 96),
        mutations: mutations.slice(0, 63).map((item) => item.slice(0, 280)),
      };
    }

    if (parsed.some((item) => typeof item !== 'string')) return null;
    return {
      rootSeed: parsed[0].slice(0, 280),
      specimenId: '',
      mutations: parsed.slice(1, 64).map((item) => item.slice(0, 280)),
    };
  } catch {
    return null;
  }
}
