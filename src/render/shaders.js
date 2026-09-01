export const FULLSCREEN_VERTEX = `#version 300 es
precision highp float;

out vec2 vUv;

void main() {
  vec2 position;
  if (gl_VertexID == 0) position = vec2(-1.0, -1.0);
  else if (gl_VertexID == 1) position = vec2(3.0, -1.0);
  else position = vec2(-1.0, 3.0);
  vUv = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

export const UPDATE_VERTEX = `#version 300 es
precision highp float;

layout(location = 0) in vec4 aState0;
layout(location = 1) in vec4 aState1;
layout(location = 2) in vec4 aState2;
layout(location = 3) in vec4 aSpine;

uniform int uFamily;
uniform vec4 uA;
uniform vec4 uB;
uniform vec4 uSeed;
uniform float uDt;
uniform float uTime;
uniform float uFlow;
uniform vec4 uGesture;
uniform vec4 uSemanticA;
uniform vec4 uSemanticB;

out vec4 vState0;
out vec4 vState1;
out vec4 vState2;
out vec4 vSpine;

float hash11(float value) {
  return fract(sin(value * 127.1 + uSeed.x * 311.7) * 43758.5453123);
}

vec3 rebirth(float identity, float layer) {
  float a = hash11(identity + 1.13 + layer * 19.17) * 6.2831853;
  float z = hash11(identity + 8.91 + layer * 7.31) * 2.0 - 1.0;
  float radius = pow(hash11(identity + 17.7 + layer * 13.73), 0.3333);
  float planar = sqrt(max(0.0, 1.0 - z * z));
  float spread = uFamily == 0 ? 1.7 : (uFamily == 1 ? 0.36 : (uFamily == 2 ? 0.48 : 0.1));
  return vec3(cos(a) * planar, sin(a) * planar, z) * radius * spread;
}

vec3 field(vec3 p) {
  if (uFamily == 0) {
    float b = uA.x;
    return vec3(sin(p.y) - b * p.x, sin(p.z) - b * p.y, sin(p.x) - b * p.z);
  }

  if (uFamily == 1) {
    float a = uA.x;
    return vec3(
      -a * p.x - 4.0 * p.y - 4.0 * p.z - p.y * p.y,
      -a * p.y - 4.0 * p.z - 4.0 * p.x - p.z * p.z,
      -a * p.z - 4.0 * p.x - 4.0 * p.y - p.x * p.x
    );
  }

  if (uFamily == 2) {
    float radial = p.x * p.x + p.y * p.y;
    return vec3(
      (p.z - uA.y) * p.x - uA.w * p.y,
      uA.w * p.x + (p.z - uA.y) * p.y,
      uA.z + uA.x * p.z - p.z * p.z * p.z / 3.0 - radial * (1.0 + uB.x * p.z) + uB.y * p.z * p.x * p.x * p.x
    );
  }

  return vec3(
    p.y - uA.x * p.x + uA.y * p.y * p.z,
    uA.z * p.y - p.x * p.z + p.z,
    uA.w * p.x * p.y - uB.x * p.z
  );
}

vec3 semanticBend(vec3 position, vec3 velocity, float layer) {
  vec3 curl = vec3(
    sin(position.y * (0.7 + abs(uSemanticB.x)) + uSemanticA.y * 3.1 + layer * 0.73) - cos(position.z * 0.63 - uSemanticB.z),
    sin(position.z * (0.74 + abs(uSemanticB.y)) - uSemanticA.z * 2.7 - layer * 0.61) - cos(position.x * 0.67 + uSemanticB.w),
    sin(position.x * (0.72 + abs(uSemanticB.z)) + uSemanticA.w * 2.9 + layer * 0.47) - cos(position.y * 0.61 - uSemanticB.x)
  );
  float coupling = (0.022 + (uSemanticA.x * 0.5 + 0.5) * 0.036) * (0.94 + layer * 0.06);
  return normalize(curl + vec3(0.0001)) * max(0.02, length(velocity)) * coupling;
}

