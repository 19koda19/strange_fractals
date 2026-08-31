import {
  COMPOSITE_FRAGMENT,
  FULLSCREEN_VERTEX,
  PARTICLE_FRAGMENT,
  PARTICLE_VERTEX,
  TRAIL_FRAGMENT,
  UPDATE_FRAGMENT,
  UPDATE_VERTEX,
} from './shaders.js';
import { makeInitialParticles } from '../core/seed.js';

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

const ZOOM_BAND_OCTAVES = 2;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function damp(current, target, smoothing, deltaTime) {
  return current + (target - current) * (1 - Math.exp(-smoothing * deltaTime));
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
    this.particleCount = reducedMotion ? 56_000 : compact || cores <= 4 ? 82_000 : cores >= 10 ? 168_000 : 124_000;
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
    this.phaseOffset = 0;
    this.phaseOffsetTarget = 0;
    this.waveDepth = 0;
    this.waveDepthTarget = 0;
    this.pointer = new Float32Array([0, 0, 0, 0]);
    this.pointerTarget = new Float32Array([0, 0, 0, 0]);
    this.brainPulse = 0;
    this.neuralWaveAge = 8;
    this.neuralWaveStrength = 0;
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
      update: createProgram(gl, UPDATE_VERTEX, UPDATE_FRAGMENT, ['vState']),
      particle: createProgram(gl, PARTICLE_VERTEX, PARTICLE_FRAGMENT),
      trail: createProgram(gl, FULLSCREEN_VERTEX, TRAIL_FRAGMENT),
      composite: createProgram(gl, FULLSCREEN_VERTEX, COMPOSITE_FRAGMENT),
    };

    this.uniforms = {
      update: locations(gl, this.programs.update, [
        'uFamily', 'uA', 'uB', 'uSeed', 'uDt', 'uTime', 'uFlow', 'uGesture', 'uSemanticA', 'uSemanticB',
      ]),
      particle: locations(gl, this.programs.particle, [
        'uResolution', 'uCameraOffset', 'uFocus', 'uSeed', 'uTime', 'uPhase', 'uWarp',
        'uWarpFrequency', 'uRenderScale', 'uZoomPhase', 'uZoomEpoch', 'uPointSize',
        'uPixelRatio', 'uSymmetry', 'uBirth', 'uColorA', 'uColorB', 'uColorC',
        'uSemanticA', 'uSemanticB',
      ]),
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
    const empty = new Float32Array(this.particleCount * 4);

    for (let index = 0; index < 2; index += 1) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.stateBuffers[index]);
      gl.bufferData(gl.ARRAY_BUFFER, empty, gl.DYNAMIC_COPY);
      gl.bindVertexArray(this.stateVaos[index]);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.stateBuffers[index]);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
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

  seed(scene) {
    const gl = this.gl;
    const particles = makeInitialParticles(scene.root, scene.family, this.particleCount, scene);
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
    this.phaseOffset = 0;
    this.phaseOffsetTarget = 0;
    this.clearTrails();
    this.pulse(1);
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
    const halfLife = Math.max(0.08, this.scene?.trailHalfLife ?? 0.8);
    const decay = this.paused ? 1 : Math.exp((-Math.LN2 * deltaTime) / halfLife);
    const zoomOctaves = Math.abs(Math.log2(Math.max(0.000001, this.trailZoom)));
    // Compose the attenuation per octave so a paced wheel gesture and a single
    // large gesture preserve the same amount of screen-space history.
    const motionRetention = Math.exp(-zoomOctaves * 1.35);
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
    const scene = this.scene;
    const uniform = this.uniforms.particle;
    const zoomEpoch = Math.floor(this.logZoom / ZOOM_BAND_OCTAVES);
    const zoomPhase = this.logZoom - zoomEpoch * ZOOM_BAND_OCTAVES;
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(this.programs.particle);
    gl.bindVertexArray(this.stateVaos[this.stateIndex]);
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
    gl.uniform1f(uniform.uZoomEpoch, ((zoomEpoch % 4096) + 4096) % 4096);
    gl.uniform1f(uniform.uPointSize, scene.pointSize);
    gl.uniform1f(uniform.uPixelRatio, this.pixelRatio);
    gl.uniform1f(uniform.uSymmetry, scene.symmetry);
    gl.uniform1f(uniform.uBirth, this.birth);
    gl.uniform3fv(uniform.uColorA, scene.palette.subarray(3, 6));
    gl.uniform3fv(uniform.uColorB, scene.palette.subarray(6, 9));
    gl.uniform3fv(uniform.uColorC, scene.palette.subarray(9, 12));
    gl.uniform4fv(uniform.uSemanticA, scene.semanticA);
    gl.uniform4fv(uniform.uSemanticB, scene.semanticB);
    gl.drawArraysInstanced(gl.POINTS, 0, this.particleCount, 5);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
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
      for (let index = 0; index < 4; index += 1) {
        this.pointer[index] = damp(this.pointer[index], this.pointerTarget[index], index === 2 ? 4 : 8, rawDelta);
      }
      this.pointerTarget[2] = damp(this.pointerTarget[2], 0.06, 1.2, rawDelta);

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

  zoomBy(delta, anchorX = 0.5, anchorY = 0.5) {
    const safeDelta = clamp(delta, -1.25, 1.25);
    const factor = 2 ** safeDelta;
    // Trackpads and synthetic wheel events can quantize the visual center by a
    // fraction of a pixel. Infinite zoom would magnify that microscopic error
    // until the camera hits its guard rail, so treat the optical center exactly.
    const bounds = this.canvas.getBoundingClientRect();
    const centerSnapX = 1 / Math.max(1, bounds.width);
    const centerSnapY = 1 / Math.max(1, bounds.height);
    const stableAnchorX = Math.abs(anchorX - 0.5) <= centerSnapX ? 0.5 : clamp(anchorX, 0, 1);
    const stableAnchorY = Math.abs(anchorY - 0.5) <= centerSnapY ? 0.5 : clamp(anchorY, 0, 1);
    const previousEpoch = Math.floor(this.logZoom / ZOOM_BAND_OCTAVES);
    this.logZoom = clamp(this.logZoom + safeDelta, -1_000_000, 1_000_000);
    const clipX = stableAnchorX * 2 - 1;
    const clipY = 1 - stableAnchorY * 2;
    const previousCameraX = this.cameraOffset[0];
    const previousCameraY = this.cameraOffset[1];
    this.cameraOffset[0] = clipX - factor * (clipX - previousCameraX);
    this.cameraOffset[1] = clipY - factor * (clipY - previousCameraY);
    const scaleDelta = 1 - factor;
    const effectiveAnchorX = Math.abs(scaleDelta) > 1e-9
      ? (scaleDelta + this.cameraOffset[0] - factor * previousCameraX) / (2 * scaleDelta)
      : stableAnchorX;
    const effectiveAnchorY = Math.abs(scaleDelta) > 1e-9
      ? (scaleDelta + this.cameraOffset[1] - factor * previousCameraY) / (2 * scaleDelta)
      : 1 - stableAnchorY;
    const previousTrailZoom = this.trailZoom;
    this.trailOffset[0] += effectiveAnchorX * (1 - 1 / factor) / previousTrailZoom;
    this.trailOffset[1] += effectiveAnchorY * (1 - 1 / factor) / previousTrailZoom;
    this.trailZoom = previousTrailZoom * factor;

    // Move a large screen-space offset into model-space focus before it can run
    // away. The phase-local scale keeps the dominant recursive band stationary.
    const epoch = Math.floor(this.logZoom / ZOOM_BAND_OCTAVES);
    const crossedEpoch = epoch !== previousEpoch;
    if (crossedEpoch || Math.max(Math.abs(this.cameraOffset[0]), Math.abs(this.cameraOffset[1])) > 0.72) {
      const phase = this.logZoom - epoch * ZOOM_BAND_OCTAVES;
      const dominantBand = Math.round(-phase / ZOOM_BAND_OCTAVES);
      const phaseScale = 2 ** (phase + dominantBand * ZOOM_BAND_OCTAVES);
      const aspect = this.trailWidth / Math.max(1, this.trailHeight);
      this.focus[0] -= (this.cameraOffset[0] * aspect) / phaseScale;
      this.focus[1] -= this.cameraOffset[1] / phaseScale;
      this.cameraOffset.fill(0);
    }
    this.pointerTarget[3] += safeDelta * 0.8;
    this.brainPulse = Math.max(this.brainPulse, Math.min(1, Math.abs(safeDelta) * 2));
    this.onDepthChange?.(this.logZoom);
  }

  focusAt(x, y) {
    const epoch = Math.floor(this.logZoom / ZOOM_BAND_OCTAVES);
    const phase = this.logZoom - epoch * ZOOM_BAND_OCTAVES;
    const band = Math.round(-phase / ZOOM_BAND_OCTAVES);
    const scale = 2 ** (phase + band * ZOOM_BAND_OCTAVES);
    const aspect = this.trailWidth / Math.max(1, this.trailHeight);
    const clipX = x * 2 - 1 - this.cameraOffset[0];
    const clipY = 1 - y * 2 - this.cameraOffset[1];
    this.focus[0] += (clipX * aspect) / Math.max(0.05, scale);
    this.focus[1] += clipY / Math.max(0.05, scale);
    this.cameraOffset.fill(0);
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
