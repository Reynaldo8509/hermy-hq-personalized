import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Ported directly from willitgoviral.xyz scoring algorithm
function analyzeContent(text: string) {
  const signals: { name: string; status: string; description: string }[] = [];
  let score = 0;
  const recommendations: string[] = [];

  // Signal 1: Has a Hook
  const firstSentence = text.split(/[.!?]/)[0];
  const hasHook = firstSentence.length > 0 && (
    text.toLowerCase().includes('how to') ||
    text.toLowerCase().includes('why') ||
    text.match(/\?/) ||
    text.toLowerCase().includes('secret') ||
    text.toLowerCase().includes('never') ||
    firstSentence.length < 100
  );
  if (hasHook) { score += 15; signals.push({ name: 'Strong Hook', status: '✅', description: 'Opens with curiosity or value' }); }
  else { signals.push({ name: 'Weak Hook', status: '❌', description: 'First sentence doesn\'t grab attention' }); recommendations.push('Start with a question, bold claim, or immediate value'); }

  // Signal 2: Asks a Question
  if (text.includes('?')) { score += 12; signals.push({ name: 'Asks Question', status: '✅', description: 'Questions drive replies - highest-weighted signal' }); }
  else { signals.push({ name: 'No Question', status: '⚠️', description: 'Missing reply trigger' }); recommendations.push('Add a question to encourage replies'); }

  // Signal 3: Optimal Length
  const wordCount = text.split(/\s+/).length;
  if (wordCount >= 30 && wordCount <= 150) { score += 10; signals.push({ name: 'Good Length', status: '✅', description: `${wordCount} words - optimal dwell time` }); }
  else if (wordCount < 30) { signals.push({ name: 'Too Short', status: '⚠️', description: `${wordCount} words - may not drive enough dwell time` }); recommendations.push('Aim for 30-150 words'); }
  else { score += 5; signals.push({ name: 'Very Long', status: '⚠️', description: `${wordCount} words - might lose attention` }); }

  // Signal 4: Numbers/Data
  if (/\d+/.test(text)) { score += 8; signals.push({ name: 'Data-Driven', status: '✅', description: 'Numbers increase credibility and shareability' }); }
  else { signals.push({ name: 'No Data', status: '⚠️', description: 'Add specific numbers for trust' }); recommendations.push('Add specific numbers or data points'); }

  // Signal 5: Line Breaks
  const lineBreaks = (text.match(/\n/g) || []).length;
  if (lineBreaks >= 2 || wordCount < 40) { score += 8; signals.push({ name: 'Readable Format', status: '✅', description: 'Good formatting keeps people reading' }); }
  else { signals.push({ name: 'Wall of Text', status: '❌', description: 'Dense text hurts dwell time' }); recommendations.push('Break into shorter paragraphs with line breaks'); }

  // Signal 6: Call-to-Action
  if (text.toLowerCase().match(/reply|comment|share|repost|like|follow|click|check|read|watch|listen/)) { score += 10; signals.push({ name: 'Clear CTA', status: '✅', description: 'Tells people what to do' }); }
  else { signals.push({ name: 'No CTA', status: '⚠️', description: 'No explicit call-to-action' }); recommendations.push('End with a clear call-to-action'); }

  // Signal 7: Spam Triggers
  if (!text.toLowerCase().match(/buy now|click here|limited time|act now|guarantee|100%|free money|dm me/g)) { score += 12; signals.push({ name: 'Not Spammy', status: '✅', description: 'Clean of spam triggers' }); }
  else { score -= 15; signals.push({ name: 'Spam Triggers', status: '❌', description: 'Contains phrases that trigger blocks' }); recommendations.push('Remove spam-like language'); }

  // Signal 8: Emotional Trigger
  if (text.match(/[!]{1,3}/) || text.toLowerCase().match(/love|hate|amazing|terrible|shocking|incredible|wild|insane|genius|stupid|brilliant/)) { score += 10; signals.push({ name: 'Emotional Hook', status: '✅', description: 'Emotional language drives engagement' }); }
  else { signals.push({ name: 'Neutral Tone', status: '😐', description: 'May not trigger strong reactions' }); recommendations.push('Add emotional language or stakes'); }

  // Signal 9: Mentions
  if (text.includes('@')) { score += 5; signals.push({ name: 'Tags Others', status: '✅', description: 'Mentions expand reach' }); }

  // Signal 10: Thread/List
  if (text.toLowerCase().match(/thread|1\/|here's|here are|\d+\s+(things|ways|reasons|tips)/)) { score += 8; signals.push({ name: 'Thread Potential', status: '✅', description: 'Lists drive sustained engagement' }); }

  // Normalize to 0-100
  score = Math.min(100, Math.max(0, score));

  // Derive breakdown scores from signals — IMPRESSION-FIRST scoring
  const hookScore = hasHook ? 8 : 3;
  const emotionScore = (text.match(/[!]{1,3}/) || text.toLowerCase().match(/love|hate|amazing|terrible|shocking|incredible|wild|insane/)) ? 7 : 3;
  const shareScore = (/\d+/.test(text) && lineBreaks >= 2) ? 8 : (/\d+/.test(text) ? 6 : 3);
  const uniqueScore = Math.min(10, Math.round(score / 10)); // rough proxy

  // Impression-first scoring (weighted: impressions 50%, bookmarks 30%, engagement 20%)
  const impressionScore = Math.round(
    hookScore * 5 +          // Hook = scroll stop = impressions (50% weight)
    shareScore * 3 +         // Shareability/bookmarks (30% weight)
    emotionScore * 1 +       // Emotion drives replies/likes (10% weight)
    uniqueScore * 1           // Uniqueness (10% weight)
  );

  return { score, impressionScore: Math.min(100, impressionScore), signals, recommendations, breakdown: { hook: hookScore, emotion: emotionScore, shareability: shareScore, uniqueness: uniqueScore } };
}

const REWRITE_PROMPT = `You are a viral tweet optimization agent based on X's algorithm signals.

The X algorithm scores tweets on: P(like), P(reply), P(repost), P(quote), P(click), P(dwell), P(share), P(follow_author).

Negative signals: P(not_interested), P(block_author), P(mute_author).

Key optimization levers:
1. Hook Engineering: first 7 words must pattern-interrupt or create curiosity gap
2. Emotional Resonance: map to high-arousal emotions (awe, surprise, validation, FOMO)
3. Reply Maximization: questions, hot takes, intentional incompleteness
4. Repost Psychology: make sharing identity-reinforcing

Given the original tweet and its issues, provide exactly 3 improved rewrites that would score higher while keeping the same core message and the author's casual, lowercase voice.

Return ONLY a JSON array of 3 strings: ["rewrite1", "rewrite2", "rewrite3"]`;

export async function POST(req: NextRequest) {
  try {
    const { text } = await req.json();
    if (!text) return NextResponse.json({ error: "No text provided" }, { status: 400 });

    // Step 1: Local scoring (instant, free)
    const analysis = analyzeContent(text);

    // Step 2: AI rewrites (if API key available)
    let suggestions: string[] = [];
    const apiKey = process.env.OPENAI_API_KEY;
    if (apiKey) {
      try {
        const issueList = analysis.signals
          .filter(s => s.status !== '✅')
          .map(s => `- ${s.name}: ${s.description}`)
          .join('\n');

        const res = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [
              { role: "system", content: REWRITE_PROMPT },
              { role: "user", content: `Original tweet:\n${text}\n\nIssues found:\n${issueList}\n\nRecommendations:\n${analysis.recommendations.join('\n')}\n\nProvide 3 improved rewrites as a JSON array.` },
            ],
            temperature: 0.8,
          }),
        });
        const data = await res.json();
        const content = data.choices?.[0]?.message?.content || "[]";
        suggestions = JSON.parse(content.replace(/```json?\n?/g, '').replace(/```/g, '').trim());
      } catch (e) {
        console.error("Rewrite error:", e);
        suggestions = analysis.recommendations.slice(0, 3);
      }
    } else {
      suggestions = analysis.recommendations.slice(0, 3);
    }

    return NextResponse.json({
      score: analysis.score,
      breakdown: analysis.breakdown,
      signals: analysis.signals,
      reasoning: analysis.recommendations.length > 0
        ? `Issues: ${analysis.signals.filter(s => s.status !== '✅').map(s => s.name).join(', ')}`
        : 'Strong across all algorithm signals!',
      suggestions,
    });
  } catch (e) {
    return NextResponse.json({ error: "Scoring failed", details: String(e) }, { status: 500 });
  }
}
