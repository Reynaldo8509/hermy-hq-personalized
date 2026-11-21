#!/usr/bin/python3
"""Publish only Gateway heartbeat freshness for HermyHQ.

The helper runs as the Gateway service identity, which can read its private
state file without a privileged capability. It never reads the heartbeat
contents; the destination is an empty file whose mtime mirrors the source.
"""

from __future__ import annotations

import os
import secrets
import stat
import sys
import time

SOURCE = "/var/lib/hermy-gateway/hermes/state/gateway.heartbeat"
DESTINATION = "/run/hermy-gateway-heartbeat/gateway.heartbeat"
EXPECTED_SOURCE_UID = 989
EXPECTED_SOURCE_GID = 989
EXPECTED_DESTINATION_UID = 989
EXPECTED_DESTINATION_GID = 989
TEMP_NAME_BYTES = 24


class HeartbeatPublishError(Exception):
    pass


def _open_directory_chain(path: str) -> int:
    if not os.path.isabs(path):
        raise HeartbeatPublishError("directory_path_invalid")
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
    fd = os.open("/", flags)
    try:
        for component in path.split("/"):
            if not component:
                continue
            next_fd = os.open(component, flags, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise


def _check_source(fd: int, expected_uid: int, expected_gid: int) -> os.stat_result:
    info = os.fstat(fd)
    if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
            or info.st_uid != expected_uid or info.st_gid != expected_gid):
        raise HeartbeatPublishError("source_identity_rejected")
    return info


def publish(
    source: str,
    destination: str,
    *,
    expected_uid: int,
    expected_gid: int,
    expected_destination_uid: int,
    expected_destination_gid: int,
) -> int:
    source_parent, source_name = os.path.split(source)
    destination_parent, destination_name = os.path.split(destination)
    if not source_name or not destination_name:
        raise HeartbeatPublishError("file_path_invalid")

    source_dir_fd = _open_directory_chain(source_parent)
    destination_dir_fd = _open_directory_chain(destination_parent)
    source_fd = -1
    temp_fd = -1
    temp_name = ""
    try:
        destination_dir = os.fstat(destination_dir_fd)
        if (not stat.S_ISDIR(destination_dir.st_mode)
                or destination_dir.st_uid != expected_destination_uid
                or destination_dir.st_gid != expected_destination_gid
                or stat.S_IMODE(destination_dir.st_mode) & 0o022):
            raise HeartbeatPublishError("destination_directory_rejected")

        source_flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
        try:
            source_fd = os.open(source_name, source_flags, dir_fd=source_dir_fd)
        except OSError as exc:
            raise HeartbeatPublishError("source_open_failed") from exc
        source_info = _check_source(source_fd, expected_uid, expected_gid)

        # Reject a pre-existing symlink or hard link. The subsequent rename is
        # still safe if the path races: rename replaces the directory entry and
        # never follows it.
        try:
            existing = os.stat(destination_name, dir_fd=destination_dir_fd, follow_symlinks=False)
        except FileNotFoundError:
            existing = None
        if existing is not None and (
            not stat.S_ISREG(existing.st_mode) or existing.st_nlink != 1
        ):
            raise HeartbeatPublishError("destination_identity_rejected")

        for _ in range(8):
            candidate = f".hb-{secrets.token_hex(6)}"
            if len(os.fsencode(candidate)) > TEMP_NAME_BYTES:
                raise HeartbeatPublishError("temporary_name_invalid")
            try:
                temp_fd = os.open(
                    candidate,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0),
                    0o644,
                    dir_fd=destination_dir_fd,
                )
                temp_name = candidate
                break
            except FileExistsError:
                continue
        if temp_fd < 0:
            raise HeartbeatPublishError("temporary_create_failed")

        os.fchown(temp_fd, expected_destination_uid, expected_destination_gid)
        os.fchmod(temp_fd, 0o644)
        temp_info = os.fstat(temp_fd)
        if (not stat.S_ISREG(temp_info.st_mode) or temp_info.st_nlink != 1
                or temp_info.st_uid != expected_destination_uid
                or temp_info.st_gid != expected_destination_gid):
            raise HeartbeatPublishError("temporary_identity_rejected")
        os.utime(temp_fd, ns=(time.time_ns(), source_info.st_mtime_ns))
        os.fsync(temp_fd)

        final_source_info = _check_source(source_fd, expected_uid, expected_gid)
        if (final_source_info.st_dev, final_source_info.st_ino, final_source_info.st_mtime_ns) != (
            source_info.st_dev, source_info.st_ino, source_info.st_mtime_ns
        ):
            raise HeartbeatPublishError("source_changed_during_publish")

        os.close(temp_fd)
        temp_fd = -1
        os.replace(temp_name, destination_name, src_dir_fd=destination_dir_fd, dst_dir_fd=destination_dir_fd)
        temp_name = ""
        os.fsync(destination_dir_fd)
        return source_info.st_mtime_ns
    finally:
        if temp_fd >= 0:
            os.close(temp_fd)
        if temp_name:
            try:
                os.unlink(temp_name, dir_fd=destination_dir_fd)
            except FileNotFoundError:
                pass
        if source_fd >= 0:
            os.close(source_fd)
        os.close(source_dir_fd)
        os.close(destination_dir_fd)


def main() -> int:
    try:
        publish(
            SOURCE,
            DESTINATION,
            expected_uid=EXPECTED_SOURCE_UID,
            expected_gid=EXPECTED_SOURCE_GID,
            expected_destination_uid=EXPECTED_DESTINATION_UID,
            expected_destination_gid=EXPECTED_DESTINATION_GID,
        )
    except HeartbeatPublishError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    except OSError:
        print("heartbeat_publish_io_error", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