vec4 advanceState(vec4 state, float layer) {
  float identity = fract(state.w);
  vec3 position = state.xyz;
  float dt = uDt * uFlow * (0.965 + layer * 0.035);
  vec3 first = field(position);
  first += semanticBend(position, first, layer);
  vec3 midpoint = position + first * dt * 0.5;
  vec3 second = field(midpoint);
  second += semanticBend(midpoint, second, layer);
  position += second * dt;

  float gestureWave = sin(position.x * 1.7 + position.y * 1.13 + uGesture.w + uTime * (1.32 + layer * 0.08) + layer * 1.91);
  position += vec3(
    cos(position.z + uGesture.w + layer),
    sin(position.x - uGesture.w - layer * 0.7),
    cos(position.y + uGesture.w * 0.7 + layer * 0.53)
  ) * gestureWave * uGesture.z * dt * 0.06;

  float bound = uFamily == 1 ? 38.0 : (uFamily == 3 ? 50.0 : 12.0);
  bool broken = any(isnan(position)) || any(isinf(position)) || dot(position, position) > bound * bound;
  if (broken) position = rebirth(identity + uTime * 0.013, layer);

  // The packed selection bit and identity are structural coordinates. Keeping
  // them fixed prevents every simulation tick from choosing a new child
  // rotation/scale and lets complete nested silhouettes remain coherent.
  return vec4(position, state.w);
}

void main() {
  vState0 = advanceState(aState0, 0.0);
  vState1 = advanceState(aState1, 1.0);
  vState2 = advanceState(aState2, 2.0);
  vSpine = advanceState(aSpine, 0.0);
}
`;

export const UPDATE_FRAGMENT = `#version 300 es
precision highp float;
out vec4 outColor;
void main() { outColor = vec4(0.0); }
`;

export const PARTICLE_VERTEX = `#version 300 es
precision highp float;

layout(location = 0) in vec4 aState0;
layout(location = 1) in vec4 aState1;
layout(location = 2) in vec4 aState2;
layout(location = 3) in vec4 aSpine;

uniform vec2 uResolution;
uniform vec2 uCameraOffset;
uniform vec2 uFocus;
uniform vec4 uSeed;
uniform float uTime;
uniform float uPhase;
uniform float uWarp;
uniform float uWarpFrequency;
uniform float uRenderScale;
uniform float uZoomPhase;
uniform float uZoomEpoch;
uniform float uZoomBandOctaves;
uniform float uNestingRatio;
uniform int uStateCycle;
uniform int uSpinePass;
uniform int uSpineLayer;
uniform float uFilamentInk;
uniform float uPointSize;
uniform float uPixelRatio;
uniform float uSymmetry;
uniform float uBirth;
uniform vec4 uSemanticA;
uniform vec4 uSemanticB;
uniform vec3 uStateCenters[4];
uniform vec2 uPortalPositions[3];
uniform int uPortalBranch;
uniform int uPortalPreview;
uniform vec2 uNeuralWave;
uniform float uZoomFreshness;
uniform float uZoomIntent;

out float vAlpha;
out float vTone;
out float vSpark;

float hash11(float value) {
  return fract(sin(value * 91.713 + uSeed.y * 317.19) * 43758.5453);
}

mat2 rotate2(float angle) {
  float sine = sin(angle);
  float cosine = cos(angle);
  return mat2(cosine, -sine, sine, cosine);
}

vec4 stateAt(int offset) {
  int slot = (uStateCycle + offset) % 3;
  if (slot == 0) return aState0;
  if (slot == 1) return aState1;
  return aState2;
}

float slotAt(int offset) {
  return float((uStateCycle + offset) % 3);
}

vec2 projectOrbit(vec4 state, float slot) {
  vec3 center = slot < 0.5
    ? uStateCenters[0]
    : (slot < 1.5 ? uStateCenters[1] : uStateCenters[2]);
  vec3 position = state.xyz - center;
  float centeredSlot = slot - 1.0;
  float yaw = uPhase * 0.32;
  yaw += (uSeed.z - 0.5) * (1.0 - uSymmetry) * 1.25 + uSemanticA.y * 0.16;
  yaw += centeredSlot * (0.29 + uSemanticB.z * 0.055);
  float pitch = 0.56 + sin(uPhase * 0.21 + uSeed.z * 6.2831 + uSemanticB.x + slot * 1.17) * 0.3;
  position.xz = rotate2(yaw) * position.xz;
  position.yz = rotate2(pitch) * position.yz;

  float layerFrequency = uWarpFrequency * (0.92 + slot * 0.08);
  float flowA = sin(position.y * layerFrequency + uPhase + slot * 1.31);
  float flowB = cos(position.x * (layerFrequency * 0.83) - uPhase * 0.71 - slot * 0.91);
  vec2 display = position.xy * uRenderScale;
  display += vec2(flowA + flowB * 0.4, flowB - flowA * 0.35) * uWarp;

  float curlFrequency = 1.8 + slot * 0.37 + abs(uSemanticA.z) * 0.28;
  vec2 curl = vec2(
    sin(display.y * curlFrequency + slot * 2.03 + uSemanticB.x),
    cos(display.x * (curlFrequency * 0.87) - slot * 1.73 + uSemanticA.w)
  );
  display += curl * uWarp * (0.12 + slot * 0.025);
  float stretch = 1.0 + centeredSlot * (0.045 + abs(uSemanticB.y) * 0.012);
  display = rotate2(centeredSlot * 0.075) * display;
  display *= vec2(stretch, 1.0 / stretch);
  return display;
}

