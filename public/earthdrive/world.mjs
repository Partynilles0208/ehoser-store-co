import { localPoint, geoPoint, distance, carHits, roadAllowed, closestOnSegment } from './physics.mjs';

const same = (a, b) => a && b && a.lat === b.lat && a.lon === b.lon;
function joinRings(members) {
  const pending = members.map(m => m.geometry?.filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon))).filter(p => p?.length > 1);
  const result = [];
  while (pending.length) {
    const ring = [...pending.pop()];
    let changed = true;
    while (!same(ring[0], ring.at(-1)) && changed) {
      changed = false;
      for (let i = 0; i < pending.length; i++) {
        let segment = pending[i];
        if (same(ring.at(-1), segment.at(-1))) segment = [...segment].reverse();
        if (same(ring.at(-1), segment[0])) { ring.push(...segment.slice(1)); pending.splice(i, 1); changed = true; break; }
        if (same(ring[0], segment[0])) segment = [...segment].reverse();
        if (same(ring[0], segment.at(-1))) { ring.unshift(...segment.slice(0, -1)); pending.splice(i, 1); changed = true; break; }
      }
    }
    if (ring.length >= 4 && same(ring[0], ring.at(-1))) result.push(ring.slice(0, -1));
  }
  return result;
}
function bounds(points) {
  return points.reduce((box, p) => ({ minX: Math.min(box.minX, p.x), minY: Math.min(box.minY, p.y), maxX: Math.max(box.maxX, p.x), maxY: Math.max(box.maxY, p.y) }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
}
export function parseWorld(data, origin) {
  const obstacles = [], buildings = [], roads = [];
  const relationMembers = new Set(data.elements.filter(e => e.type === 'relation' && e.tags?.building).flatMap(e => (e.members || []).map(m => m.ref)));
  for (const element of data.elements) {
    const tags = element.tags || {};
    const geometry = (element.geometry || []).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon));
    if (tags.highway && geometry.length >= 2 && roadAllowed(tags)) {
      roads.push({ id: element.id, tags, geo: geometry, points: geometry.map(p => localPoint(p, origin)), name: tags.name || 'Unbenannte Straße' });
    }
    const water = tags.natural === 'water', line = Boolean(tags.barrier);
    if ((!tags.building && !water && !line) || tags.building === 'no') continue;
    if (element.type === 'way' && relationMembers.has(element.id)) continue;
    const rings = element.type === 'relation'
      ? joinRings((element.members || []).filter(m => m.role === 'outer' || !m.role))
      : geometry.length >= (line ? 2 : 4) ? [same(geometry[0], geometry.at(-1)) ? geometry.slice(0, -1) : geometry] : [];
    const holes = element.type === 'relation' ? joinRings((element.members || []).filter(m => m.role === 'inner')) : [];
    for (const [ringIndex, ring] of rings.entries()) {
      const outer = ring.map(p => localPoint(p, origin));
      const height = Math.min(350, Math.max(3, parseFloat(tags.height) || (parseFloat(tags['building:levels']) || 3) * 3.2));
      const feature = { id: `${element.type}/${element.id}/${ringIndex}`, outer, holes: holes.map(r => r.map(p => localPoint(p, origin))), bounds: bounds(outer), line, water, geo: ring, geoHoles: holes, height };
      if (parseFloat(tags.min_height || tags['building:min_level'] * 3.2) < 2.5 || !Number.isFinite(parseFloat(tags.min_height || tags['building:min_level'] * 3.2))) obstacles.push(feature);
      buildings.push(feature);
    }
  }
  return { obstacles, buildings, roads, center: data.center, radius: data.radius };
}

