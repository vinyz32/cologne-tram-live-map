"""Probe the public gtfs.de GTFS-Realtime feed.

This module is intentionally small. It exists to verify whether the public feed
contains GTFS-RT VehiclePosition entities before the project commits to GTFS-RT
as its live-position provider.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass
from typing import Sequence
from urllib.request import Request, urlopen

from google.transit import gtfs_realtime_pb2


DEFAULT_FEED_URL = "https://realtime.gtfs.de/realtime-free.pb"


@dataclass(frozen=True)
class ProbeResult:
    feed_url: str
    feed_timestamp: int | None
    entity_count: int
    trip_update_count: int
    service_alert_count: int
    vehicle_entity_count: int
    vehicle_position_count: int
    sample_positions: list[dict[str, object]]

    @property
    def has_vehicle_positions(self) -> bool:
        return self.vehicle_position_count > 0


def fetch_feed(url: str = DEFAULT_FEED_URL, timeout: float = 30.0) -> bytes:
    """Download one GTFS-RT snapshot."""

    request = Request(
        url,
        headers={
            "User-Agent": "cologne-tram-live-map/0.1 (+private hobby project)",
            "Accept": "application/x-protobuf, application/octet-stream, */*",
        },
    )
    with urlopen(request, timeout=timeout) as response:
        return response.read()


def inspect_feed(payload: bytes, feed_url: str = DEFAULT_FEED_URL) -> ProbeResult:
    """Parse one feed and count the GTFS-RT entity types relevant to us."""

    feed = gtfs_realtime_pb2.FeedMessage()
    feed.ParseFromString(payload)

    trip_updates = 0
    alerts = 0
    vehicles = 0
    positions = 0
    samples: list[dict[str, object]] = []

    for entity in feed.entity:
        if entity.HasField("trip_update"):
            trip_updates += 1

        if entity.HasField("alert"):
            alerts += 1

        if entity.HasField("vehicle"):
            vehicles += 1
            vehicle = entity.vehicle

            if vehicle.HasField("position"):
                positions += 1

                if len(samples) < 5:
                    samples.append(
                        {
                            "entity_id": entity.id,
                            "trip_id": vehicle.trip.trip_id if vehicle.HasField("trip") else None,
                            "route_id": vehicle.trip.route_id if vehicle.HasField("trip") else None,
                            "vehicle_id": (
                                vehicle.vehicle.id if vehicle.HasField("vehicle") else None
                            ),
                            "latitude": vehicle.position.latitude,
                            "longitude": vehicle.position.longitude,
                            "timestamp": vehicle.timestamp or None,
                        }
                    )

    timestamp = feed.header.timestamp if feed.header.HasField("timestamp") else None

    return ProbeResult(
        feed_url=feed_url,
        feed_timestamp=timestamp,
        entity_count=len(feed.entity),
        trip_update_count=trip_updates,
        service_alert_count=alerts,
        vehicle_entity_count=vehicles,
        vehicle_position_count=positions,
        sample_positions=samples,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Inspect gtfs.de GTFS-RT for vehicle-position entities."
    )
    parser.add_argument("--url", default=DEFAULT_FEED_URL)
    parser.add_argument("--timeout", type=float, default=30.0)
    return parser


def main(argv: Sequence[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    payload = fetch_feed(args.url, timeout=args.timeout)
    result = inspect_feed(payload, feed_url=args.url)

    output = asdict(result)
    output["has_vehicle_positions"] = result.has_vehicle_positions
    print(json.dumps(output, indent=2, ensure_ascii=False))

    if result.has_vehicle_positions:
        print("\nResult: GTFS-RT vehicle positions are present.")
    else:
        print(
            "\nResult: no GTFS-RT VehiclePosition coordinates were found. "
            "For this project, use another position source such as HAFAS JourneyGeoPos."
        )


if __name__ == "__main__":
    main()
