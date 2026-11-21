-- Record structured operation intent without executing or trusting client flags.
ALTER TABLE public."AgentRequest"
  ADD COLUMN IF NOT EXISTS action text,
  ADD COLUMN IF NOT EXISTS capability text;

UPDATE public."ActionApproval" a
SET parameters_snapshot = COALESCE(a.parameters_snapshot, '{}'::jsonb)
  || jsonb_build_object('action', r.action, 'capability', r.capability)
FROM public."AgentRequest" r
WHERE a.request_id = r.id AND a.status = 'pending'
  AND a.parameters_snapshot IS NOT NULL
  AND (NOT (a.parameters_snapshot ? 'action') OR NOT (a.parameters_snapshot ? 'capability'));


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
