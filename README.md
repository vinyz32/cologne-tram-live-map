# Cologne Tram Live Map

Minimal live map for Cologne's tram/light-rail network. The project combines live vehicle positions with static network geometry and is designed for quick, glanceable use on mobile and on a small always-on display.

<p align="center"><img src="docs/cologne-tram-live-map.gif" width="260" alt="Cologne Tram Live Map demo"></p>

## Goal

Build a small, reliable live-tracking display that:

- shows current tram positions, direction and delay state;
- stays visually minimal and readable at a glance;
- works well on phone and compact displays;
- can run continuously on a Raspberry Pi;
- can be reached remotely through Tailscale without exposing the app publicly.

Longer term, the same core could support a PWA or native mobile app once an official realtime-data setup is in place.

## Current state

- **Live data:** experimental HAFAS `JourneyGeoPos` adapter (local access identifier required)
- **Network:** static VRS GTFS shapes and stops
- **Basemap:** OpenFreeMap / OpenMapTiles / OpenStreetMap
- **Polling:** browser refresh every 3 s, upstream HAFAS cache for 15 s
- **Movement:** smooth interpolation between snapshots
- **Track alignment:** live positions are visually snapped to plausible line geometry
- **Stops:** line-specific stop matching with approach/departure smoothing
- **Continuity:** marker reuse when journey IDs change or briefly disappear
- **Delay state:** on time / slightly delayed / highly delayed / unknown
- **Controls:** line filter, Cologne + 9 Stadtbezirke, free/kiosk mode
- **Responsive UI:** desktop and mobile layouts
- **Diagnostics:** `LIVE`, `SYNC`, `WAIT`, `OFFLINE` plus snapshot age, fetch time, changed vehicles and active motion count

## Architecture

```text
VRS GTFS static
  routes / trips / shapes / stops
              |
              v
        /api/network
              |
              +------------------+
                                 v
                           browser map
                                 ^
              +------------------+
              |
HAFAS JourneyGeoPos
              |
              v
       normalized vehicles
              |
              v
        15 s snapshot cache
              |
              v
        /api/vehicles
```

GTFS provides the static infrastructure. HAFAS provides the current operational vehicle state.

## Run locally

Requires Python 3.11+ and Conda/Miniconda.

```powershell
git clone https://github.com/vinyz32/cologne-tram-live-map.git
cd cologne-tram-live-map
conda env create -f environment.yml
conda activate cologne-tram-live-map

# Supply the provider access identifier locally; it is intentionally not
# distributed in this repository.
$env:COLOGNE_TRAM_HAFAS_AID="..."

cologne-tram-live-map
```

Open:

```text
http://127.0.0.1:8000
```

For private remote access through Tailscale, keep the application bound to localhost and proxy it through Tailscale Serve:

```text
cologne-tram-live-map
tailscale serve --bg http://127.0.0.1:8000
```

Binding to `0.0.0.0` is only necessary for direct LAN access and should be combined with appropriate firewall/network restrictions.

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/vehicles` | Latest cached live vehicle snapshot |
| `GET /api/network` | Static GTFS line geometry and stops |
| `GET /api/status` | Provider/cache diagnostics |
| `GET /api/config` | Frontend configuration |

Diagnostic probes:

```powershell
cologne-tram-hafas-probe
cologne-tram-gtfs-probe
```

## Data notes

### HAFAS source

The current prototype reads `JourneyGeoPos` from:

```text
https://auskunft.kvb.koeln/gate
```

The endpoint is used as an experimental technical source only. The repository does **not** distribute a HAFAS access identifier; one must be supplied locally and only where its use is authorized. This independent project is not affiliated with or endorsed by KVB. Positions should be treated as operational/calculated positions, not guaranteed raw GPS telemetry. A public hosted or commercial release should use an official realtime-data arrangement.

### VRS GTFS

Static GTFS supplies route definitions, shapes and stops. It is downloaded and parsed once per server process and then cached in memory. VRS publishes its GTFS timetable data under **Datenlizenz Deutschland – Zero – Version 2.0**.

### Basemap

Map rendering uses OpenFreeMap with OpenMapTiles/OpenStreetMap attribution. A raster OpenStreetMap fallback is available and links to the OpenStreetMap copyright / ODbL information.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the external data and software used by the project.

## Next

1. Run the app continuously on the Raspberry Pi.
2. Add Tailscale for permanent private phone access.
3. Observe long-running vehicle continuity and HAFAS edge cases.
4. Tune the UI for the final dedicated display.
5. Evaluate an official realtime feed before any public/commercial release.

## Public repository notes

- No personal credentials, Tailnet hostnames or local network addresses are required or tracked.
- Real `.env` files, logs and local IDE/runtime state are ignored by Git.
- Access logs are deliberately privacy-minimal and do not persist client IP addresses, forwarded IP addresses or user-agent strings.
- The project name and UI avoid operator logos or official branding.
- The HAFAS adapter is experimental; the code repository is suitable as a portfolio project, but the live backend should not be exposed as a public production service without an official realtime-data arrangement.
- Publishing the source code does not make the live HAFAS integration an endorsed or supported public API client.

## Scope

Independent hobby / learning project. Not an official transport-operator application.
