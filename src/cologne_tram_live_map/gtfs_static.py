"""Static VRS GTFS network loader for Cologne tram/light-rail routes."""

from __future__ import annotations

import csv
import io
import zipfile
from collections import defaultdict
from typing import Any
from urllib.request import Request, urlopen

GTFS_URL = "https://download.vrsinfo.de/gtfs/google_transit.zip"
COLOGNE_TRAM_LINES = {"1", "3", "4", "5", "7", "9", "12", "13", "15", "16", "17", "18"}


def _csv_rows(archive: zipfile.ZipFile, name: str):
    with archive.open(name) as raw:
        text = io.TextIOWrapper(raw, encoding="utf-8-sig", newline="")
        yield from csv.DictReader(text)


def _download_gtfs(timeout: float = 45.0) -> bytes:
    request = Request(
        GTFS_URL,
        headers={
            "User-Agent": "cologne-tram-live-map/0.1 (+private hobby project)",
            "Accept": "application/zip, application/octet-stream, */*",
        },
    )

    with urlopen(request, timeout=timeout) as response:
        return response.read()



def _distance_m(a: list[float], b: list[float]) -> float:
    """Fast local distance approximation for Cologne-scale geometry."""

    lat_scale = 111_320.0
    mean_lat = (a[0] + b[0]) / 2
    lon_scale = 111_320.0 * max(0.1, abs(__import__("math").cos(__import__("math").radians(mean_lat))))

    dy = (b[0] - a[0]) * lat_scale
    dx = (b[1] - a[1]) * lon_scale
    return (dx * dx + dy * dy) ** 0.5


def _path_length_m(path: list[list[float]]) -> float:
    return sum(_distance_m(path[i - 1], path[i]) for i in range(1, len(path)))


def _remove_short_loops(
    path: list[list[float]],
    close_m: float = 90.0,
    max_loop_m: float = 1800.0,
) -> list[list[float]]:
    """Collapse small self-returning excursions common around termini."""

    if len(path) < 4:
        return path

    cleaned: list[list[float]] = []
    i = 0

    while i < len(path):
        current = path[i]
        best_j: int | None = None
        travelled = 0.0

        for j in range(i + 1, min(len(path), i + 120)):
            travelled += _distance_m(path[j - 1], path[j])

            if travelled > max_loop_m:
                break

            if j >= i + 3 and _distance_m(current, path[j]) <= close_m:
                best_j = j

        cleaned.append(current)

        if best_j is not None:
            i = best_j
        else:
            i += 1

    if cleaned[-1] != path[-1]:
        cleaned.append(path[-1])

    return cleaned


