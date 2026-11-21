#!/usr/bin/env python3
"""Bounded Atlas web_extract adapter with verified access to its same-call full-text cache."""
from __future__ import annotations

import asyncio
import hashlib
import html
import json
import os
import re
import ssl
import stat
import sys
import time
import uuid
from pathlib import Path
from html.parser import HTMLParser
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import HTTPRedirectHandler, HTTPSHandler, Request, build_opener
from urllib.parse import urlsplit

MAX_STORED_CHARS = 2_000_000
MAX_CACHE_BYTES = 10_000_000
TRUNCATION_MARKER = "\n\n[... middle omitted — see footer ...]\n\n"
RFC9110_SECTION_URL = "https://www.rfc-editor.org/rfc/rfc9110.html"
MAX_TARGETED_DOCUMENT_CHARS = 2_000_000
MAX_TARGETED_RESPONSE_BYTES = 2_000_000
RFC9110_EXTRACTOR_MODULE = "hermes-bridge/atlas_document_fetch.py:stdlib-https-html"
RFC9110_FETCH_TIMEOUT_SECONDS = 20


class _NoRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        raise ValueError("atlas_document_redirect_rejected")


class _RfcHtmlNormalizer(HTMLParser):
    """Turn verified RFC HTML into bounded structural text without dropping section anchors."""

    _BLOCK_TAGS = {
        "address", "article", "blockquote", "br", "dd", "div", "dl", "dt", "h1", "h2",
        "h3", "h4", "h5", "h6", "hr", "li", "ol", "p", "pre", "section", "table",
        "td", "th", "tr", "ul",
    }
    _DROP_TAGS = {"script", "style", "svg", "template"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.anchor_stack: list[dict] = []
        self.drop_stack: list[str] = []
        self.title_parts: list[str] = []
        self.in_title = False
        self.target_section_depth: int | None = None
        self.target_section_count = 0
        self.target_section_closed = False
        self.target_section_parts: list[str] = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag in self._DROP_TAGS:
            self.drop_stack.append(tag)
            return
        if self.drop_stack:
            return
        if tag == "title":
            self.in_title = True
        if tag in self._BLOCK_TAGS:
            self.parts.append("\n")
        if tag == "section":
            if self.target_section_depth is not None:
                self.target_section_depth += 1
            if attributes.get("id") == "section-15.5.5":
                self.target_section_count += 1
                if self.target_section_count == 1:
                    self.target_section_depth = 1
                    self.target_section_closed = False
                    self.target_section_parts = []
        if tag in {"h1", "h2", "h3", "h4", "h5", "h6"}:
            self._append("#" * int(tag[1]) + " ")
        if tag == "a":
            classes = set((attributes.get("class") or "").split())
            self.anchor_stack.append({
                "href": attributes.get("href", ""),
                "text": [],
                "skip": "pilcrow" in classes,
            })

    def handle_endtag(self, tag):
        if self.drop_stack:
            if tag == self.drop_stack[-1]:
                self.drop_stack.pop()
            return
        if tag == "a" and self.anchor_stack:
            anchor = self.anchor_stack.pop()
            label = "".join(anchor["text"])
            if not anchor["skip"] and label.strip():
                href = str(anchor["href"] or "").strip()
                if href and len(href) <= 2048:
                    resolved = urljoin(RFC9110_SECTION_URL, href)
                    parsed = urlsplit(resolved)
                    if (parsed.scheme == "https" and parsed.hostname == "www.rfc-editor.org"
                            and parsed.path == "/rfc/rfc9110.html" and not parsed.username
                            and not parsed.password and not parsed.port and not parsed.query):
                        self._append(f"[{label}]({href})")
                    else:
                        self._append(label)
                else:
                    self._append(label)
        if tag == "title":
            self.in_title = False
        if tag in self._BLOCK_TAGS:
            self._append("\n")
        if tag == "section" and self.target_section_depth is not None:
            self.target_section_depth -= 1
            if self.target_section_depth == 0:
                self.target_section_depth = None
                self.target_section_closed = True

    def handle_data(self, data):
        if self.drop_stack:
            return
        if self.in_title:
            self.title_parts.append(data)
        if self.anchor_stack:
            self.anchor_stack[-1]["text"].append(data)
        else:
            self._append(data)

    def handle_entityref(self, name):
        self.handle_data(html.unescape(f"&{name};"))

    def handle_charref(self, name):
        self.handle_data(html.unescape(f"&#{name};"))

    def _append(self, value: str):
        self.parts.append(value)
        if self.target_section_depth is not None:
            self.target_section_parts.append(value)

    @staticmethod
    def _normalize_parts(parts: list[str]) -> str:
        lines = []
        previous_blank = False
        for raw_line in "".join(parts).splitlines():
            line = re.sub(r"\s+", " ", raw_line).strip()
            if not line:
                if lines and not previous_blank:
                    lines.append("")
                previous_blank = True
                continue
            lines.append(line)
            previous_blank = False
        return "\n".join(lines).strip()

    def normalized_text(self) -> str:
        return self._normalize_parts(self.parts)

    def normalized_target_section(self) -> str:
        return self._normalize_parts(self.target_section_parts)

    def title(self) -> str:
        return re.sub(r"\s+", " ", " ".join(self.title_parts)).strip()[:300]


def _fetch_authoritative_rfc_html(url: str) -> tuple[bytes, int, str, str]:
    if url != RFC9110_SECTION_URL:
        raise ValueError("atlas_documentary_source_mismatch")
    request = Request(url, headers={
        "Accept": "text/html",
        "Accept-Encoding": "identity",
        "User-Agent": "Hermes-Atlas-RFC9110-Extractor/1.0",
    })
    opener = build_opener(_NoRedirectHandler(), HTTPSHandler(context=ssl.create_default_context()))
    try:
        with opener.open(request, timeout=RFC9110_FETCH_TIMEOUT_SECONDS) as response:
            status = int(response.status)
            final_url = response.geturl()
            content_type = response.headers.get_content_type()
            declared_size = response.headers.get("Content-Length")
            if declared_size is not None:
                try:
                    if int(declared_size) > MAX_TARGETED_RESPONSE_BYTES:
                        raise ValueError("atlas_document_response_oversized")
                except ValueError as exc:
                    if str(exc).startswith("atlas_"):
                        raise
                    raise ValueError("atlas_document_content_length_invalid") from exc
            body = response.read(MAX_TARGETED_RESPONSE_BYTES + 1)
    except HTTPError as exc:
        raise ValueError(f"atlas_document_http_status_{int(exc.code)}") from None
    except URLError as exc:
        raise ValueError("atlas_document_fetch_failed") from None
    except TimeoutError:
        raise ValueError("atlas_document_fetch_timeout") from None
    if status != 200:
        raise ValueError(f"atlas_document_http_status_{status}")
    if final_url != RFC9110_SECTION_URL:
        raise ValueError("atlas_document_redirect_rejected")
    if content_type != "text/html":
        raise ValueError("atlas_document_content_type_rejected")
    if not body or len(body) > MAX_TARGETED_RESPONSE_BYTES:
        raise ValueError("atlas_document_response_oversized")
    return body, status, final_url, content_type


def parse_authoritative_rfc_html(url: str, body: bytes, *, extraction_id: str,
                                 status: int = 200, final_url: str | None = None,
                                 content_type: str = "text/html") -> dict:
    """Validate and normalize the allowlisted official RFC response, preserving both digests."""
    if url != RFC9110_SECTION_URL or final_url not in (None, url):
        raise ValueError("atlas_documentary_source_mismatch")
    if status != 200 or content_type != "text/html":
        raise ValueError("atlas_document_response_invalid")
    try:
        uuid.UUID(extraction_id)
    except (ValueError, TypeError, AttributeError) as exc:
        raise ValueError("atlas_extraction_id_invalid") from exc
    if not isinstance(body, bytes) or not body or len(body) > MAX_TARGETED_RESPONSE_BYTES:
        raise ValueError("atlas_document_response_oversized")
    try:
        document = body.decode("utf-8", "strict")
    except UnicodeDecodeError as exc:
        raise ValueError("atlas_document_encoding_invalid") from exc
    normalizer = _RfcHtmlNormalizer()
    try:
        normalizer.feed(document)
        normalizer.close()
    except Exception as exc:
        raise ValueError("atlas_document_html_invalid") from exc
    full_content = normalizer.normalized_text()
    target_section_content = normalizer.normalized_target_section()
    if (not full_content or len(full_content) > MAX_TARGETED_DOCUMENT_CHARS
            or "RFC 9110" not in full_content
            or "section-15.5.5" not in full_content
            or "section-15.5.6" not in full_content):
        raise ValueError("atlas_document_structure_incomplete")
    if (normalizer.target_section_count != 1 or not normalizer.target_section_closed
            or not target_section_content or target_section_content not in full_content
            or "section-15.5.5" not in target_section_content
            or "404 Not Found" not in target_section_content):
        raise ValueError("atlas_document_target_section_invalid")
    normalized_raw = full_content.encode("utf-8", "strict")
    return {
        "url": url,
        "sourceURL": url,
        "requestedUrl": url,
        "title": normalizer.title(),
        "extractorModule": RFC9110_EXTRACTOR_MODULE,
        "httpStatus": status,
        "contentType": content_type,
        "sourceResponseBytes": len(body),
        "sourceResponseSha256": hashlib.sha256(body).hexdigest(),
        "extractionId": extraction_id,
        "fullContent": full_content,
        "fullTextSha256": hashlib.sha256(normalized_raw).hexdigest(),
        "fullTextChars": len(full_content.encode("utf-16-le")) // 2,
        "targetSectionId": "15.5.5",
        "targetSectionContent": target_section_content,
        "targetSectionChars": len(target_section_content),
        "targetSectionSha256": hashlib.sha256(target_section_content.encode("utf-8")).hexdigest(),
        "error": None,
    }


def parse_authorized_web_extract(url: str, response_text: str, *, extraction_id: str) -> dict:
    """Bind the full document returned by this one authorized web_extract call."""
    if url != RFC9110_SECTION_URL:
        raise ValueError("atlas_documentary_source_mismatch")
    try:
        uuid.UUID(extraction_id)
    except (ValueError, TypeError, AttributeError) as exc:
        raise ValueError("atlas_extraction_id_invalid") from exc
    if not isinstance(response_text, str) or len(response_text.encode("utf-8")) > MAX_CACHE_BYTES:
        raise ValueError("atlas_web_extract_response_size_invalid")
    try:
        payload = json.loads(response_text)
    except Exception as exc:
        raise ValueError("atlas_web_extract_invalid") from exc
    results = payload.get("results") if isinstance(payload, dict) else None
    errors = payload.get("errors", []) if isinstance(payload, dict) else None
    if (not isinstance(results, list) or len(results) != 1
            or payload.get("error") or errors not in (None, [])):
        raise ValueError("atlas_web_extract_result_ambiguous")
    item = results[0]
    if (not isinstance(item, dict) or item.get("error")
            or item.get("url") != url
            or not isinstance(item.get("content"), str)
            or not item["content"].strip()):
        raise ValueError("atlas_web_extract_provenance_invalid")
    content = item["content"]
    if len(content) > MAX_TARGETED_DOCUMENT_CHARS or re.search(
            r"\[\s*(?:TRUNCATED|\.\.\.\s*(?:middle omitted|stored copy truncated)|content has been truncated)",
            content, re.I):
        raise ValueError("atlas_web_extract_truncated")
    raw = content.encode("utf-8", "strict")
    title = item.get("title", "")
    if not isinstance(title, str):
        title = ""
    return {
        "url": url,
        "sourceURL": url,
        "requestedUrl": url,
        "title": title[:300],
        "extractorModule": "tools.web_tools.web_extract_tool",
        "extractionId": extraction_id,
        "fullContent": content,
        "fullTextSha256": hashlib.sha256(raw).hexdigest(),
        "fullTextChars": len(raw.decode("utf-8").encode("utf-16-le")) // 2,
        "error": None,
    }


async def _extract_targeted_section(url: str) -> dict:
    """Fetch the exact allowlisted RFC over verified HTTPS and retain its section structure."""
    if url != RFC9110_SECTION_URL:
        raise ValueError("atlas_documentary_source_mismatch")
    from tools.web_tools import _validate_extract_urls, async_is_safe_url
    normalized, indices, invalid, blocked = _validate_extract_urls([url])
    if normalized != [url] or indices != [0] or invalid or blocked:
        raise ValueError("atlas_document_source_invalid")
    if not await async_is_safe_url(url):
        raise ValueError("atlas_document_source_blocked")
    from tools.website_policy import check_website_access
    if check_website_access(url) is not None:
        raise ValueError("atlas_document_source_policy_blocked")
    extraction_id = str(uuid.uuid4())
    body, status, final_url, content_type = await asyncio.to_thread(_fetch_authoritative_rfc_html, url)
    return parse_authoritative_rfc_html(
        url, body, extraction_id=extraction_id, status=status,
        final_url=final_url, content_type=content_type,
    )


def _host_slug(url: str) -> str:
    host = (urlsplit(url).hostname or "page").replace(":", "_")
    return re.sub(r"[^A-Za-z0-9._-]", "-", host)[:60].strip("-") or "page"


def _expected_window(text: str, char_limit: int) -> str:
    if len(text) <= char_limit:
        return text
    head_budget = int(char_limit * 0.75)
    tail_budget = char_limit - head_budget
    head, tail = text[:head_budget], text[-tail_budget:]
    if (nl := head.rfind("\n")) > head_budget * 0.5:
        head = head[:nl]
    if 0 <= (nl := tail.find("\n")) < tail_budget * 0.5:
        tail = tail[nl + 1:]
    return head + TRUNCATION_MARKER + tail


def read_verified_fulltext(url: str, returned_content: str, char_limit: int,
                           cache_dir: Path, started_ns: int, expected_uid: int | None = None,
                           expected_gid: int | None = None) -> tuple[str, str]:
    """Read the deterministic cache file written by this extraction; bind it to returned window."""
    if not isinstance(url, str) or not isinstance(returned_content, str) or char_limit != 8000:
        raise ValueError("atlas_fulltext_contract_invalid")
    parsed = urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("atlas_fulltext_url_invalid")
    uid = os.geteuid() if expected_uid is None else expected_uid
    gid = os.getegid() if expected_gid is None else expected_gid
    root = Path(cache_dir).resolve(strict=True)
    root_info = root.stat()
    if (not stat.S_ISDIR(root_info.st_mode) or root_info.st_uid not in (uid, 0)
            or root_info.st_gid != gid or root_info.st_mode & 0o002):
        raise ValueError("atlas_fulltext_cache_directory_invalid")
    digest = hashlib.sha256(url.encode("utf-8")).hexdigest()[:10]
    path = root / f"{_host_slug(url)}-{digest}.md"
    if path.parent.resolve(strict=True) != root:
        raise ValueError("atlas_fulltext_cache_path_invalid")
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags)
    try:
        before = os.fstat(fd)
        if (not stat.S_ISREG(before.st_mode) or before.st_uid != uid
                or before.st_gid != gid or before.st_mode & 0o002 or before.st_size <= 0
                or before.st_size > MAX_CACHE_BYTES
                or before.st_mtime_ns < started_ns - 5_000_000_000):
            raise ValueError("atlas_fulltext_cache_file_invalid")
        chunks = []
        remaining = MAX_CACHE_BYTES + 1
        while remaining:
            part = os.read(fd, min(1024 * 1024, remaining))
            if not part:
                break
            chunks.append(part)
            remaining -= len(part)
        after = os.fstat(fd)
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (
                after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
            raise ValueError("atlas_fulltext_cache_changed_during_read")
    finally:
        os.close(fd)
    raw = b"".join(chunks)
    if len(raw) > MAX_CACHE_BYTES:
        raise ValueError("atlas_fulltext_cache_oversized")
    text = raw.decode("utf-8", "strict")
    if len(text) > MAX_STORED_CHARS or "[... stored copy truncated at " in text:
        raise ValueError("atlas_fulltext_cache_truncated")
    expected = _expected_window(text, char_limit)
    if len(text) <= char_limit:
        if returned_content != expected:
            raise ValueError("atlas_fulltext_cache_does_not_match_tool_result")
    elif not returned_content.startswith(expected) or "[TRUNCATED]" not in returned_content:
        raise ValueError("atlas_fulltext_cache_does_not_match_tool_result")
    return text, hashlib.sha256(raw).hexdigest()


async def _main(url: str, section_id: str) -> None:
    from hermes_constants import get_hermes_dir
    from tools.web_tools import web_extract_tool

    if section_id:
        if section_id != "15.5.5":
            raise ValueError("atlas_documentary_section_not_allowlisted")
        result = await _extract_targeted_section(url)
    else:
        raw = await web_extract_tool([url], format="text", char_limit=8000)
        try:
            payload = json.loads(raw)
        except Exception as exc:
            raise ValueError("atlas_web_extract_invalid") from exc
        results = payload.get("results") if isinstance(payload, dict) else None
        if not isinstance(results, list) or len(results) != 1:
            raise ValueError("atlas_web_extract_failed")
        item = results[0]
        if (not isinstance(item, dict) or item.get("error")
                or not isinstance(item.get("url"), str)
                or not isinstance(item.get("content"), str) or not item["content"].strip()):
            raise ValueError("atlas_web_extract_failed")
        result = {"url": item["url"], "title": item.get("title", ""),
                  "content": item["content"], "extractorModule": "tools.web_tools.web_extract_tool",
                  "error": None}
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    if len(sys.argv) not in (2, 3):
        raise SystemExit("atlas_web_extract_invalid_arguments")
    try:
        asyncio.run(_main(sys.argv[1], sys.argv[2] if len(sys.argv) == 3 else ""))
    except Exception as exc:
        # Category only; provider, cache paths, and document text are not logged.
        message = str(exc) if str(exc).startswith("atlas_") else "atlas_web_extract_failed"
        print(json.dumps({"error": message}, separators=(",", ":")))
