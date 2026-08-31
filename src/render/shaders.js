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

layout(location = 0) in vec4 aState;

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

out vec4 vState;

float hash11(float value) {
  return fract(sin(value * 127.1 + uSeed.x * 311.7) * 43758.5453123);
}

vec3 rebirth(float identity) {
  float a = hash11(identity + 1.13) * 6.2831853;
  float z = hash11(identity + 8.91) * 2.0 - 1.0;
  float radius = pow(hash11(identity + 17.7), 0.3333);
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

vec3 semanticBend(vec3 position, vec3 velocity) {
  vec3 curl = vec3(
    sin(position.y * (0.7 + abs(uSemanticB.x)) + uSemanticA.y * 3.1) - cos(position.z * 0.63 - uSemanticB.z),
    sin(position.z * (0.74 + abs(uSemanticB.y)) - uSemanticA.z * 2.7) - cos(position.x * 0.67 + uSemanticB.w),
    sin(position.x * (0.72 + abs(uSemanticB.z)) + uSemanticA.w * 2.9) - cos(position.y * 0.61 - uSemanticB.x)
  );
  float coupling = 0.022 + (uSemanticA.x * 0.5 + 0.5) * 0.036;
  return normalize(curl + vec3(0.0001)) * max(0.02, length(velocity)) * coupling;
}

void main() {
  float identity = aState.w + float(gl_VertexID) * 0.000071;
  vec3 position = aState.xyz;
  float dt = uDt * uFlow;
  vec3 first = field(position);
  first += semanticBend(position, first);
  vec3 midpoint = position + first * dt * 0.5;
  vec3 second = field(midpoint);
  second += semanticBend(midpoint, second);
  position += second * dt;

  float gestureWave = sin(position.x * 1.7 + position.y * 1.13 + uGesture.w + uTime * 1.4);
  position += vec3(
    cos(position.z + uGesture.w),
    sin(position.x - uGesture.w),
    cos(position.y + uGesture.w * 0.7)
  ) * gestureWave * uGesture.z * dt * 0.06;

  float bound = uFamily == 1 ? 38.0 : (uFamily == 3 ? 50.0 : 12.0);
  bool broken = any(isnan(position)) || any(isinf(position)) || dot(position, position) > bound * bound;
  if (broken) position = rebirth(identity + uTime * 0.013);

  vState = vec4(position, fract(aState.w + 0.000037));
}
`;

export const UPDATE_FRAGMENT = `#version 300 es
precision highp float;
out vec4 outColor;
void main() { outColor = vec4(0.0); }
`;

export const PARTICLE_VERTEX = `#version 300 es
precision highp float;

layout(location = 0) in vec4 aState;

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
uniform float uPointSize;
uniform float uPixelRatio;
uniform float uSymmetry;
uniform float uBirth;
uniform vec4 uSemanticA;
uniform vec4 uSemanticB;

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

vec2 recursiveBranch(vec2 point, float identity, float branchLevel, float generation) {
  float stableLevel = mod(branchLevel + 4096.0, 4096.0);
  float branchHash = hash11(identity * 0.0137 + stableLevel * 17.17 + generation * 31.91);
  float branch = floor(branchHash * 3.0);
  float side = branch - 1.0;
  float levelTurn = (hash11(stableLevel + generation * 9.73) - 0.5) * 0.18;
  float semanticTurn = uSemanticA.x * 0.12 + uSemanticB.y * 0.08;
  float contraction = 0.255 + uSemanticB.z * 0.007;
  vec2 anchor;
  if (branch < 0.5) anchor = vec2(-0.14, 0.018);
  else if (branch < 1.5) anchor = vec2(0.0, 0.12);
  else anchor = vec2(0.14, -0.018);
  anchor = rotate2((uSeed.x - 0.5) * 0.7 + levelTurn) * anchor;
  return anchor + rotate2(side * (0.2 + uSemanticB.x * 0.055) + semanticTurn + levelTurn) * point * contraction;
}

void main() {
  const float zoomBandOctaves = 2.0;
  float band = float(gl_InstanceID) - 2.0;
  float level = mod(uZoomEpoch - band + 4096.0, 4096.0);
  float levelHash = hash11(level + uSeed.z * 43.7);
  float logScale = uZoomPhase + band * zoomBandOctaves;
  float scale = exp2(logScale);
  float fractalBloom = pow(0.5 + 0.5 * sin((uZoomPhase / zoomBandOctaves) * 6.2831853 + uSeed.w * 6.2831853 + uSemanticA.z * 1.7), 4.0);

  vec3 position = aState.xyz;
  float yaw = uPhase * 0.32 + uTime * 0.018 + (uSeed.z - 0.5) * (1.0 - uSymmetry) * 1.25 + uSemanticA.y * 0.16;
  float pitch = 0.56 + sin(uPhase * 0.21 + uSeed.z * 6.2831 + uSemanticB.x) * 0.3;
  position.xz = rotate2(yaw) * position.xz;
  position.yz = rotate2(pitch) * position.yz;

  float flowA = sin(position.y * uWarpFrequency + uPhase + uTime * 0.19);
  float flowB = cos(position.x * (uWarpFrequency * 0.83) - uPhase * 0.71 + uTime * 0.13);
  vec2 displayPosition = position.xy * uRenderScale;
  displayPosition += vec2(flowA + flowB * 0.4, flowB - flowA * 0.35) * uWarp;

  float identity = float(gl_VertexID);
  float branchRole = hash11(identity * 0.0191 + uSeed.w * 71.3);
  float levelGate = step(0.58, hash11(level + uSeed.x * 113.0));
  float isBranch = step(0.9, branchRole) * levelGate;
  vec2 nestedPosition = recursiveBranch(displayPosition, identity, level - 1.0, 0.0);
  nestedPosition = recursiveBranch(nestedPosition, identity, level, 1.0);
  float branchBlend = isBranch * 0.22;
  displayPosition = mix(displayPosition, nestedPosition, branchBlend);
  displayPosition = (displayPosition - uFocus) * scale;

  float aspect = uResolution.x / max(1.0, uResolution.y);
  vec2 clip = vec2(displayPosition.x / aspect, displayPosition.y) + uCameraOffset;
  vec2 viewportFade = 1.0 - smoothstep(vec2(0.92), vec2(1.04), abs(clip));
  float edgeFade = viewportFade.x * viewportFade.y;
  float scaleWindow = smoothstep(-4.0, -3.0, logScale) * (1.0 - smoothstep(3.0, 4.0, logScale));
  float scaleWeight = exp(-0.5 * pow(logScale / 0.8, 2.0));
  float branchWeight = mix(1.0, mix(0.12, 0.38, fractalBloom) * mix(0.9, 1.0, levelHash), isBranch);
  float densityAlpha = clamp(exp2(logScale * 0.10), 0.72, 1.22);

  vAlpha = edgeFade * scaleWindow * scaleWeight * branchWeight * densityAlpha * uBirth;
  vTone = fract(aState.w * 2.7 + position.z * 0.09 + levelHash * 0.7);
  vSpark = pow(max(0.0, sin(aState.w * 937.0 + uTime * 0.8)), 18.0);
  float densityPointSize = clamp(exp2(logScale * 0.07), 0.82, 1.18);
  gl_PointSize = uPointSize * uPixelRatio * densityPointSize * (0.82 + vSpark * 1.55);
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
  float gyriA = 1.0 - abs(sin((brainPoint.y * (8.0 + uNeural.x) + brainPoint.x * 3.2 + warp * (2.2 + uNeural.z) + uPhase * 0.08) * 3.14159));
  float gyriB = 1.0 - abs(sin((brainPoint.x * (7.2 + uNeural.y * 1.8) - brainPoint.y * 2.1 - warp * 2.0) * 3.14159));
  float gyri = pow(max(gyriA, gyriB * 0.78), 9.0);
  float neural = pow(max(0.0, sin((brainPoint.x + warp * 0.16) * 31.0) * cos((brainPoint.y - warp * 0.12) * 27.0)), 12.0);
  float cortexPulse = 0.74 + 0.26 * sin(motionTime * 1.1 + warp * 8.0 + uBrainPulse * 4.0);
  float signalRadius = max(0.05, 0.83 - uNeuralWave.x * 0.56);
  float signalRing = exp(-abs(length(brainPoint * vec2(0.88, 1.0)) - signalRadius) * 34.0);
  float signalRoutes = pow(max(0.0, sin((brainPoint.x + warp * 0.12) * 36.0 - uNeuralWave.x * 13.0)), 18.0) * neural;
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
  color += trail * mix(0.94, 1.0, diskMask);

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
