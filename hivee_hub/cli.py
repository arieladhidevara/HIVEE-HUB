from __future__ import annotations

import argparse
import logging
from dataclasses import replace
from typing import List, Optional

from .config import HubConfig
from .service import run_hub


def _setup_logging(level_name: str) -> None:
    level = getattr(logging, str(level_name or "INFO").upper(), logging.INFO)
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )


def _split_csv(raw_value: Optional[str]) -> List[str]:
    if raw_value is None:
        return []
    out: List[str] = []
    seen = set()
    for item in str(raw_value or "").split(","):
        token = item.strip()
        if not token:
            continue
        if token in seen:
            continue
        seen.add(token)
        out.append(token)
    return out


def _add_common_flags(parser: argparse.ArgumentParser, *, require_core: bool) -> None:
    parser.add_argument("--cloud-url", required=require_core, default=None)
    parser.add_argument("--install-token", required=require_core, default=None)
    parser.add_argument("--connection-id", default=None)
    parser.add_argument("--runtime", dest="runtime_type", default=None)

    parser.add_argument("--machine-name", default=None)
    parser.add_argument("--os-type", default=None)
    parser.add_argument("--hub-version", default=None)

    parser.add_argument("--heartbeat-sec", type=int, default=None)
    parser.add_argument("--discovery-sec", type=int, default=None)
    parser.add_argument("--timeout-sec", type=int, default=None)
    parser.add_argument("--once", action="store_true")

    parser.add_argument("--insecure", action="store_true", help="Disable TLS verification for cloud API")
    parser.add_argument("--log-level", default=None)

    parser.add_argument("--openclaw-base-url", default=None)
    parser.add_argument("--openclaw-api-key", default=None)
    parser.add_argument("--openclaw-insecure", action="store_true", help="Disable TLS verification for OpenClaw API")
    parser.add_argument("--runtime-agent-ids", default=None, help="Comma-separated fallback runtime agent IDs")


def _apply_overrides(base: HubConfig, args: argparse.Namespace) -> HubConfig:
    cfg = replace(base)

    if args.cloud_url is not None:
        cfg.cloud_url = str(args.cloud_url).strip()
    if args.install_token is not None:
        cfg.install_token = str(args.install_token).strip()
    if args.connection_id is not None:
        cfg.connection_id = str(args.connection_id).strip()
    if args.runtime_type is not None:
        cfg.runtime_type = str(args.runtime_type).strip().lower()

    if args.machine_name is not None:
        cfg.machine_name = str(args.machine_name).strip()
    if args.os_type is not None:
        cfg.os_type = str(args.os_type).strip().lower()
    if args.hub_version is not None:
        cfg.hub_version = str(args.hub_version).strip()

    if args.heartbeat_sec is not None:
        cfg.heartbeat_sec = int(args.heartbeat_sec)
    if args.discovery_sec is not None:
        cfg.discovery_sec = int(args.discovery_sec)
    if args.timeout_sec is not None:
        cfg.request_timeout_sec = int(args.timeout_sec)

    if args.log_level is not None:
        cfg.log_level = str(args.log_level).strip().upper()

    if args.insecure:
        cfg.verify_ssl = False
    if args.openclaw_base_url is not None:
        cfg.openclaw_base_url = str(args.openclaw_base_url).strip()
    if args.openclaw_api_key is not None:
        cfg.openclaw_api_key = str(args.openclaw_api_key).strip()
    if args.openclaw_insecure:
        cfg.openclaw_verify_ssl = False

    if args.runtime_agent_ids is not None:
        cfg.manual_agent_ids = _split_csv(args.runtime_agent_ids)

    cfg.once = bool(args.once)
    return cfg


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="hivee-hub",
        description="Hivee Hub daemon for connection registration, heartbeat, and runtime discovery",
    )
    sub = parser.add_subparsers(dest="command")

    connect = sub.add_parser("connect", help="Run hub with explicit flags")
    _add_common_flags(connect, require_core=True)

    run = sub.add_parser("run", help="Run hub using environment variables")
    _add_common_flags(run, require_core=False)

    return parser


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if not args.command:
        args = parser.parse_args(["run"] + list(argv or []))

    base_config = HubConfig.from_env()
    config = _apply_overrides(base_config, args)

    _setup_logging(config.log_level)

    try:
        return run_hub(config)
    except KeyboardInterrupt:
        logging.getLogger("hivee_hub").info("Hub stopped by user")
        return 130
    except Exception as exc:
        logging.getLogger("hivee_hub").exception("Hub failed: %s", exc)
        return 1