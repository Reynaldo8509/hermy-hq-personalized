#!/usr/bin/env python3
"""Write one redacted, validated internal Hermes outcome to Honcho.

This intentionally accepts only structured final fields. It never receives a
task prompt, command output, trace, credential, or raw agent transcript.
"""

from __future__ import annotations

import json
import re
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

APP_ROOT = "$HOME/hermes/app"
if APP_ROOT not in sys.path:
    sys.path.insert(0, APP_ROOT)

from plugins.memory.honcho.client import HonchoClientConfig, get_honcho_client

TIMEZONE = ZoneInfo("America/Guayaquil")
SESSION_ID = "hermy-hq-internal-summaries"
PEER_ID = "hermy-hq-internal"
MAX_FIELD_LENGTH = 700
SECRET_PATTERNS = (
    (re.compile(r"(?i)\b(?:api[_ -]?key|token|password|secret|authorization)\b\s*[:=]\s*[^\s,;]+"), "[REDACTED]"),
    (re.compile(r"(?i)\bbearer\s+[a-z0-9._~+/-]+"), "Bearer [REDACTED]"),
    (re.compile(r"\beyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b"), "[REDACTED_JWT]"),
)


def safe_text(value: object, limit: int = MAX_FIELD_LENGTH) -> str:
    text = " ".join(str(value or "").replace("\x00", " ").split())
    for pattern, replacement in SECRET_PATTERNS:
        text = pattern.sub(replacement, text)
    return text[:limit].rstrip()


def require(payload: dict[str, object], key: str) -> str:
    value = safe_text(payload.get(key))
    if not value:
        raise ValueError(f"missing {key}")
    return value


def main() -> None:
    payload = json.load(sys.stdin)
    if not isinstance(payload, dict):
        raise ValueError("payload must be an object")
    request_id = require(payload, "requestId")
    kind = require(payload, "kind")
    title = require(payload, "title")
    outcome = require(payload, "outcome")
    fields = payload.get("fields")
    if not isinstance(fields, dict):
        raise ValueError("missing structured fields")
    labels = (
        ("CAUSA_CONFIRMADA", "cause"),
        ("HIPOTESIS", "hypothesis"),
        ("REPARACION_APLICADA", "remediation"),
        ("VALIDACION", "validation"),
        ("LIMITACIONES", "limitations"),
        ("SIGUIENTE_ACCION", "nextAction"),
    )
    report_lines = ["Resumen interno validado de Hermy HQ", f"Tarea: {title}", f"Resultado: {outcome}", f"Solicitud: {request_id}", f"Tipo: {kind}"]
    for label, key in labels:
        value = safe_text(fields.get(key))
        if not value:
            raise ValueError(f"missing structured field {key}")
        report_lines.append(f"{label}: {value}")
    wiki_path = safe_text(payload.get("wikiPath"), 300)
    report_lines.append(f"IncidentMemory: request:{request_id}")
    report_lines.append(f"Wiki: {wiki_path or 'no aplica'}")
    local_time = datetime.now(TIMEZONE)
    report_lines.append(f"Registrado: {local_time.strftime('%Y-%m-%d %H:%M:%S %Z')}")

    client = get_honcho_client(HonchoClientConfig.from_global_config())
    peer = client.peer(PEER_ID)
    session = client.session(SESSION_ID, metadata={"scope": "internal-validated-summaries", "source": "hermy-hq"}, peers=[peer])
    session.add_messages(peer.message("\n".join(report_lines), metadata={
        "schema": "hermy-hq.internal-summary.v1",
        "request_id": request_id,
        "kind": kind,
        "outcome": outcome,
        "timezone": "America/Guayaquil",
        "wiki_path": wiki_path or None,
    }, created_at=local_time))
    print(json.dumps({"ok": True, "recordedAt": local_time.isoformat()}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"ok": False, "error": type(error).__name__}), file=sys.stdout)
        raise SystemExit(1)
