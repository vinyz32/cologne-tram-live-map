"""Local web server for Cologne Tram Live Map."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import logging
from logging.handlers import RotatingFileHandler
import os
import threading
import time
import uuid
from dataclasses import asdict
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from importlib.resources import as_file, files
from pathlib import Path
from typing import Sequence
from urllib.parse import parse_qs, urlsplit

from cologne_tram_live_map.gtfs_static import fetch_static_network
from cologne_tram_live_map.hafas import Vehicle, fetch_vehicle_snapshot


class SnapshotCache:
    def __init__(
        self,
        ttl_seconds: float = 15.0,
        min_upstream_refresh_seconds: float = 10.0,
    ) -> None:
        self.ttl_seconds = ttl_seconds
        self.min_upstream_refresh_seconds = min_upstream_refresh_seconds
        self._vehicles: list[Vehicle] = []
        self._updated_monotonic = 0.0
        self._lock = threading.Lock()
        self.last_error: str | None = None
        self.last_fetch_duration_ms: int | None = None
        self.last_changed_vehicle_count: int | None = None
        self.last_matched_vehicle_count: int | None = None
        self.fetch_count = 0

    def get(
        self,
        force: bool = False,
    ) -> tuple[list[Vehicle], bool, bool]:
        now = time.monotonic()

        with self._lock:
            snapshot_age = (
                now - self._updated_monotonic
                if self._vehicles and self._updated_monotonic
                else None
            )
            fresh = (
                snapshot_age is not None
                and snapshot_age < self.ttl_seconds
            )
            forced_refresh_limited = (
                force
                and snapshot_age is not None
                and snapshot_age < self.min_upstream_refresh_seconds
            )

            # Normal requests use the regular cache TTL. A forced refresh may
            # bypass that TTL, but never the hard upstream-rate floor. This
            # keeps browser resume behavior responsive without allowing a
            # public client to hammer the HAFAS endpoint with ?fresh=1.
            if (fresh and not force) or forced_refresh_limited:
                return list(self._vehicles), True, True

            started = time.monotonic()
            previous_positions = {
                vehicle.journey_id: (vehicle.latitude, vehicle.longitude)
                for vehicle in self._vehicles
            }

            try:
                vehicles = fetch_vehicle_snapshot()
                current_positions = {
                    vehicle.journey_id: (vehicle.latitude, vehicle.longitude)
                    for vehicle in vehicles
                }
                matched_ids = previous_positions.keys() & current_positions.keys()
                changed = sum(
                    previous_positions[journey_id] != current_positions[journey_id]
                    for journey_id in matched_ids
                )

                self._vehicles = vehicles
                self._updated_monotonic = time.monotonic()
                self.last_fetch_duration_ms = round(
                    (self._updated_monotonic - started) * 1000
                )
                self.last_changed_vehicle_count = changed
                self.last_matched_vehicle_count = len(matched_ids)
                self.fetch_count += 1
                self.last_error = None
                return list(vehicles), True, False
            except Exception as exc:
                self.last_fetch_duration_ms = round(
                    (time.monotonic() - started) * 1000
                )
                self.last_error = str(exc)
                print(f"[cologne-tram-live-map] HAFAS snapshot failed: {exc!r}")
                return list(self._vehicles), False, False

    def diagnostics(self) -> dict[str, float | int | None]:
        age_seconds = None
        if self._updated_monotonic:
            age_seconds = round(
                max(0.0, time.monotonic() - self._updated_monotonic),
                1,
            )

        return {
            "snapshot_age_seconds": age_seconds,
            "last_fetch_duration_ms": self.last_fetch_duration_ms,
            "changed_vehicle_count": self.last_changed_vehicle_count,
            "matched_vehicle_count": self.last_matched_vehicle_count,
            "fetch_count": self.fetch_count,
        }


def _build_access_logger() -> logging.Logger:
    default_path = (
        Path.home()
        / ".local"
        / "state"
        / "cologne-tram-live-map"
        / "access.log"
    )
    log_path = Path(os.environ.get("COLOGNE_TRAM_ACCESS_LOG", default_path))
    log_path.parent.mkdir(parents=True, exist_ok=True)

    logger = logging.getLogger("cologne_tram_live_map.access")
    logger.setLevel(logging.INFO)
    logger.propagate = False

    if not logger.handlers:
        handler = RotatingFileHandler(
            log_path,
            maxBytes=5_000_000,
            backupCount=4,
            encoding="utf-8",
        )
        handler.setFormatter(logging.Formatter("%(message)s"))
        logger.addHandler(handler)

    return logger


class NetworkCache:
    def __init__(self) -> None:
        self._network: dict | None = None
        self._lock = threading.Lock()
        self.last_error: str | None = None

    def get(self) -> dict | None:
        with self._lock:
            if self._network is not None:
                return self._network

            try:
                self._network = fetch_static_network()
                self.last_error = None
                line_count = len(self._network.get("lines", []))
                print(f"[cologne-tram-live-map] GTFS network loaded: {line_count} lines")
                return self._network
            except Exception as exc:
                self.last_error = str(exc)
                print(f"[cologne-tram-live-map] GTFS network failed: {exc!r}")
                return None



BOOT_ID = uuid.uuid4().hex
CACHE = SnapshotCache(
    ttl_seconds=15.0,
    min_upstream_refresh_seconds=10.0,
)
NETWORK = NetworkCache()
ACCESS_LOGGER = _build_access_logger()


class CologneTramRequestHandler(SimpleHTTPRequestHandler):
    def end_headers(self) -> None:
        if self.path.endswith((".html", ".css", ".js")) or self.path == "/":
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")

        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        super().end_headers()

    def _send_json(self, payload: object, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


    def do_GET(self) -> None:
        path = urlsplit(self.path).path

        # Railway (and other platforms) can probe this endpoint without
        # triggering HAFAS or contributing to the public-request breaker.
        if path == "/healthz":
            configured = bool(os.environ.get("COLOGNE_TRAM_HAFAS_AID", "").strip())
            self._send_json(
                {
                    "status": "ok" if configured else "misconfigured",
                    "live_provider_configured": configured,
                },
                HTTPStatus.OK if configured else HTTPStatus.SERVICE_UNAVAILABLE,
            )
            return

        if path == "/api/status":
            vehicles, live, cache_hit = CACHE.get()
            updated_at = vehicles[0].observed_at if vehicles else None
            diagnostics = CACHE.diagnostics()
            self._send_json(
                {
                    "status": "ok" if live else "degraded",
                    "live_data": bool(vehicles),
                    "vehicle_count": len(vehicles),
                    "provider": "HAFAS JourneyGeoPos",
                    "updated_at": updated_at,
                    "cache_ttl_seconds": CACHE.ttl_seconds,
                    "min_upstream_refresh_seconds": CACHE.min_upstream_refresh_seconds,
                    "cache_hit": cache_hit,
                    "diagnostics": diagnostics,
                    "last_error": CACHE.last_error,
                }
            )
            return

        if path == "/api/vehicles":
            query = parse_qs(urlsplit(self.path).query)
            force_fresh = query.get("fresh") == ["1"]
            vehicles, live, cache_hit = CACHE.get(force=force_fresh)
            updated_at = vehicles[0].observed_at if vehicles else None
            diagnostics = CACHE.diagnostics()
            self._send_json(
                {
                    "provider": "HAFAS JourneyGeoPos",
                    "live": live,
                    "updated_at": updated_at,
                    "vehicle_count": len(vehicles),
                    "vehicles": [asdict(vehicle) for vehicle in vehicles],
                    "min_upstream_refresh_seconds": CACHE.min_upstream_refresh_seconds,
                    "cache_hit": cache_hit,
                    "diagnostics": diagnostics,
                    "last_error": CACHE.last_error,
                },
                HTTPStatus.OK if vehicles else HTTPStatus.SERVICE_UNAVAILABLE,
            )
            return

        if path == "/api/config":
            self._send_json(
                {
                    "display_mode": "interactive",
                    "boot_id": BOOT_ID,
                }
            )
            return


        if path == "/api/network":
            network = NETWORK.get()

            if network is None:
                self._send_json(
                    {
                        "provider": "VRS GTFS static",
                        "lines": [],
                        "last_error": NETWORK.last_error,
                    },
                    HTTPStatus.SERVICE_UNAVAILABLE,
                )
                return

            self._send_json(
                {
                    "provider": "VRS GTFS static",
                    **network,
                    "last_error": None,
                }
            )
            return

        super().do_GET()

    def do_HEAD(self) -> None:
        super().do_HEAD()

    def _reject_unsupported_method(self) -> None:
        self.send_error(HTTPStatus.METHOD_NOT_ALLOWED, "Method not allowed")

    do_POST = _reject_unsupported_method
    do_PUT = _reject_unsupported_method
    do_PATCH = _reject_unsupported_method
    do_DELETE = _reject_unsupported_method

    def log_message(self, format: str, *args: object) -> None:
        # Keep operational request logs deliberately privacy-minimal: no
        # client IP, forwarded IP or user-agent is persisted.
        event = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "method": self.command,
            "path": self.path,
            "message": format % args,
        }
        line = json.dumps(event, ensure_ascii=False)
        ACCESS_LOGGER.info(line)
        print(f"[access] {line}")


def run_server(host: str = "127.0.0.1", port: int = 8000) -> None:
    static_resource = files("cologne_tram_live_map").joinpath("static")

    with as_file(static_resource) as static_path:
        handler = lambda *args, **kwargs: CologneTramRequestHandler(
            *args,
            directory=str(Path(static_path)),
            **kwargs,
        )

        server = ThreadingHTTPServer((host, port), handler)
        print(f"Cologne Tram Live Map running at http://{host}:{port}")
        print("Live provider: HAFAS JourneyGeoPos")
        print("Static network: VRS GTFS")
        print("Press Ctrl+C to stop.")

        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nStopping server.")
        finally:
            server.server_close()


def _default_host() -> str:
    configured = os.environ.get("HOST", "").strip()
    if configured:
        return configured

    # Railway injects PORT. Binding to all interfaces is required inside its
    # container, while local runs remain localhost-only by default.
    return "0.0.0.0" if os.environ.get("PORT") else "127.0.0.1"


def _default_port() -> int:
    raw = os.environ.get("PORT", "").strip()
    if not raw:
        return 8000

    try:
        return int(raw)
    except ValueError:
        raise RuntimeError(f"Invalid PORT environment variable: {raw!r}") from None


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run Cologne Tram Live Map.")
    parser.add_argument("--host", default=_default_host())
    parser.add_argument("--port", type=int, default=_default_port())
    return parser


def main(argv: Sequence[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    run_server(host=args.host, port=args.port)


if __name__ == "__main__":
    main()
