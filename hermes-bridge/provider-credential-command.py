#!/usr/bin/python3
"""Hermes ``key_cmd`` helper for the Bridge's systemd credential bundle.

Print exactly one selected provider key. The systemd path is authoritative when
present; environment fallback preserves standalone Hermes CLI behavior outside
the Bridge service. Never log the value or file contents.
"""

from __future__ import annotations

import os
import re
import stat
import sys

ALLOWED = frozenset({
    "GEMINI_API_KEY", "OPENROUTER_API_KEY", "GROQ_API_KEY", "CEREBRAS_API_KEY",
    "LLAMA_API_KEY", "TOKENHARBOR_API_KEY", "FREELLMAPI_API_KEY", "OPENCODE_ZEN_API_KEY",
})
VALUE_RE = re.compile(r"^[^\s\"'`$\\]+$")


class CredentialError(Exception):
    pass


def _from_systemd_credential(name: str, directory: str) -> str:
    if not os.path.isabs(directory):
        raise CredentialError("credential_directory_invalid")
    path = os.path.join(directory, "provider-env")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
    try:
        fd = os.open(path, flags)
    except OSError as exc:
        raise CredentialError("credential_open_failed") from exc
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) & 0o077 or info.st_size > 64 * 1024:
            raise CredentialError("credential_file_rejected")
        if info.st_uid not in (0, os.geteuid()):
            raise CredentialError("credential_owner_rejected")
        chunks = []
        remaining = 64 * 1024 + 1
        while remaining:
            chunk = os.read(fd, min(remaining, 8192))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        raw = b"".join(chunks)
        if len(raw) > 64 * 1024:
            raise CredentialError("credential_file_rejected")
    finally:
        os.close(fd)

    values: dict[str, str] = {}
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise CredentialError("credential_encoding_rejected") from exc
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise CredentialError("credential_format_rejected")
        key, value = line.split("=", 1)
        if (key not in ALLOWED or key in values or not value
                or value != value.strip() or not VALUE_RE.fullmatch(value)):
            raise CredentialError("credential_format_rejected")
        values[key] = value
    result = values.get(name)
    if not result:
        raise CredentialError("credential_value_unavailable")
    return result


def resolve(name: str, environ: dict[str, str] | None = None) -> str:
    env = os.environ if environ is None else environ
    if name not in ALLOWED:
        raise CredentialError("credential_name_not_allowlisted")
    directory = str(env.get("CREDENTIALS_DIRECTORY", ""))
    if directory:
        return _from_systemd_credential(name, directory)
    # No environment fallback when systemd explicitly provided a directory:
    # missing credentials must fail closed, not resurrect an ambient key.
    value = str(env.get(name, ""))
    if not value or value != value.strip() or not VALUE_RE.fullmatch(value):
        raise CredentialError("credential_value_unavailable")
    return value


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) != 1:
        print("credential_helper_usage_error", file=sys.stderr)
        return 64
    try:
        value = resolve(args[0])
    except CredentialError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    sys.stdout.write(value)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