vec2 projectSpine(vec4 state, float generation) {
  vec3 position = state.xyz - uStateCenters[3];
  float yaw = uPhase * 0.32;
  yaw += (uSeed.z - 0.5) * (1.0 - uSymmetry) * 1.25 + uSemanticA.y * 0.16;
  yaw += generation * (0.14 + uSemanticB.z * 0.025);
  float pitch = 0.56 + sin(uPhase * 0.21 + uSeed.z * 6.2831 + uSemanticB.x + generation * 0.61) * 0.3;
  position.xz = rotate2(yaw) * position.xz;
  position.yz = rotate2(pitch) * position.yz;

  float flowA = sin(position.y * uWarpFrequency + uPhase + generation * 0.43);
  float flowB = cos(position.x * (uWarpFrequency * 0.83) - uPhase * 0.71 - generation * 0.37);
  vec2 display = position.xy * uRenderScale;
  display += vec2(flowA + flowB * 0.4, flowB - flowA * 0.35) * uWarp;
  return rotate2(generation * 0.035) * display;
}

vec2 nestWithin(vec4 parent, vec2 child) {
  float identity = fract(parent.w);
  float angle = (hash11(identity * 733.1 + 17.3) - 0.5) * 0.87;
  float scale = mix(0.88, 1.12, hash11(identity * 911.7 + 83.1));
  return rotate2(angle) * child * scale;
}

