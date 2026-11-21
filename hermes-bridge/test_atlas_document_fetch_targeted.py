import asyncio
import hashlib
import importlib.util
import json
import pathlib
import sys
import types
import unittest
from unittest.mock import AsyncMock, Mock

HERE = pathlib.Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("atlas_document_fetch", HERE / "atlas_document_fetch.py")
FETCH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(FETCH)
FIXTURE = json.loads((HERE / "test-fixtures-atlas-rfc9110-1555.json").read_text(encoding="utf-8"))
URL = "https://www.rfc-editor.org/rfc/rfc9110.html"


class AuthorizedWebExtractTests(unittest.TestCase):
    def setUp(self):
        self.tools_pkg = types.ModuleType("tools")
        self.tools_pkg.__path__ = []
        self.web = types.ModuleType("tools.web_tools")
        self.web._validate_extract_urls = Mock(return_value=([URL], [0], {}, None))
        self.web.async_is_safe_url = AsyncMock(return_value=True)
        self.web.web_extract_tool = AsyncMock()
        self.policy = types.ModuleType("tools.website_policy")
        self.policy.check_website_access = Mock(return_value=None)
        self.modules = {
            "tools": self.tools_pkg,
            "tools.web_tools": self.web,
            "tools.website_policy": self.policy,
        }

    def run_extract(self, url=URL):
        with unittest.mock.patch.dict(sys.modules, self.modules):
            return asyncio.run(FETCH._extract_targeted_section(url))

    def response(self, content=None, *, url=URL, result_count=1, error=None, errors=None):
        item = {"url": url, "title": FIXTURE["title"],
                "content": FIXTURE["content"] if content is None else content,
                "error": error}
        return json.dumps({"results": [item for _ in range(result_count)], "errors": errors or []})

    def test_section_uses_only_authorized_web_extract_and_binds_full_text(self):
        self.web.web_extract_tool.return_value = self.response()
        result = self.run_extract()
        self.assertEqual(result["url"], URL)
        self.assertEqual(result["sourceURL"], URL)
        self.assertEqual(result["requestedUrl"], URL)
        self.assertEqual(result["fullContent"], FIXTURE["content"])
        self.assertEqual(result["extractorModule"], "tools.web_tools.web_extract_tool")
        self.assertEqual(result["fullTextSha256"], hashlib.sha256(FIXTURE["content"].encode()).hexdigest())
        self.assertEqual(result["fullTextChars"], len(FIXTURE["content"].encode("utf-16-le")) // 2)
        self.assertEqual(len(result["extractionId"]), 36)
        self.web.web_extract_tool.assert_awaited_once_with(
            [URL], format="text", char_limit=500_000)
        self.web._validate_extract_urls.assert_called_once_with([URL])
        self.web.async_is_safe_url.assert_awaited_once_with(URL)
        self.policy.check_website_access.assert_called_once_with(URL)

    def test_wrong_or_untrusted_source_is_rejected_before_fetch(self):
        with self.assertRaisesRegex(ValueError, "source_mismatch"):
            self.run_extract("https://example.invalid/document")
        self.web.web_extract_tool.assert_not_awaited()

    def test_denied_ssrf_or_site_policy_never_calls_extractor(self):
        self.web.async_is_safe_url.return_value = False
        with self.assertRaisesRegex(ValueError, "source_blocked"):
            self.run_extract()
        self.web.web_extract_tool.assert_not_awaited()
        self.web.async_is_safe_url.return_value = True
        self.policy.check_website_access.return_value = "blocked"
        with self.assertRaisesRegex(ValueError, "policy_blocked"):
            self.run_extract()
        self.web.web_extract_tool.assert_not_awaited()

    def test_ambiguous_wrong_url_error_and_truncated_results_fail_closed(self):
        invalid_responses = [
            self.response(url="https://www.rfc-editor.org/other"),
            self.response(result_count=2),
            self.response(error="provider failure"),
            self.response(errors=[{"url": URL, "error": "provider failure"}]),
            self.response(content="x" * 500_001),
            self.response(content=FIXTURE["content"] + "\n[... middle omitted — see footer ...]"),
        ]
        for raw in invalid_responses:
            with self.subTest(response_size=len(raw)):
                self.web.web_extract_tool.return_value = raw
                with self.assertRaises(ValueError):
                    self.run_extract()
        self.assertEqual(self.web.web_extract_tool.await_count, len(invalid_responses))


if __name__ == "__main__":
    unittest.main()