export class DrivingWorld {
  constructor(viewer, origin, api, config, photorealistic) {
    this.viewer = viewer; this.origin = origin; this.api = api; this.config = config; this.photorealistic = photorealistic;
    this.cells = []; this.grid = new Map(); this.roads = []; this.disposed = false; this.loading = false; this.retryAt = 0;
    this.visuals = [];
  }
  async load(point, signal) {
    const data = await this.api(`/world?lat=${point.lat}&lon=${point.lon}`, { signal, timeout: 50000 });
    if (this.disposed) return null;
    const cell = parseWorld(data, this.origin);
    const duplicate = this.cells.find(c => c.center.lat === cell.center.lat && c.center.lon === cell.center.lon);
    if (duplicate) return duplicate;
    this.cells.push(cell);
    if (this.cells.length > 4) this.cells.shift();
    this.rebuild();
    if (!this.photorealistic) this.refreshVisuals();
    return cell;
  }
  loadFallback(point) {
    // Keep the map and car usable when a public Overpass instance is down.
    // This is deliberately labelled as a local fallback; it does not pretend
    // that synthetic roads are OSM survey data.
    const span = .006;
    const elements = [
      { type: 'way', id: 'fallback-east-west', tags: { highway: 'residential', name: 'Lokale Ausweichstraße' }, geometry: [
        { lat: point.lat, lon: point.lon - span }, { lat: point.lat, lon: point.lon + span }
      ] },
      { type: 'way', id: 'fallback-north-south', tags: { highway: 'residential', name: 'Lokale Ausweichstraße' }, geometry: [
        { lat: point.lat - span, lon: point.lon }, { lat: point.lat + span, lon: point.lon }
      ] }
    ];
    const cell = parseWorld({ center: { lat: point.lat, lon: point.lon }, radius: 1000, elements }, this.origin);
    this.cells = [cell]; this.rebuild(); this.refreshVisuals();
    this.degraded = true;
    return cell;
  }
  rebuild() {
    this.grid.clear(); this.roads = [...new Map(this.cells.flatMap(c => c.roads).map(r => [r.id, r])).values()];
    for (const feature of new Map(this.cells.flatMap(c => c.obstacles).map(f => [f.id, f])).values()) {
      const b = feature.bounds;
      // Very large lakes are handled separately instead of creating millions of buckets.
      if ((b.maxX - b.minX) * (b.maxY - b.minY) > 4000000) { const bucket = this.grid.get('large') || []; bucket.push(feature); this.grid.set('large', bucket); continue; }
      for (let x = Math.floor(b.minX / 32); x <= Math.floor(b.maxX / 32); x++) {
        for (let y = Math.floor(b.minY / 32); y <= Math.floor(b.maxY / 32); y++) {
          const key = `${x},${y}`, bucket = this.grid.get(key) || [];
          bucket.push(feature); this.grid.set(key, bucket);
        }
      }
    }
  }
  refreshVisuals() {
    const unique = [...new Map(this.cells.flatMap(c => c.buildings).map(f => [f.id, f])).values()];
    const previous = this.visuals;
    this.visuals = this.render({ buildings: unique, roads: this.roads });
    // Keep existing geometry visible until replacement batches are ready.
    const remove = this.viewer.scene.postRender.addEventListener(() => {
      if (this.disposed || this.visuals.every(p => p.ready === undefined || p.ready)) {
        remove(); previous.forEach(p => this.removePrimitive(p));
      }
    });
  }
  covered(point, margin = 100) { return this.cells.some(c => distance(point, c.center) < c.radius - margin); }
  near(state) {
    const set = new Set(this.grid.get('large') || []);
    for (let x = Math.floor((state.x - 4) / 32); x <= Math.floor((state.x + 4) / 32); x++) {
      for (let y = Math.floor((state.y - 4) / 32); y <= Math.floor((state.y + 4) / 32); y++) {
        for (const f of this.grid.get(`${x},${y}`) || []) set.add(f);
      }
    }
    // A mapped bridge is traversable above water.
    const onBridge = this.roads.some(road => road.tags.bridge === 'yes' && road.points.slice(1).some((b, i) => closestOnSegment(state, road.points[i], b).distance < 4));
    return [...set].filter(f => !f.water || !onBridge);
  }
  blocked(state) { return carHits(state, this.near(state)); }
  async stream(point, signal, onStatus) {
    if (this.loading || this.disposed || performance.now() < this.retryAt) return;
    if (this.cells.some(c => distance(point, c.center) < 480)) return;
    this.loading = true;
    onStatus('Umgebung lädt …');
    try { await this.load(point, signal); if (!this.disposed) onStatus('Umgebung bereit'); }
    catch (error) { if (!this.disposed) { this.retryAt = performance.now() + 12000; onStatus('Umgebung nicht geladen – Fahrt am Kartenrand angehalten.'); } }
    finally { this.loading = false; }
  }
  render(cell) {
    const C = window.Cesium, instances = [], roads = [];
    const positions = ring => C.Cartesian3.fromDegreesArray(ring.flatMap(p => [p.lon, p.lat]));
    for (const f of cell.buildings) {
      if (f.line) continue;
      const hash = [...f.id].reduce((n, c) => n + c.charCodeAt(0), 0);
      const colors = ['#dddfda', '#c7d7d4', '#e7dbc8', '#b9c7ca', '#ced0c3'];
      instances.push(new C.GeometryInstance({
        geometry: new C.PolygonGeometry({
          polygonHierarchy: new C.PolygonHierarchy(positions(f.geo), f.geoHoles.map(r => new C.PolygonHierarchy(positions(r)))),
          height: f.water ? .12 : 0, extrudedHeight: f.water ? .12 : f.height,
          vertexFormat: C.PerInstanceColorAppearance.VERTEX_FORMAT
        }),
        attributes: { color: C.ColorGeometryInstanceAttribute.fromColor(C.Color.fromCssColorString(f.water ? '#5a9fb1' : colors[hash % colors.length])) }
      }));
    }
    for (const road of cell.roads) {
      roads.push(new C.GeometryInstance({ geometry: new C.CorridorGeometry({ positions: positions(road.geo), height: .16,
        width: Math.max(4, Math.min(24, Number(road.tags.lanes || 2) * 3.3)), cornerType: C.CornerType.ROUNDED,
        vertexFormat: C.PerInstanceColorAppearance.VERTEX_FORMAT }),
        attributes: { color: C.ColorGeometryInstanceAttribute.fromColor(C.Color.fromCssColorString('#58636b')) } }));
    }
    const output = [];
    for (const geometryInstances of [instances, roads]) {
      if (geometryInstances.length) output.push(this.viewer.scene.primitives.add(new C.Primitive({
        geometryInstances, appearance: new C.PerInstanceColorAppearance({ closed: true, translucent: false }),
        asynchronous: true, shadows: C.ShadowMode.ENABLED
      })));
    }
    // Fences have the same fixed coordinates as their collision lines.
    for (const f of cell.buildings.filter(f => f.line)) {
      output.push(this.viewer.entities.add({ wall: { positions: positions(f.geo), minimumHeights: f.geo.map(() => 0), maximumHeights: f.geo.map(() => 1.7), material: C.Color.fromCssColorString('#899794') } }));
    }
    return output;
  }
  removePrimitive(p) { if (this.viewer.entities.contains(p)) this.viewer.entities.remove(p); else this.viewer.scene.primitives.remove(p); }
  dispose() { this.disposed = true; this.visuals.forEach(p => this.removePrimitive(p)); this.visuals = []; this.cells = []; this.grid.clear(); }
}
