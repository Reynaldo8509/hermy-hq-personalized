import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// your approved visual theme — warm cream, white cards, colorful left bars
const ACCENT_COLORS = ["#e8614d", "#5b9cf6", "#34c785", "#f5a623", "#e879a0", "#a78bfa"];
const BG = "#f2ebe0";
const CARD_BG = "#ffffff";
const TITLE_COLOR = "#1a1a1a";
const MUTED_TEXT = "#999999";
const SUBTITLE_COLOR = "#aaaaaa";
const FOOTER_COLOR = "#bbbbbb";

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function wrapText(text: string, maxChars: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > maxChars) {
      if (cur) lines.push(cur.trim());
      cur = w;
    } else {
      cur = (cur + " " + w).trim();
    }
  }
  if (cur) lines.push(cur.trim());
  return lines;
}

function stripBullet(l: string): string {
  return l.replace(/^(\d+[\.\)]\s*|[•\-\*→\.]\s*)/, "").trim();
}

export async function POST(req: NextRequest) {
  const { draftId } = await req.json();
  if (!draftId) return NextResponse.json({ error: "draftId required" }, { status: 400 });

  const draft = await prisma.draft.findUnique({ where: { id: draftId } });
  if (!draft) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const tweetText = draft.text || "";
    const rawLines = tweetText.split(/\n+/).map((l) => l.trim()).filter(Boolean);

    // ── Detect visual type ──────────────────────────────────────────
    const isComparison = /\bvs\.?\b/i.test(tweetText) && tweetText.includes("\n");
    const listItems = rawLines.filter((l) => l.match(/^[\d•\-\*→]\s*[\.\)]?\s*/));
    const isList = listItems.length >= 3;

    // ── Shared dimensions ───────────────────────────────────────────
    const W = 1080;
    const H = 1350;
    const PAD = 64;
    const CARD_RADIUS = 16;
    const BAR_W = 6;

    let svgBody = "";

    if (isComparison) {
      // ── COMPARISON: two-column layout ────────────────────────────
      // Find "vs" line or split first/second halves
      const vsIdx = rawLines.findIndex((l) => /^vs\.?$/i.test(l));
      let leftTitle = "prompting";
      let rightTitle = "delegating";
      let leftItems: string[] = [];
      let rightItems: string[] = [];

      if (vsIdx > 0) {
        leftTitle = rawLines[0];
        rightTitle = rawLines[vsIdx + 1] || "delegating";
        leftItems = rawLines.slice(1, vsIdx).map(stripBullet).filter(Boolean);
        rightItems = rawLines.slice(vsIdx + 2).map(stripBullet).filter(Boolean);
      } else {
        // Try to extract from "examples" section or just split list items evenly
        const allItems = rawLines.filter((l) => l.startsWith("-")).map((l) => l.replace(/^-\s*/, "").trim());
        const mid = Math.ceil(allItems.length / 2);
        leftItems = allItems.slice(0, mid).map((l) => l.split(" becomes ")[0]?.replace(/^"|"$/g, "").trim()).filter(Boolean);
        rightItems = allItems.slice(0, mid).map((l) => l.split(" becomes ")[1]?.replace(/^"|"$/g, "").trim()).filter(Boolean);
        if (rightItems.every((r) => !r)) {
          leftItems = allItems.slice(0, mid);
          rightItems = allItems.slice(mid);
        }
      }

      // Title
      const titleText = rawLines[0] || "prompting vs delegating";
      const subtitleText = "most people never make the jump";
      svgBody += `<text x="${PAD}" y="96" font-size="58" font-weight="800" fill="${TITLE_COLOR}" font-family="-apple-system,'SF Pro Display','Inter',sans-serif" letter-spacing="-2">${esc(titleText)}</text>`;
      svgBody += `<text x="${PAD}" y="126" font-size="14" font-weight="600" fill="${SUBTITLE_COLOR}" font-family="-apple-system,sans-serif" letter-spacing="3" text-transform="uppercase">${esc(subtitleText.toUpperCase())}</text>`;

      // Column headers
      const colW = (W - PAD * 2 - 20) / 2;
      const colRightX = PAD + colW + 20;
      svgBody += `<text x="${PAD}" y="174" font-size="11" font-weight="700" fill="${MUTED_TEXT}" font-family="-apple-system,sans-serif" letter-spacing="3">PROMPTING</text>`;
      svgBody += `<text x="${colRightX}" y="174" font-size="11" font-weight="700" fill="#555555" font-family="-apple-system,sans-serif" letter-spacing="3">DELEGATING</text>`;

      // Rows
      const maxRows = Math.max(leftItems.length, rightItems.length);
      const availH = H - 240 - 80; // space for header + footer
      const rowH = Math.min(Math.floor(availH / maxRows) - 12, 140);
      let rowY = 194;

      for (let i = 0; i < maxRows; i++) {
        const left = leftItems[i] || "";
        const right = rightItems[i] || "";
        const accentColor = ACCENT_COLORS[i % ACCENT_COLORS.length];

        // Left card (muted, no color bar)
        svgBody += `<rect x="${PAD}" y="${rowY}" width="${colW}" height="${rowH}" rx="${CARD_RADIUS}" fill="${CARD_BG}" stroke="#eeeeee" stroke-width="1.5"/>`;
        const leftLines = wrapText(left, 24);
        leftLines.slice(0, 3).forEach((line, li) => {
          svgBody += `<text x="${PAD + 20}" y="${rowY + 30 + li * 24}" font-size="17" fill="${MUTED_TEXT}" font-style="italic" font-family="-apple-system,sans-serif">${esc(line)}</text>`;
        });

        // Right card (colored bar)
        svgBody += `<rect x="${colRightX}" y="${rowY}" width="${colW}" height="${rowH}" rx="${CARD_RADIUS}" fill="${CARD_BG}" stroke="#eeeeee" stroke-width="1.5"/>`;
        // Colored left bar (clipped to card corners)
        svgBody += `<rect x="${colRightX}" y="${rowY}" width="${BAR_W}" height="${rowH}" rx="${CARD_RADIUS}" fill="${accentColor}"/>`;
        svgBody += `<rect x="${colRightX}" y="${rowY}" width="${BAR_W}" height="${rowH / 2}" fill="${accentColor}"/>`;
        const rightLines = wrapText(right, 26);
        rightLines.slice(0, 3).forEach((line, li) => {
          svgBody += `<text x="${colRightX + BAR_W + 14}" y="${rowY + 30 + li * 24}" font-size="17" fill="${TITLE_COLOR}" font-weight="500" font-family="-apple-system,sans-serif">${esc(line)}</text>`;
        });

        rowY += rowH + 12;
      }

      // Footer
      const footerY = H - 44;
      svgBody += `<line x1="${PAD}" y1="${footerY - 18}" x2="${W - PAD}" y2="${footerY - 18}" stroke="#dddddd" stroke-width="1"/>`;
      svgBody += `<text x="${PAD}" y="${footerY}" font-size="12" fill="${FOOTER_COLOR}" font-family="-apple-system,sans-serif" letter-spacing="2">SAVES MINUTES</text>`;
      svgBody += `<text x="${W - PAD}" y="${footerY}" font-size="12" fill="#555555" font-weight="700" font-family="-apple-system,sans-serif" letter-spacing="2" text-anchor="end">GIVES YOU BACK HOURS</text>`;

    } else if (isList) {
      // ── LIST: numbered cards with colored bars ───────────────────

      // Separate list items from non-list lines
      const items = rawLines
        .filter((l) => l.match(/^[\d•\-\*→]/))
        .map(stripBullet)
        .filter(Boolean)
        .slice(0, 8);

      const nonListLines = rawLines.filter((l) => !l.match(/^[\d•\-\*→]/));

      // Title = first non-list line
      const headline = nonListLines[0] || rawLines[0] || "";
      // Closing line = last non-list line (if different from headline)
      const closingLine = nonListLines.length > 1 ? nonListLines[nonListLines.length - 1] : "";

      // Title block — wrap long headlines
      const hlLines = wrapText(headline, 32);
      const titleLineH = 56;
      const titleBlockH = hlLines.slice(0, 2).length * titleLineH + 16;
      let curY = 72;

      hlLines.slice(0, 2).forEach((line, i) => {
        svgBody += `<text x="${PAD}" y="${curY + i * titleLineH}" font-size="48" font-weight="800" fill="${TITLE_COLOR}" font-family="-apple-system,'SF Pro Display','Inter',sans-serif" letter-spacing="-1.5">${esc(line)}</text>`;
      });
      curY += titleBlockH;

      // Subtitle line (second non-list line if exists, e.g. "here's what works:")
      const subtitleLine = nonListLines.length > 1 ? nonListLines[1] : "";
      if (subtitleLine && subtitleLine !== closingLine) {
        const subLines = wrapText(subtitleLine, 48);
        subLines.slice(0, 1).forEach((line) => {
          svgBody += `<text x="${PAD}" y="${curY}" font-size="22" fill="#888888" font-family="-apple-system,sans-serif">${esc(line)}</text>`;
        });
        curY += 36;
      }

      // Closing line reserved height at bottom
      const FOOTER_H = closingLine ? 80 : 60;
      const FOOTER_Y = H - FOOTER_H;

      // Cards: cap at MAX_CARD_H so short lists don't get absurdly tall
      const MAX_CARD_H = 160;
      const CARD_GAP = 14;
      const availH = FOOTER_Y - curY - 16;
      const idealCardH = Math.floor((availH - CARD_GAP * (items.length - 1)) / items.length);
      const cardH = Math.min(idealCardH, MAX_CARD_H);

      items.forEach((item, i) => {
        const accentColor = ACCENT_COLORS[i % ACCENT_COLORS.length];
        const cardY = curY + i * (cardH + CARD_GAP);
        const cardW = W - PAD * 2;

        // Card bg
        svgBody += `<rect x="${PAD}" y="${cardY}" width="${cardW}" height="${cardH}" rx="${CARD_RADIUS}" fill="${CARD_BG}" stroke="#e8e8e8" stroke-width="1.5"/>`;
        // Colored left bar (top half rect to avoid double-radius at bottom)
        svgBody += `<rect x="${PAD}" y="${cardY}" width="${BAR_W}" height="${cardH}" rx="${CARD_RADIUS}" fill="${accentColor}"/>`;
        svgBody += `<rect x="${PAD}" y="${cardY + CARD_RADIUS}" width="${BAR_W}" height="${cardH - CARD_RADIUS}" fill="${accentColor}"/>`;

        // Item text — vertically centered in card
        const textLines = wrapText(item, 46);
        const lineH = 30;
        const textBlockH = Math.min(textLines.length, 2) * lineH;
        const textStartY = cardY + Math.floor((cardH - textBlockH) / 2) + lineH - 4;

        // Number badge aligned to first text line
        svgBody += `<text x="${PAD + BAR_W + 18}" y="${textStartY}" font-size="13" font-weight="800" fill="${accentColor}" font-family="-apple-system,sans-serif" letter-spacing="1">${i + 1}</text>`;

        textLines.slice(0, 2).forEach((line, li) => {
          svgBody += `<text x="${PAD + BAR_W + 52}" y="${textStartY + li * lineH}" font-size="22" fill="${TITLE_COLOR}" font-weight="500" font-family="-apple-system,sans-serif">${esc(line)}</text>`;
        });
      });

      // Footer: closing line + divider
      svgBody += `<line x1="${PAD}" y1="${FOOTER_Y + 14}" x2="${W - PAD}" y2="${FOOTER_Y + 14}" stroke="#dddddd" stroke-width="1"/>`;
      if (closingLine) {
        const clLines = wrapText(closingLine, 55);
        clLines.slice(0, 2).forEach((line, i) => {
          svgBody += `<text x="${PAD}" y="${FOOTER_Y + 38 + i * 24}" font-size="18" fill="#555555" font-weight="600" font-family="-apple-system,sans-serif">${esc(line)}</text>`;
        });
      } else {
        svgBody += `<text x="${W / 2}" y="${FOOTER_Y + 38}" font-size="12" fill="${FOOTER_COLOR}" font-family="-apple-system,sans-serif" text-anchor="middle" letter-spacing="2">@YOURHANDLE</text>`;
      }

    } else {
      // ── INSIGHT: single quote-card layout ────────────────────────
      // Big quote card with accent bar and key lines
      const lines = rawLines.slice(0, 6);

      // Title card
      const titleCard = { x: PAD, y: 80, w: W - PAD * 2, h: 200 };
      svgBody += `<rect x="${titleCard.x}" y="${titleCard.y}" width="${titleCard.w}" height="${titleCard.h}" rx="20" fill="${CARD_BG}" stroke="#eeeeee" stroke-width="1.5"/>`;
      svgBody += `<rect x="${titleCard.x}" y="${titleCard.y}" width="${BAR_W}" height="${titleCard.h}" rx="20" fill="${ACCENT_COLORS[0]}"/>`;
      svgBody += `<rect x="${titleCard.x}" y="${titleCard.y}" width="${BAR_W}" height="${titleCard.h / 2}" fill="${ACCENT_COLORS[0]}"/>`;

      const firstLineWords = lines[0].split(" ");
      const bigText = firstLineWords.length > 8 ? firstLineWords.slice(0, 8).join(" ") + "…" : lines[0];
      const bigLines = wrapText(bigText, 30);
      bigLines.slice(0, 3).forEach((line, i) => {
        svgBody += `<text x="${PAD + BAR_W + 28}" y="${titleCard.y + 56 + i * 52}" font-size="42" font-weight="800" fill="${TITLE_COLOR}" font-family="-apple-system,'SF Pro Display','Inter',sans-serif" letter-spacing="-1">${esc(line)}</text>`;
      });

      // Remaining lines as smaller cards
      let bodyY = titleCard.y + titleCard.h + 20;
      lines.slice(1).forEach((line, i) => {
        const accentColor = ACCENT_COLORS[(i + 1) % ACCENT_COLORS.length];
        const textLines = wrapText(line, 54);
        const cardH = Math.max(72, textLines.length * 26 + 36);
        svgBody += `<rect x="${PAD}" y="${bodyY}" width="${W - PAD * 2}" height="${cardH}" rx="${CARD_RADIUS}" fill="${CARD_BG}" stroke="#eeeeee" stroke-width="1.5"/>`;
        svgBody += `<rect x="${PAD}" y="${bodyY}" width="${BAR_W}" height="${cardH}" rx="${CARD_RADIUS}" fill="${accentColor}"/>`;
        svgBody += `<rect x="${PAD}" y="${bodyY}" width="${BAR_W}" height="${cardH / 2}" fill="${accentColor}"/>`;
        textLines.forEach((tl, li) => {
          svgBody += `<text x="${PAD + BAR_W + 24}" y="${bodyY + 30 + li * 26}" font-size="20" fill="${TITLE_COLOR}" font-family="-apple-system,sans-serif">${esc(tl)}</text>`;
        });
        bodyY += cardH + 12;
      });

      // Footer
      const footerY = H - 44;
      svgBody += `<line x1="${PAD}" y1="${footerY - 18}" x2="${W - PAD}" y2="${footerY - 18}" stroke="#dddddd" stroke-width="1"/>`;
      svgBody += `<text x="${W / 2}" y="${footerY}" font-size="12" fill="${FOOTER_COLOR}" font-family="-apple-system,sans-serif" text-anchor="middle" letter-spacing="2">@YOURHANDLE</text>`;
    }

    // ── Wrap in SVG ──────────────────────────────────────────────────
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${BG}"/>
  ${svgBody}
</svg>`;

    const svgBase64 = Buffer.from(svg).toString("base64");
    const dataUrl = `data:image/svg+xml;base64,${svgBase64}`;

    await prisma.draft.update({
      where: { id: draftId },
      data: { visualUrl: dataUrl },
    });

    return NextResponse.json({ visualUrl: dataUrl });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Visual generation failed:", msg);
    return NextResponse.json({ error: "Generation failed", details: msg }, { status: 500 });
  }
}
