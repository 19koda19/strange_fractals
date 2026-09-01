import {
  COMPOSITE_FRAGMENT,
  FULLSCREEN_VERTEX,
  PARTICLE_FRAGMENT,
  PARTICLE_VERTEX,
  TRAIL_FRAGMENT,
  UPDATE_FRAGMENT,
  UPDATE_VERTEX,
} from './shaders.js';
import { makeNestedParticles } from '../core/seed.js';

const MORPH_SCALARS = [
  'dt',
  'renderScale',
  'phase',
  'flow',
  'warp',
  'warpFrequency',
  'trailHalfLife',
  'pointSize',
  'brainCoupling',
  'eclipse',
  'symmetry',
  'pulse',
];

const NESTING_RATIO = 0.18;
export const ZOOM_BAND_OCTAVES = -Math.log2(NESTING_RATIO);
const MAX_NAVIGATION_HISTORY = 512;
const PHASE_WRAP_PERIOD = Math.PI * 200;
const STATE_FLOATS = 16;
const STATE_STRIDE_BYTES = STATE_FLOATS * Float32Array.BYTES_PER_ELEMENT;
const PARTICLE_UNIFORMS = [
  'uResolution', 'uCameraOffset', 'uFocus', 'uSeed', 'uTime', 'uPhase', 'uWarp',
  'uWarpFrequency', 'uRenderScale', 'uZoomPhase', 'uZoomEpoch', 'uZoomBandOctaves',
  'uNestingRatio', 'uStateCycle', 'uSpinePass', 'uSpineLayer', 'uFilamentInk', 'uPointSize',
  'uPixelRatio', 'uSymmetry', 'uBirth', 'uColorA', 'uColorB', 'uColorC',
  'uSemanticA', 'uSemanticB', 'uStateCenters[0]', 'uPortalPositions[0]',
  'uPortalBranch', 'uPortalPreview', 'uNeuralWave', 'uZoomFreshness',
];

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function damp(current, target, smoothing, deltaTime) {
  return current + (target - current) * (1 - Math.exp(-smoothing * deltaTime));
}

function smoothstep(edge0, edge1, value) {
  const unit = clamp((value - edge0) / Math.max(0.000001, edge1 - edge0), 0, 1);
  return unit * unit * (3 - 2 * unit);
}

export function resolveZoomPosition(logZoom) {
  const nearestEpoch = Math.round(logZoom / ZOOM_BAND_OCTAVES);
  const nearestBoundary = nearestEpoch * ZOOM_BAND_OCTAVES;
  const tolerance = Math.max(
    1e-10,
    Number.EPSILON * 32 * Math.max(1, Math.abs(logZoom)),
  );
  const atBoundary = Math.abs(logZoom - nearestBoundary) <= tolerance;
  const boundarySnapped = atBoundary ? nearestBoundary : logZoom;
  const snappedLogZoom = Object.is(boundarySnapped, -0) ? 0 : boundarySnapped;
  const rawEpoch = atBoundary ? nearestEpoch : Math.floor(snappedLogZoom / ZOOM_BAND_OCTAVES);
  const epoch = Object.is(rawEpoch, -0) ? 0 : rawEpoch;
  return {
    logZoom: snappedLogZoom,
    epoch,
    phase: atBoundary ? 0 : snappedLogZoom - epoch * ZOOM_BAND_OCTAVES,
  };
}

function focusGainAt(logZoom) {
  const { phase } = resolveZoomPosition(logZoom);
  return 2 ** phase;
}

function copyScene(scene) {
  return {
    ...scene,
    coeffA: Float32Array.from(scene.coeffA),
    coeffB: Float32Array.from(scene.coeffB),
    semanticA: Float32Array.from(scene.semanticA),
    semanticB: Float32Array.from(scene.semanticB),
    palette: Float32Array.from(scene.palette),
    seedVector: Float32Array.from(scene.seedVector),
  };
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compilation failed:\n${log}`);
  }
  return shader;
}

function createProgram(gl, vertexSource, fragmentSource, varyings) {
  const program = gl.createProgram();
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  if (varyings) gl.transformFeedbackVaryings(program, varyings, gl.INTERLEAVED_ATTRIBS);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Shader linking failed:\n${log}`);
  }

  return program;
}

function locations(gl, program, names) {
  return Object.fromEntries(names.map((name) => [name, gl.getUniformLocation(program, name)]));
}

export class GpuAttractor {
  constructor(p5Instance, { reducedMotion = false, onDepthChange, onError } = {}) {
    this.p = p5Instance;
    this.gl = p5Instance.drawingContext;
    this.canvas = p5Instance.canvas;
    this.reducedMotion = reducedMotion;
    this.onDepthChange = onDepthChange;
    this.onError = onError;
    this.isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && this.gl instanceof WebGL2RenderingContext;
    if (!this.isWebGL2) throw new Error('NOEMA needs WebGL2 to evolve its attractor field.');

    const compact = matchMedia('(max-width: 760px)').matches;
    const cores = navigator.hardwareConcurrency || 4;
    this.nestedRadix = reducedMotion || compact || cores <= 4 ? 260 : cores >= 10 ? 408 : 352;
    this.particleCount = this.nestedRadix * this.nestedRadix;
    this.filamentInk = 0.58;
    this.spineInk = 1.35;
    this.stateCenters = new Float32Array(12);
    this.portalStates = new Float32Array(9);
    this.portalPositions = new Float32Array(6);
    this.portalBranch = 0;
    this.pixelRatio = p5Instance.pixelDensity();
    this.scene = null;
    this.targetScene = null;
    this.morphSpeed = 0.75;
    this.awake = false;
    this.paused = false;
    this.birth = 0;
    this.birthTarget = 0;
    this.warmupSteps = 0;
    this.stateIndex = 0;
    this.trailIndex = 0;
    this.trailWidth = 0;
    this.trailHeight = 0;
    this.lastFrameTime = performance.now();
    this.elapsed = 0;
    this.frameAverage = 16;
    this.logZoom = 0;
    this.cameraOffset = new Float32Array([0, 0]);
    this.focus = new Float32Array([0, 0]);
    // Each parent epoch retains its exact boundary view and the stable anchor
    // used to enter the child. Besides making the recursive handoff reversible,
    // the anchor record absorbs sub-pixel input quantization on the return trip.
    this.navigationChoices = new Map();
    this.focusHistory = new Map();
    // The camera eases toward an embedded child across each zoom band. Keep
    // the view from the start of that band so reversing the gesture can unwind
    // the ease instead of leaving its pan baked into the parent view.
    this.portalBandViews = new Map();
    // Zooming outward can reveal an ancestor that was never visited before.
    // Its branch is a breadcrumb back to the exact child we just left, not a
    // fresh portal choice to be pulled under the cursor on the return journey.
    this.outwardParentViews = new Map();
    this.activeBranch = 0;
    this.zoomBandOctaves = ZOOM_BAND_OCTAVES;
    this.nestingRatio = NESTING_RATIO;
    this.phaseOffset = 0;
    this.phaseOffsetTarget = 0;
    this.waveDepth = 0;
    this.waveDepthTarget = 0;
    this.pointer = new Float32Array([0, 0, 0, 0]);
    this.pointerTarget = new Float32Array([0, 0, 0, 0]);
    this.brainPulse = 0;
    this.neuralWaveAge = 8;
    this.neuralWaveStrength = 0;
    this.zoomFreshness = 0;
    this.trailZoom = 1;
    this.trailOffset = new Float32Array([0, 0]);
    this.blankVao = this.gl.createVertexArray();

    this.buildPrograms();
    this.createStateBuffers();
    this.resizeTrails(true);
  }

