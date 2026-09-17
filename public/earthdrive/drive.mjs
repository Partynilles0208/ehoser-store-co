import { integrate, geoPoint, findSpawn } from './physics.mjs';
import { DrivingWorld } from './world.mjs';

const $ = id => document.getElementById(id);
export class Drive {
  constructor({ origin, api, config, progress, toast, signal }) {
    Object.assign(this, { origin, api, config, progress, toast, signal });
    this.C = window.Cesium;
    this.events = new AbortController();
    this.state = { x: 0, y: 0, speed: 0, steer: 0, heading: 0 };
    this.keys = new Set(); this.touch = new Set(); this.height = 0; this.heightGrid = new Map(); this.heightQueue = [];
    this.cameraMode = 0; this.paused = false; this.ready = false; this.disposed = false; this.travelled = 0;
    this.last = 0; this.accumulator = 0; this.sampleAt = 0; this.hudAt = 0; this.wheelAngle = 0;
    this.position = new this.C.Cartesian3(); this.orientation = new this.C.Quaternion();
  }
  check() { if (this.signal.aborted || this.disposed) throw new DOMException('Abgebrochen', 'AbortError'); }
  async deadline(promise, ms = 24000) {
    let timer, abort;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Die 3D-Welt lädt zu lange. Bitte erneut versuchen.')), ms);
        abort = () => reject(new DOMException('Abgebrochen', 'AbortError'));
        this.signal.addEventListener('abort', abort, { once: true });
        if (this.signal.aborted) abort();
      })]);
    } finally { clearTimeout(timer); this.signal.removeEventListener('abort', abort); }
  }
  async init() {
    const C = this.C;
    this.viewer = new C.Viewer('earth', {
      baseLayer: false, baseLayerPicker: false, terrainProvider: new C.EllipsoidTerrainProvider(),
      geocoder: false, homeButton: false, sceneModePicker: false, navigationHelpButton: false,
      timeline: false, animation: false, fullscreenButton: false, infoBox: false, selectionIndicator: false,
      shouldAnimate: false, scene3DOnly: true, requestRenderMode: true,
      maximumRenderTimeChange: Infinity, creditContainer: $('credits'), contextOptions: { webgl: { alpha: false } }
    });
    const scene = this.viewer.scene;
    scene.screenSpaceCameraController.enableInputs = false;
    scene.globe.baseColor = C.Color.fromCssColorString('#9cbca5');
    scene.backgroundColor = C.Color.fromCssColorString('#b1d5e5');
    scene.fog.enabled = true;
    this.viewer.clock.currentTime = C.JulianDate.fromIso8601('2026-06-21T12:00:00Z');
    scene.globe.enableLighting = false;
    scene.highDynamicRange = true;
    scene.postProcessStages.fxaa.enabled = true;
    this.applyQuality();
    this.viewer.camera.setView({ destination: C.Cartesian3.fromDegrees(this.origin.lon, this.origin.lat, 1800), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
    this.progress(35, 'Straßen und feste Gebäude werden geladen …');
    this.world = new DrivingWorld(this.viewer, this.origin, this.api, this.config, true);
    let cell;
    try {
      cell = await this.world.load(this.origin, this.signal);
    } catch (error) {
      this.check();
      cell = this.world.loadFallback(this.origin);
      this.toast('OpenStreetMap-Daten sind gerade nicht erreichbar. Eine vereinfachte lokale Straße ist aktiv.', 7000);
    }
    this.check();
    const spawn = findSpawn(cell.roads, cell.obstacles);
    if (!spawn) throw new Error('Hier wurde keine freie, befahrbare Straße gefunden. Wähle auf der Karte einen Ort näher an einer Straße.');
    this.spawn = { ...spawn }; Object.assign(this.state, spawn);
    const location = geoPoint(this.state, this.origin);
    this.progress(55, '3D-Landschaft wird aufgebaut …');
    if (this.config.google3d) {
      try {
        // The default URL goes straight to Google's renderer to avoid a Vercel
        // serverless timeout on the first root tileset request. Keep the bearer
        // header only for the optional local proxy.
        const headers = this.config.tileUrl.startsWith('/api/earthdrive/')
          ? { Authorization: `Bearer ${localStorage.getItem('token') || ''}` } : undefined;
        const resource = new C.Resource({ url: this.config.tileUrl, headers });
        let acceptTiles = true;
        const pendingTiles = C.Cesium3DTileset.fromUrl(resource, { showCreditsOnScreen: true, maximumScreenSpaceError: this.qualityError, cacheBytes: 192 * 1024 * 1024 });
        pendingTiles.then(tiles => { if ((!acceptTiles || this.disposed) && !tiles.isDestroyed()) tiles.destroy(); }).catch(() => {});
        try { this.tiles = await this.deadline(pendingTiles); }
        catch (error) { acceptTiles = false; throw error; }
        this.check(); this.viewer.scene.primitives.add(this.tiles);
        scene.globe.show = false;
        this.viewer.camera.setView({ destination: C.Cartesian3.fromDegrees(location.lon, location.lat, 1200), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
        if (!scene.sampleHeightSupported) throw new Error('Keine Höhenabfrage verfügbar');
        const points = [C.Cartographic.fromDegrees(location.lon, location.lat)];
        await this.deadline(scene.sampleHeightMostDetailed(points), 22000);
        this.check();
        if (!Number.isFinite(points[0]?.height) || points[0].height < -500) throw new Error('Keine 3D-Abdeckung');
        this.height = points[0].height;
        this.photorealistic = true;
        this.tiles.tileFailed.addEventListener(() => {
          if (!this.disposed) $('world-status').textContent = '3D-Kacheln fehlen – warte auf vollständigen Boden.';
        });
      } catch (error) {
        this.check();
        if (this.tiles && scene.primitives.contains(this.tiles)) scene.primitives.remove(this.tiles);
        this.tiles = null;
        this.toast('Google-3D ist hier nicht verfügbar. Du fährst in der OSM-3D-Ansicht mit festen Gebäuden.', 6500);
      }
    }
    if (!this.photorealistic) {
      scene.globe.show = true;
      this.viewer.imageryLayers.addImageryProvider(new C.UrlTemplateImageryProvider({
        url: this.config.osmTileUrl, maximumLevel: 19,
        credit: new C.Credit('© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>', true)
      }));
      this.world.photorealistic = false;
      this.world.refreshVisuals();
      this.height = .16;
    }
    this.check();
    this.progress(86, 'Dein Auto wird auf die Straße gesetzt …');
    this.spawnHeight = this.height;
    this.car = this.viewer.entities.add({
      position: new C.CallbackPositionProperty(() => this.position, false),
      orientation: new C.CallbackProperty(() => this.orientation, false),
      model: { uri: '/earthdrive/e1-touring.gltf', scale: 1, minimumPixelSize: 0, shadows: C.ShadowMode.ENABLED,
        nodeTransformations: Object.fromEntries(['wheelFL', 'wheelFR', 'wheelRL', 'wheelRR'].map(name => [name, {
          rotation: new C.CallbackProperty(() => {
            const steer = name.includes('F') ? this.state.steer : 0;
            const spin = C.Quaternion.fromAxisAngle(C.Cartesian3.UNIT_Z, -this.wheelAngle);
            return C.Quaternion.multiply(C.Quaternion.fromAxisAngle(C.Cartesian3.UNIT_Y, -steer), spin, new C.Quaternion());
          }, false)
        }]))
      }
    });
    $('trip-name').textContent = this.origin.name || this.spawn.road;
    $('renderer-label').textContent = this.photorealistic
      ? 'Google Photorealistic 3D · Höhen folgen der Landschaft. Feste OSM-Gebäude und zusätzliche Höhenprüfungen begrenzen deine Fahrt.'
      : 'OSM-3D · Echte Straßen und feste Gebäude aus OpenStreetMap. Vereinfachte Gebäudehöhen und ebener Boden.';
      $('world-status').textContent = this.photorealistic ? 'Fotorealistische 3D-Welt' : (this.world.degraded ? 'OSM-Karte · lokale Ausweichstraße' : 'OSM-3D · vereinfachte Landschaft');
    this.bind(); this.ready = true; this.updateCar(0); this.updateCamera(true); this.sampleGround();
    this.progress(100, 'Bereit. Gute Fahrt!');
    this.frame = requestAnimationFrame(time => this.tick(time));
  }
  applyQuality() {
    const quality = $('quality').value;
    this.qualityError = quality === 'high' ? 5 : quality === 'low' ? 18 : 10;
    if (this.tiles) this.tiles.maximumScreenSpaceError = this.qualityError;
    this.viewer.resolutionScale = quality === 'low' ? .75 : quality === 'high' ? Math.min(devicePixelRatio, 1.5) : 1;
    this.viewer.shadows = quality === 'high';
    this.viewer.scene.requestRender();
  }
  bind() {
    const on = (target, event, callback) => target.addEventListener(event, callback, { signal: this.events.signal });
    on(window, 'keydown', e => {
      if (e.target.matches('input, select, textarea') || $('settings').open) return;
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight', 'Space'].includes(e.code)) { e.preventDefault(); this.keys.add(e.code); }
      if (e.repeat) return;
      if (e.code === 'KeyC') this.cycleCamera();
      if (e.code === 'KeyR') this.reset();
      if (e.code === 'Escape') this.setPaused(!this.paused);
    });
    on(window, 'keyup', e => this.keys.delete(e.code));
    on(window, 'blur', () => this.setPaused(true));
    on(document, 'visibilitychange', () => { if (document.hidden) this.setPaused(true); });
    for (const button of document.querySelectorAll('[data-control]')) {
      on(button, 'pointerdown', e => { e.preventDefault(); button.setPointerCapture(e.pointerId); this.touch.add(button.dataset.control); button.classList.add('active'); this.startAudio(); });
      const release = () => { this.touch.delete(button.dataset.control); button.classList.remove('active'); };
      on(button, 'pointerup', release); on(button, 'pointercancel', release); on(button, 'lostpointercapture', release);
    }
    on($('pause-button'), 'click', () => this.setPaused(!this.paused));
    on($('resume'), 'click', () => { this.setPaused(false); this.startAudio(); });
    on($('camera-button'), 'click', () => this.cycleCamera());
    on($('settings-button'), 'click', () => { this.setPaused(true); $('settings').showModal(); });
    on($('settings'), 'close', () => { if (this.ready) this.setPaused(false); });
    on($('quality'), 'change', () => this.applyQuality());
    on($('sound'), 'change', () => this.startAudio());
    on($('reset-car'), 'click', () => this.reset());
    on($('fullscreen'), 'click', async () => {
      try { if (document.fullscreenElement) await document.exitFullscreen(); else await $('driving').requestFullscreen(); }
      catch { this.toast('Vollbild ist in diesem Browser nicht verfügbar.'); }
    });
    on(window, 'keydown', () => this.startAudio());
    this.viewer.scene.canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); this.setPaused(true); this.toast('Die Grafikverbindung wurde unterbrochen. Kehre zur Karte zurück und starte die Fahrt neu.', 7000); }, { signal: this.events.signal });
  }
  clearInput() { this.keys.clear(); this.touch.clear(); document.querySelectorAll('[data-control]').forEach(b => b.classList.remove('active')); }
  setPaused(value) { this.paused = value; this.clearInput(); $('paused').hidden = !value; this.last = 0; this.accumulator = 0; }
  cycleCamera() { this.cameraMode = (this.cameraMode + 1) % 3; this.toast(['Verfolgerkamera', 'Motorhaubenkamera', 'Übersicht'][this.cameraMode]); this.updateCamera(true); }
  reset() {
    Object.assign(this.state, this.spawn); this.height = this.spawnHeight;
    this.heightGrid.clear(); this.heightQueue = []; this.sampleAt = 0;
    this.clearInput(); this.updateCar(0); this.updateCamera(true); this.sampleGround();
    this.toast('Auto am Startpunkt zurückgesetzt.');
  }
  startAudio() {
    if (!$('sound').checked || this.audio || this.disposed) return;
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) return;
    try {
      this.audio = new Audio(); this.osc = this.audio.createOscillator(); this.gain = this.audio.createGain();
      const filter = this.audio.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 230;
      this.osc.type = 'sawtooth'; this.gain.gain.value = 0;
      this.osc.connect(filter); filter.connect(this.gain); this.gain.connect(this.audio.destination); this.osc.start();
      this.audio.resume().catch(() => {});
    } catch { /* Sound is optional. */ }
  }
  input() {
    const key = (...names) => names.some(n => this.keys.has(n));
    return { throttle: key('KeyW', 'ArrowUp') || this.touch.has('throttle') ? 1 : 0,
      reverse: key('KeyS', 'ArrowDown') || this.touch.has('reverse'),
      steer: (key('KeyD', 'ArrowRight') || this.touch.has('right') ? 1 : 0) - (key('KeyA', 'ArrowLeft') || this.touch.has('left') ? 1 : 0),
      brake: key('Space') || this.touch.has('brake') };
  }
  heightKey(x, y) { return `${Math.round(x)},${Math.round(y)}`; }
  sampleGround() {
    if (!this.photorealistic || this.disposed || !this.car) return;
    const C = this.C, scene = this.viewer.scene;
    const time = performance.now();
    const lead = Math.max(5, Math.abs(this.state.speed) * .45 + 3), sign = this.state.speed < 0 ? -1 : 1;
    const forward = { x: Math.sin(this.state.heading) * sign, y: Math.cos(this.state.heading) * sign };
    // Cache a short strip under and ahead of the wheels. Movement fails closed
    // outside sampled ground, so unloaded terrain cannot become a shortcut.
    if (time >= this.sampleAt || !this.heightQueue.length) {
      const wanted = new Map();
      for (let i = -3; i <= lead; i += .6) {
        for (const side of [-1.5, -.75, 0, .75, 1.5]) {
          const x = Math.round(this.state.x + forward.x * i + forward.y * side);
          const y = Math.round(this.state.y + forward.y * i - forward.x * side);
          const key = this.heightKey(x, y), existing = this.heightGrid.get(key);
          if (existing && time - existing.at < (Number.isFinite(existing.h) ? 1300 : 250)) continue;
          wanted.set(key, { x, y, key, priority: Math.hypot(x - this.state.x, y - this.state.y) });
        }
      }
      this.heightQueue = [...wanted.values()].sort((a, b) => a.priority - b.priority);
      this.sampleAt = time + 160;
    }
    // Depth queries are distributed across frames to avoid one large GPU stall.
    for (const point of this.heightQueue.splice(0, 8)) {
      const geo = geoPoint(point, this.origin);
      const h = scene.sampleHeight(C.Cartographic.fromDegrees(geo.lon, geo.lat), [this.car], .7);
      this.heightGrid.set(point.key, { h, at: time });
    }
    if (this.heightGrid.size > 2000) this.heightGrid = new Map([...this.heightGrid].slice(-1000));
  }
  blocked(next) {
    const point = geoPoint(next, this.origin);
    if (Math.abs(point.lat) > 84.9 || !this.world.covered(point)) { this.blockReason = 'Umgebung lädt – kurz warten.'; return true; }
    if (this.world.blocked(next)) { this.blockReason = 'Hindernis – lenke zurück auf die Straße.'; return true; }
    if (this.photorealistic) {
      // Front and rear probes include the car's full footprint. Abrupt rises
      // (walls/parked scan geometry) stop the car; gentle slopes remain drivable.
      for (const offset of [0, 1.8, -1.8]) {
        const x = next.x + Math.sin(next.heading) * offset, y = next.y + Math.cos(next.heading) * offset;
        const sample = this.heightGrid.get(this.heightKey(x, y));
        if (!sample || !Number.isFinite(sample.h) || performance.now() - sample.at > 2000) { this.blockReason = '3D-Boden lädt – kurz warten.'; return true; }
        if (Math.abs(sample.h - this.height) > 1.4) { this.blockReason = 'Hindernis oder zu steile Kante.'; return true; }
      }
    }
    return false;
  }
  tick(time) {
    if (this.disposed) return;
    const dt = this.last ? Math.min((time - this.last) / 1000, .05) : 0;
    this.last = time;
    if (!this.paused) {
      if (Date.now() >= this.config.expiresAt) { this.setPaused(true); this.toast('Dein Pro-Zugang wird erneut geprüft.'); }
      else {
        this.sampleGround();
        this.accumulator += dt;
        while (this.accumulator >= 1 / 60) {
          const result = integrate(this.state, this.input(), 1 / 60, next => this.blocked(next));
          this.travelled += result.travelled; this.wheelAngle += result.travelled / .34;
          if (result.hit) $('world-status').textContent = this.blockReason;
          this.accumulator -= 1 / 60;
        }
        this.updateCar(dt); this.updateCamera();
        this.world.stream(geoPoint(this.state, this.origin), this.signal, text => { if (!this.disposed) $('world-status').textContent = text; });
      }
    }
    if (time > this.hudAt) { this.updateHud(); this.hudAt = time + 100; }
    if (this.audio) {
      this.osc.frequency.setTargetAtTime(35 + Math.abs(this.state.speed) * 4, this.audio.currentTime, .1);
      this.gain.gain.setTargetAtTime(!this.paused && $('sound').checked ? .024 : 0, this.audio.currentTime, .08);
    }
    this.viewer.scene.requestRender();
    this.frame = requestAnimationFrame(t => this.tick(t));
  }
  updateCar(dt) {
    const C = this.C;
    if (this.photorealistic) {
      const h = this.heightGrid.get(this.heightKey(this.state.x, this.state.y))?.h;
      if (Number.isFinite(h) && Math.abs(h - this.height) < 1.4) this.height += (h - this.height) * Math.min(1, dt * 16);
    }
    const geo = geoPoint(this.state, this.origin);
    C.Cartesian3.fromDegrees(geo.lon, geo.lat, this.height + .06, C.Ellipsoid.WGS84, this.position);
    C.Transforms.headingPitchRollQuaternion(this.position, new C.HeadingPitchRoll(this.state.heading - Math.PI / 2, 0, -this.state.steer * this.state.speed * .006), C.Ellipsoid.WGS84, C.Transforms.eastNorthUpToFixedFrame, this.orientation);
  }
  updateCamera(immediate = false) {
    if (!this.viewer || this.disposed) return;
    const C = this.C;
    const range = this.cameraMode === 0 ? 13 + Math.abs(this.state.speed) * .13 : this.cameraMode === 1 ? 1 : 38;
    const elevation = this.cameraMode === 0 ? 5.6 : this.cameraMode === 1 ? 1.45 : 30;
    const forward = { x: Math.sin(this.state.heading), y: Math.cos(this.state.heading) };
    const behind = { x: this.state.x - forward.x * range, y: this.state.y - forward.y * range };
    let height = this.height + elevation;
    // Camera clearance against nearby OSM roofs in both render modes.
    for (const feature of this.world.near({ ...behind, heading: this.state.heading })) {
      const b = feature.bounds;
      if (!feature.water && behind.x >= b.minX && behind.x <= b.maxX && behind.y >= b.minY && behind.y <= b.maxY) height = Math.max(height, this.height + feature.height + 3);
    }
    const location = geoPoint(behind, this.origin);
    const destination = C.Cartesian3.fromDegrees(location.lon, location.lat, height);
    if (!immediate && this.cameraMode !== 1) C.Cartesian3.lerp(this.viewer.camera.positionWC, destination, .16, destination);
    const aimGeo = geoPoint({ x: this.state.x + forward.x * 8, y: this.state.y + forward.y * 8 }, this.origin);
    const aim = C.Cartesian3.fromDegrees(aimGeo.lon, aimGeo.lat, this.height + 1.2);
    const direction = C.Cartesian3.normalize(C.Cartesian3.subtract(aim, destination, new C.Cartesian3()), new C.Cartesian3());
    const up = C.Ellipsoid.WGS84.geodeticSurfaceNormal(destination, new C.Cartesian3());
    this.viewer.camera.setView({ destination, orientation: { direction, up } });
    if (this.car) this.car.show = this.cameraMode !== 1;
  }
  updateHud() {
    $('speed').textContent = Math.round(Math.abs(this.state.speed) * 3.6);
    $('gear').textContent = this.state.speed < -.1 ? 'R' : 'D';
    $('speed-bar').style.width = `${Math.abs(this.state.speed) / 44 * 100}%`;
    $('trip-distance').textContent = `${(this.travelled / 1000).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} km`;
    const compass = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'];
    $('heading').textContent = compass[((Math.round(this.state.heading / (Math.PI / 4)) % 8) + 8) % 8];
    const ctx = $('mini-map').getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, 320, 240); ctx.fillStyle = '#183e33'; ctx.fillRect(0, 0, 320, 240);
    const transform = p => ({ x: 160 + (p.x - this.state.x) * .7, y: 120 - (p.y - this.state.y) * .7 });
    ctx.strokeStyle = '#78958b'; ctx.lineWidth = 4;
    for (const road of this.world.roads) {
      ctx.beginPath();
      road.points.forEach((p, i) => { const s = transform(p); if (i) ctx.lineTo(s.x, s.y); else ctx.moveTo(s.x, s.y); }); ctx.stroke();
    }
    ctx.save(); ctx.translate(160, 120); ctx.rotate(this.state.heading);
    ctx.fillStyle = '#bcf7d6'; ctx.shadowColor = '#10251d'; ctx.shadowBlur = 10;
    ctx.beginPath(); ctx.moveTo(0, -11); ctx.lineTo(7, 8); ctx.lineTo(0, 5); ctx.lineTo(-7, 8); ctx.closePath(); ctx.fill(); ctx.restore();
  }
  dispose() {
    this.disposed = true; this.ready = false; this.events.abort(); this.clearInput(); cancelAnimationFrame(this.frame);
    if (this.audio) this.audio.close().catch(() => {});
    if (this.world) this.world.dispose();
    if (this.viewer && !this.viewer.isDestroyed()) this.viewer.destroy();
    $('paused').hidden = true; if ($('settings').open) $('settings').close();
    $('earth').replaceChildren(); $('credits').replaceChildren();
  }
}
