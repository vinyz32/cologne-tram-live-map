"""HAFAS JourneyGeoPos client and live Cologne tram snapshot provider."""

from __future__ import annotations

import argparse
import json
import os
from dataclasses import asdict, dataclass
from datetime import datetime
from typing import Any, Sequence
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

ENDPOINT = "https://auskunft.kvb.koeln/gate"
DEFAULT_AID = os.environ.get("COLOGNE_TRAM_HAFAS_AID", "").strip()

DEFAULT_WEST = 6.72
DEFAULT_SOUTH = 50.75
DEFAULT_EAST = 7.25
DEFAULT_NORTH = 51.15
DEFAULT_TRAM_MASK = 2


@dataclass(frozen=True)
class Vehicle:
    journey_id: str
    line: str
    direction: str | None
    latitude: float
    longitude: float
    observed_at: str
    animation_path: list[list[float]]
    animation_steps: list[dict[str, float | int]]
    delay_minutes: float | None
    delay_status: str


def hafas_coord(value: float) -> int:
    return round(value * 1_000_000)


def build_request(
    *,
    when: datetime,
    west: float = DEFAULT_WEST,
    south: float = DEFAULT_SOUTH,
    east: float = DEFAULT_EAST,
    north: float = DEFAULT_NORTH,
    product_mask: int = DEFAULT_TRAM_MASK,
    aid: str = DEFAULT_AID,
) -> dict[str, Any]:
    if not aid:
        raise RuntimeError(
            "No HAFAS AID configured. Set COLOGNE_TRAM_HAFAS_AID locally "
            "or pass --aid to the diagnostic probe."
        )

    return {
        "ver": "1.58",
        "lang": "deu",
        "auth": {"type": "AID", "aid": aid},
        "client": {
            "type": "WEB",
            "id": "HAFAS",
            "name": "webapp",
            "l": "vs_webapp",
            "v": "154",
        },
        "formatted": False,
        "svcReqL": [
            {
                "cfg": {"polyEnc": "GPA"},
                "meth": "JourneyGeoPos",
                "req": {
                    "getUnmatched": True,
                    "jnyFltrL": [
                        {"type": "PROD", "mode": "INC", "value": product_mask}
                    ],
                    "maxJny": 256,
                    "perStep": 10_000,
                    "perSize": 30_000,
                    "rect": {
                        "llCrd": {"x": hafas_coord(west), "y": hafas_coord(south)},
                        "urCrd": {"x": hafas_coord(east), "y": hafas_coord(north)},
                    },
                    "trainPosMode": "CALC_REPORT",
                    "date": when.strftime("%Y%m%d"),
                    "time": when.strftime("%H%M%S"),
                },
            }
        ],
    }


def post_json(payload: dict[str, Any], timeout: float = 20.0) -> dict[str, Any]:
    request = Request(
        ENDPOINT,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "cologne-tram-live-map/0.1 (+private hobby project)",
        },
        method="POST",
    )

    with urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _product_for_journey(
    common: dict[str, Any], journey: dict[str, Any]
) -> dict[str, Any] | None:
    products = common.get("prodL", [])
    index = journey.get("prodX")
    if isinstance(index, int) and 0 <= index < len(products):
        return products[index]
    return None


def _decode_hafas_polyline(encoded: str) -> list[list[float]]:
    """Best-effort decoder for HAFAS crdEncYX.

    Animation data is optional. A malformed/unsupported polyline must never
    make the whole live snapshot fail.
    """

    try:
        points: list[list[float]] = []
        index = 0
        y = 0
        x = 0

        while index < len(encoded):
            deltas: list[int] = []

            for _ in range(2):
                result = 1
                shift = 0

                while True:
                    if index >= len(encoded):
                        return []

                    value = ord(encoded[index]) - 64
                    index += 1
                    result += (value - 1) << shift
                    shift += 5

                    if value < 32:
                        break

                    if shift > 35:
                        return []

                delta = ~(result >> 1) if result & 1 else result >> 1
                deltas.append(delta)

            y += deltas[0]
            x += deltas[1]
            lat = y / 100_000
            lon = x / 100_000

            if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                return []

            points.append([lat, lon])

        return points
    except (IndexError, TypeError, ValueError, OverflowError):
        return []


def _animation_path(
    common: dict[str, Any], journey: dict[str, Any]
) -> tuple[list[list[float]], list[dict[str, float | int]]]:
    ani = journey.get("ani")
    if not isinstance(ani, dict):
        return [], []

    try:
        poly_indexes = ((ani.get("polyG") or {}).get("polyXL") or [])
        poly_list = common.get("polyL") or []

        path: list[list[float]] = []
        for poly_index in poly_indexes:
            if not isinstance(poly_index, int) or not 0 <= poly_index < len(poly_list):
                continue

            encoded = poly_list[poly_index].get("crdEncYX")
            if not encoded:
                continue

            decoded = _decode_hafas_polyline(encoded)
            if not decoded:
                continue

            if path and path[-1] == decoded[0]:
                decoded = decoded[1:]
            path.extend(decoded)

        milliseconds = ani.get("mSec") or []
        progress_values = ani.get("proc") or []
        steps = [
            {"milliseconds": int(ms), "progress": float(progress)}
            for ms, progress in zip(milliseconds, progress_values)
            if isinstance(ms, (int, float)) and isinstance(progress, (int, float))
        ]

        if len(path) < 2 or len(steps) < 2:
            return [], []

        return path, steps
    except (AttributeError, IndexError, TypeError, ValueError):
        return [], []



