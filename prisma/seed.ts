import { PrismaClient } from '@prisma/client'
import * as fs from 'fs'
import * as path from 'path'

const prisma = new PrismaClient()
const DATA_DIR = './data'

function readJson(filename: string): unknown {
  const p = path.join(DATA_DIR, filename)
  if (!fs.existsSync(p)) { console.warn(`⚠️  Missing: ${filename}`); return null }
  return JSON.parse(fs.readFileSync(p, 'utf-8'))
}

function safeDate(val: unknown, fallback = new Date()): Date {
  if (!val) return fallback
  const d = new Date(val as string)
  return isNaN(d.getTime()) ? fallback : d
}

async function seedDrafts() {
  const raw = readJson('drafts.json') as any[]
  if (!raw) return
  console.log(`📝 Seeding ${raw.length} drafts...`)

  for (const d of raw) {
    const feedback = d.feedback ?? {}
    await prisma.draft.upsert({
      where: { id: d.id },
      update: {},
      create: {
        id: d.id,
        text: d.text ?? '',
        title: d.title ?? null,
        model: d.model ?? null,
        status: d.status ?? 'pending',
        type: d.type ?? null,
        category: d.category ?? null,
        hookType: d.hookType ?? null,
        feedbackRating: feedback.rating ?? null,
        feedbackReason: feedback.reason ?? null,
        viralScore: d.viralScore ?? undefined,
        impressionScore: d.impressionScore ?? undefined,
        scheduledDate: d.scheduledDate ?? null,
        scheduledTime: d.scheduledTime ?? null,
        visualUrl: d.visualUrl ?? null,
        variantGroup: d.variantGroup ?? null,
        postedAt: d.postedAt ? safeDate(d.postedAt) : null,
        postedUrl: d.postedUrl ?? null,
        tweetUrl: d.tweetUrl ?? null,
        tweetId: d.tweetId ?? null,
        metrics: d.metrics ?? undefined,
        editHistory: d.editHistory ?? [],
        createdAt: safeDate(d.createdAt),
        updatedAt: safeDate(d.updatedAt),
      },
    })
  }
  console.log(`  ✅ ${raw.length} drafts done`)
}

async function seedIdeas() {
  const raw = readJson('ideas.json') as any[]
  if (!raw) return
  console.log(`💡 Seeding ${raw.length} ideas...`)

  for (const d of raw) {
    await prisma.idea.upsert({
      where: { id: d.id },
      update: {},
      create: {
        id: d.id,
        title: d.title ?? '',
        description: d.description ?? null,
        category: d.category ?? null,
        type: d.type ?? null,
        model: d.model ?? null,
        status: d.status ?? null,
        timestamp: safeDate(d.timestamp),
      },
    })
  }
  console.log(`  ✅ ${raw.length} ideas done`)
}

async function seedLongformScripts() {
  const raw = readJson('longform-scripts.json') as any[]
  if (!raw) return
  console.log(`📄 Seeding ${raw.length} longform scripts...`)

  for (const d of raw) {
    await prisma.longformScript.upsert({
      where: { id: d.id },
      update: {},
      create: {
        id: d.id,
        title: d.title ?? '',
        type: d.type ?? null,
        status: d.status ?? 'draft',
        platform: d.platform ?? null,
        platforms: d.platforms ?? undefined,
        description: d.description ?? null,
        hook: d.hook ?? null,
        outline: d.outline ?? null,
        fullScript: d.fullScript ?? null,
        targetLength: d.targetLength ?? null,
        factCheck: d.factCheck ?? undefined,
        notes: d.notes ?? null,
        createdAt: safeDate(d.createdAt),
        updatedAt: safeDate(d.updatedAt),
      },
    })
  }
  console.log(`  ✅ ${raw.length} longform scripts done`)
}

async function seedYoutubeScripts() {
  const raw = readJson('youtube-scripts.json') as any[]
  if (!raw) return
  console.log(`🎬 Seeding ${raw.length} YouTube scripts...`)

  for (const d of raw) {
    await prisma.youtubeScript.upsert({
      where: { id: d.id },
      update: {},
      create: {
        id: d.id,
        title: d.title ?? '',
        hook: d.hook ?? null,
        storySetup: d.storySetup ?? null,
        conflict: d.conflict ?? null,
        insight: d.insight ?? null,
        cta: d.cta ?? null,
        caption: d.caption ?? null,
        onScreenText: d.onScreenText ?? null,
        hookType: d.hookType ?? null,
        funnelStage: d.funnelStage ?? null,
        factCheck: d.factCheck ?? undefined,
        status: d.status ?? 'draft',
        rejectedReason: d.rejectedReason ?? null,
        createdAt: safeDate(d.createdAt),
        updatedAt: safeDate(d.updatedAt),
      },
    })
  }
  console.log(`  ✅ ${raw.length} YouTube scripts done`)
}