def _distance_to_path_m(point: list[float], path: list[list[float]]) -> float:
    """Approximate point-to-path distance using sampled GTFS vertices."""

    if not path:
        return float("inf")

    step = max(1, len(path) // 250)
    return min(_distance_m(point, candidate) for candidate in path[::step])


def _representative_paths(
    candidate_paths: list[list[list[float]]],
    endpoint_precision: int = 3,
) -> list[list[list[float]]]:
    """Keep a clean main route plus only genuinely distinct branches.

    Reverse-direction and short-turn variants are grouped by terminal pair.
    The longest continuous original shape represents each group. Additional
    groups are kept only when at least one endpoint adds a genuinely new
    branch relative to already selected geometry.
    """

    groups: dict[
        tuple[tuple[float, float], tuple[float, float]],
        list[list[list[float]]],
    ] = defaultdict(list)

    for raw_path in candidate_paths:
        path = _remove_short_loops(raw_path)
        if len(path) < 2:
            continue

        start = (
            round(path[0][0], endpoint_precision),
            round(path[0][1], endpoint_precision),
        )
        end = (
            round(path[-1][0], endpoint_precision),
            round(path[-1][1], endpoint_precision),
        )
        key = (start, end) if start <= end else (end, start)
        groups[key].append(path)

    candidates = [
        max(paths, key=_path_length_m)
        for paths in groups.values()
        if paths
    ]
    candidates.sort(key=_path_length_m, reverse=True)

    selected: list[list[list[float]]] = []

    for path in candidates:
        if not selected:
            selected.append(path)
            continue

        start = path[0]
        end = path[-1]

        start_distance = min(_distance_to_path_m(start, existing) for existing in selected)
        end_distance = min(_distance_to_path_m(end, existing) for existing in selected)

        # Keep only variants that create a real new branch/terminus.
        if max(start_distance, end_distance) >= 450.0:
            selected.append(path)

    return selected


def fetch_static_network(timeout: float = 45.0) -> dict[str, Any]:
    """Download one VRS GTFS snapshot and extract Cologne tram/light-rail route shapes."""

    payload = _download_gtfs(timeout=timeout)

    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        route_meta: dict[str, dict[str, str]] = {}
        route_ids_by_line: dict[str, set[str]] = defaultdict(set)

        for row in _csv_rows(archive, "routes.txt"):
            line = (row.get("route_short_name") or "").strip()
            route_type = (row.get("route_type") or "").strip()

            if line not in COLOGNE_TRAM_LINES:
                continue

            # GTFS route_type 0 = tram/light rail. Some feeds use extended
            # tram/light-rail types in the 900-series, so keep those as well.
            if route_type not in {"0", "1"} and not route_type.startswith("9"):
                continue

            route_id = row.get("route_id")
            if not route_id:
                continue

            color = (row.get("route_color") or "").strip().lstrip("#").upper()
            text_color = (row.get("route_text_color") or "").strip().lstrip("#").upper()

            route_meta[route_id] = {
                "line": line,
                "color": f"#{color}" if len(color) in {3, 6} else "",
                "text_color": f"#{text_color}" if len(text_color) in {3, 6} else "",
            }
            route_ids_by_line[line].add(route_id)

        if not route_meta:
            raise RuntimeError("No target Cologne tram routes found in VRS GTFS routes.txt")

        shape_ids_by_route: dict[str, set[str]] = defaultdict(set)
        route_id_by_trip: dict[str, str] = {}

        for row in _csv_rows(archive, "trips.txt"):
            route_id = row.get("route_id")
            trip_id = row.get("trip_id")
            shape_id = row.get("shape_id")

            if route_id not in route_meta:
                continue

            if trip_id:
                route_id_by_trip[trip_id] = route_id

            if shape_id:
                shape_ids_by_route[route_id].add(shape_id)

        shape_to_route_ids: dict[str, set[str]] = defaultdict(set)
        for route_id, shape_ids in shape_ids_by_route.items():
            for shape_id in shape_ids:
                shape_to_route_ids[shape_id].add(route_id)

        wanted_shape_ids = set(shape_to_route_ids)
        if not wanted_shape_ids:
            raise RuntimeError("Target tram routes found, but no shape_ids referenced by trips.txt")

        shapes: dict[str, list[tuple[int, float, float]]] = defaultdict(list)

        for row in _csv_rows(archive, "shapes.txt"):
            shape_id = row.get("shape_id")
            if shape_id not in wanted_shape_ids:
                continue

            try:
                sequence = int(row.get("shape_pt_sequence") or 0)
                lat = float(row["shape_pt_lat"])
                lon = float(row["shape_pt_lon"])
            except (KeyError, TypeError, ValueError):
                continue

            shapes[shape_id].append((sequence, lat, lon))

        used_stop_ids: set[str] = set()
        stop_ids_by_route: dict[str, set[str]] = defaultdict(set)

        for row in _csv_rows(archive, "stop_times.txt"):
            trip_id = row.get("trip_id")
            stop_id = row.get("stop_id")
            route_id = route_id_by_trip.get(trip_id or "")

            if route_id and stop_id:
                used_stop_ids.add(stop_id)
                stop_ids_by_route[route_id].add(stop_id)

        stop_records: dict[str, dict[str, str]] = {}
        for row in _csv_rows(archive, "stops.txt"):
            stop_id = row.get("stop_id")
            if stop_id:
                stop_records[stop_id] = row

        stations: dict[str, dict[str, Any]] = {}
        canonical_id_by_stop_id: dict[str, str] = {}

        for stop_id in used_stop_ids:
            row = stop_records.get(stop_id)
            if not row:
                continue

            parent_id = (row.get("parent_station") or "").strip()
            canonical = stop_records.get(parent_id) if parent_id else row
            canonical = canonical or row
            canonical_id = parent_id or stop_id

            try:
                lat = float(canonical.get("stop_lat") or row["stop_lat"])
                lon = float(canonical.get("stop_lon") or row["stop_lon"])
            except (KeyError, TypeError, ValueError):
                continue

            name = (canonical.get("stop_name") or row.get("stop_name") or "").strip()

            canonical_id_by_stop_id[stop_id] = canonical_id
            stations[canonical_id] = {
                "id": canonical_id,
                "name": name,
                "latitude": lat,
                "longitude": lon,
            }

        lines: dict[str, dict[str, Any]] = {}

        for line, route_ids in route_ids_by_line.items():
            color = ""
            text_color = ""
            candidate_paths: list[list[list[float]]] = []
            line_stop_ids: set[str] = set()

            for route_id in route_ids:
                for stop_id in stop_ids_by_route.get(route_id, set()):
                    canonical_id = canonical_id_by_stop_id.get(stop_id)
                    if canonical_id and canonical_id in stations:
                        line_stop_ids.add(canonical_id)

            for route_id in sorted(route_ids):
                meta = route_meta[route_id]
                color = color or meta["color"]
                text_color = text_color or meta["text_color"]

                for shape_id in sorted(shape_ids_by_route.get(route_id, set())):
                    points = sorted(shapes.get(shape_id, []), key=lambda item: item[0])
                    path = [[lat, lon] for _, lat, lon in points]

                    if len(path) >= 2:
                        candidate_paths.append(path)

            if candidate_paths:
                representative_paths = _representative_paths(candidate_paths)

                if not representative_paths:
                    continue

                lines[line] = {
                    "line": line,
                    "color": color,
                    "text_color": text_color,
                    "paths": representative_paths,
                    "shape_variants_seen": len(candidate_paths),
                    "representative_variants": len(representative_paths),
                    "stop_ids": sorted(line_stop_ids),
                }

        if not lines:
            raise RuntimeError("No usable Cologne tram shape geometry found in VRS GTFS")

        return {
            "source": GTFS_URL,
            "lines": [lines[line] for line in sorted(lines, key=lambda value: int(value))],
            "stops": sorted(stations.values(), key=lambda stop: stop["name"]),
        }
