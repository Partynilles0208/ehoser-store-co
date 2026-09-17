# EarthDrive

EarthDrive adds a Pro driving game at `/earthdrive/` and a launch card on the
existing ehoser homepage. It uses the existing ehoser login, JWT verification,
and server-side subscription profile. Premium includes Pro access, matching the
rest of the site.

## Play

1. Log in with an active Pro or Premium account.
2. Open **EarthDrive** on the homepage.
3. Choose a point on the OpenStreetMap map, select a suggested city, or submit
   a place/address in the search box at the top right.
4. Select **Fahrt starten**. The car spawns on a nearby, unblocked mapped road.

| Control | Action |
| --- | --- |
| W / up arrow | Accelerate |
| S / down arrow | Brake, then reverse |
| A / D or left / right arrows | Steer |
| Space | Brake |
| C | Chase, bonnet, or overhead camera |
| R | Return to the starting road |
| Escape | Pause |

Touch devices have independent steering, accelerator, reverse, and brake
buttons. Losing focus releases controls and pauses the car. Settings include
graphics quality, optional synthesized engine sound, reset, and fullscreen.

## Vercel / maps

Before deploying, configure the server's credentials in Vercel. During publishing,
the existing server file was found to contain hardcoded credential defaults;
this change removes them instead of uploading those values again.

| Variable | Requirement |
| --- | --- |
| `JWT_SECRET` | Required at startup; a stable secret shared with the existing authentication services |
| `UNLOCK_CODE` | Required for the existing code-based sign-in and registration flows |
| `ADMIN_UPLOAD_KEY` | Required for existing admin endpoints; requests are denied when unset |
| `PIXABAY_KEY` | Required only for the existing image search; returns 503 when unset |

Use fresh values for credentials previously committed to the repository. Removing
the literals does not remove earlier Git history. Rotating `JWT_SECRET` signs
users out, so coordinate that value with any other service verifying these tokens.

The existing `GOOGLE_MAPS_API_KEY` environment variable is used for Google
Photorealistic 3D Tiles. By default the browser loads Google's root tileset
directly, which avoids Vercel's short serverless timeout on a cold proxy request.
Set `EARTHDRIVE_DIRECT_TILES=false` to force the authenticated proxy instead.
No new account table or production dependency is needed. The key must have **Map Tiles API** access and its application
restrictions must permit server requests from the Vercel application. A key
enabled only for Maps JavaScript or restricted exclusively to browser referrers
does not automatically authorize these requests. The current key's permissions
and the live Vercel configuration were not accessible during implementation.

If the key, region, depth-texture support, or 3D data is unavailable, the game
shows a notice and uses the OSM-3D view: a real map, mapped roads and fixed,
extruded building footprints on flat ground. It does not label that view as
photorealistic terrain. Where OSM heights are absent, building heights are
estimated. Unavailable/incomplete OSM geometry stops loading with a retryable
error rather than creating an empty driveable world.

Optional provider overrides:

| Variable | Default |
| --- | --- |
| `EARTHDRIVE_OSM_TILES` | `https://tile.openstreetmap.org/{z}/{x}/{y}.png` |
| `EARTHDRIVE_GEOCODER_URL` | Photon-compatible `https://photon.komoot.io/api/` |
| `EARTHDRIVE_OVERPASS_URL` | Overpass API, with Private.coffee as one fallback for outages |

Search runs only after submitting the form. Search/world requests are cached
and coalesced per server instance. Limits are per user and per instance; this
is not a distributed billing quota. Larger deployments should configure
appropriately provisioned OSM/Photon/Overpass services and provider quotas.
Google tile responses are not cached by this proxy. Google/Cesium credits and
OSM attribution remain visible.

The existing Vercel Express entry point mounts `lib/earthdrive.js`. Its build
includes `public/**` and `lib/**`, with a 60-second function duration. Large
world and mesh responses use response streaming instead of buffered JSON/binary
responses, to accommodate Vercel response-size limits. Existing SkyBreak routes
are preserved.

## Access and terrain

- All `/api/earthdrive/*` endpoints require a verified ehoser token and a current
  server-side Pro subscription deadline. Local `proStatus` flags are ignored.
- The game renews a two-minute access lease every 45 seconds. Failed renewal
  closes the game; expiration pauses it. Tile requests use a subscription lookup
  cached for at most 15 seconds and never past the subscription deadline.
- Google manifests and binary meshes pass through an authenticated, fixed-host
  proxy. Nested URLs are rewritten; this feature's config/manifest responses do
  not include the Maps key. The site's pre-existing `/api/config` behavior is
  unchanged.
- The car has a full-body collision capsule and short physics steps to prevent
  passing through thin mapped walls at high speed. Building courtyards,
  fences/walls, and mapped water are handled; mapped bridges can cross water.
- Footprints stay at fixed geographic coordinates. Neighbouring areas stream
  while driving, deduplicate overlapping geometry, and retain a bounded working
  set. The car stops before leaving loaded collision coverage.
- Photorealistic mode samples ground ahead and under the car. Unloaded ground or
  abrupt height changes block movement. This is an arcade terrain/collision
  approximation, not a complete rigid-body collision mesh for every scanned
  object. Missing OSM features, tunnels, stacked roads, overhangs, and tiny scan
  objects have limitations. OSM fallback terrain is flat.

## Verification

Run the deterministic access, proxy, geometry, and driving tests:

```sh
npm ci
node --test tests/earthdrive/*.test.*
```

Local browser QA without real accounts:

```sh
node tests/earthdrive/preview.cjs --fixtures
# http://localhost:4173/qa/pro
# http://localhost:4173/qa/free
# http://localhost:4173/qa/logout
```

Omit `--fixtures` to use live OSM services. This harness is not imported by a
production entry point. It never supplies a Google key. The original E1 Touring
model can be rebuilt with `python scripts/generate-earthdrive-car.py`.

Completed checks include deterministic tests, JavaScript syntax, original glTF
asset validation, Cesium geometry creation and inherited authorization headers,
and a live Photon place search. The cloud browser could not open the local
preview, so visual/WebGL driving QA and a live Google-3D trip with the production
key remain to be performed on the Vercel preview. Live Overpass availability
could not be confirmed from this environment.

## Provider references

- [Google 3D Tiles renderer setup](https://developers.google.com/maps/documentation/tile/use-renderer)
- [Cesium height sampling](https://cesium.com/learn/cesiumjs/ref-doc/Scene.html#sampleHeight)
- [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/)
- [Overpass public instances](https://wiki.openstreetmap.org/wiki/Overpass_API)
- [Vercel response streaming and payload size](https://vercel.com/kb/guide/how-to-bypass-vercel-body-size-limit-serverless-functions)