void main() {
  float level = mod(uZoomEpoch + 4095.0, 4095.0);
  float scale = exp2(uZoomPhase);
  float appearanceScale = scale;
  float progress = clamp(uZoomPhase / max(0.0001, uZoomBandOctaves), 0.0, 1.0);
  float neutralReveal = smoothstep(0.08, 0.98, progress);
  // Lead with whichever recursive level the gesture is moving toward. These
  // complementary eases preserve the exact endpoint handoff and roughly
  // constant visual mass, but give the incoming geometry a non-zero slope at
  // once instead of waiting through most of the octave.
  float inwardReveal = 1.0 - pow(1.0 - progress, 1.8);
  float outwardReveal = pow(progress, 1.8);
  float inwardIntent = smoothstep(0.0, 0.72, max(0.0, uZoomIntent));
  float outwardIntent = smoothstep(0.0, 0.72, max(0.0, -uZoomIntent));
  float portalReveal = mix(neutralReveal, inwardReveal, inwardIntent);
  portalReveal = mix(portalReveal, outwardReveal, outwardIntent);
  vec4 state0 = stateAt(0);
  vec4 state1 = stateAt(1);
  vec4 state2 = stateAt(2);
  float currentGeneration = float(uStateCycle);
  float nextGeneration = float((uStateCycle + 1) % 3);
  vec2 displayPosition;
  float wholeFiberGate;
  float instanceOpacity = 1.0;

  if (uSpinePass == 1) {
    vec2 spineWorld;
    if (uSpineLayer == 1) {
      appearanceScale *= uNestingRatio;
      int portalIndex = uPortalBranch;
      vec2 portal = uPortalPositions[portalIndex];
      vec2 child = projectSpine(aSpine, nextGeneration);
      spineWorld = portal + child * uNestingRatio;
      instanceOpacity = uPortalPreview == 1
        ? 0.11 * (1.0 - portalReveal)
        : mix(0.055, 1.0, portalReveal);
    } else {
      spineWorld = projectSpine(aSpine, currentGeneration);
      // Transfer visual mass between the two real copies instead of letting a
      // screen-filling parent linger as a translucent cloud.
      instanceOpacity = mix(1.0, 0.05, portalReveal);
    }
    displayPosition = (spineWorld - uFocus) * scale;
    wholeFiberGate = 1.0;
  } else {
    if (uSpineLayer == 1) {
      appearanceScale *= uNestingRatio;
      int portalIndex = uPortalBranch;
      vec2 portal = uPortalPositions[portalIndex];
      vec2 childOuter = projectOrbit(state1, slotAt(1));
      vec2 childInner = projectOrbit(state2, slotAt(2));
      vec2 childFiber = childOuter + nestWithin(state1, childInner) * uNestingRatio;
      displayPosition = (portal + childFiber * uNestingRatio - uFocus) * scale;
      wholeFiberGate = step(1.0, state1.w);
      instanceOpacity = mix(0.035, 1.0, portalReveal);
    } else {
      vec2 outer = projectOrbit(state0, slotAt(0));
      vec2 inner = projectOrbit(state1, slotAt(1));
      // Each selected parent point owns one complete child orbit. The selected
      // child is rendered separately, so it becomes this exact layer after the
      // boundary instead of flashing in as unrelated geometry.
      vec2 currentFiber = outer + nestWithin(state0, inner) * uNestingRatio;
      displayPosition = (currentFiber - uFocus) * scale;
      wholeFiberGate = step(1.0, state0.w);
      instanceOpacity = mix(1.0, 0.04, portalReveal);
    }
  }

  float aspect = uResolution.x / max(1.0, uResolution.y);
  vec2 clip = vec2(displayPosition.x / aspect, displayPosition.y) + uCameraOffset;
  vec2 viewportFade = 1.0 - smoothstep(vec2(0.92), vec2(1.04), abs(clip));
  float edgeFade = viewportFade.x * viewportFade.y;
  float appearanceLevel = mod(level + float(uSpineLayer), 4095.0);
  float levelHash = hash11(appearanceLevel + uSeed.z * 43.7);
  float densityAlpha = clamp(pow(max(0.25, appearanceScale), 0.055), 0.82, 1.14);
  vAlpha = edgeFade * densityAlpha * wholeFiberGate * instanceOpacity * uFilamentInk * uBirth * (1.0 + uZoomFreshness * 0.15);
  vec4 toneState0 = uSpinePass == 1
    ? aSpine
    : (uSpineLayer == 1 ? state1 : state0);
  vec4 toneState1 = uSpineLayer == 1 ? state2 : state1;
  vec4 toneState2 = uSpineLayer == 1 ? state0 : state2;
  vTone = uSpinePass == 1
    ? fract(toneState0.w * 2.7 + toneState0.z * 0.09 + levelHash * 0.7)
    : fract(fract(toneState0.w) * 1.71 + fract(toneState1.w) * 0.73 + fract(toneState2.w) * 0.31 + toneState0.z * 0.09 + levelHash * 0.7);
  float sparkIdentity = uSpinePass == 1
    ? toneState0.w
    : fract(toneState0.w) + fract(toneState1.w) * 0.37 + fract(toneState2.w) * 0.13;
  vSpark = pow(max(0.0, sin(sparkIdentity * 937.0 + uTime * 0.8)), 18.0);
  vec2 neuralPoint = vec2(clip.x * aspect, clip.y - 0.035);
  neuralPoint.y *= 1.07;
  float neuralRadius = max(0.05, 0.83 - uNeuralWave.x * 0.56);
  float neuralTransfer = exp(-abs(length(neuralPoint * vec2(0.88, 1.0)) - neuralRadius) * 34.0) * uNeuralWave.y;
  vAlpha *= 1.0 + neuralTransfer * (uSpinePass == 1 ? 2.25 : 0.68);
  vSpark = max(vSpark, neuralTransfer);
  float densityPointSize = clamp(pow(max(0.25, appearanceScale), 0.045), 0.84, 1.14);
  float pointProfile = uSpinePass == 1
    ? 0.82 + vSpark * 1.55
    : 0.52 + vSpark * 0.72;
  gl_PointSize = uPointSize * uPixelRatio * densityPointSize * pointProfile;
  gl_Position = vec4(clip, 0.0, 1.0);
}
`;

export const PARTICLE_FRAGMENT = `#version 300 es
precision highp float;

uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uColorC;

in float vAlpha;
in float vTone;
in float vSpark;
out vec4 outColor;

