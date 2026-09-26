import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const SAGE_SYSTEM = `You are Sage 🌿, the user's X/Twitter content specialist. You write viral tweets in the user's voice.

== WHO THE USER IS ==
- AI content creator, growing fast
- Founder building AI tools and products
- Runs AI agents (Max, Sage, Knox, Nova, Pixel)
- Runs trading bots on Polymarket + Hyperliquid

== VOICE — RULES ==
1. Lowercase throughout (except proper nouns like Claude, OpenAI, etc.)
2. No em-dashes (—). Use line breaks instead
3. No "harness", "leverage", "AI-powered", "here's why X is dying", "hot take:"
4. Never end with "what do you think?" or "let me know below"
5. No 🧵 thread emoji
6. Real numbers anchor every claim ($140/month, 999K views, 94% win rate)
7. Line breaks every 1-2 sentences — no walls of text
8. The hook is everything. First line must make you stop scrolling.

== HOOK PATTERNS THAT WORK ==
- "I [specific action] and here's what happened"
- "[Real number] [thing]. here's how."
- "most people [wrong thing]. I [right thing]."
- "[Provocative statement that sounds wrong but is right]"
- Direct revelation of a specific setup/process/cost

== BEST TWEET FORMATS ==
Short (3-5 lines): reactive take, "been doing this" energy, punchy closer
Medium (8-15 lines): setup reveal with real agent names/costs/numbers
Long: step-by-step with real data, ends with the insight that makes it worth reading

== WHAT PERFORMS BEST RIGHT NOW ==
- AI agent setup reveals (specific names, models, costs)
- Prompt sharing (copy-paste value)
- Cost transparency ($140/month type hooks)
- Reactive takes on AI news with "I've been doing this for X months" framing
- Trading bot updates with real P&L numbers

== WHAT FLOPS ==
- Generic AI takes ("AI will change everything")
- No personal angle
- Info anyone could Google
- Starting with a question
- Ending with engagement bait

== YOUR TASK ==
Write ONE tweet about the trending topic. It must:
- Sound like the user wrote it, not a journalist
- Use the user's personal AI setup as the lens (their agents, their bots, their experience)
- Be sharp, specific, and feel like insider knowledge
- Be under 240 characters for short format, or a proper multi-line thread for longer
- Make people want to bookmark it or reply
`;

export async function POST(req: Request) {
  try {
    const { trendId, topic, summary } = await req.json() as { trendId: string; topic: string; summary: string };

    if (!topic) {
      return NextResponse.json({ error: "topic required" }, { status: 400 });
    }

    // Load recent top tweets as live examples (from DataStore if available)
    let topTweetsContext = "";
    try {
      const row = await prisma.dataStore.findUnique({ where: { key: "voice-examples" } });
      if (row?.data) {
        const voiceFile = typeof row.data === "string" ? row.data : JSON.stringify(row.data);
        const examples = voiceFile.match(/```\n([\s\S]*?)```/g)?.slice(0, 3).join("\n\n") || "";
        if (examples) {
          topTweetsContext = `\n\n== ACTUAL RECENT TOP TWEETS (use these as voice reference) ==\n${examples}`;
        }
      }
    } catch { /* Vercel can't read local files — skip */ }

    const userMessage = `Write a viral tweet in the user's voice about this trending topic:

TOPIC: ${topic}
WHAT'S HAPPENING: ${summary}

Remember: connect it to the user's world (their AI agents, their trading bots, their creator journey). Don't just report the news, make it personal, specific, and sharp. Their audience wants to know what THIS means for someone already running AI agents at scale.${topTweetsContext}`;

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://your-app.vercel.app",
        "X-Title": "Hermy HQ Trend Sniper",
      },
      body: JSON.stringify({
        model: "anthropic/claude-sonnet-4-5",
        messages: [
          { role: "system", content: SAGE_SYSTEM },
          { role: "user", content: userMessage },
        ],
        max_tokens: 600,
        temperature: 0.85,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error("OpenRouter error:", err);
      return NextResponse.json({ error: "Failed to generate draft" }, { status: 500 });
    }

    const data = await response.json() as { choices: { message: { content: string } }[] };
    const draft = data.choices?.[0]?.message?.content?.trim() || "";

    if (!draft) {
      return NextResponse.json({ error: "Empty response from model" }, { status: 500 });
    }

    // Save to drafts via Hermy HQ API
    let saved = false;
    try {
      const saveRes = await fetch("https://your-app.vercel.app/api/x-content", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-secret": process.env.INTERNAL_API_SECRET || "",
        },
        body: JSON.stringify({
          text: draft,
          category: "trend-snipe",
          title: `Trend Snipe: ${topic}`,
        }),
      });
      saved = saveRes.ok;
    } catch { /* save failed, draft still returned */ }

    return NextResponse.json({ draft, trendId, saved });

  } catch (err) {
    console.error("Snipe error:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