def _time_to_seconds(value: Any) -> int | None:
    if value is None:
        return None

    text = str(value).strip().replace(":", "")
    if not text.isdigit():
        return None

    text = text.zfill(6)[-6:]
    try:
        hours = int(text[0:2])
        minutes = int(text[2:4])
        seconds = int(text[4:6])
    except ValueError:
        return None

    if minutes > 59 or seconds > 59:
        return None

    return hours * 3600 + minutes * 60 + seconds


def _delay_for_journey(journey: dict[str, Any]) -> tuple[float | None, str]:
    delays: list[int] = []

    for stop in journey.get("stopL") or []:
        for scheduled_key, realtime_key in (
            ("dTimeS", "dTimeR"),
            ("aTimeS", "aTimeR"),
        ):
            scheduled = _time_to_seconds(stop.get(scheduled_key))
            realtime = _time_to_seconds(stop.get(realtime_key))

            if scheduled is None or realtime is None:
                continue

            delta = realtime - scheduled

            # Normalize midnight crossings into a sensible local delay.
            if delta > 12 * 3600:
                delta -= 24 * 3600
            elif delta < -12 * 3600:
                delta += 24 * 3600

            delays.append(delta)

    if not delays:
        return None, "unknown"

    delay_seconds = delays[-1]
    delay_minutes = round(delay_seconds / 60, 1)

    if delay_seconds <= 60:
        status = "on_time"
    elif delay_seconds <= 300:
        status = "slightly_delayed"
    else:
        status = "highly_delayed"

    return delay_minutes, status


def parse_vehicle_snapshot(data: dict[str, Any], observed_at: datetime) -> list[Vehicle]:
    service = (data.get("svcResL") or [{}])[0]
    if data.get("err") != "OK" or service.get("err") != "OK":
        raise RuntimeError(
            f"HAFAS error: top={data.get('err')} service={service.get('err')} "
            f"text={service.get('errTxt') or data.get('errTxt')}"
        )

    result = service.get("res") or {}
    common = result.get("common") or {}
    journeys = result.get("jnyL") or []

    vehicles: list[Vehicle] = []

    for journey in journeys:
        pos = journey.get("pos")
        if not isinstance(pos, dict) or "x" not in pos or "y" not in pos:
            continue

        product = _product_for_journey(common, journey) or {}
        line = (
            product.get("line")
            or product.get("number")
            or product.get("name")
            or "?"
        )

        path, steps = _animation_path(common, journey)
        delay_minutes, delay_status = _delay_for_journey(journey)

        vehicles.append(
            Vehicle(
                journey_id=str(journey.get("jid", "")),
                line=str(line),
                direction=journey.get("dirTxt"),
                latitude=pos["y"] / 1_000_000,
                longitude=pos["x"] / 1_000_000,
                observed_at=observed_at.isoformat(),
                animation_path=path,
                animation_steps=steps,
                delay_minutes=delay_minutes,
                delay_status=delay_status,
            )
        )

    return vehicles


def fetch_vehicle_snapshot(
    *,
    timeout: float = 20.0,
    aid: str = DEFAULT_AID,
    west: float = DEFAULT_WEST,
    south: float = DEFAULT_SOUTH,
    east: float = DEFAULT_EAST,
    north: float = DEFAULT_NORTH,
    product_mask: int = DEFAULT_TRAM_MASK,
) -> list[Vehicle]:
    now = datetime.now(ZoneInfo("Europe/Berlin"))
    data = post_json(
        build_request(
            when=now,
            west=west,
            south=south,
            east=east,
            north=north,
            product_mask=product_mask,
            aid=aid,
        ),
        timeout=timeout,
    )
    return parse_vehicle_snapshot(data, observed_at=now)


def summarize_response(data: dict[str, Any]) -> dict[str, Any]:
    now = datetime.now(ZoneInfo("Europe/Berlin"))
    service = (data.get("svcResL") or [{}])[0]
    result = service.get("res") or {}
    common = result.get("common") or {}
    journeys = result.get("jnyL") or []

    try:
        vehicles = parse_vehicle_snapshot(data, observed_at=now)
    except RuntimeError:
        vehicles = []

    return {
        "top_level_error": data.get("err"),
        "service_error": service.get("err"),
        "journey_count": len(journeys),
        "positioned_journey_count": len(vehicles),
        "animated_journey_count": sum(
            bool(vehicle.animation_path and vehicle.animation_steps)
            for vehicle in vehicles
        ),
        "sample_positions": [asdict(vehicle) for vehicle in vehicles[:3]],
        "product_count": len(common.get("prodL") or []),
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Request one HAFAS JourneyGeoPos snapshot for Cologne."
    )
    parser.add_argument("--timeout", type=float, default=20.0)
    parser.add_argument("--aid", default=DEFAULT_AID)
    parser.add_argument("--product-mask", type=int, default=DEFAULT_TRAM_MASK)
    return parser


def main(argv: Sequence[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    now = datetime.now(ZoneInfo("Europe/Berlin"))

    try:
        data = post_json(
            build_request(
                when=now,
                product_mask=args.product_mask,
                aid=args.aid,
            ),
            timeout=args.timeout,
        )
    except HTTPError as exc:
        print(f"HTTP error: {exc.code} {exc.reason}")
        return
    except URLError as exc:
        print(f"Network error: {exc.reason}")
        return
    except json.JSONDecodeError as exc:
        print(f"Invalid JSON response: {exc}")
        return

    print(json.dumps(summarize_response(data), indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
