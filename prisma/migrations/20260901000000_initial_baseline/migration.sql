CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "emailVerified" TIMESTAMP(3),
    "image" TEXT,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "Draft" (
    "id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "title" TEXT,
    "model" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "type" TEXT,
    "category" TEXT,
    "hookType" TEXT,
    "feedbackRating" TEXT,
    "feedbackReason" TEXT,
    "viralScore" JSONB,
    "impressionScore" JSONB,
    "scheduledDate" TEXT,
    "scheduledTime" TEXT,
    "visualUrl" TEXT,
    "variantGroup" TEXT,
    "postedAt" TIMESTAMP(3),
    "postedUrl" TEXT,
    "tweetUrl" TEXT,
    "tweetId" TEXT,
    "metrics" JSONB,
    "editHistory" JSONB DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "quoteUrl" TEXT,
    "quoteText" TEXT,
    "source" TEXT,
    "engagementScore" DOUBLE PRECISION,
    "engagementTier" TEXT,

    CONSTRAINT "Draft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TweetMetric" (
    "id" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "tweetId" TEXT,
    "url" TEXT,
    "postedAt" TIMESTAMP(3),
    "checkpoints" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TweetMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Idea" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "type" TEXT,
    "model" TEXT,
    "status" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Idea_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentCalendar" (
    "id" TEXT NOT NULL,
    "week" TEXT NOT NULL,
    "data" JSONB NOT NULL,

    CONSTRAINT "ContentCalendar_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "YoutubeIdea" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "hook" TEXT,
    "angle" TEXT,
    "hookType" TEXT,
    "funnelStage" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "rejectedReason" TEXT,
    "sourceUrl" TEXT,
    "sourceSummary" TEXT,
    "competitionScore" TEXT,
    "competitionData" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "YoutubeIdea_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "YoutubeScript" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "hook" TEXT,
    "storySetup" TEXT,
    "conflict" TEXT,
    "insight" TEXT,
    "cta" TEXT,
    "caption" TEXT,
    "onScreenText" TEXT,
    "hookType" TEXT,
    "funnelStage" TEXT,
    "factCheck" JSONB,
    "fullScript" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "rejectedReason" TEXT,
    "seoTitle" TEXT,
    "seoDescription" TEXT,
    "seoTags" JSONB,
    "seoChapters" JSONB,
    "titleVariants" JSONB,
    "thumbnailConcept" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "YoutubeScript_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "YoutubeFeedback" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "reason" TEXT,
    "type" TEXT,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "YoutubeFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LongformScript" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "platform" TEXT,
    "platforms" JSONB,
    "description" TEXT,
    "hook" TEXT,
    "outline" TEXT,
    "fullScript" TEXT,
    "targetLength" TEXT,
    "factCheck" JSONB,
    "notes" TEXT,
    "rejectedReason" TEXT,
    "youtubeUrl" TEXT,
    "thumbnailUrl" TEXT,
    "tweetUrl" TEXT,
    "youtubeViews" INTEGER,
    "youtubeLikes" INTEGER,
    "youtubeComments" INTEGER,
    "tweetViews" INTEGER,
    "tweetLikes" INTEGER,
    "tweetBookmarks" INTEGER,
    "tweetRetweets" INTEGER,
    "tweetReplies" INTEGER,
    "postedAt" TIMESTAMP(3),
    "competitionScore" TEXT,
    "competitionData" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LongformScript_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentState" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "emoji" TEXT,
    "role" TEXT,
    "status" TEXT NOT NULL DEFAULT 'offline',
    "lastActive" TIMESTAMP(3),
    "tasksCompleted" INTEGER NOT NULL DEFAULT 0,
    "totalCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currentTask" TEXT,
    "recentActivity" JSONB DEFAULT '[]',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentBusMessage" (
    "id" TEXT NOT NULL,
    "fromAgent" TEXT NOT NULL,
    "toAgent" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentBusMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BattleRoyaleBot" (
    "id" TEXT NOT NULL,
    "state" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BattleRoyaleBot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentRequest" (
    "id" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "resultDraftIds" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ContentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataStore" (
    "key" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DataStore_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "Brief" (
    "id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'brief',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Brief_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Mission" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "result" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Mission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Article" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "track" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'idea',
    "qtTweet" TEXT,
    "qtUrl" TEXT,
    "heroImageUrl" TEXT,
    "heroImageHtml" TEXT,
    "inspirationUrls" TEXT,
    "themes" TEXT,
    "scheduledDate" TEXT,
    "postedAt" TIMESTAMP(3),
    "postedUrl" TEXT,
    "impressions" INTEGER,
    "likes" INTEGER,
    "bookmarks" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Article_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavedTitle" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "track" TEXT NOT NULL,
    "themes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SavedTitle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientPulseClient" (
    "id" TEXT NOT NULL,
    "notionPageId" TEXT,
    "clientName" TEXT NOT NULL,
    "status" TEXT,
    "services" JSONB NOT NULL DEFAULT '[]',
    "productManagerName" TEXT,
    "renewalDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "expectedCheckinHours" INTEGER NOT NULL DEFAULT 72,
    "sourceUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientPulseClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientPulseChat" (
    "id" TEXT NOT NULL,
    "telegramChatId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "linkedClientId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "internalUserIds" JSONB NOT NULL DEFAULT '[]',
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientPulseChat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientPulseMessage" (
    "id" TEXT NOT NULL,
    "telegramMessageId" TEXT NOT NULL,
    "telegramChatId" TEXT NOT NULL,
    "chatId" TEXT,
    "senderTelegramId" TEXT NOT NULL,
    "senderName" TEXT NOT NULL,
    "isInternal" BOOLEAN NOT NULL DEFAULT false,
    "isBot" BOOLEAN NOT NULL DEFAULT false,
    "text" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL,
    "intent" TEXT NOT NULL DEFAULT 'other',
    "sentiment" TEXT NOT NULL DEFAULT 'neutral',
    "needsReply" BOOLEAN NOT NULL DEFAULT false,
    "rawJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientPulseMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientPulseAnalysis" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "sentimentScore" INTEGER NOT NULL,
    "responseScore" INTEGER NOT NULL,
    "cadenceScore" INTEGER NOT NULL,
    "renewalRiskScore" INTEGER NOT NULL,
    "positiveSignalScore" INTEGER NOT NULL DEFAULT 70,
    "overallScore" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "reasons" JSONB NOT NULL DEFAULT '[]',
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "recommendedAction" TEXT,
    "llmSummary" TEXT,
    "analysisSource" TEXT NOT NULL DEFAULT 'fallback',
    "analyzedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientPulseAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientPulseAlert" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "chatId" TEXT,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "reason" TEXT NOT NULL,
    "recommendedAction" TEXT,
    "sentTo" TEXT,
    "sentAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientPulseAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRequest" (
    "id" TEXT NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'web',
    "kind" TEXT NOT NULL DEFAULT 'oneshot',
    "title" TEXT NOT NULL,
    "prompt" TEXT,
    "sideEffecting" BOOLEAN NOT NULL DEFAULT false,
    "action" TEXT,
    "capability" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "result" TEXT,
    "error" TEXT,
    "hermesTaskId" TEXT,
    "idempotencyKey" TEXT,
    "dependsOn" JSONB NOT NULL DEFAULT '[]',
    "decidedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentEvent" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'activity',
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "agent" TEXT,
    "level" TEXT NOT NULL DEFAULT 'info',
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActionApproval" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requested_by" TEXT NOT NULL,
    "approved_by" TEXT,
    "reason" TEXT,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(6),
    "expires_at" TIMESTAMP(6),
    "parameters_snapshot" JSONB,

    CONSTRAINT "ActionApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncidentMemory" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "incident" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "cause" TEXT NOT NULL,
    "hypothesis" TEXT NOT NULL,
    "remediation" TEXT NOT NULL,
    "validation" TEXT NOT NULL,
    "provider" TEXT,
    "model" TEXT,
    "duration_ms" BIGINT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "agent" TEXT,
    "request_id" TEXT,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(6),
    "attempts" JSONB,
    "limitations" TEXT NOT NULL DEFAULT 'No limitaciones registradas.',
    "next_action" TEXT NOT NULL DEFAULT 'Sin siguiente acción registrada.',

    CONSTRAINT "IncidentMemory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InferenceAttempt" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "attempt_no" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "duration_ms" BIGINT,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(6),

    CONSTRAINT "InferenceAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HermesTask" (
    "id" TEXT NOT NULL,
    "board" TEXT NOT NULL DEFAULT 'default',
    "title" TEXT NOT NULL,
    "assignee" TEXT,
    "status" TEXT NOT NULL DEFAULT 'todo',
    "priority" INTEGER,
    "result" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HermesTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HermesMemory" (
    "id" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'fact',
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "confidence" TEXT,
    "provenance" TEXT,
    "tags" TEXT[],
    "links" TEXT[],
    "body" TEXT NOT NULL DEFAULT '',
    "validFrom" TIMESTAMP(3),
    "validTo" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HermesMemory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_sessionToken_key" ON "Session"("sessionToken");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_token_key" ON "VerificationToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_identifier_token_key" ON "VerificationToken"("identifier", "token");

-- CreateIndex
CREATE INDEX "Draft_status_idx" ON "Draft"("status");

-- CreateIndex
CREATE INDEX "Draft_createdAt_idx" ON "Draft"("createdAt");

-- CreateIndex
CREATE INDEX "Draft_tweetId_idx" ON "Draft"("tweetId");

-- CreateIndex
CREATE INDEX "Draft_source_idx" ON "Draft"("source");

-- CreateIndex
CREATE INDEX "Draft_engagementTier_idx" ON "Draft"("engagementTier");

-- CreateIndex
CREATE INDEX "TweetMetric_draftId_idx" ON "TweetMetric"("draftId");

-- CreateIndex
CREATE INDEX "Idea_category_idx" ON "Idea"("category");

-- CreateIndex
CREATE INDEX "Idea_type_idx" ON "Idea"("type");

-- CreateIndex
CREATE UNIQUE INDEX "ContentCalendar_week_key" ON "ContentCalendar"("week");

-- CreateIndex
CREATE INDEX "YoutubeIdea_status_idx" ON "YoutubeIdea"("status");

-- CreateIndex
CREATE INDEX "YoutubeScript_status_idx" ON "YoutubeScript"("status");

-- CreateIndex
CREATE INDEX "LongformScript_status_idx" ON "LongformScript"("status");

-- CreateIndex
CREATE INDEX "AgentBusMessage_toAgent_read_idx" ON "AgentBusMessage"("toAgent", "read");

-- CreateIndex
CREATE INDEX "AgentBusMessage_fromAgent_idx" ON "AgentBusMessage"("fromAgent");

-- CreateIndex
CREATE UNIQUE INDEX "Brief_date_key" ON "Brief"("date");

-- CreateIndex
CREATE INDEX "Mission_agentId_idx" ON "Mission"("agentId");

-- CreateIndex
CREATE INDEX "Mission_status_idx" ON "Mission"("status");

-- CreateIndex
CREATE INDEX "Article_status_idx" ON "Article"("status");

-- CreateIndex
CREATE INDEX "Article_track_idx" ON "Article"("track");

-- CreateIndex
CREATE INDEX "Article_scheduledDate_idx" ON "Article"("scheduledDate");

-- CreateIndex
CREATE INDEX "SavedTitle_track_idx" ON "SavedTitle"("track");

-- CreateIndex
CREATE UNIQUE INDEX "ClientPulseClient_notionPageId_key" ON "ClientPulseClient"("notionPageId");

-- CreateIndex
CREATE INDEX "ClientPulseClient_status_idx" ON "ClientPulseClient"("status");

-- CreateIndex
CREATE INDEX "ClientPulseClient_clientName_idx" ON "ClientPulseClient"("clientName");

-- CreateIndex
CREATE INDEX "ClientPulseClient_productManagerName_idx" ON "ClientPulseClient"("productManagerName");

-- CreateIndex
CREATE UNIQUE INDEX "ClientPulseChat_telegramChatId_key" ON "ClientPulseChat"("telegramChatId");

-- CreateIndex
CREATE INDEX "ClientPulseChat_linkedClientId_idx" ON "ClientPulseChat"("linkedClientId");

-- CreateIndex
CREATE INDEX "ClientPulseChat_status_idx" ON "ClientPulseChat"("status");

-- CreateIndex
CREATE INDEX "ClientPulseMessage_telegramChatId_sentAt_idx" ON "ClientPulseMessage"("telegramChatId", "sentAt");

-- CreateIndex
CREATE INDEX "ClientPulseMessage_chatId_sentAt_idx" ON "ClientPulseMessage"("chatId", "sentAt");

-- CreateIndex
CREATE INDEX "ClientPulseMessage_needsReply_idx" ON "ClientPulseMessage"("needsReply");

-- CreateIndex
CREATE UNIQUE INDEX "ClientPulseMessage_telegramChatId_telegramMessageId_key" ON "ClientPulseMessage"("telegramChatId", "telegramMessageId");

-- CreateIndex
CREATE INDEX "ClientPulseAnalysis_clientId_analyzedAt_idx" ON "ClientPulseAnalysis"("clientId", "analyzedAt");

-- CreateIndex
CREATE INDEX "ClientPulseAnalysis_category_idx" ON "ClientPulseAnalysis"("category");

-- CreateIndex
CREATE INDEX "ClientPulseAnalysis_overallScore_idx" ON "ClientPulseAnalysis"("overallScore");

-- CreateIndex
CREATE INDEX "ClientPulseAlert_clientId_createdAt_idx" ON "ClientPulseAlert"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "ClientPulseAlert_severity_idx" ON "ClientPulseAlert"("severity");

-- CreateIndex
CREATE INDEX "ClientPulseAlert_sentAt_idx" ON "ClientPulseAlert"("sentAt");

-- CreateIndex
CREATE INDEX "ClientPulseAlert_acknowledgedAt_idx" ON "ClientPulseAlert"("acknowledgedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRequest_idempotencyKey_key" ON "AgentRequest"("idempotencyKey");

-- CreateIndex
CREATE INDEX "AgentRequest_status_idx" ON "AgentRequest"("status");

-- CreateIndex
CREATE INDEX "AgentRequest_createdAt_idx" ON "AgentRequest"("createdAt");

-- CreateIndex
CREATE INDEX "AgentEvent_createdAt_idx" ON "AgentEvent"("createdAt");

-- CreateIndex
CREATE INDEX "ActionApproval_pending_idx" ON "ActionApproval"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "IncidentMemory_fingerprint_idx" ON "IncidentMemory"("fingerprint", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "IncidentMemory_request_idx" ON "IncidentMemory"("request_id");

-- CreateIndex
CREATE INDEX "IncidentMemory_status_idx" ON "IncidentMemory"("status", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "incident_memory_evidence_trgm_idx" ON "IncidentMemory" USING GIN ("evidence" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "incident_memory_incident_trgm_idx" ON "IncidentMemory" USING GIN ("incident" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "InferenceAttempt_request_idx" ON "InferenceAttempt"("request_id", "attempt_no");

-- CreateIndex
CREATE INDEX "HermesTask_board_idx" ON "HermesTask"("board");

-- CreateIndex
CREATE INDEX "HermesTask_status_idx" ON "HermesTask"("status");

-- CreateIndex
CREATE INDEX "HermesMemory_type_idx" ON "HermesMemory"("type");

-- CreateIndex
CREATE INDEX "HermesMemory_status_idx" ON "HermesMemory"("status");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientPulseChat" ADD CONSTRAINT "ClientPulseChat_linkedClientId_fkey" FOREIGN KEY ("linkedClientId") REFERENCES "ClientPulseClient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientPulseMessage" ADD CONSTRAINT "ClientPulseMessage_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "ClientPulseChat"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientPulseAnalysis" ADD CONSTRAINT "ClientPulseAnalysis_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "ClientPulseClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientPulseAlert" ADD CONSTRAINT "ClientPulseAlert_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "ClientPulseClient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientPulseAlert" ADD CONSTRAINT "ClientPulseAlert_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "ClientPulseChat"("id") ON DELETE SET NULL ON UPDATE CASCADE;



CREATE OR REPLACE FUNCTION public.hermy_incident_memory_sync() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  vstatus text; vagent text; vprovider text; vmodel text; vduration bigint;
  vcause text; vhypothesis text; vremediation text; vvalidation text;
  vlimitations text; vnext_action text;
BEGIN
  IF NEW.origin='error-supervisor' OR NEW.title LIKE 'Max · incidente %' OR NEW.kind IN ('codex.engineering','codex.audit','codex.change') THEN
    vstatus := CASE WHEN NEW.status IN ('failed','cancelled','rejected') THEN 'blocked' ELSE 'open' END;
    vagent := CASE WHEN NEW.kind IN ('codex.engineering','codex.audit','codex.change') THEN 'codex' ELSE split_part(NEW.kind,'.',1) END;
    vprovider := CASE WHEN NEW.kind IN ('codex.engineering','codex.audit','codex.change') THEN 'codex' ELSE 'custom' END;
    vmodel := CASE WHEN NEW.kind IN ('codex.engineering','codex.audit','codex.change') THEN 'codex' ELSE 'qwen3-8b-local' END;
    vduration := CASE WHEN NEW."startedAt" IS NOT NULL THEN (extract(epoch from (coalesce(NEW."finishedAt",now())-NEW."startedAt"))*1000)::bigint END;
    vcause := CASE
      WHEN NEW.status IN ('failed','cancelled','rejected') THEN coalesce(nullif(NEW.error,''),'La solicitud terminó sin causa confirmada; requiere análisis de la evidencia.')
      WHEN NEW.status='done' THEN 'La ejecución terminó sin un fallo confirmado en la evidencia registrada.'
      ELSE 'La ejecución sigue pendiente; todavía no existe un informe del agente que confirme una causa.'
    END;
    vhypothesis := CASE
      WHEN NEW.status IN ('done','rejected') THEN 'No se sostiene una hipótesis de fallo sin evidencia adicional; el estado registrado no la confirma.'
      ELSE 'No se formula una hipótesis hasta recibir la evidencia estructurada del agente.'
    END;
    vremediation := CASE
      WHEN NEW.status='done' THEN coalesce(nullif(NEW.result,''),'La ejecución terminó sin evidencia de cambios aplicados.')
      WHEN NEW.status IN ('failed','cancelled','rejected') THEN 'No se aplicó reparación porque la solicitud terminó bloqueada antes de una ejecución validada.'
      ELSE 'No se ha aplicado reparación; la solicitud aún no ha sido aprobada o ejecutada.'
    END;
    vvalidation := CASE
      WHEN NEW.status='done' THEN coalesce(nullif(NEW.result,''),'La ejecución terminó, pero no aportó evidencia de validación.')
      WHEN NEW.status IN ('failed','cancelled','rejected') THEN 'No validado: la solicitud no se completó con una ejecución verificable.'
      ELSE 'No validado todavía: la solicitud permanece pendiente de aprobación o ejecución.'
    END;
    vlimitations := CASE
      WHEN NEW.status='done' THEN 'La calidad de la validación depende de que el informe final contenga las seis etiquetas estructuradas.'
      ELSE 'No hay informe final del agente; la evidencia disponible se limita al estado de la solicitud y su solicitud original.'
    END;
    vnext_action := CASE
      WHEN NEW.status='done' THEN 'Revisar las seis etiquetas del informe y conservar solo la validación respaldada por evidencia.'
      WHEN NEW.status IN ('failed','cancelled','rejected') THEN 'Revisar la causa registrada y decidir si se reintenta con un informe estructurado y autorización vigente.'
      ELSE 'Esperar la aprobación o ejecución y exigir un informe completo con las seis etiquetas antes de cerrar.'
    END;
    INSERT INTO "IncidentMemory" (id,fingerprint,incident,evidence,cause,hypothesis,remediation,validation,limitations,next_action,status,agent,request_id,provider,model,duration_ms,created_at,updated_at,closed_at)
    VALUES ('req-'||NEW.id,md5(coalesce(NEW.title,'')||'|'||coalesce(NEW.prompt,'')),coalesce(NEW.title,'incident'),coalesce(NEW.prompt,NEW.title),vcause,vhypothesis,vremediation,vvalidation,vlimitations,vnext_action,vstatus,vagent,NEW.id,vprovider,vmodel,vduration,coalesce(NEW."createdAt",now()),now(),CASE WHEN vstatus IN ('resolved','blocked') THEN coalesce(NEW."finishedAt",now()) END)
    ON CONFLICT (id) DO UPDATE SET
      status=CASE WHEN "IncidentMemory".status IN ('resolved','closed','blocked') THEN "IncidentMemory".status ELSE EXCLUDED.status END, agent=EXCLUDED.agent, provider=EXCLUDED.provider, model=EXCLUDED.model, duration_ms=EXCLUDED.duration_ms,
      cause=CASE WHEN NEW.status IN ('failed','cancelled','rejected') THEN vcause ELSE "IncidentMemory".cause END,
      hypothesis=CASE WHEN NEW.status IN ('queued','approved','running') THEN vhypothesis ELSE "IncidentMemory".hypothesis END,
      remediation=CASE WHEN NEW.status IN ('done','failed','cancelled','rejected') THEN vremediation ELSE "IncidentMemory".remediation END,
      validation=CASE WHEN NEW.status='done' THEN vvalidation ELSE "IncidentMemory".validation END,
      limitations=EXCLUDED.limitations, next_action=EXCLUDED.next_action, updated_at=now(), closed_at=CASE WHEN "IncidentMemory".status IN ('resolved','closed') THEN "IncidentMemory".closed_at ELSE NULL END;
  END IF;
  IF NEW."sideEffecting"=true THEN
    IF TG_OP='INSERT' THEN
      INSERT INTO "ActionApproval" (id,request_id,action,status,requested_by,reason,created_at,expires_at,parameters_snapshot)
      VALUES ('approval-'||NEW.id,NEW.id,'execute','pending',coalesce(NEW.origin,'unknown'),'side-effecting request',now(),now()+interval '24 hours',
        jsonb_build_object('requestId',NEW.id,'origin',NEW.origin,'kind',NEW.kind,'title',NEW.title,'prompt',NEW.prompt,
          'sideEffecting',NEW."sideEffecting",'action',NEW.action,'capability',NEW.capability,'dependencies',COALESCE(NEW."dependsOn",'[]'::jsonb)))
      ON CONFLICT (id) DO NOTHING;
    ELSIF NEW.status='approved' THEN
      INSERT INTO "ActionApproval" (id,request_id,action,status,requested_by,approved_by,reason,resolved_at) VALUES ('approval-'||NEW.id,NEW.id,'execute','approved',coalesce(NEW.origin,'unknown'),'hermy-hq','approved through existing approval inbox',now()) ON CONFLICT (id) DO UPDATE SET status='approved',approved_by=COALESCE("ActionApproval".approved_by,'hermy-hq'),resolved_at=now();
    ELSIF NEW.status IN ('rejected','cancelled') THEN
      UPDATE "ActionApproval" SET status='rejected',resolved_at=now() WHERE request_id=NEW.id AND status='pending';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


CREATE OR REPLACE FUNCTION public.hermy_require_action_approval() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NEW."sideEffecting"=true AND NEW.status IN ('running','done') AND NOT EXISTS (SELECT 1 FROM "ActionApproval" WHERE request_id=NEW.id AND status='approved') THEN
  RAISE EXCEPTION 'ACTION_APPROVAL_REQUIRED request=%',NEW.id USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END;$$;


CREATE OR REPLACE FUNCTION public.hermy_require_structured_operation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_allowed boolean;
BEGIN
  v_allowed := CASE NEW.kind
    WHEN 'max.chief-of-staff' THEN NEW.action='coordinate' AND NEW.capability='read_only'
    WHEN 'atlas.research' THEN NEW.action='research' AND NEW.capability='read_only'
    WHEN 'pulse.social' THEN NEW.action='strategy' AND NEW.capability='read_only'
    WHEN 'ledger.operations' THEN NEW.action='audit' AND NEW.capability='read_only'
    WHEN 'domus.home' THEN NEW.action='review' AND NEW.capability='read_only'
    WHEN 'milo.email' THEN NEW.action='triage' AND NEW.capability='read_only'
    WHEN 'codex.audit' THEN NEW.action='audit' AND NEW.capability='read_only'
    WHEN 'video.youtube.analyze' THEN NEW.action='analyze_video' AND NEW.capability='read_only'
    ELSE FALSE
  END;
  IF v_allowed IS DISTINCT FROM TRUE OR NEW."sideEffecting"=TRUE THEN
    NEW."sideEffecting" := TRUE;
    IF TG_OP='INSERT' AND NEW.status <> 'awaiting_approval' THEN
      NEW.status := 'awaiting_approval';
    ELSIF TG_OP='UPDATE' AND NEW.status IN ('queued','approved') THEN
      NEW.status := 'awaiting_approval';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_request_structured_operation ON public."AgentRequest";
CREATE TRIGGER agent_request_structured_operation BEFORE INSERT OR UPDATE OF kind, action, capability, "sideEffecting" ON public."AgentRequest" FOR EACH ROW EXECUTE FUNCTION public.hermy_require_structured_operation();
DROP TRIGGER IF EXISTS agent_request_action_gate ON public."AgentRequest";
CREATE TRIGGER agent_request_action_gate BEFORE UPDATE OF status ON public."AgentRequest" FOR EACH ROW EXECUTE FUNCTION public.hermy_require_action_approval();
DROP TRIGGER IF EXISTS agent_request_incident_memory ON public."AgentRequest";
CREATE TRIGGER agent_request_incident_memory AFTER INSERT OR UPDATE OF status, result, error, "sideEffecting", action, capability ON public."AgentRequest" FOR EACH ROW EXECUTE FUNCTION public.hermy_incident_memory_sync();