  buildPrograms() {
    const gl = this.gl;
    this.programs = {
      update: createProgram(gl, UPDATE_VERTEX, UPDATE_FRAGMENT, ['vState0', 'vState1', 'vState2', 'vSpine']),
      particle: createProgram(gl, PARTICLE_VERTEX, PARTICLE_FRAGMENT),
      trail: createProgram(gl, FULLSCREEN_VERTEX, TRAIL_FRAGMENT),
      composite: createProgram(gl, FULLSCREEN_VERTEX, COMPOSITE_FRAGMENT),
    };

    this.uniforms = {
      update: locations(gl, this.programs.update, [
        'uFamily', 'uA', 'uB', 'uSeed', 'uDt', 'uTime', 'uFlow', 'uGesture', 'uSemanticA', 'uSemanticB',
      ]),
      particle: locations(gl, this.programs.particle, PARTICLE_UNIFORMS),
      trail: locations(gl, this.programs.trail, ['uTrail', 'uTrailMotion']),
      composite: locations(gl, this.programs.composite, [
        'uTrail', 'uResolution', 'uSeed', 'uPointer', 'uVoidColor', 'uColorA', 'uColorB',
        'uColorC', 'uTime', 'uPhase', 'uBrain', 'uBrainPulse', 'uEclipse', 'uBirth', 'uReducedMotion',
        'uLogZoom', 'uCameraOffset', 'uNeural', 'uNeuralWave',
        'uSemanticA', 'uSemanticB',
      ]),
    };
  }

