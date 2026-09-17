// Deterministic, renderer-independent driving and footprint collision geometry.
export const METERS_PER_DEGREE = 111320;
export const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
export const wrapLon = lon => ((lon + 180) % 360 + 360) % 360 - 180;
export function localPoint(point, origin) {
  return { x: wrapLon(point.lon - origin.lon) * METERS_PER_DEGREE * Math.cos(origin.lat * Math.PI / 180),
    y: (point.lat - origin.lat) * METERS_PER_DEGREE };
}
export function geoPoint(point, origin) {
  return { lon: wrapLon(origin.lon + point.x / (METERS_PER_DEGREE * Math.cos(origin.lat * Math.PI / 180))),
    lat: origin.lat + point.y / METERS_PER_DEGREE };
}
export function distance(a, b) { const p = localPoint(a, b); return Math.hypot(p.x, p.y); }
export function closestOnSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1), 0, 1);
  const x = a.x + t * dx, y = a.y + t * dy;
  return { x, y, distance: Math.hypot(p.x - x, p.y - y), t };
}
function inside(p, ring) {
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if (((a.y > p.y) !== (b.y > p.y)) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) result = !result;
  }
  return result;
}
export function circleHitsPolygon(point, radius, outer, holes = []) {
  const rings = [outer, ...holes];
  if (inside(point, outer) && !holes.some(ring => inside(point, ring))) return true;
  return rings.some(ring => ring.some((a, i) => closestOnSegment(point, a, ring[(i + 1) % ring.length]).distance <= radius));
}
export function carHits(state, obstacles) {
  // A capsule: three discs cover the full body, including the front/rear corners.
  const forward = { x: Math.sin(state.heading), y: Math.cos(state.heading) };
  return [-1.3, 0, 1.3].some(offset => {
    const p = { x: state.x + forward.x * offset, y: state.y + forward.y * offset };
    return obstacles.some(o => {
      if (p.x < o.bounds.minX - 1.05 || p.x > o.bounds.maxX + 1.05 || p.y < o.bounds.minY - 1.05 || p.y > o.bounds.maxY + 1.05) return false;
      return o.line ? o.outer.slice(1).some((b, i) => closestOnSegment(p, o.outer[i], b).distance < 1.05)
        : circleHitsPolygon(p, 1.05, o.outer, o.holes);
    });
  });
}
export function integrate(state, input, dt, isBlocked) {
  // Small fixed-distance substeps prevent tunnelling through thin walls at speed.
  dt = clamp(dt, 0, .05);
  const steps = Math.max(1, Math.ceil(Math.abs(state.speed) * dt / .35));
  let hit = false, travelled = 0;
  for (let i = 0; i < steps; i++) {
    const t = dt / steps;
    const targetSteer = clamp(input.steer || 0, -1, 1) * .48 / (1 + Math.abs(state.speed) * .035);
    state.steer += (targetSteer - state.steer) * Math.min(1, t * 9);
    let acceleration = (input.throttle || 0) * (state.speed < -.5 ? 14 : 7.6);
    if (input.reverse) acceleration -= state.speed > .5 ? 17 : 4.5;
    if (input.brake) acceleration -= Math.sign(state.speed) * Math.min(Math.abs(state.speed) / t, 20);
    acceleration -= state.speed * .12 + Math.sign(state.speed) * .35;
    state.speed = clamp(state.speed + acceleration * t, -9, 44);
    if (!input.throttle && !input.reverse && Math.abs(state.speed) < .1) state.speed = 0;
    const heading = state.heading + state.speed / 2.7 * Math.tan(state.steer) * t;
    const next = { ...state, heading, x: state.x + Math.sin(heading) * state.speed * t, y: state.y + Math.cos(heading) * state.speed * t };
    if (isBlocked(next)) { state.speed = 0; hit = true; break; }
    travelled += Math.hypot(next.x - state.x, next.y - state.y);
    Object.assign(state, next);
  }
  return { hit, travelled };
}

const drivable = /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|road|track)(?:_link)?$/;
export function roadAllowed(tags = {}) {
  return drivable.test(tags.highway || '') && tags.access !== 'no' && tags.motor_vehicle !== 'no' && tags.tunnel !== 'yes';
}
export function findSpawn(roads, obstacles) {
  const candidates = [];
  for (const road of roads) {
    if (!roadAllowed(road.tags)) continue;
    for (let i = 1; i < road.points.length; i++) {
      const a = road.points[i - 1], b = road.points[i];
      const closest = closestOnSegment({ x: 0, y: 0 }, a, b);
      const heading = Math.atan2(b.x - a.x, b.y - a.y);
      for (const point of [closest, a, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }]) {
        const candidate = { x: point.x, y: point.y, heading, speed: 0, steer: 0, road: road.name };
        const range = Math.hypot(candidate.x, candidate.y);
        if (range < 700 && !carHits(candidate, obstacles)) candidates.push({ ...candidate, range });
      }
    }
  }
  return candidates.sort((a, b) => a.range - b.range)[0] || null;
}