async function seedYoutubeIdeas() {
  const raw = readJson('youtube-ideas.json') as any[]
  if (!raw) return
  console.log(`🎯 Seeding ${raw.length} YouTube ideas...`)

  // Delete and re-insert (no stable IDs in source file)
  await prisma.youtubeIdea.deleteMany()
  for (const d of raw) {
    await prisma.youtubeIdea.create({
      data: {
        title: d.title ?? '',
        hook: d.hook ?? null,
        angle: d.angle ?? null,
        hookType: d.hookType ?? null,
        funnelStage: d.funnelStage ?? null,
        status: d.status ?? 'pending',
        rejectedReason: d.rejectedReason ?? null,
        createdAt: safeDate(d.createdAt),
      },
    })
  }
  console.log(`  ✅ ${raw.length} YouTube ideas done`)
}

async function seedYoutubeFeedback() {
  const raw = readJson('youtube-feedback.json') as any[]
  if (!raw) return
  console.log(`💬 Seeding ${raw.length} YouTube feedback...`)

  await prisma.youtubeFeedback.deleteMany()
  for (const d of raw) {
    await prisma.youtubeFeedback.create({
      data: {
        title: d.title ?? '',
        reason: d.reason ?? null,
        type: d.type ?? null,
        date: safeDate(d.date),
      },
    })
  }
  console.log(`  ✅ ${raw.length} YouTube feedback done`)
}

async function seedTweetMetrics() {
  const raw = readJson('tweet-metrics.json') as any[]
  if (!raw) return
  console.log(`📊 Seeding ${raw.length} tweet metrics...`)

  await prisma.tweetMetric.deleteMany()
  for (const d of raw) {
    await prisma.tweetMetric.create({
      data: {
        draftId: d.draftId ?? '',
        tweetId: d.tweetId ?? null,
        url: d.url ?? null,
        postedAt: d.postedAt ? safeDate(d.postedAt) : null,
        checkpoints: d.checkpoints ?? undefined,
        createdAt: safeDate(d.createdAt),
      },
    })
  }
  console.log(`  ✅ ${raw.length} tweet metrics done`)
}

async function seedAgentState() {
  const raw = readJson('agent-state.json') as any[]
  if (!raw) return
  console.log(`🤖 Seeding ${raw.length} agent states...`)

  for (const d of raw) {
    await prisma.agentState.upsert({
      where: { id: d.id },
      update: {
        name: d.name,
        emoji: d.emoji ?? null,
        role: d.role ?? null,
        status: d.status ?? 'offline',
        lastActive: d.lastActive ? safeDate(d.lastActive) : null,
        tasksCompleted: d.tasksCompleted ?? 0,
        totalCost: d.totalCost ?? 0,
        currentTask: d.currentTask ?? null,
        recentActivity: d.recentActivity ?? [],
        updatedAt: new Date(),
      },
      create: {
        id: d.id,
        name: d.name,
        emoji: d.emoji ?? null,
        role: d.role ?? null,
        status: d.status ?? 'offline',
        lastActive: d.lastActive ? safeDate(d.lastActive) : null,
        tasksCompleted: d.tasksCompleted ?? 0,
        totalCost: d.totalCost ?? 0,
        currentTask: d.currentTask ?? null,
        recentActivity: d.recentActivity ?? [],
        updatedAt: new Date(),
      },
    })
  }
  console.log(`  ✅ ${raw.length} agent states done`)
}

async function seedContentCalendar() {
  const raw = readJson('content-calendar.json') as any
  if (!raw) return
  // File is { week: "...", days: [...] }
  const week = raw.week
  if (!week) { console.warn('⚠️  content-calendar.json missing week field'); return }
  console.log(`📅 Seeding content calendar (week ${week})...`)

  await prisma.contentCalendar.upsert({
    where: { week },
    update: { data: raw },
    create: { week, data: raw },
  })
  console.log(`  ✅ Calendar done`)
}

async function seedContentRequests() {
  const raw = readJson('content-requests.json') as any[]
  if (!raw || !raw.length) return
  console.log(`📬 Seeding ${raw.length} content requests...`)

  for (const d of raw) {
    await prisma.contentRequest.upsert({
      where: { id: d.id },
      update: {},
      create: {
        id: d.id,
        prompt: d.prompt ?? '',
        status: d.status ?? 'pending',
        resultDraftIds: d.resultDraftIds ?? undefined,
        createdAt: safeDate(d.createdAt),
        completedAt: d.completedAt ? safeDate(d.completedAt) : null,
      },
    })
  }
  console.log(`  ✅ ${raw.length} content requests done`)
}

async function main() {
  console.log('🌱 Starting Max HQ data seed...\n')

  await seedAgentState()
  await seedDrafts()
  await seedIdeas()
  await seedLongformScripts()
  await seedYoutubeScripts()
  await seedYoutubeIdeas()
  await seedYoutubeFeedback()
  await seedTweetMetrics()
  await seedContentCalendar()
  await seedContentRequests()

  console.log('\n✅ All done! Max HQ database is fully seeded.')
}

main()
  .catch((e) => { console.error('❌ Seed failed:', e); process.exit(1) })
  .finally(() => prisma.$disconnect())