  createStateBuffers() {
    const gl = this.gl;
    this.stateBuffers = [gl.createBuffer(), gl.createBuffer()];
    this.stateVaos = [gl.createVertexArray(), gl.createVertexArray()];
    const empty = new Float32Array(this.particleCount * STATE_FLOATS);

    for (let index = 0; index < 2; index += 1) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.stateBuffers[index]);
      gl.bufferData(gl.ARRAY_BUFFER, empty, gl.DYNAMIC_COPY);
      gl.bindVertexArray(this.stateVaos[index]);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.stateBuffers[index]);
      for (let layer = 0; layer < 4; layer += 1) {
        gl.enableVertexAttribArray(layer);
        gl.vertexAttribPointer(
          layer,
          4,
          gl.FLOAT,
          false,
          STATE_STRIDE_BYTES,
          layer * 4 * Float32Array.BYTES_PER_ELEMENT,
        );
      }
    }

    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  resizeTrails(force = false) {
    const gl = this.gl;
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    if (!force && width === this.trailWidth && height === this.trailHeight) return;
    this.trailWidth = width;
    this.trailHeight = height;

    if (this.trailTextures) {
      this.trailTextures.forEach((texture) => gl.deleteTexture(texture));
      this.trailFramebuffers.forEach((framebuffer) => gl.deleteFramebuffer(framebuffer));
    }

    const canFloat = Boolean(gl.getExtension('EXT_color_buffer_float'));
    this.trailTextures = [gl.createTexture(), gl.createTexture()];
    this.trailFramebuffers = [gl.createFramebuffer(), gl.createFramebuffer()];

    for (let index = 0; index < 2; index += 1) {
      gl.bindTexture(gl.TEXTURE_2D, this.trailTextures[index]);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        canFloat ? gl.RGBA16F : gl.RGBA8,
        width,
        height,
        0,
        gl.RGBA,
        canFloat ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE,
        null,
      );
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.trailFramebuffers[index]);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.trailTextures[index], 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error('The GPU could not create the light-memory buffers.');
      }
      gl.viewport(0, 0, width, height);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.trailIndex = 0;
  }

  zoomPosition(logZoom = this.logZoom) {
    return resolveZoomPosition(logZoom);
  }

  seed(scene) {
    const gl = this.gl;
    const particles = makeNestedParticles(
      scene.root,
      scene.family,
      this.nestedRadix,
      scene,
    );
    this.stateCenters.fill(0);
    for (let vertex = 0; vertex < this.particleCount; vertex += 1) {
      const base = vertex * STATE_FLOATS;
      for (let state = 0; state < 4; state += 1) {
        const source = base + state * 4;
        const target = state * 3;
        this.stateCenters[target] += particles[source];
        this.stateCenters[target + 1] += particles[source + 1];
        this.stateCenters[target + 2] += particles[source + 2];
      }
    }
    for (let index = 0; index < this.stateCenters.length; index += 1) {
      this.stateCenters[index] /= this.particleCount;
    }
    this.phaseOffset = 0;
    this.waveDepth = 0;
    this.choosePortalStates(particles, scene);
    for (const buffer of this.stateBuffers) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, particles);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.scene = copyScene(scene);
    this.targetScene = copyScene(scene);
    this.stateIndex = 0;
    this.awake = true;
    this.birth = this.reducedMotion ? 1 : 0;
    this.birthTarget = 1;
    this.warmupSteps = this.reducedMotion ? 8 : 22;
    this.logZoom = 0;
    this.cameraOffset.fill(0);
    this.focus.fill(0);
    this.navigationChoices.clear();
    this.focusHistory.clear();
    this.portalBandViews.clear();
    this.outwardParentViews.clear();
    this.activeBranch = 0;
    this.portalBranch = 0;
    this.zoomFreshness = 0;
    this.phaseOffsetTarget = 0;
    this.clearTrails();
    this.pulse(1);
  }

  projectSpinePoint(state, generation, scene = this.scene) {
    if (!scene) return [0, 0];
    const center = this.stateCenters.subarray(9, 12);
    let x = state[0] - center[0];
    let y = state[1] - center[1];
    let z = state[2] - center[2];
    const rotatePair = (first, second, angle) => {
      const sine = Math.sin(angle);
      const cosine = Math.cos(angle);
      return [cosine * first + sine * second, -sine * first + cosine * second];
    };
    const phase = scene.phase + this.phaseOffset;
    let yaw = phase * 0.32;
    yaw += (scene.seedVector[2] - 0.5) * (1 - scene.symmetry) * 1.25 + scene.semanticA[1] * 0.16;
    yaw += generation * (0.14 + scene.semanticB[2] * 0.025);
    [x, z] = rotatePair(x, z, yaw);
    const pitch = 0.56 + Math.sin(
      phase * 0.21 + scene.seedVector[2] * Math.PI * 2 + scene.semanticB[0] + generation * 0.61,
    ) * 0.3;
    [y, z] = rotatePair(y, z, pitch);

    const flowA = Math.sin(y * scene.warpFrequency + phase + generation * 0.43);
    const flowB = Math.cos(x * (scene.warpFrequency * 0.83) - phase * 0.71 - generation * 0.37);
    const warp = scene.warp + this.waveDepth * 0.055;
    let displayX = x * scene.renderScale + (flowA + flowB * 0.4) * warp;
    let displayY = y * scene.renderScale + (flowB - flowA * 0.35) * warp;
    [displayX, displayY] = rotatePair(displayX, displayY, generation * 0.035);
    return [displayX, displayY];
  }

  choosePortalStates(particles, scene) {
    const targets = [[0, 0.02], [-0.32, 0.1], [0.32, -0.08]];
    const candidateStride = Math.max(1, Math.floor(this.particleCount / 1600));
    const candidates = [];
    for (let vertex = 0; vertex < this.particleCount; vertex += candidateStride) {
      const offset = vertex * STATE_FLOATS + 12;
      const state = particles.subarray(offset, offset + 3);
      candidates.push({ state, point: this.projectSpinePoint(state, 0, scene) });
    }

    const chosen = [];
    targets.forEach((target, branch) => {
      let best = null;
      let bestScore = Infinity;
      for (const candidate of candidates) {
        if (chosen.includes(candidate)) continue;
        const dx = candidate.point[0] - target[0];
        const dy = candidate.point[1] - target[1];
        const score = dx * dx + dy * dy;
        if (score < bestScore) {
          best = candidate;
          bestScore = score;
        }
      }
      chosen.push(best);
      this.portalStates.set(best?.state ?? [0, 0, 0], branch * 3);
    });
  }

  portalPosition(branch, generation) {
    const offset = clamp(Math.floor(branch), 0, 2) * 3;
    return this.projectSpinePoint(this.portalStates.subarray(offset, offset + 3), generation);
  }

  nearestPortal(anchorX, anchorY, epoch, scale) {
    const aspect = this.trailWidth / Math.max(1, this.trailHeight);
    const clipX = anchorX * 2 - 1;
    const clipY = 1 - anchorY * 2;
    const generation = ((epoch % 3) + 3) % 3;
    let nearest = 0;
    let nearestDistance = Infinity;
    for (let branch = 0; branch < 3; branch += 1) {
      const portal = this.portalPosition(branch, generation);
      const portalClipX = ((portal[0] - this.focus[0]) * scale) / aspect + this.cameraOffset[0];
      const portalClipY = (portal[1] - this.focus[1]) * scale + this.cameraOffset[1];
      const distance = (portalClipX - clipX) ** 2 + (portalClipY - clipY) ** 2;
      if (distance < nearestDistance) {
        nearest = branch;
        nearestDistance = distance;
      }
    }
    return nearest;
  }

  setDormant(scene) {
    this.scene = copyScene(scene);
    this.targetScene = copyScene(scene);
    this.birth = 0;
    this.birthTarget = 0;
    this.awake = false;
  }

  morph(scene, duration = 2.2) {
    if (!this.scene || scene.family !== this.scene.family || scene.root !== this.scene.root) {
      this.seed(scene);
      return;
    }
    this.targetScene = copyScene(scene);
    this.morphSpeed = 1 / Math.max(0.2, duration);
    this.pulse(clamp(scene.pulse, 0.3, 1));
  }

  assimilate(scene, duration = 3.1) {
    let distanceSquared = 0;
    if (this.scene?.semanticA && this.scene?.semanticB) {
      for (const key of ['semanticA', 'semanticB']) {
        for (let index = 0; index < this.scene[key].length; index += 1) {
          const difference = scene[key][index] - this.scene[key][index];
          distanceSquared += difference * difference;
        }
      }
    }
    this.morph(scene, duration);
    const strength = clamp(0.62 + Math.sqrt(distanceSquared) * 0.16, 0.62, 1);
    this.neuralWaveAge = 0;
    this.neuralWaveStrength = strength;
    this.brainPulse = Math.max(this.brainPulse, strength);
    this.warmupSteps = Math.max(this.warmupSteps, this.reducedMotion ? 2 : 9);
  }

  advanceScene(deltaTime) {
    if (!this.scene || !this.targetScene) return;
    const amount = 1 - Math.exp(-this.morphSpeed * deltaTime * 4.2);
    for (const property of MORPH_SCALARS) {
      this.scene[property] += (this.targetScene[property] - this.scene[property]) * amount;
    }
    for (const property of ['coeffA', 'coeffB', 'semanticA', 'semanticB', 'palette', 'seedVector']) {
      for (let index = 0; index < this.scene[property].length; index += 1) {
        this.scene[property][index] += (this.targetScene[property][index] - this.scene[property][index]) * amount;
      }
    }
    this.scene.phrase = this.targetScene.phrase;
    this.scene.depth = this.targetScene.depth;
  }

  simulate(stepTime) {
    if (!this.awake || this.paused || !this.scene) return;
    const gl = this.gl;
    const sourceIndex = this.stateIndex;
    const targetIndex = 1 - sourceIndex;
    const program = this.programs.update;
    const uniform = this.uniforms.update;
    gl.useProgram(program);
    gl.uniform1i(uniform.uFamily, this.scene.family);
    gl.uniform4fv(uniform.uA, this.scene.coeffA);
    gl.uniform4fv(uniform.uB, this.scene.coeffB);
    gl.uniform4fv(uniform.uSeed, this.scene.seedVector);
    gl.uniform1f(uniform.uDt, this.scene.dt * stepTime);
    gl.uniform1f(uniform.uTime, this.elapsed);
    gl.uniform1f(uniform.uFlow, this.scene.flow);
    gl.uniform4f(uniform.uGesture, this.pointer[0], this.pointer[1], this.waveDepth, this.phaseOffset);
    gl.uniform4fv(uniform.uSemanticA, this.scene.semanticA);
    gl.uniform4fv(uniform.uSemanticB, this.scene.semanticB);
    gl.bindVertexArray(this.stateVaos[sourceIndex]);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, this.stateBuffers[targetIndex]);
    gl.enable(gl.RASTERIZER_DISCARD);
    gl.beginTransformFeedback(gl.POINTS);
    gl.drawArrays(gl.POINTS, 0, this.particleCount);
    gl.endTransformFeedback();
    gl.disable(gl.RASTERIZER_DISCARD);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
    gl.bindVertexArray(null);
    this.stateIndex = targetIndex;
  }

  renderTrail(deltaTime) {
    const gl = this.gl;
    const source = this.trailIndex;
    const target = 1 - source;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.trailFramebuffers[target]);
    gl.viewport(0, 0, this.trailWidth, this.trailHeight);
    gl.disable(gl.BLEND);
    gl.useProgram(this.programs.trail);
    gl.bindVertexArray(this.blankVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.trailTextures[source]);
    gl.uniform1i(this.uniforms.trail.uTrail, 0);
    const halfLife = clamp(this.scene?.trailHalfLife ?? 0.8, 0.08, 2);
    const decay = this.paused ? 1 : Math.exp((-Math.LN2 * deltaTime) / halfLife);
    const zoomOctaves = Math.abs(Math.log2(Math.max(0.000001, this.trailZoom)));
    // Compose the attenuation per octave so a paced wheel gesture and a single
    // large gesture preserve the same amount of screen-space history.
    // Preserve transformed light long enough for an embedded child to visibly
    // become its parent. Clearing nearly everything per octave made continuous
    // geometry feel like a fresh object had spawned in front of the camera.
    const motionRetention = Math.exp(-zoomOctaves * 1.4);
    gl.uniform4f(
      this.uniforms.trail.uTrailMotion,
      this.trailZoom,
      this.trailOffset[0],
      this.trailOffset[1],
      clamp(decay * motionRetention, 0, 1),
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.trailZoom = 1;
    this.trailOffset.fill(0);

    if (this.awake && this.birth > 0.002) {
      this.renderParticles();
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.trailIndex = target;
  }

  renderParticles() {
    const gl = this.gl;
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.bindVertexArray(this.stateVaos[this.stateIndex]);

    this.bindParticleProgram('particle', this.filamentInk, false);
    gl.uniform1i(this.uniforms.particle.uSpineLayer, 0);
    gl.drawArrays(gl.POINTS, 0, this.particleCount);
    gl.uniform1i(this.uniforms.particle.uSpineLayer, 1);
    gl.drawArrays(gl.POINTS, 0, this.particleCount);

    // The phrase reads first as a full-density strange attractor. The sparse
    // Latin sheet adds recursive children without replacing that living spine.
    this.bindParticleProgram('particle', this.spineInk, true);
    gl.uniform1i(this.uniforms.particle.uSpineLayer, 0);
    gl.drawArrays(gl.POINTS, 0, this.particleCount);
    gl.uniform1i(this.uniforms.particle.uSpineLayer, 1);
    // Keep all three destinations visibly embedded before a gesture chooses
    // one. The selected child is then drawn at full density, so changing the
    // cursor target transfers emphasis instead of teleporting a lone copy.
    const selectedPortal = this.portalBranch;
    const previewCount = Math.max(1, Math.floor(this.particleCount / 8));
    gl.uniform1i(this.uniforms.particle.uPortalPreview, 1);
    for (let branch = 0; branch < 3; branch += 1) {
      gl.uniform1i(this.uniforms.particle.uPortalBranch, branch);
      gl.drawArrays(gl.POINTS, 0, previewCount);
    }
    gl.uniform1i(this.uniforms.particle.uPortalPreview, 0);
    gl.uniform1i(this.uniforms.particle.uPortalBranch, selectedPortal);
    gl.drawArrays(gl.POINTS, 0, this.particleCount);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  bindParticleProgram(programName, ink, spinePass = false) {
    const gl = this.gl;
    const scene = this.scene;
    const uniform = this.uniforms[programName];
    const { epoch: zoomEpoch, phase: zoomPhase } = resolveZoomPosition(this.logZoom);
    gl.useProgram(this.programs[programName]);
    gl.uniform2f(uniform.uResolution, this.trailWidth, this.trailHeight);
    gl.uniform2fv(uniform.uCameraOffset, this.cameraOffset);
    gl.uniform2fv(uniform.uFocus, this.focus);
    gl.uniform4fv(uniform.uSeed, scene.seedVector);
    gl.uniform1f(uniform.uTime, this.elapsed);
    gl.uniform1f(uniform.uPhase, scene.phase + this.phaseOffset);
    gl.uniform1f(uniform.uWarp, scene.warp + this.waveDepth * 0.055);
    gl.uniform1f(uniform.uWarpFrequency, scene.warpFrequency);
    gl.uniform1f(uniform.uRenderScale, scene.renderScale);
    gl.uniform1f(uniform.uZoomPhase, zoomPhase);
    gl.uniform1f(uniform.uZoomEpoch, ((zoomEpoch % 4095) + 4095) % 4095);
    gl.uniform1f(uniform.uZoomBandOctaves, ZOOM_BAND_OCTAVES);
    gl.uniform1f(uniform.uNestingRatio, NESTING_RATIO);
    gl.uniform1i(uniform.uStateCycle, ((zoomEpoch % 3) + 3) % 3);
    gl.uniform1i(uniform.uSpinePass, spinePass ? 1 : 0);
    gl.uniform1i(uniform.uSpineLayer, 0);
    gl.uniform1i(uniform.uPortalPreview, 0);
    gl.uniform1f(uniform.uFilamentInk, ink);
    gl.uniform1f(uniform.uPointSize, scene.pointSize * 0.82);
    gl.uniform1f(uniform.uPixelRatio, this.pixelRatio);
    gl.uniform1f(uniform.uSymmetry, scene.symmetry);
    gl.uniform1f(uniform.uBirth, this.birth);
    gl.uniform1f(uniform.uZoomFreshness, this.zoomFreshness);
    gl.uniform3fv(uniform.uColorA, scene.palette.subarray(3, 6));
    gl.uniform3fv(uniform.uColorB, scene.palette.subarray(6, 9));
    gl.uniform3fv(uniform.uColorC, scene.palette.subarray(9, 12));
    gl.uniform4fv(uniform.uSemanticA, scene.semanticA);
    gl.uniform4fv(uniform.uSemanticB, scene.semanticB);
    gl.uniform3fv(uniform['uStateCenters[0]'], this.stateCenters);
    for (let branch = 0; branch < 3; branch += 1) {
      this.portalPositions.set(this.portalPosition(branch, ((zoomEpoch % 3) + 3) % 3), branch * 2);
    }
    gl.uniform2fv(uniform['uPortalPositions[0]'], this.portalPositions);
    gl.uniform1i(uniform.uPortalBranch, this.portalBranch);
    gl.uniform2f(uniform.uNeuralWave, this.neuralWaveAge, this.neuralWaveStrength);
  }

  composite() {
    const gl = this.gl;
    const scene = this.scene;
    if (!scene) return;
    const uniform = this.uniforms.composite;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.programs.composite);
    gl.bindVertexArray(this.blankVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.trailTextures[this.trailIndex]);
    gl.uniform1i(uniform.uTrail, 0);
    gl.uniform2f(uniform.uResolution, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform4fv(uniform.uSeed, scene.seedVector);
    gl.uniform4fv(uniform.uPointer, this.pointer);
    gl.uniform3fv(uniform.uVoidColor, scene.palette.subarray(0, 3));
    gl.uniform3fv(uniform.uColorA, scene.palette.subarray(3, 6));
    gl.uniform3fv(uniform.uColorB, scene.palette.subarray(6, 9));
    gl.uniform3fv(uniform.uColorC, scene.palette.subarray(9, 12));
    gl.uniform1f(uniform.uTime, this.elapsed);
    gl.uniform1f(uniform.uPhase, scene.phase + this.phaseOffset);
    gl.uniform1f(uniform.uBrain, scene.brainCoupling);
    gl.uniform1f(uniform.uBrainPulse, this.brainPulse);
    gl.uniform1f(uniform.uEclipse, scene.eclipse);
    gl.uniform1f(uniform.uBirth, this.birth);
    gl.uniform1f(uniform.uReducedMotion, this.reducedMotion ? 1 : 0);
    gl.uniform1f(uniform.uLogZoom, this.logZoom);
    gl.uniform2fv(uniform.uCameraOffset, this.cameraOffset);
    gl.uniform4f(uniform.uNeural, scene.warpFrequency, scene.symmetry, scene.flow, scene.pulse);
    gl.uniform2f(uniform.uNeuralWave, this.neuralWaveAge, this.neuralWaveStrength);
    gl.uniform4fv(uniform.uSemanticA, scene.semanticA);
    gl.uniform4fv(uniform.uSemanticB, scene.semanticB);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  draw() {
    try {
      const now = performance.now();
      const rawDelta = clamp((now - this.lastFrameTime) / 1000, 0.001, 0.05);
      this.lastFrameTime = now;
      this.frameAverage = this.frameAverage * 0.94 + rawDelta * 1000 * 0.06;
      const deltaTime = this.paused ? 0 : rawDelta;
      if (!this.paused) this.elapsed += deltaTime;
      if (!this.paused) this.neuralWaveAge += deltaTime;
      this.resizeTrails();
      this.advanceScene(rawDelta);
      this.birth = damp(this.birth, this.birthTarget, this.reducedMotion ? 40 : 1.55, rawDelta);
      this.phaseOffset = damp(this.phaseOffset, this.phaseOffsetTarget, 5.4, rawDelta);
      this.waveDepth = damp(this.waveDepth, this.waveDepthTarget, 4.2, rawDelta);
      this.waveDepthTarget = damp(this.waveDepthTarget, 0, 0.72, rawDelta);
      this.brainPulse = damp(this.brainPulse, 0, 1.1, rawDelta);
      this.neuralWaveStrength = damp(this.neuralWaveStrength, 0, 0.72, rawDelta);
      this.zoomFreshness = damp(this.zoomFreshness, 0, 3.2, rawDelta);
      for (let index = 0; index < 4; index += 1) {
        this.pointer[index] = damp(this.pointer[index], this.pointerTarget[index], index === 2 ? 4 : 8, rawDelta);
      }
      this.pointerTarget[2] = damp(this.pointerTarget[2], 0.06, 1.2, rawDelta);
      this.wrapPhaseAccumulators();
      this.refreshPortalBandCamera();

      if (this.awake && !this.paused) {
        let steps = this.frameAverage < 19 && !this.reducedMotion ? 2 : 1;
        if (this.warmupSteps > 0) {
          steps = Math.min(this.warmupSteps, this.frameAverage < 26 ? 7 : 3);
          this.warmupSteps -= steps;
        }
        for (let step = 0; step < steps; step += 1) this.simulate(1);
      }

      this.renderTrail(rawDelta);
      this.composite();
    } catch (error) {
      this.onError?.(error);
      this.paused = true;
      throw error;
    }
  }

  clearTrails() {
    const gl = this.gl;
    for (const framebuffer of this.trailFramebuffers) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.viewport(0, 0, this.trailWidth, this.trailHeight);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.trailZoom = 1;
    this.trailOffset.fill(0);
  }

  resize() {
    this.pixelRatio = this.p.pixelDensity();
    this.resizeTrails(true);
  }

  setPointer(x, y, strength = 0.08) {
    this.pointerTarget[0] = clamp(x, -1, 1);
    this.pointerTarget[1] = clamp(y, -1, 1);
    this.pointerTarget[2] = clamp(strength, 0, 1);
  }

  comb(deltaX, deltaY, velocity = 0.2) {
    this.phaseOffsetTarget += deltaX * 2.4;
    this.waveDepthTarget = clamp(this.waveDepthTarget - deltaY * 1.7 + velocity * 0.16, -1, 1);
    this.pointerTarget[2] = clamp(0.35 + velocity * 0.8, 0, 1);
    this.pointerTarget[3] += velocity * 0.12;
    this.brainPulse = Math.max(this.brainPulse, clamp(velocity, 0.15, 1));
  }

  shiftPhase(amount, waveAmount = 0) {
    this.phaseOffsetTarget += amount;
    this.waveDepthTarget = clamp(this.waveDepthTarget + waveAmount, -1, 1);
    this.pulse(Math.min(1, Math.abs(amount) * 0.35 + Math.abs(waveAmount)));
  }

  wrapPhaseAccumulators() {
    if (Math.abs(this.phaseOffset) > PHASE_WRAP_PERIOD * 8) {
      const turns = Math.trunc(this.phaseOffset / PHASE_WRAP_PERIOD);
      const wrapped = turns * PHASE_WRAP_PERIOD;
      this.phaseOffset -= wrapped;
      this.phaseOffsetTarget -= wrapped;
    }
    if (Math.abs(this.pointer[3]) > Math.PI * 128) {
      const turns = Math.trunc(this.pointer[3] / (Math.PI * 2));
      const wrapped = turns * Math.PI * 2;
      this.pointer[3] -= wrapped;
      this.pointerTarget[3] -= wrapped;
    }
  }

  applyCameraZoom(delta, clipX, clipY) {
    const factor = 2 ** delta;
    this.cameraOffset[0] = clipX - factor * (clipX - this.cameraOffset[0]);
    this.cameraOffset[1] = clipY - factor * (clipY - this.cameraOffset[1]);
  }

  rememberPortalBandView(epoch, anchorX, anchorY, phase = 0) {
    if (this.portalBandViews.has(epoch)) return;
    const clipX = anchorX * 2 - 1;
    const clipY = 1 - anchorY * 2;
    const scale = 2 ** phase;
    // Usually this is recorded at phase zero. The inverse zoom below also
    // gives a stable fallback if a restored session first moves mid-band.
    const cameraX = clipX - (clipX - this.cameraOffset[0]) / scale;
    const cameraY = clipY - (clipY - this.cameraOffset[1]) / scale;
    this.portalBandViews.set(epoch, [
      this.focus[0],
      this.focus[1],
      cameraX,
      cameraY,
      anchorX,
      anchorY,
      this.portalBranch,
    ]);
    while (this.portalBandViews.size > MAX_NAVIGATION_HISTORY) {
      const oldestEpoch = this.portalBandViews.keys().next().value;
      this.portalBandViews.delete(oldestEpoch);
    }
  }

  positionCameraInPortalBand(epoch, phase, portalLock = true) {
    const bandView = this.portalBandViews.get(epoch);
    if (!bandView) return [0, 0];
    const [focusX, focusY, cameraX, cameraY, anchorX, anchorY, branch] = bandView;
    if (![focusX, focusY, cameraX, cameraY, anchorX, anchorY, branch].every(Number.isFinite)) {
      this.portalBandViews.delete(epoch);
      return [0, 0];
    }

    const generation = ((epoch % 3) + 3) % 3;
    const portal = this.portalPosition(branch, generation);
    const aspect = this.trailWidth / Math.max(1, this.trailHeight);
    const progress = clamp(phase / ZOOM_BAND_OCTAVES, 0, 1);
    const lock = portalLock ? smoothstep(0.08, 0.9, progress) : 0;
    const scale = 2 ** phase;
    const clipX = anchorX * 2 - 1;
    const clipY = 1 - anchorY * 2;
    const baseX = clipX - scale * (clipX - cameraX);
    const baseY = clipY - scale * (clipY - cameraY);
    const targetX = clipX - ((portal[0] - focusX) * scale) / Math.max(0.000001, aspect);
    const targetY = clipY - (portal[1] - focusY) * scale;
    const previousX = this.cameraOffset[0];
    const previousY = this.cameraOffset[1];
    this.cameraOffset[0] = baseX + (targetX - baseX) * lock;
    this.cameraOffset[1] = baseY + (targetY - baseY) * lock;
    if (Number.isInteger(branch)) this.portalBranch = branch;
    return [this.cameraOffset[0] - previousX, this.cameraOffset[1] - previousY];
  }

  refreshPortalBandCamera() {
    const { epoch, phase } = resolveZoomPosition(this.logZoom);
    if (!this.portalBandViews.has(epoch) || phase <= 0) return;
    const [panX, panY] = this.positionCameraInPortalBand(
      epoch,
      phase,
      !this.outwardParentViews.has(epoch),
    );
    if (panX === 0 && panY === 0) return;
    const trailScale = Math.max(0.000001, this.trailZoom);
    this.trailOffset[0] -= (panX * 0.5) / trailScale;
    this.trailOffset[1] -= (panY * 0.5) / trailScale;
  }

  rememberBoundaryView(parentEpoch, branch, anchorX, anchorY) {
    // Refresh insertion order if a previously visited epoch is entered again.
    this.focusHistory.delete(parentEpoch);
    this.navigationChoices.delete(parentEpoch);
    this.focusHistory.set(parentEpoch, [
      this.focus[0],
      this.focus[1],
      this.cameraOffset[0],
      this.cameraOffset[1],
    ]);
    this.navigationChoices.set(parentEpoch, [branch, anchorX, anchorY]);

    while (this.focusHistory.size > MAX_NAVIGATION_HISTORY) {
      const oldestEpoch = this.focusHistory.keys().next().value;
      this.focusHistory.delete(oldestEpoch);
      this.navigationChoices.delete(oldestEpoch);
    }
    while (this.navigationChoices.size > MAX_NAVIGATION_HISTORY) {
      const oldestEpoch = this.navigationChoices.keys().next().value;
      this.navigationChoices.delete(oldestEpoch);
      this.focusHistory.delete(oldestEpoch);
    }
  }

  enterChildEpoch(parentEpoch, anchorX, anchorY) {
    const branch = this.portalBranch;
    const generation = ((parentEpoch % 3) + 3) % 3;
    const portal = this.portalPosition(branch, generation);
    this.portalBranch = branch;
    this.rememberBoundaryView(parentEpoch, branch, anchorX, anchorY);
    const aspect = this.trailWidth / Math.max(1, this.trailHeight);
    this.cameraOffset[0] += (portal[0] - this.focus[0]) / (NESTING_RATIO * aspect);
    this.cameraOffset[1] += (portal[1] - this.focus[1]) / NESTING_RATIO;
    this.focus.fill(0);
    // The chosen child is now the root; a later gesture will choose its child.
    this.portalBranch = 0;
  }

  leaveChildEpoch(childEpoch) {
    const parentEpoch = childEpoch - 1;
    const boundaryView = this.focusHistory.get(parentEpoch);
    const navigationChoice = this.navigationChoices.get(parentEpoch);
    const hasStoredView = boundaryView?.length >= 2
      && Number.isFinite(boundaryView[0])
      && Number.isFinite(boundaryView[1]);

    if (hasStoredView) {
      this.focus[0] = boundaryView[0];
      this.focus[1] = boundaryView[1];
      this.cameraOffset[0] = Number.isFinite(boundaryView[2]) ? boundaryView[2] : 0;
      this.cameraOffset[1] = Number.isFinite(boundaryView[3]) ? boundaryView[3] : 0;
      this.portalBranch = Number.isInteger(navigationChoice?.[0]) ? navigationChoice[0] : 0;
    } else {
      // Construct an unseen parent from its embedded portal transform instead
      // of snapping the attractor back to the center of the camera.
      const branch = 0;
      const childView = [
        branch,
        this.focus[0],
        this.focus[1],
        this.cameraOffset[0],
        this.cameraOffset[1],
      ];
      const generation = ((parentEpoch % 3) + 3) % 3;
      const portal = this.portalPosition(branch, generation);
      const aspect = this.trailWidth / Math.max(1, this.trailHeight);
      this.cameraOffset[0] -= this.focus[0] / aspect + portal[0] / (NESTING_RATIO * aspect);
      this.cameraOffset[1] -= this.focus[1] + portal[1] / NESTING_RATIO;
      this.focus.fill(0);
      this.portalBranch = branch;
      this.outwardParentViews.set(parentEpoch, childView);
      while (this.outwardParentViews.size > MAX_NAVIGATION_HISTORY) {
        const oldestEpoch = this.outwardParentViews.keys().next().value;
        this.outwardParentViews.delete(oldestEpoch);
      }
    }

    this.focusHistory.delete(parentEpoch);
    this.navigationChoices.delete(parentEpoch);
  }

  zoomBy(delta, anchorX = 0.5, anchorY = 0.5) {
    const requestedDelta = clamp(delta, -1.25, 1.25);
    // Trackpads and synthetic wheel events can quantize the visual center by a
    // fraction of a pixel. Recursive zoom magnifies that microscopic error, so
    // treat the optical center exactly.
    const bounds = this.canvas.getBoundingClientRect();
    const centerSnapX = 1 / Math.max(1, bounds.width);
    const centerSnapY = 1 / Math.max(1, bounds.height);
    const requestedAnchorX = Math.abs(anchorX - 0.5) <= centerSnapX ? 0.5 : clamp(anchorX, 0, 1);
    const requestedAnchorY = Math.abs(anchorY - 0.5) <= centerSnapY ? 0.5 : clamp(anchorY, 0, 1);
    // Let the pointer choose a region while keeping a gentle pull toward the
    // field's living core.
    const anchorGravity = 0.72;
    let stableAnchorX = 0.5 + (requestedAnchorX - 0.5) * anchorGravity;
    let stableAnchorY = 0.5 + (requestedAnchorY - 0.5) * anchorGravity;
    const previousPosition = resolveZoomPosition(this.logZoom);
    const previousLogZoom = previousPosition.logZoom;
    const previousEpoch = previousPosition.epoch;
    const nextPosition = resolveZoomPosition(
      clamp(previousLogZoom + requestedDelta, -1_000_000, 1_000_000),
    );
    this.logZoom = nextPosition.logZoom;
    const appliedDelta = this.logZoom - previousLogZoom;
    const factor = 2 ** appliedDelta;
    const epoch = nextPosition.epoch;

    // A return gesture at the same apparent pixel should use the exact stored
    // entry anchor, even when browser event coordinates differ by a sub-pixel.
    if (epoch < previousEpoch) {
      const entryChoice = this.navigationChoices.get(epoch);
      const entryAnchor = entryChoice?.length >= 3
        ? [entryChoice[1], entryChoice[2]]
        : entryChoice;
      if (
        entryAnchor?.length >= 2
        && Math.abs(stableAnchorX - entryAnchor[0]) <= centerSnapX
        && Math.abs(stableAnchorY - entryAnchor[1]) <= centerSnapY
      ) {
        [stableAnchorX, stableAnchorY] = entryAnchor;
      }
    }

    const clipX = stableAnchorX * 2 - 1;
    const clipY = 1 - stableAnchorY * 2;
    let portalPanX = 0;
    let portalPanY = 0;

    if (appliedDelta > 0) {
      const phase = previousPosition.phase;
      const returnView = this.outwardParentViews.get(previousEpoch);
      if (Number.isInteger(returnView?.[0])) {
        this.portalBranch = returnView[0];
      } else if (Number.isInteger(this.portalBandViews.get(previousEpoch)?.[6])) {
        this.portalBranch = this.portalBandViews.get(previousEpoch)[6];
      } else {
        this.portalBranch = this.nearestPortal(stableAnchorX, stableAnchorY, previousEpoch, 2 ** phase);
      }
      this.rememberPortalBandView(previousEpoch, stableAnchorX, stableAnchorY, phase);
    }

    if (epoch > previousEpoch) {
      const boundary = (previousEpoch + 1) * ZOOM_BAND_OCTAVES;
      this.applyCameraZoom(boundary - previousLogZoom, clipX, clipY);
      const returnView = this.outwardParentViews.get(previousEpoch);
      {
        const [panX, panY] = this.positionCameraInPortalBand(
          previousEpoch,
          ZOOM_BAND_OCTAVES,
          !returnView,
        );
        portalPanX += panX;
        portalPanY += panY;
      }
      this.enterChildEpoch(previousEpoch, stableAnchorX, stableAnchorY);
      if (returnView?.length >= 5 && returnView.slice(1).every(Number.isFinite)) {
        const previousFocusX = this.focus[0];
        const previousFocusY = this.focus[1];
        const previousX = this.cameraOffset[0];
        const previousY = this.cameraOffset[1];
        this.focus[0] = returnView[1];
        this.focus[1] = returnView[2];
        this.cameraOffset[0] = returnView[3];
        this.cameraOffset[1] = returnView[4];
        const aspect = this.trailWidth / Math.max(1, this.trailHeight);
        portalPanX += this.cameraOffset[0] - previousX - (this.focus[0] - previousFocusX) / aspect;
        portalPanY += this.cameraOffset[1] - previousY - (this.focus[1] - previousFocusY);
      }
      this.outwardParentViews.delete(previousEpoch);
      const childReturnView = this.outwardParentViews.get(epoch);
      const childBandView = this.portalBandViews.get(epoch);
      if (Number.isInteger(childReturnView?.[0])) {
        this.portalBranch = childReturnView[0];
      } else if (Number.isInteger(childBandView?.[6])) {
        this.portalBranch = childBandView[6];
      } else {
        this.portalBranch = this.nearestPortal(stableAnchorX, stableAnchorY, epoch, 1);
      }
      this.rememberPortalBandView(epoch, stableAnchorX, stableAnchorY);
      const residualDelta = this.logZoom - boundary;
      const residualFactor = 2 ** residualDelta;
      portalPanX *= residualFactor;
      portalPanY *= residualFactor;
      this.applyCameraZoom(residualDelta, clipX, clipY);
      {
        const phase = nextPosition.phase;
        const [panX, panY] = this.positionCameraInPortalBand(epoch, phase, !childReturnView);
        portalPanX += panX;
        portalPanY += panY;
      }
    } else if (epoch < previousEpoch) {
      const boundary = previousEpoch * ZOOM_BAND_OCTAVES;
      this.applyCameraZoom(boundary - previousLogZoom, clipX, clipY);
      {
        const [panX, panY] = this.positionCameraInPortalBand(previousEpoch, 0);
        portalPanX += panX;
        portalPanY += panY;
      }
      this.portalBandViews.delete(previousEpoch);
      this.leaveChildEpoch(previousEpoch);
      const residualDelta = this.logZoom - boundary;
      const residualFactor = 2 ** residualDelta;
      portalPanX *= residualFactor;
      portalPanY *= residualFactor;
      this.applyCameraZoom(residualDelta, clipX, clipY);
      {
        const phase = nextPosition.phase;
        const [panX, panY] = this.positionCameraInPortalBand(
          epoch,
          phase,
          !this.outwardParentViews.has(epoch),
        );
        portalPanX += panX;
        portalPanY += panY;
      }
    } else {
      this.applyCameraZoom(appliedDelta, clipX, clipY);
      if (appliedDelta > 0) {
        const phase = nextPosition.phase;
        [portalPanX, portalPanY] = this.positionCameraInPortalBand(
          epoch,
          phase,
          !this.outwardParentViews.has(epoch),
        );
      } else if (appliedDelta < 0) {
        const phase = nextPosition.phase;
        [portalPanX, portalPanY] = this.positionCameraInPortalBand(
          epoch,
          phase,
          !this.outwardParentViews.has(epoch),
        );
        if (phase <= 0.000001) this.portalBandViews.delete(epoch);
      }
    }

    const previousTrailZoom = this.trailZoom;
    this.trailOffset[0] += stableAnchorX * (1 - 1 / factor) / previousTrailZoom;
    this.trailOffset[1] += (1 - stableAnchorY) * (1 - 1 / factor) / previousTrailZoom;
    this.trailOffset[0] -= (portalPanX * 0.5) / (factor * previousTrailZoom);
    this.trailOffset[1] -= (portalPanY * 0.5) / (factor * previousTrailZoom);
    this.trailZoom = previousTrailZoom * factor;
    this.activeBranch = ((epoch % 3) + 3) % 3;
    this.pointerTarget[3] += appliedDelta * 0.8;
    this.brainPulse = Math.max(this.brainPulse, Math.min(1, Math.abs(appliedDelta) * 2));
    this.zoomFreshness = Math.max(this.zoomFreshness, Math.min(0.65, Math.abs(appliedDelta) * 0.6));
    this.onDepthChange?.(this.logZoom);
  }

  focusAt(x, y) {
    const { epoch } = resolveZoomPosition(this.logZoom);
    const focusGain = focusGainAt(this.logZoom);
    const aspect = this.trailWidth / Math.max(1, this.trailHeight);
    const clipX = x * 2 - 1 - this.cameraOffset[0];
    const clipY = 1 - y * 2 - this.cameraOffset[1];
    this.focus[0] += (clipX * aspect) / Math.max(0.05, focusGain);
    this.focus[1] += clipY / Math.max(0.05, focusGain);
    this.cameraOffset.fill(0);
    // A manual focus starts a new path inside the current scale band, but the
    // exact parent views behind it are still valid breadcrumbs for zooming out.
    this.portalBandViews.delete(epoch);
    this.outwardParentViews.delete(epoch);
    this.activeBranch = ((epoch % 3) + 3) % 3;
    this.clearTrails();
    this.pulse(1);
  }

  pulse(strength = 0.6) {
    this.brainPulse = Math.max(this.brainPulse, strength);
    this.neuralWaveAge = 0;
    this.neuralWaveStrength = Math.max(this.neuralWaveStrength, strength);
    this.waveDepthTarget = clamp(this.waveDepthTarget + strength * 0.22, -1, 1);
    this.pointerTarget[3] += strength * 0.8;
  }

  typingPulse(character = '') {
    const point = character.codePointAt(0) || 0;
    this.brainPulse = Math.max(this.brainPulse, 0.22 + (point % 11) / 38);
    if (this.neuralWaveAge > 0.16) this.neuralWaveAge = 0;
    this.neuralWaveStrength = Math.max(this.neuralWaveStrength, 0.16 + (point % 7) * 0.018);
    this.phaseOffsetTarget += ((point % 17) - 8) * 0.0018;
    this.pointerTarget[3] += 0.08;
  }

  resetView() {
    this.logZoom = 0;
    this.cameraOffset.fill(0);
    this.focus.fill(0);
    this.navigationChoices.clear();
    this.focusHistory.clear();
    this.portalBandViews.clear();
    this.outwardParentViews.clear();
    this.activeBranch = 0;
    this.portalBranch = 0;
    this.phaseOffsetTarget = 0;
    this.waveDepthTarget = 0;
    this.clearTrails();
    this.onDepthChange?.(0);
    this.pulse(0.7);
  }

  setPaused(value) {
    this.paused = Boolean(value);
    if (!this.paused) this.lastFrameTime = performance.now();
    return this.paused;
  }

  togglePaused() {
    return this.setPaused(!this.paused);
  }
}