void main() {
  vec2 point = gl_PointCoord * 2.0 - 1.0;
  float radiusSquared = dot(point, point);
  if (radiusSquared > 1.0 || vAlpha <= 0.0001) discard;
  float filament = exp(-radiusSquared * 3.8);
  vec3 color = mix(uColorA, uColorB, smoothstep(0.12, 0.88, vTone));
  color = mix(color, uColorC, vSpark * 0.7);
  float light = filament * vAlpha * (0.021 + vSpark * 0.048);
  outColor = vec4(color * light, light);
}
`;

export const TRAIL_FRAGMENT = `#version 300 es
precision highp float;

uniform sampler2D uTrail;
uniform vec4 uTrailMotion;

in vec2 vUv;
out vec4 outColor;

void main() {
  float zoom = max(0.000001, uTrailMotion.x);
  vec2 sampleUv = vUv / zoom + uTrailMotion.yz;
  vec3 previous = texture(uTrail, clamp(sampleUv, vec2(0.0), vec2(1.0))).rgb;
  if (any(isnan(previous)) || any(isinf(previous))) previous = vec3(0.0);
  previous = clamp(previous, vec3(0.0), vec3(32.0));
  vec2 enters = smoothstep(vec2(-0.004), vec2(0.014), sampleUv);
  vec2 leaves = 1.0 - smoothstep(vec2(0.986), vec2(1.004), sampleUv);
  float inside = enters.x * enters.y * leaves.x * leaves.y;
  outColor = vec4(previous * uTrailMotion.w * inside, 1.0);
}
`;

export const COMPOSITE_FRAGMENT = `#version 300 es
precision highp float;

uniform sampler2D uTrail;
uniform vec2 uResolution;
uniform vec4 uSeed;
uniform vec4 uPointer;
uniform vec3 uVoidColor;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uColorC;
uniform float uTime;
uniform float uPhase;
uniform float uBrain;
uniform float uBrainPulse;
uniform float uEclipse;
uniform float uBirth;
uniform float uReducedMotion;
uniform float uLogZoom;
uniform vec2 uCameraOffset;
uniform vec4 uNeural;
uniform vec2 uNeuralWave;
uniform vec4 uSemanticA;
uniform vec4 uSemanticB;

in vec2 vUv;
out vec4 outColor;

float hash21(vec2 point) {
  point = fract(point * vec2(123.34, 456.21));
  point += dot(point, point + 45.32 + uSeed.xy * 9.7);
  return fract(point.x * point.y);
}

float noise21(vec2 point) {
  vec2 cell = floor(point);
  vec2 local = fract(point);
  local = local * local * (3.0 - 2.0 * local);
  return mix(
    mix(hash21(cell), hash21(cell + vec2(1.0, 0.0)), local.x),
    mix(hash21(cell + vec2(0.0, 1.0)), hash21(cell + 1.0), local.x),
    local.y
  );
}

float fbm(vec2 point) {
  float value = 0.0;
  float amplitude = 0.52;
  mat2 turn = mat2(0.81, -0.59, 0.59, 0.81);
  for (int octave = 0; octave < 5; octave++) {
    value += noise21(point) * amplitude;
    point = turn * point * 2.03 + 13.17;
    amplitude *= 0.49;
  }
  return value;
}

float ellipseSdf(vec2 point, vec2 radius) {
  return length(point / radius) - 1.0;
}

vec2 uvFromWorld(vec2 world) {
  return vec2(world.x * uResolution.y / uResolution.x, world.y) * 0.5 + 0.5;
}

vec3 sampleTrail(vec2 uv) {
  vec2 texel = 1.0 / uResolution;
  vec3 sharp = texture(uTrail, uv).rgb;
  vec3 nearBloom = vec3(0.0);
  nearBloom += texture(uTrail, uv + vec2(texel.x * 2.5, 0.0)).rgb;
  nearBloom += texture(uTrail, uv - vec2(texel.x * 2.5, 0.0)).rgb;
  nearBloom += texture(uTrail, uv + vec2(0.0, texel.y * 2.5)).rgb;
  nearBloom += texture(uTrail, uv - vec2(0.0, texel.y * 2.5)).rgb;
  vec3 farBloom = vec3(0.0);
  farBloom += texture(uTrail, uv + texel * vec2(7.0, 5.0)).rgb;
  farBloom += texture(uTrail, uv + texel * vec2(-7.0, 5.0)).rgb;
  farBloom += texture(uTrail, uv + texel * vec2(7.0, -5.0)).rgb;
  farBloom += texture(uTrail, uv - texel * vec2(7.0, 5.0)).rgb;
  return sharp * 0.94 + nearBloom * 0.022 + farBloom * 0.005;
}

