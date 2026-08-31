function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function angleBetween(first, second) {
  return Math.atan2(second.y - first.y, second.x - first.x);
}

function distanceBetween(first, second) {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

export class GestureController {
  constructor(element, renderer, onGesture = () => {}) {
    this.element = element;
    this.renderer = renderer;
    this.onGesture = onGesture;
    this.pointers = new Map();
    this.multiSnapshot = null;
    this.dragDistance = 0;
    this.bind();
  }

  position(event) {
    const bounds = this.element.getBoundingClientRect();
    return {
      x: clamp((event.clientX - bounds.left) / bounds.width, 0, 1),
      y: clamp((event.clientY - bounds.top) / bounds.height, 0, 1),
      time: performance.now(),
    };
  }

  bind() {
    this.onPointerDown = (event) => {
      if (event.button !== 0 && event.pointerType !== 'touch') return;
      const point = this.position(event);
      this.pointers.set(event.pointerId, point);
      this.dragDistance = 0;
      this.element.setPointerCapture?.(event.pointerId);
      this.renderer.setPointer(point.x * 2 - 1, 1 - point.y * 2, 0.5);
      if (this.pointers.size === 2) this.captureMulti();
      event.preventDefault();
    };

    this.onPointerMove = (event) => {
      const point = this.position(event);
      this.renderer.setPointer(point.x * 2 - 1, 1 - point.y * 2, this.pointers.has(event.pointerId) ? 0.72 : 0.09);
      const previous = this.pointers.get(event.pointerId);
      if (!previous) return;
      this.pointers.set(event.pointerId, point);

      if (this.pointers.size >= 2) {
        const values = [...this.pointers.values()].slice(0, 2);
        const distance = distanceBetween(values[0], values[1]);
        const angle = angleBetween(values[0], values[1]);
        const center = { x: (values[0].x + values[1].x) / 2, y: (values[0].y + values[1].y) / 2 };
        if (this.multiSnapshot) {
          const zoom = Math.log2(Math.max(0.001, distance) / Math.max(0.001, this.multiSnapshot.distance));
          let turn = angle - this.multiSnapshot.angle;
          if (turn > Math.PI) turn -= Math.PI * 2;
          if (turn < -Math.PI) turn += Math.PI * 2;
          this.renderer.zoomBy(zoom, center.x, center.y);
          this.renderer.shiftPhase(turn * 2.4, (center.y - this.multiSnapshot.center.y) * -1.8);
          if (Math.abs(zoom) > 0.002) this.onGesture('zoom');
          if (Math.abs(turn) > 0.002) this.onGesture('phase');
        }
        this.multiSnapshot = { distance, angle, center };
      } else {
        const deltaX = point.x - previous.x;
        const deltaY = point.y - previous.y;
        const elapsed = Math.max(8, point.time - previous.time);
        const velocity = clamp(Math.hypot(deltaX, deltaY) * 1000 / elapsed, 0, 1.5);
        this.dragDistance += Math.hypot(deltaX, deltaY);
        if (event.shiftKey) {
          this.renderer.shiftPhase(deltaX * 6.5, -deltaY * 3.2);
          this.onGesture('phase');
        } else {
          this.renderer.comb(deltaX, deltaY, velocity);
          this.onGesture('drag');
        }
      }
      event.preventDefault();
    };

    this.onPointerUp = (event) => {
      if (this.pointers.has(event.pointerId) && this.dragDistance > 0.012) this.renderer.pulse(clamp(this.dragDistance * 2.5, 0.18, 0.9));
      this.pointers.delete(event.pointerId);
      this.multiSnapshot = null;
      if (this.pointers.size === 2) this.captureMulti();
      event.preventDefault();
    };

    this.onWheel = (event) => {
      const point = this.position(event);
      const units = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 0.035 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 0.7 : 0.0024;
      const sensitivity = event.ctrlKey ? 1.45 : 1;
      this.renderer.zoomBy(-event.deltaY * units * sensitivity, point.x, point.y);
      this.onGesture('zoom');
      event.preventDefault();
    };

    this.onDoubleClick = (event) => {
      const point = this.position(event);
      this.renderer.focusAt(point.x, point.y);
      this.onGesture('focus');
      event.preventDefault();
    };

    this.element.addEventListener('pointerdown', this.onPointerDown);
    this.element.addEventListener('pointermove', this.onPointerMove);
    this.element.addEventListener('pointerup', this.onPointerUp);
    this.element.addEventListener('pointercancel', this.onPointerUp);
    this.element.addEventListener('wheel', this.onWheel, { passive: false });
    this.element.addEventListener('dblclick', this.onDoubleClick);
    this.element.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  captureMulti() {
    const values = [...this.pointers.values()].slice(0, 2);
    if (values.length < 2) return;
    this.multiSnapshot = {
      distance: distanceBetween(values[0], values[1]),
      angle: angleBetween(values[0], values[1]),
      center: { x: (values[0].x + values[1].x) / 2, y: (values[0].y + values[1].y) / 2 },
    };
  }
}
