from __future__ import annotations

import logging
import time
from typing import Dict

from .cloud_api import HiveeCloudClient
from .config import HubConfig
from .runtime import OpenClawRuntimeAdapter, RuntimeAgent


log = logging.getLogger("hivee_hub.service")


def _build_runtime_adapter(config: HubConfig) -> OpenClawRuntimeAdapter:
    return OpenClawRuntimeAdapter(
        base_url=config.openclaw_base_url,
        api_key=config.openclaw_api_key,
        timeout_sec=config.request_timeout_sec,
        verify_ssl=config.openclaw_verify_ssl,
        manual_agent_ids=config.manual_agent_ids,
    )


def _agent_to_discovery_payload(agent: RuntimeAgent) -> Dict[str, object]:
    return {
        "runtime_agent_id": agent.runtime_agent_id,
        "agent_name": agent.agent_name,
        "status": agent.status or "online",
        "agent_card_json": agent.agent_card_json or {},
    }


def _agent_card_for_upload(agent: RuntimeAgent) -> Dict[str, object]:
    if isinstance(agent.agent_card_json, dict) and agent.agent_card_json:
        return dict(agent.agent_card_json)
    return {
        "schema": "hivee.agent_card.v1",
        "runtime": "openclaw",
        "runtime_agent_id": agent.runtime_agent_id,
        "name": agent.agent_name,
        "capabilities": ["chat"],
    }


def _sync_discovery_and_cards(
    cloud: HiveeCloudClient,
    *,
    config: HubConfig,
    connection_id: str,
    adapter: OpenClawRuntimeAdapter,
) -> Dict[str, int]:
    discovered_agents = adapter.discover_agents()
    payload_agents = [_agent_to_discovery_payload(agent) for agent in discovered_agents]

    discovered_res = cloud.report_agents_discovered(
        connection_id=connection_id,
        install_token=config.install_token,
        agents=payload_agents,
    )

    runtime_to_managed: Dict[str, str] = {}
    for item in (discovered_res.get("agents") or []):
        if not isinstance(item, dict):
            continue
        runtime_agent_id = str(item.get("runtime_agent_id") or "").strip()
        managed_agent_id = str(item.get("managed_agent_id") or "").strip()
        if runtime_agent_id and managed_agent_id:
            runtime_to_managed[runtime_agent_id] = managed_agent_id

    cards_uploaded = 0
    for agent in discovered_agents:
        managed_agent_id = runtime_to_managed.get(agent.runtime_agent_id)
        if not managed_agent_id:
            continue
        cloud.upload_agent_card(
            managed_agent_id=managed_agent_id,
            connection_id=connection_id,
            install_token=config.install_token,
            agent_card_json=_agent_card_for_upload(agent),
            agent_card_version="1.0",
        )
        cards_uploaded += 1

    return {
        "discovered": len(discovered_agents),
        "cards_uploaded": cards_uploaded,
    }


