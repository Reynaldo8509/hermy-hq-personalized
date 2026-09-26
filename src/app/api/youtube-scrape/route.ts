export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const { url } = await req.json();
    if (!url) return NextResponse.json({ error: "url required" }, { status: 400 });

    const match = url.match(/(?:v=|youtu\.be\/|\/shorts\/)([a-zA-Z0-9_-]{11})/);
    if (!match) return NextResponse.json({ error: "Invalid YouTube URL" }, { status: 400 });
    const videoId = match[1];

    // Try YouTube Data API v3 if key available
    const ytKey = process.env.YOUTUBE_API_KEY;
    if (ytKey) {
      const apiRes = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?id=${videoId}&part=snippet,statistics&key=${ytKey}`,
        { cache: "no-store" }
      );
      if (apiRes.ok) {
        const data = await apiRes.json();
        const item = data.items?.[0];
        if (item) {
          return NextResponse.json({
            title: item.snippet?.title || "",
            description: item.snippet?.description || "",
            thumbnail: item.snippet?.thumbnails?.maxres?.url || item.snippet?.thumbnails?.high?.url || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
            duration: "",
            viewCount: parseInt(item.statistics?.viewCount || "0"),
            likeCount: parseInt(item.statistics?.likeCount || "0"),
            commentCount: parseInt(item.statistics?.commentCount || "0"),
            transcript: "",
          });
        }
      }
    }

    // Fallback: oEmbed + page scrape
    let title = "";
    let thumbnail = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
    let viewCount = 0;
    let likeCount = 0;
    let description = "";

    try {
      const oembed = await fetch(
        `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
        { cache: "no-store" }
      );
      if (oembed.ok) {
        const d = await oembed.json();
        title = d.title || "";
        thumbnail = d.thumbnail_url || thumbnail;
      }
    } catch { /* ok */ }

    try {
      const pageRes = await fetch(
        `https://www.youtube.com/watch?v=${videoId}`,
        {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" },
          cache: "no-store",
        }
      );
      if (pageRes.ok) {
        const html = await pageRes.text();
        const vcMatch = html.match(/"viewCount"\s*:\s*"(\d+)"/);
        if (vcMatch) viewCount = parseInt(vcMatch[1]);
        const lcMatch = html.match(/"likeCount"\s*:\s*"(\d+)"/);
        if (lcMatch) likeCount = parseInt(lcMatch[1]);
        const descMatch = html.match(/"shortDescription"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (descMatch) description = descMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"');
        if (!title) {
          const tMatch = html.match(/<title>([^<]+)<\/title>/);
          if (tMatch) title = tMatch[1].replace(" - YouTube", "").trim();
        }
      }
    } catch { /* ok */ }

    return NextResponse.json({
      title,
      description,
      thumbnail,
      duration: "",
      viewCount,
      likeCount,
      commentCount: 0,
      transcript: "",
    });
  } catch (e) {
    console.error("youtube-scrape error:", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
