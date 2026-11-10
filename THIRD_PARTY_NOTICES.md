# Third-party data and software

This project is independent and is not affiliated with or endorsed by KVB, VRS,
OpenStreetMap, OpenFreeMap, OpenMapTiles, MapLibre, Leaflet, or their contributors.

## Data and services

### VRS GTFS

Static timetable, route, shape and stop data is downloaded from VRS.

VRS states that its GTFS timetable data may be used under
**Datenlizenz Deutschland – Zero – Version 2.0**.

- Source: https://www.vrs.de/fuer-unternehmen/open-data-service
- License: https://www.govdata.de/dl-de/zero-2-0

### OpenStreetMap

Map data is © OpenStreetMap contributors and is available under the
**Open Data Commons Open Database License (ODbL)**.

- https://www.openstreetmap.org/copyright

### OpenFreeMap / OpenMapTiles

The primary basemap uses OpenFreeMap. OpenFreeMap requires attribution and
documents the attribution string as:

`OpenFreeMap © OpenMapTiles Data from OpenStreetMap`

- https://openfreemap.org/

### HAFAS JourneyGeoPos

The live-position adapter targets the operator's HAFAS web endpoint as an
experimental technical integration. This repository intentionally does not
distribute a provider access identifier.

This endpoint is not presented here as an official public API contract. Anyone
running the adapter is responsible for ensuring that their access and usage are
authorized and compliant with the provider's current terms. The project uses
backend caching and a hard refresh floor to avoid unnecessary upstream traffic.

For a public hosted or commercial deployment, use an official realtime-data
arrangement such as the VRS interfaces / GTFS-RT access described by VRS.

- VRS Open Data / OpenService: https://www.vrs.de/fuer-unternehmen/open-data-service
- KVB open-data notes: https://www.kvb.koeln/service/open_data.html

## Browser libraries

The frontend loads versioned browser libraries from public CDNs:

- Leaflet 1.9.4
- MapLibre GL JS 5.x
- maplibre-gl-leaflet
- leaflet-polylineoffset 1.1.1
- IBM Plex Mono (Google Fonts)

Each remains subject to its upstream license and copyright notices.
