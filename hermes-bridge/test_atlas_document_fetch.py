from __future__ import annotations

import importlib.util
import os
import tempfile
import time
import unittest
from pathlib import Path

SOURCE = Path(__file__).with_name("atlas_document_fetch.py")
spec = importlib.util.spec_from_file_location("atlas_document_fetch", SOURCE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

URL = "https://www.rfc-editor.org/rfc/rfc9110.html"


class VerifiedCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.url = URL
        self.text = "".join(f"line {i:05d} information\n" for i in range(1200))
        self.path = self.root / f"{module._host_slug(self.url)}-{__import__('hashlib').sha256(self.url.encode()).hexdigest()[:10]}.md"
        self.started = time.time_ns()
        self.path.write_text(self.text, encoding="utf-8")
        os.chmod(self.path, 0o600)
        os.utime(self.path, None)
        self.window = module._expected_window(self.text, 8000)
        self.returned = self.window + "\n[TRUNCATED] full text saved"

    def tearDown(self):
        self.temp.cleanup()

    def test_same_call_window_binds_full_text(self):
        full, digest = module.read_verified_fulltext(
            self.url, self.returned, 8000, self.root, self.started, os.geteuid())
        self.assertEqual(full, self.text)
        self.assertEqual(len(digest), 64)

    def test_cache_with_different_middle_or_window_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "does_not_match_tool_result"):
            module.read_verified_fulltext(
                self.url, "unrelated head and tail\n[TRUNCATED]", 8000,
                self.root, self.started, os.geteuid())

    def test_stale_cache_is_rejected(self):
        os.utime(self.path, ns=(self.started - 20_000_000_000, self.started - 20_000_000_000))
        with self.assertRaisesRegex(ValueError, "cache_file_invalid"):
            module.read_verified_fulltext(
                self.url, self.returned, 8000, self.root, self.started, os.geteuid())

    def test_symlink_cache_is_rejected(self):
        target = self.root / "target.md"
        self.path.rename(target)
        self.path.symlink_to(target)
        with self.assertRaises(OSError):
            module.read_verified_fulltext(
                self.url, self.returned, 8000, self.root, self.started, os.geteuid())

    def test_service_group_write_is_allowed_but_world_write_is_rejected(self):
        os.chmod(self.root, 0o770)
        os.chmod(self.path, 0o660)
        full, _ = module.read_verified_fulltext(
            self.url, self.returned, 8000, self.root, self.started,
            os.geteuid(), os.getegid())
        self.assertEqual(full, self.text)
        os.chmod(self.path, 0o666)
        with self.assertRaisesRegex(ValueError, "cache_file_invalid"):
            module.read_verified_fulltext(
                self.url, self.returned, 8000, self.root, self.started,
                os.geteuid(), os.getegid())

    def test_wrong_limit_fails_closed(self):
        with self.assertRaisesRegex(ValueError, "contract_invalid"):
            module.read_verified_fulltext(
                self.url, self.returned, 500000, self.root, self.started, os.geteuid())


if __name__ == "__main__":
    unittest.main()
