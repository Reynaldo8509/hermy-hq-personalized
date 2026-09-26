export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import fs from "fs";

const TWEETS_FILE = "./data/tweet-library/tweets.json";

export async function GET() {
  try {
    if (!fs.existsSync(TWEETS_FILE)) {
      return NextResponse.json([]);
    }
    const data = JSON.parse(fs.readFileSync(TWEETS_FILE, "utf-8"));
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const tweets = (data.tweets || data || [])
      .map((t: Record<string, unknown>) => ({
        text: (t.text as string) || "",
        views: (t.metrics as Record<string, number>)?.views ?? (t.views as number) ?? 0,
        likes: (t.metrics as Record<string, number>)?.likes ?? (t.likes as number) ?? 0,
        retweets: (t.metrics as Record<string, number>)?.retweets ?? (t.retweets as number) ?? 0,
        replies: (t.metrics as Record<string, number>)?.replies ?? (t.replies as number) ?? 0,
        bookmarks: (t.metrics as Record<string, number>)?.bookmarks ?? (t.bookmarks as number) ?? 0,
        date: (t.date as string) || "",
        url: (t.url as string) || "",
      }))
      .filter((t: { date: string }) => {
        if (!t.date) return false;
        try { return new Date(t.date) >= thirtyDaysAgo; } catch { return false; }
      })
      .sort((a: { views: number; likes: number }, b: { views: number; likes: number }) => (b.views || b.likes) - (a.views || a.likes))
      .slice(0, 20);
    return NextResponse.json(tweets);
  } catch {
    return NextResponse.json([]);
  }
}