mat2 rotateField(float angle) {
  float sine = sin(angle);
  float cosine = cos(angle);
  return mat2(cosine, -sine, sine, cosine);
}

void main() {
  vec2 world = (gl_FragCoord.xy * 2.0 - uResolution) / uResolution.y;
  float motionTime = uTime * mix(0.14, 1.0, 1.0 - uReducedMotion);
  vec3 color = uVoidColor * (0.18 + 0.08 * max(0.0, world.y));

  vec2 brainPoint = world - vec2(0.0, 0.035);
  brainPoint.y *= 1.07;
  float leftLobe = ellipseSdf(brainPoint + vec2(0.235, 0.0), vec2(0.56, 0.69));
  float rightLobe = ellipseSdf(brainPoint - vec2(0.235, 0.0), vec2(0.56, 0.69));
  float crownWarp = (fbm(brainPoint * 3.8 + uSeed.xy * 11.0) - 0.5) * 0.085;
  float brainDistance = min(leftLobe, rightLobe) + crownWarp;
  float silhouette = 1.0 - smoothstep(-0.045, 0.035, brainDistance);
  float fissure = smoothstep(0.018, 0.055, abs(brainPoint.x) + max(0.0, -brainPoint.y - 0.14) * 0.18);
  silhouette *= mix(0.38, 1.0, fissure);
  float stem = 1.0 - smoothstep(-0.03, 0.04, ellipseSdf(brainPoint - vec2(0.0, -0.65), vec2(0.14, 0.32)));
  silhouette = max(silhouette, stem * 0.58);

  float warp = fbm(brainPoint * (4.2 + uNeural.x * 0.48) + vec2(motionTime * 0.035, -motionTime * 0.025));
  float gyriA = 1.0 - abs(sin((brainPoint.y * (8.0 + uNeural.x) + brainPoint.x * 3.2 + warp * (2.2 + uNeural.z)) * 3.14159 + uPhase * 0.08));
  float gyriB = 1.0 - abs(sin((brainPoint.x * (7.2 + uNeural.y * 1.8) - brainPoint.y * 2.1 - warp * 2.0) * 3.14159));
  float gyri = pow(max(gyriA, gyriB * 0.78), 9.0);
  float neural = pow(max(0.0, sin((brainPoint.x + warp * 0.16) * 31.0) * cos((brainPoint.y - warp * 0.12) * 27.0)), 12.0);
  float cortexPulse = 0.74 + 0.26 * sin(motionTime * 1.1 + warp * 8.0 + uBrainPulse * 4.0);
  float signalRadius = max(0.05, 0.83 - uNeuralWave.x * 0.56);
  float signalRing = exp(-abs(length(brainPoint * vec2(0.88, 1.0)) - signalRadius) * 34.0);
  float semanticRoute = dot(uSemanticA.xy, vec2(2.7, -1.9)) + dot(uSemanticB.zw, vec2(1.3, 2.1));
  float signalRoutes = pow(max(0.0, sin((brainPoint.x + warp * 0.12) * 36.0 - uNeuralWave.x * 13.0 + semanticRoute)), 18.0) * neural;
  float neuralSignal = (signalRing * 0.7 + signalRoutes) * uNeuralWave.y * silhouette;
  float brainLight = silhouette * (0.022 + gyri * 0.15 + neural * 0.16) * uBrain * cortexPulse * (1.0 + uBrainPulse * 0.72) + neuralSignal * 0.28;
  color += mix(uColorA, uColorB, warp) * brainLight * (0.34 + uBirth * 0.66);
  float cortexEdge = exp(-abs(brainDistance) * 31.0) * uBrain;
  float centerCleft = exp(-abs(brainPoint.x) * 52.0) * smoothstep(-0.34, 0.56, brainPoint.y) * silhouette;
  color += mix(uColorA, uColorC, 0.28) * (cortexEdge * 0.052 + centerCleft * 0.028);

  float aspect = uResolution.x / uResolution.y;
  float eclipsePresence = 0.07 + 0.27 * exp(-abs(uLogZoom) * 0.52);
  vec2 eclipseCenter = vec2(uCameraOffset.x * aspect, uCameraOffset.y + 0.025);
  vec2 eclipseVector = world - eclipseCenter;
  float eclipseRadius = length(eclipseVector * vec2(0.97, 1.035));
  float ringNoise = fbm(vec2(atan(eclipseVector.y, eclipseVector.x) * 2.2, motionTime * 0.07 + eclipseRadius * 7.0));
  float horizonRadius = eclipseRadius + (ringNoise - 0.5) * uEclipse * 0.24;
  float horizonAngle = atan(eclipseVector.y, eclipseVector.x);
  float brokenEdge = pow(max(0.0, 0.5 + 0.5 * cos(horizonAngle - 0.8 + ringNoise * 2.4)), 7.0);
  brokenEdge *= smoothstep(0.24, 0.72, ringNoise + brokenEdge * 0.2);
  float ring = exp(-abs(horizonRadius - uEclipse) * (21.0 + ringNoise * 13.0)) * brokenEdge;
  float outerStain = exp(-abs(horizonRadius - uEclipse * 1.32) * 7.0) * brokenEdge;
  vec3 corona = mix(uColorC, uColorB, ringNoise) * (ring * 0.042 + outerStain * 0.012) * uBirth * eclipsePresence;
  color += corona;

  float lensBand = smoothstep(uEclipse * 0.76, uEclipse * 1.08, eclipseRadius) * (1.0 - smoothstep(uEclipse * 1.08, uEclipse * 2.65, eclipseRadius));
  lensBand *= brokenEdge * eclipsePresence;
  vec2 lensedWorld = world + eclipseVector * (0.008 / (eclipseRadius * eclipseRadius + 0.038)) * lensBand;

  float eclipseVoid = (1.0 - smoothstep(uEclipse * 0.5, uEclipse * 1.08, horizonRadius)) * eclipsePresence;
  eclipseVoid *= 0.4 + brokenEdge * 0.6;
  vec3 abyssTint = color * 0.76 + uVoidColor * 0.12 + mix(uColorA, uColorB, ringNoise) * 0.004;
  color = mix(color, abyssTint, eclipseVoid * 0.12);

  vec2 pointerWorld = vec2(uPointer.x * uResolution.x / uResolution.y, uPointer.y);
  vec2 pointerVector = lensedWorld - pointerWorld;
  float pointerDistance = dot(pointerVector, pointerVector) + 0.025;
  lensedWorld += pointerVector * (uPointer.z * 0.008 / pointerDistance);
  vec3 trail = sampleTrail(uvFromWorld(lensedWorld));
  float diskMask = smoothstep(uEclipse * 0.7, uEclipse * 1.22, horizonRadius);
  float trailEnergy = clamp(max(trail.r, max(trail.g, trail.b)) * 2.25, 0.0, 1.0);
  float inferenceBurst = uNeuralWave.y * exp(-uNeuralWave.x * 0.42);
  float cortexContact = silhouette * trailEnergy * uBrain;
  float synapticContact = clamp(gyri * 0.72 + neural * 0.64 + neuralSignal * 1.8, 0.0, 1.0);
  vec3 contactColor = mix(uColorB, uColorC, clamp(warp * 0.72 + uSemanticA.w * 0.12 + 0.12, 0.0, 1.0));
  // The language embedding does not merely tint two unrelated layers: the
  // cortex lights at their actual points of contact, then a completed neural
  // inference sends that light back through the living attractor.
  color += contactColor * cortexContact * (0.055 + synapticContact * 0.16 + inferenceBurst * 0.18);
  float attractorIgnition = 1.0 + inferenceBurst * (0.32 + silhouette * 0.46 + neuralSignal * 0.9);
  color += trail * mix(0.98, 1.06, diskMask) * attractorIgnition;

  vec2 starCell = floor(gl_FragCoord.xy / 3.0);
  float star = step(0.9978, hash21(starCell + floor(uSeed.zw * 811.0)));
  star *= (0.18 + 0.2 * fbm(world * 1.8)) * mix(1.0, diskMask, eclipsePresence);
  color += mix(uColorA, uColorC, hash21(starCell)) * star * (1.0 - silhouette * 0.7);

  float vignette = 1.0 - smoothstep(0.24, 1.52, length(world * vec2(0.72, 0.9)));
  color *= 0.48 + vignette * 0.52;
  color = vec3(1.0) - exp(-color * 1.22);
  color = pow(max(color, 0.0), vec3(0.86));
  outColor = vec4(color, 1.0);
}
`;