def _process_single_runtime_job(
    cloud: HiveeCloudClient,
    *,
    config: HubConfig,
    connection_id: str,
    adapter: OpenClawRuntimeAdapter,
) -> bool:
    job = cloud.claim_runtime_job(
        connection_id=connection_id,
        install_token=config.install_token,
        max_wait_sec=1,
    )
    if not job:
        return False

    job_id = str(job.get("id") or "").strip()
    runtime_agent_id = str(job.get("runtime_agent_id") or "").strip()
    prompt_text = str(job.get("prompt_text") or "").strip()
    runtime_session_key = str(job.get("runtime_session_key") or "").strip() or "default"

    if not job_id:
        log.warning("Claimed runtime job without id: %s", job)
        return False
    if not runtime_agent_id:
        cloud.complete_runtime_job(
            job_id=job_id,
            connection_id=connection_id,
            install_token=config.install_token,
            status="failed",
            error_text="runtime_agent_id is missing on dispatch job",
        )
        return True
    if not prompt_text:
        cloud.complete_runtime_job(
            job_id=job_id,
            connection_id=connection_id,
            install_token=config.install_token,
            status="failed",
            error_text="prompt_text is empty on dispatch job",
        )
        return True

    log.info(
        "Runtime job claimed: id=%s project=%s agent=%s",
        job_id,
        str(job.get("project_id") or ""),
        runtime_agent_id,
    )

    try:
        chat_res = adapter.send_chat(
            runtime_agent_id=runtime_agent_id,
            message=prompt_text,
            session_key=runtime_session_key,
            timeout_sec=max(10, min(config.request_timeout_sec + 10, 90)),
        )
    except Exception as exc:
        cloud.complete_runtime_job(
            job_id=job_id,
            connection_id=connection_id,
            install_token=config.install_token,
            status="failed",
            error_text=f"runtime adapter exception: {exc}",
        )
        log.exception("Runtime job failed with adapter exception: id=%s", job_id)
        return True

    if chat_res.ok:
        text = str(chat_res.text or "").strip() or "Acknowledged."
        cloud.complete_runtime_job(
            job_id=job_id,
            connection_id=connection_id,
            install_token=config.install_token,
            status="completed",
            result_text=text,
            error_text="",
        )
        log.info("Runtime job completed: id=%s chars=%s", job_id, len(text))
    else:
        err = str(chat_res.error or "runtime adapter returned empty error").strip()[:1800]
        cloud.complete_runtime_job(
            job_id=job_id,
            connection_id=connection_id,
            install_token=config.install_token,
            status="failed",
            result_text="",
            error_text=err,
        )
        log.warning("Runtime job failed: id=%s error=%s", job_id, err)

    return True


def run_hub(config: HubConfig) -> int:
    config.validate()
    adapter = _build_runtime_adapter(config)

    with HiveeCloudClient(
        cloud_url=config.cloud_url,
        timeout_sec=config.request_timeout_sec,
        verify_ssl=config.verify_ssl,
    ) as cloud:
        install_res = cloud.install_complete(
            install_token=config.install_token,
            machine_name=config.machine_name,
            os_type=config.os_type,
            hub_version=config.hub_version,
        )
        connection_id = str(install_res.get("connection_id") or config.connection_id or "").strip()
        if not connection_id:
            raise RuntimeError("Hub registration failed: missing connection_id")
        if config.connection_id and config.connection_id != connection_id:
            log.warning(
                "Provided connection_id=%s differs from cloud-resolved connection_id=%s",
                config.connection_id,
                connection_id,
            )

        log.info("Hub connected: connection_id=%s runtime=%s", connection_id, config.runtime_type)

        next_heartbeat_at = 0.0
        next_discovery_at = 0.0
        next_job_poll_at = 0.0

        while True:
            now = time.time()

            if now >= next_heartbeat_at:
                cloud.heartbeat(
                    connection_id=connection_id,
                    install_token=config.install_token,
                    hub_status="online",
                    machine_name=config.machine_name,
                    os_type=config.os_type,
                    hub_version=config.hub_version,
                )
                next_heartbeat_at = now + config.heartbeat_sec

            if now >= next_discovery_at:
                try:
                    stats = _sync_discovery_and_cards(
                        cloud,
                        config=config,
                        connection_id=connection_id,
                        adapter=adapter,
                    )
                    log.info(
                        "Discovery sync complete: discovered=%s cards_uploaded=%s",
                        stats.get("discovered", 0),
                        stats.get("cards_uploaded", 0),
                    )
                except Exception as exc:
                    log.exception("Discovery sync failed: %s", exc)
                    try:
                        cloud.heartbeat(
                            connection_id=connection_id,
                            install_token=config.install_token,
                            hub_status="error",
                            machine_name=config.machine_name,
                            os_type=config.os_type,
                            hub_version=config.hub_version,
                        )
                    except Exception:
                        log.debug("Failed to send error heartbeat", exc_info=True)
                next_discovery_at = now + config.discovery_sec

            if now >= next_job_poll_at:
                try:
                    _process_single_runtime_job(
                        cloud,
                        config=config,
                        connection_id=connection_id,
                        adapter=adapter,
                    )
                except Exception as exc:
                    log.exception("Runtime job poll failed: %s", exc)
                next_job_poll_at = now + 2

            if config.once:
                break

            sleep_for = max(1.0, min(next_heartbeat_at, next_discovery_at, next_job_poll_at) - time.time())
            time.sleep(sleep_for)

    return 0