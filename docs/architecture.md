# Architecture

## Goal

Display estimated Cologne tram/light-rail positions on a small dedicated screen. The first version runs locally and serves a browser-based map.

## Principles

- Keep the codebase small.
- Separate data retrieval from presentation.
- Do not present calculated positions as verified GPS data.
- Cache the latest successful snapshot.
- Fail gracefully when upstream data is unavailable.
- Keep provider-specific identifiers outside the product branding.

## Data sources

### GTFS-RT

The public gtfs.de feed was tested on 2026-09-27 and contained no `VehiclePosition` coordinates, so it cannot directly power the live map.

### HAFAS JourneyGeoPos

`JourneyGeoPos` can return current journey positions for a geographic bounding box. The app therefore requests one Cologne-area snapshot instead of polling individual stops or trips.

```text
HAFAS JourneyGeoPos
        |
        v
provider parser
        |
        v
Vehicle[]
        |
        v
in-memory snapshot cache
        |
        +----> GET /api/vehicles
        |
        v
browser UI
```

Static VRS GTFS is processed separately and exposed through `GET /api/network`.

## Normalized vehicle model

```text
Vehicle
- journey_id
- line
- direction
- latitude
- longitude
- observed_at
- delay_minutes
- delay_status
- animation_path
- animation_steps
```

Browser code stays independent of HAFAS-specific index references.

## Current provider

`src/cologne_tram_live_map/hafas.py` issues the Cologne-area `JourneyGeoPos` request. The current endpoint lives at `https://auskunft.kvb.koeln/gate`; this is a technical source reference and does not imply affiliation with the operator.

The default product mask is `2`, which selects the relevant tram/light-rail product in the current HAFAS configuration.

## Polling

The browser can request updates frequently while the backend centralizes upstream HAFAS access through a 15-second snapshot cache. This avoids one upstream request per browser refresh/client.
