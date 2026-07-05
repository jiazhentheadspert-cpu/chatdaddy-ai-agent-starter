import { Agent, getAgentByName, routeAgentRequest } from "agents";

const VERSION = "hermas-cloudflare-agents-runtime-v0.1";

const CORS_HEADERS = {
  "access-control-allow-origin": "https://jiazhentheadspert-cpu.github.io",
  "access-control-allow-methods": "GET,POST,PATCH,OPTIONS",
  "access-control-allow-headers": "content-type,authorization,x-webhook-secret,x-admin-token,x-staff-token,x-operator-token",
  "access-control-allow-credentials": "true",
  "access-control-max-age": "86400",
  "vary": "Origin"
};

const HERMAS_SESSION_COOKIE = "hermas_session";
const HERMAS_SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

export class HermasProjectAgent extends Agent {
  initialState = {
    runtime_mode: "approval_first",
    auto_send_enabled: false,
    auto_trigger_flows_enabled: false,
    last_event_at: null
  };

  async onRequest(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      this.ensureTables();
      return json({
        ok: true,
        runtime: "HermasProjectAgent",
        version: VERSION,
        state: this.state
      });
    }

    if (request.method === "GET" && url.pathname === "/samples") {
      this.ensureTables();
      const connectionId = url.searchParams.get("connection_id");
      const rows = connectionId
        ? this.sql`
          SELECT id, project_key, connection_id, event_type, message_type, payload_shape, normalized_preview, created_at
          FROM webhook_payload_samples
          WHERE connection_id = ${connectionId}
          ORDER BY created_at DESC
          LIMIT 20
        `
        : this.sql`
          SELECT id, project_key, connection_id, event_type, message_type, payload_shape, normalized_preview, created_at
          FROM webhook_payload_samples
          ORDER BY created_at DESC
          LIMIT 20
        `;
      return json({
        ok: true,
        runtime: "HermasProjectAgent",
        samples: rows.map((row) => ({
          ...row,
          payload_shape: safeJsonParse(row.payload_shape),
          normalized_preview: safeJsonParse(row.normalized_preview)
        }))
      });
    }

    if (request.method === "POST" && url.pathname === "/intake/chatdaddy") {
      this.ensureTables();
      const connectionId = url.searchParams.get("connection_id") || "default";
      const payload = await readJson(request);
      const projectKey = normalizeProjectKey(
        payload.project_key ||
        payload.projectKey ||
        this.env.AGENT_PROJECT_KEY ||
        "beyoute"
      );
      const normalized = normalizeChatDaddyPayload(payload, {
        projectKey,
        connectionId
      });

      this.recordLocalEvent(normalized);
      this.recordPayloadSample(normalized, payload);
      const intakePersistence = await persistSupabaseIntakeRecords(this.env, normalized, payload);
      const backgroundJob = await persistSupabaseBackgroundJob(this.env, normalized, intakePersistence.refs);

      const contactKey = await stableContactKey(normalized);
      const conversationAgent = await getAgentByName(
        this.env.HermasConversationAgent,
        `conv:${projectKey}:${contactKey}`
      );
      const decisionResponse = await conversationAgent.fetch(new Request("https://agent.local/decide", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ normalized, payload, supabase_refs: intakePersistence.refs })
      }));
      const decisionBody = await decisionResponse.json();

      this.setState({
        ...this.state,
        last_event_at: new Date().toISOString(),
        last_project_key: projectKey
      });

      return json({
        ok: true,
        runtime: "HermasProjectAgent",
        project_key: projectKey,
        connection_id: connectionId,
        normalized: publicNormalizedEvent(normalized),
        decision: decisionBody.decision,
        persistence: {
          intake: intakePersistence,
          background_job: backgroundJob,
          decision: decisionBody.persistence || null
        }
      });
    }

    return json({ ok: false, error: "project_agent_not_found" }, 404);
  }

  ensureTables() {
    this.sql`
      CREATE TABLE IF NOT EXISTS project_events (
        event_key TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_message_id TEXT,
        event_type TEXT,
        message_type TEXT,
        text TEXT,
        created_at TEXT NOT NULL
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS webhook_payload_samples (
        id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        event_type TEXT,
        message_type TEXT,
        payload_shape TEXT NOT NULL,
        normalized_preview TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `;
  }

  recordLocalEvent(normalized) {
    const eventKey = normalized.provider_message_id || normalized.event_id;
    this.sql`
      INSERT OR REPLACE INTO project_events (
        event_key,
        project_key,
        provider,
        provider_message_id,
        event_type,
        message_type,
        text,
        created_at
      )
      VALUES (
        ${eventKey},
        ${normalized.project_key},
        ${normalized.provider},
        ${normalized.provider_message_id},
        ${normalized.event_type},
        ${normalized.message_type},
        ${normalized.text || ""},
        ${new Date().toISOString()}
      )
    `;
  }

  recordPayloadSample(normalized, rawPayload) {
    const id = `${normalized.project_key}:${normalized.connection_id}:${normalized.provider_message_id || normalized.event_id}`;
    this.sql`
      INSERT OR REPLACE INTO webhook_payload_samples (
        id,
        project_key,
        connection_id,
        event_type,
        message_type,
        payload_shape,
        normalized_preview,
        created_at
      )
      VALUES (
        ${id},
        ${normalized.project_key},
        ${normalized.connection_id},
        ${normalized.event_type},
        ${normalized.message_type},
        ${JSON.stringify(toPayloadShape(rawPayload))},
        ${JSON.stringify(publicNormalizedEvent(normalized))},
        ${new Date().toISOString()}
      )
    `;
  }
}

export class HermasConversationAgent extends Agent {
  initialState = {
    runtime_mode: "approval_first",
    last_decision_at: null,
    last_stage: null
  };

  async onRequest(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      this.ensureTables();
      return json({
        ok: true,
        runtime: "HermasConversationAgent",
        version: VERSION,
        state: this.state
      });
    }

    if (request.method === "POST" && url.pathname === "/decide") {
      this.ensureTables();
      const { normalized, payload, supabase_refs: supabaseRefs } = await readJson(request);
      const deterministicDecision = decideApprovalFirst(normalized);
      const decision = await maybeImproveDraftWithModel(this.env, normalized, deterministicDecision);
      this.recordDecision(normalized, decision);
      const persistence = await persistSupabaseDecision(this.env, normalized, decision, payload, supabaseRefs || {});
      this.setState({
        ...this.state,
        last_decision_at: new Date().toISOString(),
        last_stage: decision.stage
      });
      return json({
        ok: true,
        runtime: "HermasConversationAgent",
        decision,
        persistence
      });
    }

    return json({ ok: false, error: "conversation_agent_not_found" }, 404);
  }

  ensureTables() {
    this.sql`
      CREATE TABLE IF NOT EXISTS conversation_decisions (
        id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        provider_message_id TEXT,
        intent TEXT,
        stage TEXT,
        risk_level TEXT,
        next_action TEXT,
        reply_text TEXT,
        created_at TEXT NOT NULL
      )
    `;
  }

  recordDecision(normalized, decision) {
    const id = `${normalized.project_key}:${normalized.provider_message_id || normalized.event_id}`;
    this.sql`
      INSERT OR REPLACE INTO conversation_decisions (
        id,
        project_key,
        provider_message_id,
        intent,
        stage,
        risk_level,
        next_action,
        reply_text,
        created_at
      )
      VALUES (
        ${id},
        ${normalized.project_key},
        ${normalized.provider_message_id},
        ${decision.intent},
        ${decision.stage},
        ${decision.risk_level},
        ${decision.next_action},
        ${decision.reply_text || ""},
        ${new Date().toISOString()}
      )
    `;
  }
}

export class HermasOpsAgent extends Agent {
  initialState = {
    runtime_mode: "approval_first",
    last_review_at: null
  };

  async onRequest(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        runtime: "HermasOpsAgent",
        version: VERSION,
        state: this.state
      });
    }
    return json({ ok: false, error: "ops_agent_not_found" }, 404);
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeadersForRequest(request) });

    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/api/agents/runtime/health")) {
      return json({
        ok: true,
        version: VERSION,
        mode: "approval_first",
        cloudflare_agents_sdk: true,
        webhook_ack_mode: webhookAckMode(env),
        has_supabase: Boolean(hasSupabase(env)),
        auto_send_enabled: false,
        auto_trigger_flows_enabled: false
      });
    }

    if (request.method === "GET" && url.pathname === "/api/meta-capi/status") {
      const projectKey = normalizeProjectKey(url.searchParams.get("project_key") || env.AGENT_PROJECT_KEY || "beyoute");
      return json({
        ok: true,
        meta_capi: await metaCapiPublicStatus(env, url.origin, projectKey),
        event_map: META_CAPI_EVENT_MAP,
        next: "确认已付款 / COD 确认后，Dashboard 才会发送 Purchase；普通询问、等下付款、截图占位不会当成交。"
      });
    }

    if (request.method === "POST" && url.pathname === "/api/meta-capi/test") {
      return handleMetaCapiTest(request, env);
    }

    const adminAdsConnectionMatch = url.pathname.match(/^\/api\/admin\/projects\/([^/]+)\/ads-connection(?:\/(test))?$/);
    if (adminAdsConnectionMatch && ["GET", "POST", "PUT"].includes(request.method)) {
      return handleAdminAdsConnection(request, env, {
        projectKey: decodeURIComponent(adminAdsConnectionMatch[1]),
        subAction: adminAdsConnectionMatch[2] || ""
      });
    }

    if (request.method === "POST" && url.pathname === "/api/auth/login") {
      const payload = await readJson(request);
      return handleSupabaseAuthLogin(payload, env, request);
    }

    if (request.method === "POST" && url.pathname === "/api/auth/logout") {
      return handleSupabaseAuthLogout(env, request);
    }

    if (request.method === "GET" && url.pathname === "/api/auth/session") {
      return handleSupabaseAuthSession(env, request);
    }

    if (request.method === "GET" && url.pathname === "/api/me/projects") {
      const auth = await getSupabaseSessionAuth(request, env);
      if (!auth?.ok) return authJson({ ok: false, error: auth?.error || "not_logged_in" }, auth?.status || 401, request);
      return authJson({ ok: true, projects: await listSupabaseProjectsForUser(env, auth.user) }, 200, request);
    }

    if (request.method === "POST" && url.pathname === "/api/agents/runtime/decide-test") {
      const payload = await readJson(request);
      const projectKey = normalizeProjectKey(payload.project_key || env.AGENT_PROJECT_KEY || "beyoute");
      const normalized = normalizeChatDaddyPayload(payload, {
        projectKey,
        connectionId: payload.connection_id || "decide-test"
      });
      const contactKey = await stableContactKey(normalized);
      const conversationAgent = await getAgentByName(
        env.HermasConversationAgent,
        `conv:${projectKey}:${contactKey}`
      );
      return conversationAgent.fetch(new Request("https://agent.local/decide", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ normalized, payload })
      }));
    }

    if (request.method === "GET" && url.pathname === "/api/agents/runtime/payload-samples") {
      const authError = verifyAdminToken(request, env);
      if (authError) return authError;

      const projectKey = normalizeProjectKey(url.searchParams.get("project_key") || env.AGENT_PROJECT_KEY || "beyoute");
      const connectionId = url.searchParams.get("connection_id") || "";
      const projectAgent = await getAgentByName(env.HermasProjectAgent, `project:${projectKey}`);
      return projectAgent.fetch(new Request(`https://agent.local/samples?connection_id=${encodeURIComponent(connectionId)}`, {
        method: "GET",
        headers: request.headers
      }));
    }

    if (request.method === "GET" && url.pathname === "/api/channels/chatdaddy/contacts") {
      const authError = await verifyStaffOrAdminToken(request, env);
      if (authError) return authError;
      return handleChatDaddyContacts(request, env);
    }

    const conversationHistoryImportMatch = url.pathname.match(/^\/api\/hermas\/projects\/([^/]+)\/conversation-history\/import$/);
    if (request.method === "POST" && conversationHistoryImportMatch) {
      const authError = await verifyStaffOrAdminToken(request, env);
      if (authError) return authError;
      const payload = await readJson(request);
      return handleHermasConversationHistoryImport(decodeURIComponent(conversationHistoryImportMatch[1]), payload, env);
    }

    const conversationHistorySyncMatch = url.pathname.match(/^\/api\/hermas\/projects\/([^/]+)\/conversation-history\/sync-chatdaddy$/);
    if (request.method === "POST" && conversationHistorySyncMatch) {
      const authError = await verifyStaffOrAdminToken(request, env);
      if (authError) return authError;
      const payload = await readJson(request);
      return handleHermasConversationHistorySyncChatDaddy(decodeURIComponent(conversationHistorySyncMatch[1]), payload, env);
    }

    if (request.method === "GET" && url.pathname === "/api/approvals/pending") {
      const authError = await verifyStaffOrAdminToken(request, env);
      if (authError) return authError;
      return handleSupabaseApprovalsPending(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/approvals/import-legacy-items") {
      const authError = await verifyStaffOrAdminToken(request, env);
      if (authError) return authError;
      return handleLegacyApprovalItemsImport(request, env);
    }

    const hermasCaseActionMatch = url.pathname.match(/^\/api\/hermas\/projects\/([^/]+)\/cases\/([^/]+)\/(approve-send|return-ai|handoff|manual-resolve|mark-purchase|external-flow-continued)$/);
    if (request.method === "POST" && hermasCaseActionMatch) {
      const authError = await verifyStaffOrAdminToken(request, env);
      if (authError) return authError;
      return handleSupabaseCaseAction(request, env, {
        projectKey: decodeURIComponent(hermasCaseActionMatch[1]),
        caseId: decodeURIComponent(hermasCaseActionMatch[2]),
        action: hermasCaseActionMatch[3]
      });
    }

    const approvalActionMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/(approve|reject|mark-seen|manual-resolve|mark-purchase)$/);
    if (request.method === "POST" && approvalActionMatch) {
      const authError = await verifyStaffOrAdminToken(request, env);
      if (authError) return authError;
      const projectKey = normalizeProjectKey(url.searchParams.get("project_key") || env.AGENT_PROJECT_KEY || "beyoute");
      const action = approvalActionMatch[2] === "approve"
        ? "approve-send"
        : approvalActionMatch[2] === "reject"
          ? "handoff"
          : approvalActionMatch[2];
      return handleSupabaseCaseAction(request, env, {
        projectKey,
        caseId: decodeURIComponent(approvalActionMatch[1]),
        action
      });
    }

    const legacyCaseActionMatch = url.pathname.match(/^\/api\/cases\/([^/]+)\/([^/]+)$/);
    if (request.method === "POST" && legacyCaseActionMatch) {
      const authError = await verifyStaffOrAdminToken(request, env);
      if (authError) return authError;
      const projectKey = normalizeProjectKey(url.searchParams.get("project_key") || env.AGENT_PROJECT_KEY || "beyoute");
      return handleSupabaseCaseAction(request, env, {
        projectKey,
        caseId: decodeURIComponent(legacyCaseActionMatch[1]),
        action: normalizeDashboardCaseActionName(legacyCaseActionMatch[2])
      });
    }

    const webhookMatch = url.pathname.match(/^\/api\/channels\/chatdaddy\/webhook\/([^/]+)$/);
    if (request.method === "POST" && webhookMatch) {
      const webhookAuthError = verifyWebhookSecret(request, env);
      if (webhookAuthError) return webhookAuthError;

      const connectionId = decodeURIComponent(webhookMatch[1]);
      const body = await request.text();
      const projectKey = normalizeProjectKey(url.searchParams.get("project_key") || env.AGENT_PROJECT_KEY || "beyoute");
      const projectAgent = await getAgentByName(env.HermasProjectAgent, `project:${projectKey}`);
      const intakeRequest = new Request(`https://agent.local/intake/chatdaddy?connection_id=${encodeURIComponent(connectionId)}`, {
        method: "POST",
        headers: request.headers,
        body
      });

      if (shouldFastAckWebhook(env, url)) {
        ctx.waitUntil(projectAgent.fetch(intakeRequest).catch((error) => {
          console.error("Hermas ChatDaddy webhook background intake failed", error);
        }));
        return json({
          ok: true,
          accepted: true,
          runtime: "HermasProjectAgent",
          mode: "approval_first",
          webhook_ack_mode: "fast",
          project_key: projectKey,
          connection_id: connectionId,
          decision_status: "queued",
          auto_send_enabled: false,
          auto_trigger_flows_enabled: false
        }, 202);
      }

      return projectAgent.fetch(intakeRequest);
    }

    return (
      (await routeAgentRequest(request, env)) ||
      json({ ok: false, error: "not_found" }, 404)
    );
  }
};

function decideApprovalFirst(normalized) {
  const text = normalized.text || "";
  const lower = text.toLowerCase();
  const hasText = Boolean(text.trim());
  const base = {
    schema_version: "hermas.agent_decision.v1",
    project_key: normalized.project_key,
    customer_id: normalized.external_customer_id || null,
    conversation_id: normalized.external_conversation_id || null,
    message_id: normalized.provider_message_id || normalized.event_id,
    intent: "unknown",
    stage: normalized.stage || "current_stage",
    risk_level: "medium",
    reply_text: "",
    next_action: "create_approval_case",
    flow_key: null,
    send_now: false,
    trigger_flow_now: false,
    needs_human: false,
    reason: "Approval-first default. Staff must review before send.",
    source_refs: [],
    learning_candidate: null
  };

  if (normalized.direction !== "inbound") {
    return {
      ...base,
      intent: "provider_outbound_or_status",
      risk_level: "low",
      next_action: "record_auto_event",
      reason: "Provider outbound/status event is context only.",
      source_refs: ["channel:event_context"]
    };
  }

  if (normalized.button_text || normalized.event_type === "button_click") {
    return {
      ...base,
      intent: "button_click",
      risk_level: "low",
      next_action: "record_auto_event",
      reason: "ChatDaddy owns button-to-next-Flow. Hermas records only.",
      source_refs: ["channel:chatdaddy_button"]
    };
  }

  if (!hasText && normalized.attachments.length) {
    return {
      ...base,
      intent: "attachment_without_text",
      risk_level: "medium",
      reply_text: "亲，这个我先帮你记录起来；如果是付款或订单资料，我会先核对清楚才继续安排。",
      next_action: "create_approval_case",
      reason: "Attachment has no text. Do not guess visual meaning.",
      source_refs: ["channel:attachment"]
    };
  }

  if (!hasText) {
    return {
      ...base,
      intent: "no_text_event",
      risk_level: "low",
      next_action: "record_auto_event",
      reason: "No customer text. Keep out of staff queue unless evidence is needed.",
      source_refs: ["channel:no_text"]
    };
  }

  if (containsAny(lower, ["refund", "退款", "退货", "投诉", "complain", "骗子", "scam"])) {
    return {
      ...base,
      intent: "complaint_refund_after_sales",
      risk_level: "high",
      reply_text: "亲，我先帮你了解清楚情况。你可以把订单资料和遇到的问题发我，我这边会认真核对后再处理。",
      next_action: "handoff",
      needs_human: true,
      reason: "Refund, complaint, and after-sales must be handled by human.",
      source_refs: ["risk:after_sales"]
    };
  }

  if (isSafetyContradictionOrderText(lower)) {
    return {
      ...base,
      intent: "health_boundary_pushback",
      risk_level: "high",
      reply_text: "亲，你说得对。既然已经涉及身体情况，我这边先不继续推配套，也不会叫你下单。我先把前面的情况核对清楚，再谨慎回复你。",
      next_action: "handoff",
      needs_human: true,
      reason: "Customer is pushing back after being told not to drink or to ask a doctor. Do not treat as order intent.",
      source_refs: ["risk:health_sensitive", "guard:no_order_after_do_not_drink"]
    };
  }

  if (containsAny(lower, ["怀孕", "孕妇", "胃痛", "胃酸", "胃病", "骨髓", "血小板", "便秘", "有病", "医生", "药", "medical"])) {
    return {
      ...base,
      intent: "health_sensitive_question",
      risk_level: "high",
      reply_text: "亲，这个涉及身体情况，我先不要乱答。你可以把目前的情况告诉我，我会按资料帮你确认适不适合；如果是严重不舒服或正在治疗，建议先问医生比较安心。",
      next_action: "handoff",
      needs_human: true,
      reason: "Health-sensitive question requires safe boundary and human review.",
      source_refs: ["risk:health_sensitive"]
    };
  }

  if (isDrinkUsageQuestion(text)) {
    return {
      ...base,
      intent: "faq_drink_usage",
      risk_level: "low",
      reply_text: beyouteDrinkUsageReply(),
      next_action: "create_approval_case",
      reason: "Customer asked a direct product usage FAQ. Answer from Beyoute FAQ before any CTA or Flow decision.",
      source_refs: ["faq:drink_usage", "policy:answer_first"]
    };
  }

  if (containsAny(lower, ["等下付款", "等下付", "later pay", "迟点付款", "今晚付款"])) {
    return {
      ...base,
      intent: "payment_later",
      risk_level: "low",
      reply_text: "好的亲，没问题。你等下付款后把截图或汇款资料发我，我这边核对金额和订单资料后就继续帮你安排。",
      next_action: "create_approval_case",
      reason: "Customer says they will pay later. Reply politely; do not mark paid.",
      source_refs: ["payment:not_confirmed"]
    };
  }

  if (containsAny(lower, ["付款", "汇款", "receipt", "收据", "截图", "transfer", "bank in"])) {
    return {
      ...base,
      intent: "payment_or_receipt_review",
      risk_level: "medium",
      reply_text: "亲，收到你的付款/汇款讯息或截图。我先核对金额、截图和订单资料，确认后才会继续安排。",
      next_action: "order_payment_review",
      reason: "Payment needs evidence and amount review. Do not guess paid.",
      source_refs: ["payment:review_required"]
    };
  }

  if (containsAny(lower, ["我要下单", "下单", "cod", "地址", "电话", "我要买", "order"])) {
    return {
      ...base,
      intent: "order_intent",
      risk_level: "low",
      reply_text: "可以的亲。我先跟你确认订单资料：名字、电话、完整地址、要的配套和付款方式。资料齐了我再帮你安排。",
      next_action: "order_payment_review",
      reason: "Order intent requires order field confirmation.",
      source_refs: ["order:collect_fields"]
    };
  }

  if (containsAny(lower, ["价格", "多少钱", "几钱", "price", "rm", "优惠"])) {
    return {
      ...base,
      intent: "price_question",
      risk_level: "medium",
      reply_text: "可以的亲，我先帮你看你比较适合哪一个配套，再跟你讲清楚今天的价格和优惠。",
      next_action: "create_approval_case",
      flow_key: "next_configured_step",
      reason: "Price question needs project pricing context and approval.",
      source_refs: ["faq:price", "flow:configured_stage"]
    };
  }

  return {
    ...base,
    intent: "faq_or_free_text_question",
    risk_level: "medium",
    reply_text: "亲，我明白你的问题。我先根据资料帮你确认清楚，再用最简单的方式回复你。",
    next_action: "create_approval_case",
    flow_key: "next_configured_step",
    reason: "Free-text after Flow stops belongs to Hermas. Answer first, then decide Flow/CTA after approval.",
    source_refs: ["policy:answer_first"]
  };
}

async function maybeImproveDraftWithModel(env, normalized, decision) {
  if (env.HERMAS_AGENT_LLM_ENABLED !== "true" || !env.OPENAI_API_KEY) return decision;
  if (decision.next_action === "record_auto_event") return decision;

  const prompt = [
    "You are Hermas, an approval-first customer-service reply agent.",
    "Return strict JSON only.",
    "Never set send_now true.",
    "Never set trigger_flow_now true.",
    "Do not say you are AI. Do not tell the customer to wait for customer service.",
    "Answer the customer question first. If facts are missing, keep the reply safe.",
    `Customer message: ${normalized.text || ""}`,
    `Initial decision: ${JSON.stringify(decision)}`
  ].join("\n");

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: env.HERMAS_AGENT_MODEL || env.OPENAI_SALES_BRAIN_MODEL || "gpt-5.4-mini",
        input: [
          {
            role: "user",
            content: prompt
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "hermas_agent_decision",
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["reply_text", "intent", "risk_level", "next_action", "reason"],
              properties: {
                reply_text: { type: "string" },
                intent: { type: "string" },
                risk_level: { type: "string", enum: ["low", "medium", "high"] },
                next_action: { type: "string" },
                reason: { type: "string" }
              }
            }
          }
        },
        max_output_tokens: 260
      })
    });
    if (!response.ok) return decision;
    const data = await response.json();
    const text = extractOpenAIText(data);
    const patch = JSON.parse(text);
    return {
      ...decision,
      ...patch,
      send_now: false,
      trigger_flow_now: false,
      source_refs: [...new Set([...(decision.source_refs || []), "model:openai_in_agent"])]
    };
  } catch {
    return decision;
  }
}

function normalizeChatDaddyPayload(payload, options = {}) {
  const raw = Array.isArray(payload) ? (payload[0] || {}) : (payload || {});
  const data = raw.data || raw.message || raw.event || raw.payload || raw;
  const contact = raw.contact || data.contact || raw.customer || data.customer || {};
  const message = raw.message || data.message || data;
  const metadata = {
    raw_event_type: raw.event_type || raw.eventType || data.event_type || data.type || null,
    button_text: firstString(raw.button_text, raw.buttonText, data.button_text, data.buttonText, data.button?.text, data.button?.payload),
    flow_id: firstString(raw.flow_id, raw.flowId, data.flow_id, data.flowId, data.bot_id, data.botId),
    step: firstString(raw.step, raw.step_name, raw.stepName, data.step, data.step_name, data.stepName),
    caption: firstString(raw.caption, data.caption, message.caption)
  };
  const text = firstString(
    raw._raw_text,
    raw.text,
    raw.message_text,
    raw.messageText,
    data.text,
    data.body,
    data.message_text,
    message.text,
    message.body,
    message.caption
  );
  const attachments = normalizeAttachments(raw, data, message);
  const buttonText = metadata.button_text;
  const messageType = normalizeMessageType(firstString(raw.message_type, raw.messageType, data.message_type, data.messageType, message.type), attachments);
  const direction = normalizeDirection(firstString(raw.direction, data.direction, message.direction), raw.from_me ?? raw.fromMe ?? data.from_me ?? data.fromMe ?? message.from_me ?? message.fromMe);
  const providerMessageId = firstString(raw.message_id, raw.messageId, data.message_id, data.messageId, message.id, message.message_id, message.messageId);
  const externalCustomerId = firstString(raw.contact_id, raw.contactId, data.contact_id, data.contactId, contact.id, contact.contact_id, contact.contactId, contact.uid);
  const externalConversationId = firstString(raw.chat_id, raw.chatId, raw.thread_id, raw.threadId, data.chat_id, data.chatId, data.thread_id, data.threadId, message.chat_id, message.chatId);
  const phone = firstString(raw.phone, data.phone, contact.phone, contact.phone_number, contact.phoneNumber, contact.mobile);
  const displayName = sanitizeDisplayName(firstString(raw.display_name, raw.displayName, data.display_name, data.displayName, contact.name, contact.display_name, contact.displayName, contact.profile_name, contact.profileName));
  const eventType = buttonText ? "button_click" : firstString(raw.event_type, raw.eventType, data.event_type, data.eventType, data.type) || "message";

  return {
    schema_version: "hermas.channel_adapter.v1",
    event_id: firstString(raw.event_id, raw.eventId, data.event_id, data.eventId) || providerMessageId || crypto.randomUUID(),
    provider: "chatdaddy",
    project_key: options.projectKey || normalizeProjectKey(raw.project_key || raw.projectKey || "beyoute"),
    connection_id: options.connectionId || firstString(raw.connection_id, raw.connectionId, data.connection_id, data.connectionId) || "default",
    provider_message_id: providerMessageId || null,
    external_customer_id: externalCustomerId || null,
    external_conversation_id: externalConversationId || null,
    phone,
    display_name: displayName,
    direction,
    event_type: eventType,
    message_type: messageType,
    text: text || "",
    button_text: buttonText || null,
    attachments,
    stage: normalizeStage(metadata.step),
    message_at: normalizeDate(firstString(raw.timestamp, raw.created_at, raw.createdAt, data.timestamp, data.created_at, message.timestamp)),
    metadata
  };
}

function normalizeAttachments(...objects) {
  const attachments = [];
  for (const object of objects) {
    if (!object || typeof object !== "object") continue;
    const candidates = [
      object.attachments,
      object.attachment,
      object.media,
      object.files,
      object.image,
      object.audio,
      object.video
    ];
    for (const candidate of candidates) {
      if (!candidate) continue;
      if (Array.isArray(candidate)) {
        for (const item of candidate) attachments.push(normalizeAttachment(item));
      } else {
        attachments.push(normalizeAttachment(candidate));
      }
    }
  }
  return attachments.filter(Boolean);
}

function normalizeAttachment(value) {
  if (!value) return null;
  if (typeof value === "string") return { url: value, type: "file" };
  if (typeof value !== "object") return null;
  return {
    url: firstString(value.url, value.download_url, value.downloadUrl, value.media_url, value.mediaUrl, value.link),
    type: firstString(value.type, value.mime_type, value.mimeType, value.kind) || "file",
    name: firstString(value.name, value.filename, value.file_name, value.fileName) || null
  };
}

async function persistSupabaseMessage(env, normalized, rawPayload) {
  if (!hasSupabase(env)) return { attempted: false, reason: "supabase_not_configured" };
  return persistSupabaseMessageWithRefs(env, normalized, rawPayload, {});
}

async function persistSupabaseIntakeRecords(env, normalized, rawPayload) {
  const out = {
    attempted: false,
    ok: false,
    refs: {},
    project: null,
    connection: null,
    customer: null,
    contact: null,
    conversation: null,
    message: null
  };
  if (!hasSupabase(env)) {
    return { ...out, reason: "supabase_not_configured" };
  }

  out.attempted = true;
  out.project = await lookupSupabaseProject(env, normalized.project_key);
  if (!out.project?.id) {
    return {
      ...out,
      reason: "project_not_seeded",
      error: `Project ${normalized.project_key} must exist before webhook intake.`
    };
  }

  out.connection = await lookupSupabaseChannelConnection(env, normalized.project_key, normalized.connection_id);
  const channelConnectionId = out.connection?.id || null;
  const legacyBrandId = out.connection?.brand_id || out.project?.brand_id || null;

  out.customer = await upsertSupabaseCustomer(env, normalized, channelConnectionId);
  const customerId = firstReturnedId(out.customer);
  out.contact = legacyBrandId
    ? await upsertSupabaseContact(env, normalized, {
      brand_id: legacyBrandId,
      channel_connection_id: channelConnectionId
    })
    : { attempted: false, reason: "legacy_brand_not_present" };
  const contactId = firstReturnedId(out.contact);

  out.conversation = await upsertSupabaseConversation(env, normalized, {
    brand_id: legacyBrandId,
    contact_id: contactId,
    customer_id: customerId,
    channel_connection_id: channelConnectionId
  });
  const conversationId = firstReturnedId(out.conversation);

  const refs = {
    brand_id: legacyBrandId,
    project_id: out.project.id,
    channel_connection_id: channelConnectionId,
    contact_id: contactId,
    customer_id: customerId,
    conversation_id: conversationId
  };

  out.message = await persistSupabaseMessageWithRefs(env, normalized, rawPayload, refs);
  refs.message_id = firstReturnedId(out.message);
  out.refs = refs;
  out.ok = Boolean(out.message?.ok || out.message?.skipped_existing);
  return out;
}

async function lookupSupabaseProject(env, projectKey) {
  const rows = await supabaseSelectRows(
    env,
    `projects?project_key=eq.${encodeURIComponent(projectKey)}&select=id,project_key,name,status&limit=1`
  );
  return rows[0] || null;
}

async function lookupSupabaseChannelConnection(env, projectKey, connectionId) {
  if (!connectionId) return null;
  const byKey = await supabaseSelectRows(
    env,
    `channel_connections?project_key=eq.${encodeURIComponent(projectKey)}&connection_key=eq.${encodeURIComponent(connectionId)}&select=id,project_key,connection_key,provider_connection_id,status,brand_id&limit=1`
  );
  if (byKey[0]) return byKey[0];
  const byKeyWithoutBrand = await supabaseSelectRows(
    env,
    `channel_connections?project_key=eq.${encodeURIComponent(projectKey)}&connection_key=eq.${encodeURIComponent(connectionId)}&select=id,project_key,connection_key,provider_connection_id,status&limit=1`
  );
  if (byKeyWithoutBrand[0]) return byKeyWithoutBrand[0];
  const byProviderId = await supabaseSelectRows(
    env,
    `channel_connections?project_key=eq.${encodeURIComponent(projectKey)}&provider_connection_id=eq.${encodeURIComponent(connectionId)}&select=id,project_key,connection_key,provider_connection_id,status,brand_id&limit=1`
  );
  if (byProviderId[0]) return byProviderId[0];
  const byProviderIdWithoutBrand = await supabaseSelectRows(
    env,
    `channel_connections?project_key=eq.${encodeURIComponent(projectKey)}&provider_connection_id=eq.${encodeURIComponent(connectionId)}&select=id,project_key,connection_key,provider_connection_id,status&limit=1`
  );
  return byProviderIdWithoutBrand[0] || null;
}

async function upsertSupabaseCustomer(env, normalized, channelConnectionId) {
  const existing = await findSupabaseCustomer(env, normalized, channelConnectionId);
  const payload = withoutUndefined({
    project_key: normalized.project_key,
    channel_connection_id: channelConnectionId || undefined,
    external_customer_id: normalized.external_customer_id || undefined,
    phone_e164: normalized.phone || undefined,
    display_name: normalized.display_name || undefined,
    source: normalized.provider,
    last_seen_at: normalized.message_at,
    profile: {
      provider: normalized.provider,
      connection_id: normalized.connection_id,
      external_conversation_id: normalized.external_conversation_id || null
    }
  });

  if (existing?.id) {
    const patch = withoutUndefined({
      external_customer_id: normalized.external_customer_id || undefined,
      phone_e164: normalized.phone || undefined,
      display_name: normalized.display_name || undefined,
      last_seen_at: normalized.message_at,
      profile: payload.profile
    });
    const patched = await supabasePatch(env, `customers?id=eq.${existing.id}`, patch);
    return { ...patched, existing: true, data: patched.data?.length ? patched.data : [existing] };
  }

  if (!payload.external_customer_id && !payload.phone_e164 && !payload.display_name) {
    return { attempted: false, skipped: true, reason: "no_customer_identifier" };
  }
  return supabaseInsert(env, "customers", payload);
}

async function findSupabaseCustomer(env, normalized, channelConnectionId) {
  if (normalized.external_customer_id && channelConnectionId) {
    const rows = await supabaseSelectRows(
      env,
      `customers?project_key=eq.${encodeURIComponent(normalized.project_key)}&channel_connection_id=eq.${channelConnectionId}&external_customer_id=eq.${encodeURIComponent(normalized.external_customer_id)}&select=id,display_name,phone_e164,external_customer_id&limit=1`
    );
    if (rows[0]) return rows[0];
  }

  if (normalized.external_customer_id) {
    const rows = await supabaseSelectRows(
      env,
      `customers?project_key=eq.${encodeURIComponent(normalized.project_key)}&external_customer_id=eq.${encodeURIComponent(normalized.external_customer_id)}&select=id,display_name,phone_e164,external_customer_id&limit=1`
    );
    if (rows[0]) return rows[0];
  }

  if (normalized.phone) {
    const rows = await supabaseSelectRows(
      env,
      `customers?project_key=eq.${encodeURIComponent(normalized.project_key)}&phone_e164=eq.${encodeURIComponent(normalized.phone)}&select=id,display_name,phone_e164,external_customer_id&limit=1`
    );
    if (rows[0]) return rows[0];
  }

  return null;
}

async function upsertSupabaseContact(env, normalized, refs = {}) {
  if (!refs.brand_id) {
    return { attempted: false, skipped: true, reason: "brand_id_required_for_legacy_contacts" };
  }

  const existing = await findSupabaseContact(env, normalized, refs);
  const payload = withoutUndefined({
    brand_id: refs.brand_id,
    channel_connection_id: refs.channel_connection_id || undefined,
    external_contact_id: normalized.external_customer_id || undefined,
    phone_e164: normalized.phone || undefined,
    display_name: normalized.display_name || undefined,
    source: normalized.provider,
    last_seen_at: normalized.message_at,
    custom_fields: {
      project_key: normalized.project_key,
      provider: normalized.provider,
      connection_id: normalized.connection_id,
      external_conversation_id: normalized.external_conversation_id || null
    }
  });

  if (existing?.id) {
    const patch = withoutUndefined({
      channel_connection_id: refs.channel_connection_id || undefined,
      external_contact_id: normalized.external_customer_id || undefined,
      phone_e164: normalized.phone || undefined,
      display_name: normalized.display_name || undefined,
      last_seen_at: normalized.message_at,
      custom_fields: payload.custom_fields
    });
    const patched = await supabasePatch(env, `contacts?id=eq.${existing.id}`, patch);
    return { ...patched, existing: true, data: patched.data?.length ? patched.data : [existing] };
  }

  if (!payload.external_contact_id && !payload.phone_e164 && !payload.display_name) {
    return { attempted: false, skipped: true, reason: "no_contact_identifier" };
  }
  return supabaseInsert(env, "contacts", payload);
}

async function findSupabaseContact(env, normalized, refs = {}) {
  if (!refs.brand_id) return null;
  if (normalized.external_customer_id && refs.channel_connection_id) {
    const rows = await supabaseSelectRows(
      env,
      `contacts?brand_id=eq.${refs.brand_id}&channel_connection_id=eq.${refs.channel_connection_id}&external_contact_id=eq.${encodeURIComponent(normalized.external_customer_id)}&select=id,display_name,phone_e164,external_contact_id&limit=1`
    );
    if (rows[0]) return rows[0];
  }

  if (normalized.external_customer_id) {
    const rows = await supabaseSelectRows(
      env,
      `contacts?brand_id=eq.${refs.brand_id}&external_contact_id=eq.${encodeURIComponent(normalized.external_customer_id)}&select=id,display_name,phone_e164,external_contact_id&limit=1`
    );
    if (rows[0]) return rows[0];
  }

  if (normalized.phone) {
    const rows = await supabaseSelectRows(
      env,
      `contacts?brand_id=eq.${refs.brand_id}&phone_e164=eq.${encodeURIComponent(normalized.phone)}&select=id,display_name,phone_e164,external_contact_id&limit=1`
    );
    if (rows[0]) return rows[0];
  }

  return null;
}

async function upsertSupabaseConversation(env, normalized, refs) {
  const existing = await findSupabaseConversation(env, normalized, refs);
  const payload = withoutUndefined({
    brand_id: refs.brand_id || undefined,
    project_key: normalized.project_key,
    contact_id: refs.contact_id || undefined,
    customer_id: refs.customer_id || undefined,
    channel_connection_id: refs.channel_connection_id || undefined,
    external_conversation_id: normalized.external_conversation_id || undefined,
    external_thread_id: normalized.external_conversation_id || undefined,
    status: "open",
    stage: normalized.stage || undefined,
    last_message_at: normalized.message_at,
    last_customer_message_at: normalized.direction === "inbound" ? normalized.message_at : undefined,
    last_agent_message_at: normalized.direction === "outbound" ? normalized.message_at : undefined,
    metadata: {
      provider: normalized.provider,
      connection_id: normalized.connection_id
    }
  });

  if (existing?.id) {
    const patched = await supabasePatch(env, `conversations?id=eq.${existing.id}`, payload);
    return { ...patched, existing: true, data: patched.data?.length ? patched.data : [existing] };
  }

  return supabaseInsert(env, "conversations", payload);
}

async function findSupabaseConversation(env, normalized, refs) {
  if (normalized.external_conversation_id) {
    const rows = await supabaseSelectRows(
      env,
      `conversations?project_key=eq.${encodeURIComponent(normalized.project_key)}&external_conversation_id=eq.${encodeURIComponent(normalized.external_conversation_id)}&select=id,external_conversation_id,customer_id&limit=1`
    );
    if (rows[0]) return rows[0];
  }

  if (normalized.external_conversation_id && refs.brand_id) {
    const rows = await supabaseSelectRows(
      env,
      `conversations?brand_id=eq.${refs.brand_id}&external_thread_id=eq.${encodeURIComponent(normalized.external_conversation_id)}&select=id,external_thread_id,contact_id&limit=1`
    );
    if (rows[0]) return rows[0];
  }

  if (refs.contact_id && refs.brand_id) {
    const rows = await supabaseSelectRows(
      env,
      `conversations?brand_id=eq.${refs.brand_id}&contact_id=eq.${refs.contact_id}&status=eq.open&select=id,external_thread_id,contact_id&limit=1`
    );
    if (rows[0]) return rows[0];
  }

  if (refs.customer_id) {
    const rows = await supabaseSelectRows(
      env,
      `conversations?project_key=eq.${encodeURIComponent(normalized.project_key)}&customer_id=eq.${refs.customer_id}&status=eq.open&select=id,external_conversation_id,customer_id&limit=1`
    );
    if (rows[0]) return rows[0];
  }

  return null;
}

async function persistSupabaseMessageWithRefs(env, normalized, rawPayload, refs = {}) {
  if (!hasSupabase(env)) return { attempted: false, reason: "supabase_not_configured" };
  const existing = await findSupabaseMessage(env, normalized);
  if (existing?.id) {
    return {
      attempted: true,
      ok: true,
      table: "messages",
      skipped_existing: true,
      rows: 1,
      data: [existing]
    };
  }

  const payload = {
    ...withoutUndefined({ brand_id: refs.brand_id || undefined }),
    project_key: normalized.project_key,
    conversation_id: refs.conversation_id || null,
    ...withoutUndefined({ contact_id: refs.contact_id || undefined }),
    customer_id: refs.customer_id || null,
    direction: normalized.direction,
    sender_type: normalized.direction === "inbound" ? "customer" : "provider",
    provider: normalized.provider,
    provider_message_id: normalized.provider_message_id,
    text: normalized.text || null,
    message_type: normalized.message_type,
    attachments: normalized.attachments,
    content: publicNormalizedEvent(normalized),
    status: "received",
    message_at: normalized.message_at,
    metadata: {
      connection_id: normalized.connection_id,
      event_id: normalized.event_id,
      display_name: normalized.display_name || null,
      external_customer_id: normalized.external_customer_id || null,
      external_conversation_id: normalized.external_conversation_id || null,
      raw_payload_shape_seen: Boolean(rawPayload)
    }
  };
  return supabaseInsert(env, "messages", payload);
}

async function findSupabaseMessage(env, normalized) {
  if (!normalized.provider_message_id) return null;
  const rows = await supabaseSelectRows(
    env,
    `messages?project_key=eq.${encodeURIComponent(normalized.project_key)}&provider=eq.${encodeURIComponent(normalized.provider)}&provider_message_id=eq.${encodeURIComponent(normalized.provider_message_id)}&select=id,provider_message_id&limit=1`
  );
  return rows[0] || null;
}

async function persistSupabaseBackgroundJob(env, normalized, refs = {}) {
  if (!hasSupabase(env)) return { attempted: false, reason: "supabase_not_configured" };
  const jobType = normalized.direction === "inbound"
    ? "chatdaddy_inbound_decision"
    : "chatdaddy_context_record";
  const dedupeKey = [
    jobType,
    normalized.provider,
    normalized.provider_message_id || normalized.event_id
  ].join(":");

  const existing = await findSupabaseBackgroundJob(env, normalized.project_key, dedupeKey);
  if (existing?.id) {
    return {
      attempted: true,
      ok: true,
      table: "background_jobs",
      skipped_existing: true,
      rows: 1,
      data: [existing]
    };
  }

  return supabaseInsert(env, "background_jobs", {
    project_key: normalized.project_key,
    job_type: jobType,
    status: "queued",
    priority: normalized.direction === "inbound" ? 4 : 7,
    attempt_count: 0,
    max_attempts: 5,
    next_run_at: new Date().toISOString(),
    dedupe_key: dedupeKey,
    payload: {
      normalized: publicNormalizedEvent(normalized),
      connection_id: normalized.connection_id,
      provider: normalized.provider,
      provider_message_id: normalized.provider_message_id,
      event_type: normalized.event_type,
      message_type: normalized.message_type,
      refs
    }
  });
}

async function findSupabaseBackgroundJob(env, projectKey, dedupeKey) {
  if (!dedupeKey) return null;
  const rows = await supabaseSelectRows(
    env,
    `background_jobs?project_key=eq.${encodeURIComponent(projectKey)}&dedupe_key=eq.${encodeURIComponent(dedupeKey)}&select=id,dedupe_key,status&limit=1`
  );
  return rows[0] || null;
}

async function persistSupabaseDecision(env, normalized, decision, rawPayload, refs = {}) {
  const out = {
    ai_decision: { attempted: false, reason: "supabase_not_configured" },
    approval_case: { attempted: false, reason: "not_required" }
  };
  if (!hasSupabase(env)) return out;

  out.ai_decision = await supabaseInsert(env, "ai_decisions", {
    ...withoutUndefined({ brand_id: refs.brand_id || undefined }),
    project_key: normalized.project_key,
    conversation_id: refs.conversation_id || null,
    trigger_message_id: refs.message_id || null,
    model: decision.source_refs?.includes("model:openai_in_agent") ? (env.HERMAS_AGENT_MODEL || env.OPENAI_SALES_BRAIN_MODEL || "openai") : "deterministic-agent",
    prompt_version: "hermas.cloudflare_agents_sdk.v1",
    decision: decision.next_action,
    risk_level: decision.risk_level,
    stage_before: normalized.stage || null,
    stage_after: decision.stage || null,
    suggested_reply: decision.reply_text || null,
    next_action: decision.next_action,
    confidence: decision.risk_level === "low" ? 0.8 : 0.55,
    data: {
      decision,
      normalized: publicNormalizedEvent(normalized)
    }
  });

  if (["create_approval_case", "handoff", "order_payment_review"].includes(decision.next_action)) {
    const queueBucket = decision.next_action === "handoff"
      ? "human"
      : decision.next_action === "order_payment_review"
        ? "order_payment"
        : "approvable";
    out.approval_case = await insertOrFindSupabaseApprovalCase(env, {
      ...withoutUndefined({ brand_id: refs.brand_id || undefined }),
      project_key: normalized.project_key,
      customer_id: refs.customer_id || null,
      conversation_id: refs.conversation_id || null,
      trigger_message_id: refs.message_id || null,
      status: decision.next_action === "handoff" ? "handoff" : "needs_approval",
      queue_bucket: queueBucket,
      stage: decision.stage || normalized.stage || null,
      intent: decision.intent,
      risk_level: decision.risk_level,
      customer_last_text: normalized.text || null,
      suggested_reply: decision.reply_text || null,
      next_action: decision.next_action,
      confidence: decision.risk_level === "low" ? 0.8 : 0.55,
      reason: decision.reason,
      provider: normalized.provider,
      provider_case_id: normalized.provider_message_id || normalized.event_id,
      idempotency_key: `${normalized.project_key}:${normalized.provider}:${normalized.provider_message_id || normalized.event_id}`,
      data: {
        decision,
        normalized: publicNormalizedEvent(normalized),
        has_raw_payload: Boolean(rawPayload)
      }
    });
  }

  if (decision.next_action === "record_auto_event") {
    await supabaseInsert(env, "flow_events", {
      ...withoutUndefined({ brand_id: refs.brand_id || undefined }),
      project_key: normalized.project_key,
      customer_id: refs.customer_id || null,
      conversation_id: refs.conversation_id || null,
      channel_connection_id: refs.channel_connection_id || null,
      provider: normalized.provider,
      provider_event_id: normalized.provider_message_id || normalized.event_id,
      flow_id: normalized.metadata?.flow_id || null,
      flow_key: decision.flow_key || null,
      flow_step: normalized.metadata?.step || null,
      event_type: decision.intent,
      status: "received",
      event_at: normalized.message_at,
      data: {
        decision,
        normalized: publicNormalizedEvent(normalized)
      }
    });
  }

  return out;
}

async function insertOrFindSupabaseApprovalCase(env, payload) {
  if (payload.idempotency_key) {
    const existing = await supabaseSelectRows(
      env,
      `approval_cases?project_key=eq.${encodeURIComponent(payload.project_key)}&idempotency_key=eq.${encodeURIComponent(payload.idempotency_key)}&select=id,status,queue_bucket,idempotency_key&limit=1`
    );
    if (existing[0]) {
      return {
        attempted: true,
        ok: true,
        table: "approval_cases",
        skipped_existing: true,
        rows: 1,
        data: existing
      };
    }
  }
  return supabaseInsert(env, "approval_cases", payload);
}

async function handleSupabaseApprovalsPending(request, env) {
  if (!hasSupabase(env)) return json({ ok: false, error: "supabase_not_configured" }, 503);

  const url = new URL(request.url);
  const projectKey = normalizeProjectKey(url.searchParams.get("project_key") || env.AGENT_PROJECT_KEY || "beyoute");
  const limit = clampInteger(url.searchParams.get("limit"), 1, 250, 50);
  const scanLimit = clampInteger(url.searchParams.get("scan_limit"), limit, 2000, Math.max(limit, 500));
  const requestedStatus = String(url.searchParams.get("status") || "pending").trim().toLowerCase() || "pending";
  const includeTests = ["1", "true", "yes"].includes(String(url.searchParams.get("include_tests") || "").toLowerCase());
  const realOnly = !["0", "false", "no"].includes(String(url.searchParams.get("real_only") || "1").toLowerCase());
  const compactConversations = ["1", "true", "yes"].includes(String(
    url.searchParams.get("compact_conversations") ||
    url.searchParams.get("compactConversations") ||
    ""
  ).toLowerCase());
  const rows = await supabaseSelectRows(
    env,
    `approval_cases?project_key=eq.${encodeURIComponent(projectKey)}&select=*&order=created_at.desc&limit=${scanLimit}`
  );

  const customerIds = uniqueTruthy(rows.map((row) => row.customer_id));
  const messageIds = uniqueTruthy(rows.map((row) => row.trigger_message_id));
  const conversationIds = uniqueTruthy(rows.map((row) => row.conversation_id));
  const customers = await selectSupabaseRowsByIds(env, "customers", customerIds, "id,external_customer_id,phone_e164,display_name,profile");
  const messages = await selectSupabaseRowsByIds(env, "messages", messageIds, "id,provider_message_id,text,message_at,metadata,content,customer_id");
  const recentMessageRows = await selectSupabaseRecentMessagesByConversationIds(env, projectKey, conversationIds);
  const customerById = objectById(customers);
  const messageById = objectById(messages);
  const recentMessagesByConversationId = groupSupabaseMessagesByConversationId(recentMessageRows);

  const items = rows.map((row) => approvalCaseRowToDashboardItem(row, {
    customer: customerById[row.customer_id] || null,
    message: messageById[row.trigger_message_id] || null,
    recentMessages: recentMessagesByConversationId[row.conversation_id] || []
  }));
  const legacy = await fetchLegacyApprovalItems(request, env, projectKey);
  const mergedItems = mergeApprovalItems(items, legacy.items);
  const cleanItems = (!includeTests || realOnly)
    ? mergedItems.filter((item) => !isLikelyDashboardTestItem(item))
    : mergedItems;
  const statusFilteredItems = filterDashboardItemsByRequestedStatus(cleanItems, requestedStatus);
  const visibleItems = (compactConversations || shouldCollapseDashboardItemsForStatus(requestedStatus))
    ? collapseDashboardItemsByConversation(statusFilteredItems)
    : statusFilteredItems;
  const limitedItems = visibleItems.slice(0, limit);
  const syncStatus = await loadSupabaseDashboardSyncStatus(env, projectKey, {
    rows,
    recentMessageRows,
    mergedItems
  });

  return json({
    ok: true,
    source: legacy.items.length ? "supabase_approval_cases_plus_legacy" : "supabase_approval_cases",
    runtime: "HermasProjectAgent",
    project_key: projectKey,
    status: requestedStatus,
    items: limitedItems,
    count: visibleItems.length,
    raw_count: mergedItems.length,
    supabase_count: items.length,
    legacy_count: legacy.items.length,
    filtered_count: statusFilteredItems.length,
    scan_limit: scanLimit,
    include_tests: includeTests,
    real_only: realOnly,
    compact_conversations: compactConversations,
    sync_status: syncStatus,
    legacy_error: legacy.error || null,
    auto_send_enabled: false,
    auto_trigger_flows_enabled: false
  });
}

async function loadSupabaseDashboardSyncStatus(env, projectKey, context = {}) {
  const now = new Date();
  const latestMessages = await supabaseSelectRows(
    env,
    `messages?project_key=eq.${encodeURIComponent(projectKey)}&select=message_at,created_at,direction,sender_type,message_type&order=message_at.desc&limit=1`
  );
  const latestCases = await supabaseSelectRows(
    env,
    `approval_cases?project_key=eq.${encodeURIComponent(projectKey)}&select=created_at,updated_at,status,queue_bucket&order=updated_at.desc&limit=1`
  );
  const latestMessageAt = latestDateString([
    latestMessages[0]?.message_at,
    latestMessages[0]?.created_at,
    ...(context.recentMessageRows || []).map((row) => row.message_at || row.created_at)
  ]);
  const latestCaseAt = latestDateString([
    latestCases[0]?.updated_at,
    latestCases[0]?.created_at,
    ...(context.rows || []).map((row) => row.updated_at || row.created_at),
    ...(context.mergedItems || []).map((item) => item.updated_at || item.created_at || item.last_message_at)
  ]);
  const freshnessAnchorAt = latestMessageAt || latestCaseAt;
  const latestMessageAgeMinutes = latestMessageAt
    ? Math.max(0, Math.floor((now.getTime() - new Date(latestMessageAt).getTime()) / 60000))
    : null;
  const latestCaseAgeMinutes = latestCaseAt
    ? Math.max(0, Math.floor((now.getTime() - new Date(latestCaseAt).getTime()) / 60000))
    : null;
  const staleAfterMinutes = 240;
  return {
    ok: true,
    source: "supabase_messages_and_approval_cases",
    server_time: now.toISOString(),
    latest_message_at: latestMessageAt || null,
    latest_case_at: latestCaseAt || null,
    latest_dashboard_event_at: freshnessAnchorAt || null,
    age_minutes: latestMessageAgeMinutes,
    case_update_age_minutes: latestCaseAgeMinutes,
    stale_after_minutes: staleAfterMinutes,
    is_stale: latestMessageAgeMinutes === null ? true : latestMessageAgeMinutes > staleAfterMinutes,
    note: latestMessageAgeMinutes === null
      ? "No dashboard message event found."
      : latestMessageAgeMinutes > staleAfterMinutes
        ? "Dashboard has not received a recent message within the freshness window."
        : "Dashboard has received a recent event within the freshness window."
  };
}

async function handleChatDaddyContacts(request, env) {
  const config = chatDaddyConfig(env);
  if (!config.apiKey) {
    return json({ ok: false, error: "chatdaddy_api_not_configured" }, 503);
  }

  const url = new URL(request.url);
  const requestedContacts = [
    ...url.searchParams.getAll("contact"),
    ...url.searchParams.getAll("contact_id"),
    ...url.searchParams.getAll("chat_id"),
    ...String(url.searchParams.get("contacts") || "").split(/[,\s]+/)
  ].map(normalizeChatDaddyToContact).filter(Boolean);
  const contacts = [...new Set(requestedContacts)].slice(0, 80);
  if (!contacts.length) {
    return json({
      ok: false,
      error: "contacts_query_required",
      example: "/api/channels/chatdaddy/contacts?contacts=60123456789"
    }, 400);
  }

  const results = [];
  const concurrency = 6;
  for (let index = 0; index < contacts.length; index += concurrency) {
    const batch = contacts.slice(index, index + concurrency);
    results.push(...await Promise.all(batch.map((contactId) => fetchChatDaddyContact(config, contactId))));
  }

  const names = {};
  const items = results.map((result) => {
    const item = normalizeChatDaddyContactResult(result);
    if (item.name) {
      for (const id of [item.id, item.requested_id, item.phone].map(normalizeChatDaddyToContact).filter(Boolean)) {
        names[id] = item.name;
      }
    }
    return item;
  });

  return json({
    ok: true,
    provider: "chatdaddy",
    count: items.length,
    matched_count: Object.keys(names).length,
    names,
    items
  });
}

async function handleHermasConversationHistoryImport(rawProjectKey, payload = {}, env) {
  const projectKey = normalizeProjectKey(rawProjectKey || payload.project_key || payload.projectKey || env.AGENT_PROJECT_KEY || "beyoute");
  if (!projectKey) return json({ ok: false, error: "project_key_required" }, 400);

  const normalizedMessages = normalizeHermasConversationHistoryImportPayload(payload, {
    projectKey,
    provider: "chatdaddy"
  });
  if (!normalizedMessages.length) {
    return json({
      ok: true,
      project_key: projectKey,
      provider: "chatdaddy",
      source: payload.source || "conversation_history_import",
      imported_count: 0,
      skipped_count: 0,
      failed_count: 0,
      sends_messages: false,
      triggers_flows: false,
      creates_approval_cases: false,
      next: "No importable messages were provided."
    });
  }

  const records = [];
  for (const item of normalizedMessages) {
    const result = await persistSupabaseIntakeRecords(env, item.normalized, item.raw);
    records.push({
      ok: Boolean(result.ok),
      skipped_existing: Boolean(result.message?.skipped_existing),
      message_id: result.refs?.message_id || null,
      conversation_id: result.refs?.conversation_id || null,
      direction: item.normalized.direction,
      message_at: item.normalized.message_at,
      error: result.ok ? null : result.reason || result.error || result.message?.error || "import_failed"
    });
  }

  const imported = records.filter((record) => record.ok && !record.skipped_existing);
  const skipped = records.filter((record) => record.ok && record.skipped_existing);
  const failed = records.filter((record) => !record.ok);
  return json({
    ok: failed.length === 0,
    project_key: projectKey,
    provider: "chatdaddy",
    source: payload.source || "conversation_history_import",
    imported_count: imported.length,
    skipped_count: skipped.length,
    failed_count: failed.length,
    conversation_ids: uniqueTruthy(records.map((record) => record.conversation_id)),
    sends_messages: false,
    triggers_flows: false,
    creates_approval_cases: false,
    records
  }, failed.length ? 207 : 200);
}

async function handleHermasConversationHistorySyncChatDaddy(rawProjectKey, payload = {}, env) {
  const projectKey = normalizeProjectKey(rawProjectKey || payload.project_key || payload.projectKey || env.AGENT_PROJECT_KEY || "beyoute");
  const config = chatDaddyConfig(env);
  if (!config.apiKey || !config.accountId) {
    return json({
      ok: false,
      error: "chatdaddy_api_or_account_not_configured",
      sends_messages: false,
      triggers_flows: false,
      creates_approval_cases: false
    }, 503);
  }

  const chatId = normalizeChatDaddyToContact(firstString(
    payload.chat_id,
    payload.chatId,
    payload.contact_id,
    payload.contactId,
    payload.customer_phone,
    payload.phone,
    payload.whatsapp,
    payload.to
  ));
  if (!chatId) {
    return json({
      ok: false,
      error: "chat_id_or_contact_id_required",
      example: { chat_id: "60122752511", count: 30 },
      sends_messages: false,
      triggers_flows: false,
      creates_approval_cases: false
    }, 400);
  }

  const count = clampInteger(payload.count || payload.limit, 1, 80, 30);
  const chatDaddyResult = await fetchChatDaddyRecentMessages(config, {
    chatId,
    count,
    beforeId: payload.before_id || payload.beforeId || "",
    status: payload.status || "",
    fromMe: payload.from_me ?? payload.fromMe,
    fetchFromPlatform: payload.fetch_from_platform ?? payload.fetchFromPlatform ?? true
  });
  if (!chatDaddyResult.ok) {
    return json({
      ok: false,
      error: "chatdaddy_messages_sync_failed",
      status: chatDaddyResult.status,
      source: "chatdaddy_messages_get",
      raw_shape: chatDaddyResult.raw_shape,
      row_shape: chatDaddyResult.row_shape,
      sends_messages: false,
      triggers_flows: false,
      creates_approval_cases: false
    }, chatDaddyResult.status || 502);
  }

  const customerName = firstNonGenericContactName(
    payload.customer_name,
    payload.customerName,
    payload.display_name,
    payload.displayName,
    payload.name,
    chatDaddyResult.customer_name
  );
  const messages = normalizeChatDaddyRecentMessagesForImport(chatDaddyResult.body, {
    chatId,
    projectKey,
    customerName
  });
  if (!messages.length) {
    return json({
      ok: true,
      project_key: projectKey,
      provider: "chatdaddy",
      source: "chatdaddy_messages_sync",
      chat_id: chatId,
      fetched_count: 0,
      imported_count: 0,
      raw_shape: chatDaddyResult.raw_shape,
      row_shape: chatDaddyResult.row_shape,
      sends_messages: false,
      triggers_flows: false,
      creates_approval_cases: false,
      next: "ChatDaddy returned no importable recent messages."
    });
  }

  const importResponse = await handleHermasConversationHistoryImport(projectKey, {
    provider: "chatdaddy",
    source: "chatdaddy_messages_sync",
    chat_id: chatId,
    contact_id: chatId,
    customer_name: customerName,
    messages
  }, env);
  const importBody = await importResponse.json().catch(() => ({}));
  return json({
    ...importBody,
    source: "chatdaddy_messages_sync",
    chat_id: chatId,
    fetched_count: messages.length,
    raw_shape: chatDaddyResult.raw_shape,
    row_shape: chatDaddyResult.row_shape,
    sends_messages: false,
    triggers_flows: false,
    creates_approval_cases: false
  }, importResponse.status);
}

async function selectSupabaseRecentMessagesByConversationIds(env, projectKey, conversationIds = []) {
  if (!conversationIds.length) return [];
  const idList = conversationIds.map((id) => String(id || "").trim()).filter(Boolean).join(",");
  if (!idList) return [];
  return supabaseSelectRows(
    env,
    `messages?project_key=eq.${encodeURIComponent(projectKey)}&conversation_id=in.(${idList})&select=id,provider_message_id,text,message_at,metadata,content,customer_id,conversation_id,direction,sender_type,message_type,attachments,status,created_at&order=message_at.asc&limit=1200`
  );
}

function groupSupabaseMessagesByConversationId(rows = []) {
  const grouped = {};
  for (const row of rows || []) {
    const conversationId = String(row?.conversation_id || "").trim();
    if (!conversationId) continue;
    const list = grouped[conversationId] || [];
    list.push(supabaseMessageRowToDashboardMessage(row));
    grouped[conversationId] = list;
  }
  for (const key of Object.keys(grouped)) {
    grouped[key] = grouped[key]
      .sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0))
      .slice(-20);
  }
  return grouped;
}

function supabaseMessageRowToDashboardMessage(row = {}) {
  const direction = String(row.direction || row.sender_type || "").toLowerCase();
  const text = firstString(row.text, row.content?.text, row.content?.body, row.content?.caption);
  const messageType = firstString(row.message_type, row.content?.type, "text").toLowerCase();
  const attachments = Array.isArray(row.attachments) ? row.attachments : [];
  return {
    id: row.id || row.provider_message_id || "",
    provider_message_id: row.provider_message_id || "",
    direction: direction === "outbound" || direction === "agent" || direction === "assistant" || direction === "bot" ? "outbound" : "inbound",
    role: direction === "outbound" || direction === "agent" || direction === "assistant" || direction === "bot" ? "agent" : "customer",
    text,
    type: attachments.length && !text ? "attachment" : messageType,
    message_type: attachments.length && !text ? "attachment" : messageType,
    at: row.message_at || row.created_at || "",
    message_at: row.message_at || row.created_at || "",
    is_attachment: attachments.length > 0
  };
}

function latestVisibleCustomerMessage(messages = []) {
  const normalized = (messages || [])
    .filter((message) => {
      const direction = String(message.direction || message.role || "").toLowerCase();
      if (direction === "outbound" || direction === "agent" || direction === "assistant" || direction === "bot") return false;
      const text = firstString(message.text, message.body, message.message);
      const type = String(message.type || message.message_type || "").toLowerCase();
      return Boolean(text) || /(attachment|image|photo|file|audio|voice)/.test(type) || message.is_attachment;
    })
    .sort((a, b) => new Date(a.at || a.message_at || 0) - new Date(b.at || b.message_at || 0));
  return normalized.at(-1) || null;
}

function filterDashboardItemsByRequestedStatus(items = [], status = "pending") {
  const normalized = String(status || "pending").toLowerCase();
  if (normalized === "all") return items;
  if (["pending", "open", "needs_attention"].includes(normalized)) {
    return items.filter((item) => item.status === "pending");
  }
  if (["approval", "approvable", "needs_approval"].includes(normalized)) {
    return items.filter((item) => item.status === "pending" && item.category === "approval");
  }
  if (["human", "handoff"].includes(normalized)) {
    return items.filter((item) => item.status === "pending" && item.category === "human");
  }
  if (["order", "orders", "payment", "purchase"].includes(normalized)) {
    return items.filter((item) => item.status === "pending" && item.category === "order");
  }
  if (["auto", "records", "auto_record", "external_flow_continued"].includes(normalized)) {
    return items.filter((item) => item.status === "external_flow_continued");
  }
  if (["sent", "closed"].includes(normalized)) {
    return items.filter((item) => ["sent", "manual_resolved", "purchase_confirmed"].includes(item.status));
  }
  return items;
}

function isSafetyContradictionOrderText(text = "") {
  const lower = String(text || "").toLowerCase();
  if (!lower) return false;
  const hasDoNotDrinkBoundary = containsAny(lower, [
    "建议不要喝",
    "不要喝",
    "不能喝",
    "不适合喝",
    "不建议喝",
    "先问医生",
    "询问医生",
    "问医生",
    "ask doctor",
    "doctor first"
  ]);
  const hasOrderPushback = containsAny(lower, [
    "还下单做什么",
    "还下单",
    "下单做什么",
    "为什么还要买",
    "为什么还买",
    "还买做什么",
    "那买来做什么",
    "那下单做什么",
    "营养师都建议",
    "你们的营养师"
  ]);
  return hasDoNotDrinkBoundary && hasOrderPushback;
}

function isDrinkUsageQuestion(text = "") {
  const clean = String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return false;
  if (/(一天|每日|每天|一日).{0,8}(喝|drink|吃|服用).{0,8}(几次|幾次|多少次|berapa|how many)/i.test(clean)) return true;
  if (/(喝|drink|吃|服用).{0,8}(几次|幾次|多少次|berapa|how many)/i.test(clean)) return true;
  if (/(怎么喝|怎麼喝|如何喝|怎样喝|怎樣喝|喝法|饭前饭后|飯前飯後|餐前|餐后|餐後|before meal|after meal)/i.test(clean)) return true;
  const hasDrinkVerb = containsAny(clean, ["喝", "drink", "服用", "吃"]);
  const hasUsageSignal = containsAny(clean, ["一天", "每天", "每日", "几次", "幾次", "怎么", "怎麼", "如何", "怎样", "怎樣", "饭前", "飯前", "饭后", "飯後", "餐前", "餐后", "餐後"]);
  return hasDrinkVerb && hasUsageSignal;
}

function beyouteDrinkUsageReply() {
  return [
    "亲，一天 1 次就可以了。",
    "",
    "如果想见效快一点，也可以一天 2 次。",
    "",
    "建议选你吃最多的那一餐，餐前用 150-200ml 常温水冲泡，喝完 15-30 分钟后再吃饭。",
    "",
    "如果有吃西药或保健品，记得隔开 1-2 小时；茶或咖啡就隔开半小时哦。"
  ].join("\n");
}

function isGenericConfirmationReply(text = "") {
  return /(我明白你的问题|先根据资料帮你确认|先帮你确认清楚|再用最简单的方式回复|先让客服|客服看回上一句|避免答错)/i.test(String(text || ""));
}

function safeHandoffReplyFallback(inboundText = "", intent = "", nextAction = "") {
  const haystack = `${inboundText || ""} ${intent || ""} ${nextAction || ""}`.toLowerCase();
  const isHandoffLike = containsAny(haystack, [
    "handoff",
    "human",
    "medical",
    "health",
    "complaint",
    "refund",
    "after_sales",
    "order_payment_review",
    "payment",
    "receipt"
  ]);
  if (!isHandoffLike) return "";
  if (/(等下付款|等下付|迟点付款|遲點付款|今晚付款|later pay|pay later)/i.test(haystack)) {
    return "好的亲，没问题。你付款后把截图或汇款资料发我，我会先核对金额和订单资料，确认好再继续安排。";
  }
  if (/(付款截图|付款截圖|付款证明|付款證明|收据|收據|receipt|bank in|transfer|汇款|匯款|\[付款截图\]|\[附件\]|\[图片\]|\[image\])/i.test(haystack)) {
    return "亲，收到你的付款/汇款讯息或截图。我先核对金额和订单资料，确认好后才会继续安排。";
  }
  if (/(自取|pickup|pick up|拿货|拿貨|过去拿|過去拿|取货|取貨|店拿|门市|門市|药店|藥店|西药店|西藥店)/i.test(haystack)) {
    return "亲，可以，我先帮你确认取货/安排方式和库存。还没确认前我先不乱承诺地点，确认好再回复你。";
  }
  if (/(孕|怀孕|懷孕|哺乳|药|藥|胃酸|胃痛|胃病|糖尿|高血压|高血壓|骨髓|血小板|便秘严重|嚴重|过敏|過敏|医生|醫生|medical|health)/i.test(haystack)) {
    return "亲，这个涉及身体情况，我先不乱答。你可以把目前情况告诉我，我会按资料帮你确认适不适合；如果正在治疗或严重不舒服，建议先问医生比较安心。";
  }
  if (/(refund|退款|退货|退貨|投诉|投訴|complain|scam|骗子|騙子)/i.test(haystack)) {
    return "亲，我先了解清楚你的情况。你可以把订单资料和遇到的问题发我，我会认真核对后再处理。";
  }
  return "亲，我先把你的情况核对清楚，再给你一个准确回复。";
}

function shouldCollapseDashboardItemsForStatus(status = "") {
  const normalized = String(status || "pending").toLowerCase();
  return ["pending", "open", "needs_attention", "approval", "approvable", "needs_approval", "human", "handoff", "order", "orders", "payment", "purchase"].includes(normalized);
}

function collapseDashboardItemsByConversation(items = []) {
  const grouped = new Map();
  const passthrough = [];
  for (const item of items || []) {
    const key = dashboardConversationKey(item);
    if (!key) {
      passthrough.push(item);
      continue;
    }
    const group = grouped.get(key) || [];
    group.push(item);
    grouped.set(key, group);
  }

  for (const group of grouped.values()) {
    if (group.length === 1) {
      passthrough.push(group[0]);
      continue;
    }
    const sorted = [...group].sort((a, b) => dashboardItemTimestamp(b) - dashboardItemTimestamp(a));
    const representative = {
      ...sorted[0],
      dashboard_grouped_case_count: group.length,
      dashboard_grouped_case_ids: sorted.map((item) => item.id).filter(Boolean),
      dashboard_grouped_open_count: sorted.filter((item) => item.status === "pending").length,
      dashboard_grouped_cases: sorted.map((item) => ({
        id: item.id || "",
        status: item.status || "",
        at: item.updated_at || item.last_message_at || item.created_at || "",
        last_message: item.inbound?.text || item.last_message || "",
        action: item.action?.type || item.next_action || ""
      }))
    };
    passthrough.push(representative);
  }
  return passthrough.sort((a, b) => dashboardItemTimestamp(b) - dashboardItemTimestamp(a));
}

function dashboardConversationKey(item = {}) {
  const values = [
    item.customer?.chat_id,
    item.customer?.id,
    item.customer?.phone,
    item.inbound?.chat_id,
    item.inbound?.phone,
    item.raw?.conversation_id,
    item.raw?.case_id
  ].map((value) => String(value || "").trim()).filter(Boolean);
  const value = values.find((candidate) => !/^appr[_-]/i.test(candidate) && !/^case[_-]/i.test(candidate));
  return value ? `contact:${value}` : "";
}

function dashboardItemTimestamp(item = {}) {
  const date = new Date(item.updated_at || item.inbound?.message_at || item.last_message_at || item.created_at || 0);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function isLikelyDashboardTestItem(item = {}) {
  const text = [
    item.id,
    item.project_key,
    item.source,
    item.customer?.id,
    item.customer?.chat_id,
    item.customer?.name,
    item.customer?.display_name,
    item.inbound?.chat_id,
    item.inbound?.customer_name,
    item.inbound?.display_name,
    item.raw?.case_id,
    item.raw?.provider_case_id,
    item.raw_approval?.customer?.name,
    item.raw_approval?.inbound?.customer_name,
    item.raw_approval?.inbound?.external_customer_id
  ].map((value) => String(value || "").toLowerCase()).join(" ");
  return /(smoke\s*test|debug-contact|codex_button_selftest|selftest|test customer|mock customer|demo customer)/i.test(text);
}

async function fetchLegacyApprovalItems(request, env, projectKey) {
  const base = String(env.LEGACY_APPROVALS_API_BASE || "").trim().replace(/\/$/, "");
  const includeLegacy = new URL(request.url).searchParams.get("include_legacy");
  if (!base || !["1", "true", "yes"].includes(String(includeLegacy || "").toLowerCase())) {
    return { items: [], error: null };
  }

  try {
    const current = new URL(request.url);
    const query = new URLSearchParams(current.search);
    query.set("project_key", projectKey);
    query.delete("include_legacy");
    const legacyUrl = `${base}/api/approvals/pending?${query.toString()}`;
    const token = request.headers.get("x-staff-token")
      || request.headers.get("x-admin-token")
      || env.HERMAS_STAFF_TOKEN
      || env.STAFF_TOKEN
      || env.AGENT_STAFF_TOKEN
      || env.HERMAS_ADMIN_TOKEN
      || env.ADMIN_TOKEN
      || "";
    const response = await fetch(legacyUrl, {
      method: "GET",
      headers: withoutUndefined({
        accept: "application/json",
        "user-agent": "Hermas-Agents-Legacy-Bridge/1.0",
        "x-staff-token": token || undefined,
        "x-admin-token": token || undefined
      })
    });
    if (!response.ok) return { items: [], error: `legacy_http_${response.status}` };
    const data = await response.json();
    const items = Array.isArray(data.items)
      ? data.items
      : Array.isArray(data.approvals)
        ? data.approvals
        : Array.isArray(data.data)
          ? data.data
          : [];
    return {
      items: items.map((item) => ({
        ...item,
        source: item.source || "legacy_pilot_worker",
        legacy_source: "pilot_worker"
      })),
      error: null
    };
  } catch (error) {
    return { items: [], error: error?.message || String(error) };
  }
}

async function handleLegacyApprovalItemsImport(request, env) {
  if (!hasSupabase(env)) return json({ ok: false, error: "supabase_not_configured" }, 503);

  const payload = await readJson(request);
  const projectKey = normalizeProjectKey(payload.project_key || env.AGENT_PROJECT_KEY || "beyoute");
  const connectionId = String(payload.connection_id || "beyoute-chatdaddy").trim() || "beyoute-chatdaddy";
  const items = Array.isArray(payload.items) ? payload.items.slice(0, 250) : [];
  const previewLimit = clampInteger(payload.preview_limit, 0, 20, 0);
  if (!items.length) return json({ ok: false, error: "items_required" }, 400);

  const project = await lookupSupabaseProject(env, projectKey);
  if (!project?.id) return json({ ok: false, error: "project_not_seeded", project_key: projectKey }, 400);
  const connection = await lookupSupabaseChannelConnection(env, projectKey, connectionId);
  const baseRefs = {
    brand_id: connection?.brand_id || project?.brand_id || null,
    project_id: project.id,
    channel_connection_id: connection?.id || null
  };

  const results = [];
  for (const item of items) {
    results.push(await importLegacyApprovalItem(env, item, { projectKey, connectionId, baseRefs, previewLimit }));
  }

  const counts = results.reduce((acc, item) => {
    const key = item.status || "unknown";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  return json({
    ok: results.every((item) => item.ok || item.status === "skipped"),
    project_key: projectKey,
    received: items.length,
    imported_count: results.filter((item) => item.ok).length,
    skipped_count: results.filter((item) => item.status === "skipped").length,
    failed_count: results.filter((item) => item.status === "failed").length,
    counts,
    sends_messages: false,
    triggers_flows: false,
    results: results.slice(0, 50)
  });
}

async function handleSupabaseCaseAction(request, env, options = {}) {
  if (!hasSupabase(env)) return json({ ok: false, error: "supabase_not_configured" }, 503);

  const payload = await readJson(request);
  const projectKey = normalizeProjectKey(options.projectKey || payload.project_key || env.AGENT_PROJECT_KEY || "beyoute");
  const caseId = String(options.caseId || "").trim();
  const action = normalizeDashboardCaseActionName(options.action || payload.action);
  const dryRun = truthyValue(payload.dry_run) || truthyValue(payload.dryRun) || truthyValue(payload.previewOnly) || truthyValue(payload.testOnly);
  const operator = caseActionOperatorFromRequest(request, payload);
  const now = new Date().toISOString();

  if (!caseId) return json({ ok: false, error: "case_id_required" }, 400);
  if (!action) return json({ ok: false, error: "action_required" }, 400);

  const context = await loadSupabaseApprovalCaseContext(env, projectKey, caseId);
  if (!context.case) {
    return json({ ok: false, error: "case_not_found", project_key: projectKey, case_id: caseId }, 404);
  }

  const before = context.case;
  if (isSupabaseApprovalCaseClosed(before) && !dryRun && action !== "mark-seen") {
    return json({
      ok: true,
      already_handled: true,
      sends_messages: false,
      triggers_flows: false,
      case: approvalCaseRowToDashboardItem(before, context.refs),
      next: "这张 Case 已经处理过，不会重复发送或重复记录。"
    });
  }

  const replyText = firstString(payload.text, payload.replyText, payload.reply_message, payload.manualReplyText, before.suggested_reply, before.data?.decision?.reply_text);
  const note = firstString(payload.reason, payload.note, payload.handoff_reason);

  if (action === "approve-send") {
    const confirmedLiveSend = truthyValue(payload.confirmLiveSend) || truthyValue(payload.confirm_send);
    if (!replyText.trim()) {
      return json({ ok: false, error: "reply_text_required", sends_messages: false, triggers_flows: false }, 400);
    }
    const target = chatDaddyTargetFromCaseContext(before, context.refs);
    const preview = {
      action,
      project_key: projectKey,
      case_id: caseId,
      to: maskPublicTarget(target.value),
      target_type: target.type || "",
      text_length: replyText.length,
      sends_messages: !dryRun && confirmedLiveSend,
      triggers_flows: false
    };
    if (dryRun) {
      return json({
        ok: true,
        dry_run: true,
        preview_only: true,
        preview,
        case: approvalCaseRowToDashboardItem(before, context.refs),
        sends_messages: false,
        triggers_flows: false,
        next: "Dry-run only. Nothing was sent to ChatDaddy."
      });
    }
    if (!confirmedLiveSend) {
      return json({
        ok: false,
        blocked: true,
        preview_only: true,
        preview,
        error: "confirmLiveSend_required",
        message: "必须由客服确认发送后，系统才会发给真实顾客。",
        sends_messages: false,
        triggers_flows: false
      }, 409);
    }
    if (!target.ok) {
      return json({
        ok: false,
        blocked: true,
        error: "missing_chatdaddy_reply_target",
        message: "这张 Case 缺少真实 ChatDaddy contact/chat id，所以没有发送给顾客。",
        reason: target.reason,
        sends_messages: false,
        triggers_flows: false,
        case: approvalCaseRowToDashboardItem(before, context.refs)
      }, 409);
    }

    const sendResult = await sendSupabaseApprovalViaLegacyChatDaddy(env, {
      target: target.value,
      text: replyText,
      caseId,
      projectKey,
      providerMessageId: before.provider_case_id || context.refs.message?.provider_message_id || ""
    });
    if (!sendResult.sent) {
      await recordSupabaseCaseAction(env, {
        projectKey,
        caseId,
        operator,
        action: "approve_send_failed",
        beforeStatus: before.status,
        afterStatus: before.status,
        messageText: replyText,
        note: sendResult.reason || sendResult.error || "ChatDaddy send failed.",
        data: { send_result: sendResult }
      });
      return json({
        ok: false,
        error: "chatdaddy_send_failed",
        message: "发送失败，Case 保持待处理，没有标记已发。",
        result: publicSendResult(sendResult),
        sends_messages: false,
        triggers_flows: false,
        case: approvalCaseRowToDashboardItem(before, context.refs)
      }, 502);
    }

    const patch = {
      status: "sent",
      queue_bucket: "closed",
      suggested_reply: replyText,
      closed_at: now,
      updated_at: now,
      data: {
        ...(before.data || {}),
        final_text: replyText,
        approved_by: operator.name,
        approved_at: now,
        send_result: publicSendResult(sendResult)
      }
    };
    const updated = await patchSupabaseApprovalCase(env, caseId, patch);
    if (!updated.ok) return json({ ok: false, error: "case_update_failed", message: updated.error }, 503);
    await recordSupabaseCaseAction(env, {
      projectKey,
      caseId,
      operator,
      action: "approve_send",
      beforeStatus: before.status,
      afterStatus: "sent",
      messageText: replyText,
      data: { send_result: publicSendResult(sendResult) }
    });
    await insertSupabaseOutboundMessageForCase(env, updated.row, context.refs, {
      text: replyText,
      status: "sent",
      providerMessageId: sendResult.provider_message_id || "",
      metadata: {
        source: "dashboard_approval",
        operator_name: operator.name,
        send_result: publicSendResult(sendResult)
      }
    });
    return json({
      ok: true,
      case: approvalCaseRowToDashboardItem(updated.row, context.refs),
      item: approvalCaseRowToDashboardItem(updated.row, context.refs),
      result: publicSendResult(sendResult),
      sends_messages: true,
      triggers_flows: false,
      next: "已发送给顾客，并记录在 Dashboard。"
    });
  }

  if (action === "return-ai") {
    const patch = {
      status: "returned_ai",
      queue_bucket: "pending",
      updated_at: now,
      data: {
        ...(before.data || {}),
        returned_ai: true,
        returned_ai_by: operator.name,
        returned_ai_at: now,
        returned_ai_reason: note || "客服退回 AI 重写。"
      }
    };
    return handleNonSendingSupabaseAction(env, { dryRun, before, context, patch, projectKey, caseId, operator, action, afterStatus: "returned_ai", note, messageText: replyText });
  }

  if (action === "handoff") {
    const patch = {
      status: "handoff",
      queue_bucket: "human",
      updated_at: now,
      data: {
        ...(before.data || {}),
        handoff: true,
        handoff_by: operator.name,
        handoff_at: now,
        handoff_reason: note || "客服选择转人工。"
      }
    };
    return handleNonSendingSupabaseAction(env, { dryRun, before, context, patch, projectKey, caseId, operator, action, afterStatus: "handoff", note, messageText: "" });
  }

  if (action === "manual-resolve") {
    const manualReplyText = firstString(payload.manualReplyText, payload.final_human_reply, payload.reply_message, payload.text);
    const patch = {
      status: "manual_resolved",
      queue_bucket: "closed",
      closed_at: now,
      updated_at: now,
      data: {
        ...(before.data || {}),
        manual_resolved: true,
        manual_resolved_by: operator.name,
        manual_resolved_at: now,
        manual_reply_text: manualReplyText || null,
        final_human_reply: firstString(payload.final_human_reply, manualReplyText) || null,
        handoff_reason: payload.handoff_reason || null,
        customer_outcome: payload.customer_outcome || null,
        learning_outcome_note: payload.learning_outcome_note || null,
        learnability: payload.learnability || null,
        note: payload.note || null
      }
    };
    const response = await handleNonSendingSupabaseAction(env, { dryRun, before, context, patch, projectKey, caseId, operator, action, afterStatus: "manual_resolved", note: payload.note || "", messageText: manualReplyText });
    return response;
  }

  if (action === "mark-purchase") {
    const amount = normalizeMoneyAmount(payload.amount_rm || payload.amount || payload.total_amount);
    if (amount === null || amount <= 0) {
      return json({
        ok: false,
        error: "purchase_amount_required",
        message: "先输入真实成交金额，例如 RM 378。",
        sends_messages: false,
        triggers_flows: false
      }, 400);
    }
    const currency = firstString(payload.currency, "MYR").toUpperCase();
    const orderId = firstString(payload.order_id, payload.orderId, before.data?.order_id, before.id);
    const purchase = {
      amount_rm: amount,
      value: amount,
      currency,
      order_id: orderId,
      payment_status: firstString(payload.payment_status, payload.paymentStatus, "paid"),
      purchase_status: "confirmed",
      order_status: firstString(payload.order_status, payload.orderStatus, "confirmed"),
      confirmed_at: now,
      confirmed_by: operator.name,
      confirmed_by_id: operator.id || null,
      source: firstString(payload.source, "dashboard_mark_purchase")
    };
    const alreadySent = before.data?.meta_capi_sent === true && !truthyValue(payload.resendMetaCapi);
    if (alreadySent) {
      return json({
        ok: true,
        already_confirmed: true,
        already_sent: true,
        action,
        purchase: before.data?.purchase || purchase,
        meta_capi: before.data?.meta_capi_purchase_result || { sent: true, already_sent: true },
        case: approvalCaseRowToDashboardItem(before, context.refs),
        item: approvalCaseRowToDashboardItem(before, context.refs),
        sends_messages: false,
        triggers_flows: false,
        next: "这笔成交已经回流过广告；没有重复发送 Purchase。"
      });
    }
    if (dryRun) {
      const metaPreview = await trackSupabasePurchaseWithMetaCapi(env, before, context.refs, purchase, {
        ...payload,
        confirmMetaSend: false
      });
      return json({
        ok: true,
        dry_run: true,
        preview_only: true,
        action,
        purchase,
        meta_capi: metaPreview,
        sends_messages: false,
        triggers_flows: false,
        case: approvalCaseRowToDashboardItem(before, context.refs),
        item: approvalCaseRowToDashboardItem(before, context.refs),
        next: "Dry-run only. 没有记录成交，也没有回流广告。"
      });
    }
    const patch = {
      status: "closed",
      queue_bucket: "closed",
      closed_at: now,
      updated_at: now,
      data: {
        ...(before.data || {}),
        purchase_confirmed: true,
        purchase_confirmed_by: operator.name,
        purchase_confirmed_at: now,
        amount_rm: amount,
        order_value: amount,
        currency,
        order_id: orderId,
        purchase,
        meta_capi_sent: false,
        meta_capi_note: "Dashboard mark-paid records the payment; Purchase is sent to Meta only after confirmMetaSend=true and Meta CAPI is configured."
      }
    };
    const updated = await patchSupabaseApprovalCase(env, caseId, patch);
    if (!updated.ok) return json({ ok: false, error: "case_update_failed", message: updated.error, sends_messages: false, triggers_flows: false }, 503);
    const paymentLog = await insertSupabasePaymentForCase(env, updated.row, context.refs, { amount, currency, operator, payload, purchase });
    const metaCapi = await trackSupabasePurchaseWithMetaCapi(env, updated.row, context.refs, purchase, payload);
    const finalPatch = {
      data: {
        ...(updated.row.data || {}),
        meta_capi_sent: metaCapi.sent === true || metaCapi.deduped === true || metaCapi.already_sent === true,
        meta_capi_purchase_result: publicMetaCapiResult(metaCapi),
        meta_capi_note: metaCapi.sent
          ? "Purchase sent to Meta CAPI."
          : metaCapi.deduped || metaCapi.already_sent
            ? "Purchase already sent or deduped."
            : metaCapi.configured
              ? "Purchase recorded; Meta CAPI did not confirm send."
              : "Purchase recorded; Meta CAPI not configured on this path.",
      }
    };
    const finalUpdate = await patchSupabaseApprovalCase(env, caseId, finalPatch);
    const finalRow = finalUpdate.ok ? finalUpdate.row : updated.row;
    await recordSupabaseCaseAction(env, {
      projectKey,
      caseId,
      operator,
      action,
      beforeStatus: before.status,
      afterStatus: "closed",
      messageText: "",
      amount,
      note: "确认已付款",
      data: {
        sends_messages: false,
        triggers_flows: false,
        purchase,
        payment_log: paymentLog,
        meta_capi: publicMetaCapiResult(metaCapi)
      }
    });
    const item = approvalCaseRowToDashboardItem(finalRow, context.refs);
    return json({
      ok: true,
      action,
      case: item,
      item,
      purchase,
      payment_log: paymentLog,
      meta_capi: publicMetaCapiResult(metaCapi),
      sends_messages: false,
      triggers_flows: false,
      next: metaCapi.sent
        ? "已确认付款并回流 Meta Purchase；没有发送顾客讯息，也没有触发 Flow。"
        : metaCapi.deduped || metaCapi.already_sent
          ? "已确认付款；这笔 Purchase 已处理过，没有重复回流。"
          : metaCapi.configured
            ? "已确认付款；Meta CAPI 未确认成功，请看 meta_capi 结果。"
            : "已确认付款；Meta CAPI 还没配置，所以未回流广告。"
    });
  }

  if (action === "external-flow-continued") {
    const patch = {
      status: "auto_record",
      queue_bucket: "auto_record",
      closed_at: now,
      updated_at: now,
      data: {
        ...(before.data || {}),
        external_flow_continued: true,
        external_flow_confirmed_by: operator.name,
        external_flow_confirmed_at: now,
        external_flow_evidence: {
          provider: payload.provider || "chatdaddy",
          provider_event_type: payload.provider_event_type || "",
          provider_event_id: payload.provider_event_id || "",
          provider_flow_id: payload.provider_flow_id || "",
          provider_message_id: payload.provider_message_id || "",
          event_at: payload.event_at || "",
          evidence_note: payload.evidence_note || payload.note || ""
        }
      }
    };
    return handleNonSendingSupabaseAction(env, { dryRun, before, context, patch, projectKey, caseId, operator, action, afterStatus: "auto_record", note: payload.evidence_note || payload.note || "", messageText: "" });
  }

  if (action === "mark-seen") {
    const patch = {
      updated_at: now,
      data: {
        ...(before.data || {}),
        seen_by: operator.name,
        seen_at: now,
        seen_note: payload.note || "客服已看过。"
      }
    };
    return handleNonSendingSupabaseAction(env, { dryRun, before, context, patch, projectKey, caseId, operator, action, afterStatus: before.status, note: payload.note || "", messageText: "" });
  }

  return json({ ok: false, error: "unknown_case_action", action }, 404);
}

async function handleNonSendingSupabaseAction(env, options = {}) {
  const { dryRun, before, context, patch, projectKey, caseId, operator, action, afterStatus, note, messageText, amount } = options;
  if (dryRun) {
    return json({
      ok: true,
      dry_run: true,
      preview_only: true,
      action,
      would_update_status: afterStatus,
      sends_messages: false,
      triggers_flows: false,
      case: approvalCaseRowToDashboardItem(before, context.refs),
      next: "Dry-run only. Nothing was sent and no Dashboard record was changed."
    });
  }

  const updated = await patchSupabaseApprovalCase(env, caseId, patch);
  if (!updated.ok) return json({ ok: false, error: "case_update_failed", message: updated.error, sends_messages: false, triggers_flows: false }, 503);
  await recordSupabaseCaseAction(env, {
    projectKey,
    caseId,
    operator,
    action,
    beforeStatus: before.status,
    afterStatus,
    messageText,
    amount,
    note,
    data: {
      sends_messages: false,
      triggers_flows: false
    }
  });
  const updatedItem = approvalCaseRowToDashboardItem(updated.row, context.refs);
  return json({
    ok: true,
    action,
    case: updatedItem,
    item: updatedItem,
    sends_messages: false,
    triggers_flows: false,
    next: action === "mark-purchase"
      ? "已确认付款并记录；不会发送顾客讯息，也不会触发 Flow。"
      : "已记录；没有发送顾客讯息，也没有触发 Flow。"
  });
}

function normalizeDashboardCaseActionName(value = "") {
  const action = String(value || "").trim().toLowerCase().replace(/_/g, "-");
  const aliases = {
    approve: "approve-send",
    send: "approve-send",
    "approve-send": "approve-send",
    learn: "approve-send",
    reject: "handoff",
    handoff: "handoff",
    "return-ai": "return-ai",
    "manual-resolve": "manual-resolve",
    "manual-reply": "manual-resolve",
    "mark-purchase": "mark-purchase",
    "mark-paid": "mark-purchase",
    "mark-seen": "mark-seen",
    "external-flow-continued": "external-flow-continued"
  };
  return aliases[action] || action;
}

async function loadSupabaseApprovalCaseContext(env, projectKey, caseId) {
  const rows = await supabaseSelectRows(
    env,
    `approval_cases?project_key=eq.${encodeURIComponent(projectKey)}&id=eq.${encodeURIComponent(caseId)}&select=*&limit=1`
  );
  const row = rows[0] || null;
  if (!row) return { case: null, refs: {} };
  const customer = row.customer_id
    ? (await selectSupabaseRowsByIds(env, "customers", [row.customer_id], "id,external_customer_id,phone_e164,display_name,profile"))[0] || null
    : null;
  const message = row.trigger_message_id
    ? (await selectSupabaseRowsByIds(env, "messages", [row.trigger_message_id], "id,provider_message_id,text,message_at,metadata,content,customer_id,conversation_id,direction,sender_type,message_type,attachments,status,created_at"))[0] || null
    : null;
  const recentMessages = row.conversation_id
    ? await selectSupabaseRecentMessagesByConversationIds(env, projectKey, [row.conversation_id])
    : [];
  return {
    case: row,
    refs: {
      customer,
      message,
      recentMessages
    }
  };
}

async function patchSupabaseApprovalCase(env, caseId, patch) {
  const result = await supabasePatch(env, `approval_cases?id=eq.${encodeURIComponent(caseId)}`, patch);
  const row = Array.isArray(result.data) ? result.data[0] : null;
  if (!result.ok || !row) {
    return { ok: false, error: result.error || "approval_case_patch_failed", result };
  }
  return { ok: true, row };
}

async function recordSupabaseCaseAction(env, input = {}) {
  const payload = withoutUndefined({
    project_key: input.projectKey,
    case_id: input.caseId,
    action: input.action,
    before_status: input.beforeStatus || undefined,
    after_status: input.afterStatus || undefined,
    message_text: input.messageText || undefined,
    amount: input.amount === null || input.amount === undefined || input.amount === "" ? undefined : input.amount,
    currency: input.currency || "MYR",
    note: input.note || undefined,
    data: {
      operator_name: input.operator?.name || "",
      operator_role: input.operator?.role || "staff",
      ...(input.data || {})
    }
  });
  return supabaseInsert(env, "case_actions", payload);
}

async function insertSupabaseOutboundMessageForCase(env, row = {}, refs = {}, input = {}) {
  if (!input.text) return { attempted: false, skipped: true, reason: "empty_text" };
  return supabaseInsert(env, "messages", withoutUndefined({
    project_key: row.project_key,
    conversation_id: row.conversation_id || undefined,
    customer_id: row.customer_id || undefined,
    direction: "outbound",
    sender_type: "staff",
    provider: row.provider || "chatdaddy",
    provider_message_id: input.providerMessageId || undefined,
    text: input.text,
    message_type: "text",
    attachments: [],
    content: {
      text: input.text
    },
    status: input.status || "recorded",
    message_at: new Date().toISOString(),
    metadata: {
      ...(input.metadata || {}),
      trigger_message_id: row.trigger_message_id || null,
      customer_external_id: refs.customer?.external_customer_id || null
    }
  }));
}

async function insertSupabasePaymentForCase(env, row = {}, refs = {}, input = {}) {
  const amount = normalizeMoneyAmount(input.amount);
  return supabaseInsert(env, "payments", withoutUndefined({
    project_key: row.project_key,
    customer_id: row.customer_id || undefined,
    conversation_id: row.conversation_id || undefined,
    case_id: row.id,
    amount: amount === null ? undefined : amount,
    currency: input.currency || "MYR",
    status: "confirmed",
    evidence_type: "dashboard_staff_confirmed",
    confirmed_at: new Date().toISOString(),
    data: {
      source: "dashboard_mark_purchase",
      operator_name: input.operator?.name || "",
      order_id: firstString(input.payload?.order_id, input.payload?.orderId),
      purchase: input.purchase || undefined,
      meta_capi_sent: false
    }
  }));
}

const META_CAPI_EVENT_MAP = [
  { key: "whatsapp_message_received", meta_event: "Lead", when: "顾客第一次或普通 WhatsApp 讯息进来" },
  { key: "qualified_lead", meta_event: "Lead", when: "顾客点按钮、进 Flow、问价格或被标记为 qualified/hot lead" },
  { key: "price_or_payment_step_reached", meta_event: "ViewContent", when: "顾客到达价格 / Payment Flow，开始进入成交阶段" },
  { key: "order_submitted", meta_event: "InitiateCheckout", when: "顾客提交下单资料或 AI 判断可以收单" },
  { key: "payment_receipt_uploaded", meta_event: "AddPaymentInfo", when: "顾客上传 receipt / payment proof" },
  { key: "payment_confirmed", meta_event: "Purchase", when: "付款确认或 COD 订单确认" }
];

async function metaCapiPublicStatus(env, origin = "", projectKey = "") {
  const project = normalizeProjectKey(projectKey || env.AGENT_PROJECT_KEY || "beyoute");
  const local = await metaCapiConfigForProject(env, project);
  const legacy = !local.configured ? await fetchLegacyMetaCapiStatus(env) : null;
  const delegated = !local.configured && legacy?.configured === true;
  return {
    project_key: project,
    configured: local.configured || delegated,
    mode: local.configured ? local.source || "direct" : delegated ? "legacy_delegate" : "not_configured",
    direct_configured: local.configured,
    project_connection_configured: local.source === "project_ads_connection" && local.configured,
    project_connection_status: local.projectStatus || "",
    vault_key_configured: adsVaultConfigured(env),
    vault_key_required: local.vaultRequired === true,
    vault_key_missing: local.vaultMissing === true,
    legacy_delegate_configured: Boolean(delegated),
    legacy_delegate_status: withoutUndefined({
      checked: Boolean(legacy),
      configured: legacy?.configured === true,
      status: legacy?.status,
      reason: legacy?.reason,
      attempts: legacy?.attempts
    }),
    auto_track_enabled: local.autoTrack,
    purchase_auto_track_enabled: local.purchaseAutoTrack,
    pixel_id: local.pixelId ? redactSecret(local.pixelId) : legacy?.pixel_id || "",
    graph_version: local.graphVersion || legacy?.graph_version || "v23.0",
    test_event_code_configured: Boolean(local.testEventCode || legacy?.test_event_code_configured),
    access_token_configured: Boolean(local.accessToken || legacy?.access_token_configured),
    access_token_last4: local.accessTokenLast4 || "",
    page_id_configured: Boolean(local.pageId || legacy?.page_id_configured),
    endpoint: local.pixelId
      ? local.endpoint.replace(local.pixelId, redactSecret(local.pixelId))
      : legacy?.endpoint || local.endpoint,
    dashboard_endpoint: origin ? `${origin}/api/meta-capi/status?project_key=${encodeURIComponent(project)}` : "/api/meta-capi/status",
    test_endpoint: origin ? `${origin}/api/meta-capi/test` : "/api/meta-capi/test",
    safe_default: "默认不会自动追 Lead/Flow；Dashboard 只有确认付款或 COD 订单，并带 confirmMetaSend=true，才会发 Purchase。"
  };
}

function metaCapiConfig(env) {
  const pixelId = String(env.META_CAPI_PIXEL_ID || env.META_PIXEL_ID || "").trim();
  const accessToken = String(env.META_CAPI_ACCESS_TOKEN || env.META_ACCESS_TOKEN || "").trim();
  const pageId = String(env.META_CAPI_PAGE_ID || env.META_PAGE_ID || "").trim();
  const graphVersion = String(env.META_CAPI_GRAPH_VERSION || env.META_GRAPH_VERSION || "v23.0").trim() || "v23.0";
  const endpoint = String(env.META_CAPI_ENDPOINT || "").trim() ||
    (pixelId ? `https://graph.facebook.com/${encodeURIComponent(graphVersion)}/${encodeURIComponent(pixelId)}/events` : `https://graph.facebook.com/${encodeURIComponent(graphVersion)}/{pixel_id}/events`);
  return {
    configured: Boolean(pixelId && accessToken),
    source: "env",
    pixelId,
    accessToken,
    pageId,
    graphVersion,
    endpoint,
    testEventCode: String(env.META_CAPI_TEST_EVENT_CODE || "").trim(),
    autoTrack: truthyValue(env.META_CAPI_AUTO_TRACK),
    purchaseAutoTrack: truthyValue(env.META_CAPI_PURCHASE_AUTO_TRACK)
  };
}

async function metaCapiConfigForProject(env, projectKey = "") {
  const fallback = metaCapiConfig(env);
  const project = normalizeProjectKey(projectKey || env.AGENT_PROJECT_KEY || "beyoute");
  if (!hasSupabase(env) || !project) return fallback;

  const result = await selectProjectAdsConnection(env, project);
  const row = result.row || null;
  if (!row) return fallback;

  const hasProjectSettings = Boolean(
    row.pixel_id ||
    row.dataset_id ||
    row.page_id ||
    row.access_token_ciphertext ||
    row.access_token_configured
  );
  if (!hasProjectSettings) return fallback;

  const pixelId = firstString(row.pixel_id, row.dataset_id);
  const graphVersion = firstString(row.graph_version, fallback.graphVersion, "v23.0");
  const endpoint = pixelId
    ? `https://graph.facebook.com/${encodeURIComponent(graphVersion)}/${encodeURIComponent(pixelId)}/events`
    : `https://graph.facebook.com/${encodeURIComponent(graphVersion)}/{pixel_id}/events`;
  let accessToken = "";
  let tokenError = "";
  if (row.access_token_ciphertext && row.access_token_iv) {
    if (!adsVaultConfigured(env)) {
      tokenError = "ads_vault_key_missing";
    } else {
      const decrypted = await decryptAdsSecret(env, row.access_token_ciphertext, row.access_token_iv);
      if (decrypted.ok) accessToken = decrypted.value;
      else tokenError = decrypted.error || "ads_token_decrypt_failed";
    }
  }

  return {
    ...fallback,
    configured: Boolean(pixelId && accessToken),
    source: "project_ads_connection",
    projectKey: project,
    projectStatus: row.status || "",
    pixelId,
    accessToken,
    accessTokenLast4: row.access_token_last4 || "",
    pageId: firstString(row.page_id, fallback.pageId),
    graphVersion,
    endpoint,
    testEventCode: firstString(row.test_event_code, fallback.testEventCode),
    autoTrack: truthyValue(row.auto_track_enabled),
    purchaseAutoTrack: truthyValue(row.purchase_auto_track_enabled),
    vaultRequired: Boolean(row.access_token_ciphertext || row.access_token_configured),
    vaultMissing: Boolean(tokenError === "ads_vault_key_missing"),
    tokenError
  };
}

async function selectProjectAdsConnection(env, projectKey = "") {
  if (!hasSupabase(env)) return { ok: false, row: null, error: "supabase_not_configured" };
  const project = normalizeProjectKey(projectKey || "");
  if (!project) return { ok: false, row: null, error: "project_key_required" };
  const result = await supabaseSelectResult(
    env,
    `project_ads_connections?project_key=eq.${encodeURIComponent(project)}&provider=eq.meta_capi&select=*&limit=1`
  );
  if (!result.ok) return { ok: false, row: null, error: result.error || "project_ads_connection_select_failed", status: result.status };
  return { ok: true, row: result.data?.[0] || null };
}

async function handleAdminAdsConnection(request, env, options = {}) {
  const projectKey = normalizeProjectKey(options.projectKey || env.AGENT_PROJECT_KEY || "beyoute");
  const auth = await requireAdminAccess(request, env, { projectKey });
  if (!auth.ok) return auth.response;
  if (!hasSupabase(env)) {
    return json({
      ok: false,
      error: "supabase_not_configured",
      message: "还没接 Supabase，不能保存项目级广告回流。"
    }, 503);
  }

  if (options.subAction === "test") {
    if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
    const payload = await readJson(request);
    const wantsLiveSend = truthyValue(payload.confirmMetaSend) || truthyValue(payload.confirm_send);
    const config = await metaCapiConfigForProject(env, projectKey);
    const event = await buildMetaCapiEventFromInput(env, {
      event_name: payload.event_name || "Purchase",
      event_key: payload.event_key || "admin_ads_connection_test",
      project_key: projectKey,
      value: payload.value || payload.amount_rm || 1,
      currency: payload.currency || "MYR",
      order_id: payload.order_id || `test_${Date.now()}`,
      external_id: payload.external_id || `admin-test:${projectKey}:${Date.now()}`,
      phone: payload.phone || "",
      custom_data: {
        ...(payload.custom_data || {}),
        project_key: projectKey,
        source: "admin_ads_connection_test"
      }
    }, request);
    const result = await sendMetaCapiEvent(env, event, {
      confirmMetaSend: wantsLiveSend,
      source: "admin_ads_connection_test",
      config,
      allowLegacyDelegate: false
    });
    await patchProjectAdsConnectionTestResult(env, projectKey, result);
    return json({
      ok: wantsLiveSend ? result.sent === true : true,
      sent: result.sent === true,
      preview_only: result.preview_only === true,
      event,
      result: publicMetaCapiResult(result),
      ads_connection: publicProjectAdsConnection((await selectProjectAdsConnection(env, projectKey)).row, env),
      next: result.sent
        ? "测试 Purchase 已发送；去 Meta Events Manager 的 Test Events 看。"
        : result.preview_only
          ? "这是预览，未发送。按正式测试才会发一笔测试事件。"
          : "测试没有成功，请检查 Pixel ID / Token / Test Event Code。"
    }, wantsLiveSend && !result.sent ? 502 : 200);
  }

  if (request.method === "GET") {
    const selected = await selectProjectAdsConnection(env, projectKey);
    if (!selected.ok) {
      return json({
        ok: false,
        error: "ads_connection_table_missing",
        message: "Supabase 还没建立广告回流表。请先跑 project_ads_connections migration。",
        details: selected.error || ""
      }, 503);
    }
    return json({
      ok: true,
      ads_connection: publicProjectAdsConnection(selected.row, env),
      meta_capi: await metaCapiPublicStatus(env, new URL(request.url).origin, projectKey),
      next: "Admin 在这里保存一次，客服确认付款时就会按项目自动回流 Purchase。"
    });
  }

  const payload = await readJson(request);
  const saved = await saveProjectAdsConnection(env, projectKey, payload, auth.auth);
  if (!saved.ok) return json(saved, saved.status || 400);
  return json({
    ok: true,
    ads_connection: publicProjectAdsConnection(saved.row, env),
    meta_capi: await metaCapiPublicStatus(env, new URL(request.url).origin, projectKey),
    next: "广告回流设置已保存；默认仍是 approval-first，不会开启自动发送。"
  });
}

async function saveProjectAdsConnection(env, projectKey = "", payload = {}, auth = {}) {
  const selected = await selectProjectAdsConnection(env, projectKey);
  if (!selected.ok) {
    return {
      ok: false,
      status: 503,
      error: "ads_connection_table_missing",
      message: "Supabase 还没建立广告回流表。请先跑 project_ads_connections migration。",
      details: selected.error || ""
    };
  }
  const existing = selected.row || {};
  const tokenInput = firstString(payload.access_token, payload.accessToken).trim();
  const clearToken = truthyValue(payload.clear_access_token) || truthyValue(payload.clearAccessToken);
  const pixelId = firstString(payload.pixel_id, payload.pixelId, payload.dataset_id, payload.datasetId, existing.pixel_id).trim();
  const graphVersion = firstString(payload.graph_version, payload.graphVersion, existing.graph_version, env.META_CAPI_GRAPH_VERSION, "v23.0").trim();
  const now = new Date().toISOString();
  const row = withoutUndefined({
    project_key: projectKey,
    provider: "meta_capi",
    status: "not_configured",
    pixel_id: pixelId || null,
    dataset_id: pixelId || null,
    page_id: firstString(payload.page_id, payload.pageId, existing.page_id).trim() || null,
    ad_account_id: firstString(payload.ad_account_id, payload.adAccountId, existing.ad_account_id).trim() || null,
    graph_version: graphVersion || "v23.0",
    test_event_code: firstString(payload.test_event_code, payload.testEventCode, existing.test_event_code).trim() || null,
    auto_track_enabled: truthyValue(payload.auto_track_enabled) || truthyValue(payload.autoTrackEnabled),
    purchase_auto_track_enabled: truthyValue(payload.purchase_auto_track_enabled) || truthyValue(payload.purchaseAutoTrackEnabled),
    updated_at: now,
    updated_by: auth.user_id || auth.subject || auth.display_name || null,
    data: {
      ...(existing.data || {}),
      managed_from: "hermas_admin_dashboard",
      safe_default: "approval_first",
      updated_by: auth.display_name || auth.subject || "admin"
    }
  });

  if (!existing.id) row.created_at = now;
  if (clearToken) {
    row.access_token_ciphertext = null;
    row.access_token_iv = null;
    row.access_token_configured = false;
    row.access_token_last4 = null;
  } else if (tokenInput) {
    if (!adsVaultConfigured(env)) {
      return {
        ok: false,
        status: 400,
        error: "ads_vault_key_missing",
        message: "还没设置 HERMAS_ADS_VAULT_KEY。先设置一次 Worker 加密钥，之后 20 个品牌都能在 Admin 页面保存。"
      };
    }
    const encrypted = await encryptAdsSecret(env, tokenInput);
    if (!encrypted.ok) {
      return { ok: false, status: 500, error: "ads_token_encrypt_failed", message: encrypted.error || "Token 加密失败。" };
    }
    row.access_token_ciphertext = encrypted.ciphertext;
    row.access_token_iv = encrypted.iv;
    row.access_token_key_version = "v1";
    row.access_token_configured = true;
    row.access_token_last4 = tokenInput.slice(-4);
  }

  const tokenConfigured = clearToken
    ? false
    : Boolean(tokenInput || existing.access_token_configured || existing.access_token_ciphertext);
  row.status = pixelId && tokenConfigured ? "active" : "not_configured";

  const result = await supabaseUpsert(env, "project_ads_connections", row, "project_key");
  if (!result.ok) {
    return {
      ok: false,
      status: result.status || 500,
      error: "ads_connection_save_failed",
      message: result.error || "保存广告回流失败。"
    };
  }
  return { ok: true, row: result.data?.[0] || row };
}

async function patchProjectAdsConnectionTestResult(env, projectKey = "", result = {}) {
  if (!hasSupabase(env) || !projectKey) return null;
  return supabasePatch(
    env,
    `project_ads_connections?project_key=eq.${encodeURIComponent(projectKey)}&provider=eq.meta_capi`,
    {
      last_test_at: new Date().toISOString(),
      last_test_status: result.sent ? "sent" : result.preview_only ? "preview" : "failed",
      last_test_result: publicMetaCapiResult(result),
      updated_at: new Date().toISOString()
    }
  );
}

function publicProjectAdsConnection(row = null, env = {}) {
  if (!row) {
    return {
      configured: false,
      status: "not_configured",
      provider: "meta_capi",
      vault_key_configured: adsVaultConfigured(env),
      access_token_configured: false,
      safe_default: "approval_first"
    };
  }
  return {
    project_key: row.project_key || "",
    provider: row.provider || "meta_capi",
    configured: Boolean(row.pixel_id && row.access_token_configured),
    status: row.status || "not_configured",
    pixel_id: row.pixel_id || "",
    page_id: row.page_id || "",
    ad_account_id: row.ad_account_id || "",
    graph_version: row.graph_version || "v23.0",
    test_event_code_configured: Boolean(row.test_event_code),
    access_token_configured: Boolean(row.access_token_configured),
    access_token_last4: row.access_token_last4 || "",
    auto_track_enabled: truthyValue(row.auto_track_enabled),
    purchase_auto_track_enabled: truthyValue(row.purchase_auto_track_enabled),
    last_test_at: row.last_test_at || null,
    last_test_status: row.last_test_status || "",
    last_test_result: publicMetaCapiResult(row.last_test_result || {}),
    vault_key_configured: adsVaultConfigured(env),
    safe_default: "approval_first"
  };
}

async function fetchLegacyMetaCapiStatus(env) {
  const bases = legacyMetaCapiBases(env);
  if (!bases.length) return { configured: false, reason: "legacy_base_missing" };
  const attempts = [];
  for (const base of bases) {
    try {
      const response = await fetch(`${base}/api/meta-capi/status`, {
        headers: {
          accept: "application/json",
          "user-agent": "Hermas-Agents-Meta-Status/1.0"
        }
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data?.ok) {
        return { ...(data.meta_capi || {}), status: response.status, base_host: new URL(base).host };
      }
      attempts.push({
        base_host: safeUrlHost(base),
        status: response.status,
        reason: data?.error || data?.message || "legacy_status_not_ok",
        version: data?.version || data?.runtime || ""
      });
    } catch {
      attempts.push({ base_host: safeUrlHost(base), status: 0, reason: "legacy_status_fetch_failed" });
    }
  }
  return { configured: false, status: attempts[0]?.status || 0, reason: attempts[0]?.reason || "legacy_status_not_ok", attempts };
}

async function handleMetaCapiTest(request, env) {
  const url = new URL(request.url);
  const payload = await readJson(request);
  const projectKey = normalizeProjectKey(payload.project_key || url.searchParams.get("project_key") || env.AGENT_PROJECT_KEY || "beyoute");
  const wantsLiveSend = truthyValue(payload.confirmMetaSend) || truthyValue(payload.confirm_send);
  if (wantsLiveSend) {
    const auth = await requireAdminAccess(request, env, { projectKey });
    if (!auth.ok) return auth.response;
  }
  const event = await buildMetaCapiEventFromInput(env, { ...payload, project_key: projectKey }, request);
  const config = await metaCapiConfigForProject(env, projectKey);
  const result = await sendMetaCapiEvent(env, event, {
    confirmMetaSend: wantsLiveSend,
    source: "manual_meta_capi_test",
    config,
    allowLegacyDelegate: true
  });
  return json({
    ok: wantsLiveSend ? result.sent === true || result.deduped === true || result.already_sent === true : true,
    sent: result.sent === true,
    event,
    result,
    next: result.sent
      ? "Meta CAPI test sent. Check Meta Events Manager > Test Events."
      : result.preview_only
        ? "Preview only. Pass confirmMetaSend=true with admin token to send one test event."
        : "Meta CAPI test did not confirm send; check configuration/result."
  }, wantsLiveSend && !result.sent && !result.deduped && !result.already_sent ? 502 : 200);
}

async function trackSupabasePurchaseWithMetaCapi(env, row = {}, refs = {}, purchase = {}, payload = {}) {
  const wantsLiveSend = truthyValue(payload.confirmMetaSend) ||
    truthyValue(payload.confirm_send) ||
    truthyValue(payload.send_to_meta) ||
    truthyValue(payload.sendToMeta);
  const event = await buildPurchaseMetaCapiEvent(env, row, refs, purchase, payload);
  const config = await metaCapiConfigForProject(env, row.project_key || payload.project_key || env.AGENT_PROJECT_KEY || "beyoute");
  return sendMetaCapiEvent(env, event, {
    confirmMetaSend: wantsLiveSend,
    source: "dashboard_purchase_confirmed",
    config,
    allowLegacyDelegate: true
  });
}

async function buildPurchaseMetaCapiEvent(env, row = {}, refs = {}, purchase = {}, payload = {}) {
  const customer = refs.customer || {};
  const data = row.data || {};
  const customFields = {
    ...(data.custom_fields || {}),
    ...(payload.custom_fields || {}),
    amount_rm: purchase.amount_rm,
    order_value: purchase.value,
    value: purchase.value,
    currency: purchase.currency,
    order_id: purchase.order_id,
    payment_status: purchase.payment_status,
    purchase_status: purchase.purchase_status,
    order_status: purchase.order_status,
    project_key: row.project_key || payload.project_key || env.AGENT_PROJECT_KEY || "beyoute"
  };
  return buildMetaCapiEvent({
    env,
    eventName: "Purchase",
    eventKey: "payment_confirmed",
    projectKey: row.project_key || payload.project_key || env.AGENT_PROJECT_KEY || "beyoute",
    eventId: `purchase_${row.project_key || "project"}_${row.id || "case"}_${purchase.order_id || "order"}`.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 120),
    phone: firstString(payload.phone, customer.phone_e164, data.phone_e164, data.customer_phone),
    externalId: firstString(payload.external_id, payload.externalId, customer.external_customer_id, customer.id, row.customer_id, row.id),
    fbp: firstString(payload.fbp, customFields.fbp),
    fbc: firstString(payload.fbc, customFields.fbc, customFields.ctwa_clid),
    userAgent: firstString(payload.user_agent, payload.userAgent),
    customData: {
      currency: purchase.currency,
      value: purchase.value,
      order_id: purchase.order_id,
      content_name: firstString(payload.content_name, payload.contentName, data.product_name, row.project_key, "WhatsApp Purchase"),
      conversion_stage: "purchase_confirmed",
      status: "purchase_confirmed",
      project_key: row.project_key || payload.project_key || env.AGENT_PROJECT_KEY || "beyoute"
    }
  });
}

async function buildMetaCapiEventFromInput(env, payload = {}, request = null) {
  const customFields = {
    ...(payload.custom_fields || {}),
    ...(payload.customData || {}),
    ...(payload.custom_data || {})
  };
  const eventName = firstString(payload.event_name, payload.eventName, payload.meta_event_name, "Lead");
  const eventKey = firstString(payload.event_key, payload.eventKey, "manual_test");
  const value = normalizeMoneyAmount(firstString(payload.value, payload.order_value, payload.amount_rm, customFields.value, customFields.order_value));
  const customData = {
    ...(payload.custom_data || {}),
    ...(payload.customData || {}),
    currency: firstString(payload.currency, customFields.currency, "MYR")
  };
  if (value !== null) customData.value = value;
  if (firstString(payload.order_id, payload.orderId, customFields.order_id)) {
    customData.order_id = firstString(payload.order_id, payload.orderId, customFields.order_id);
  }
  return buildMetaCapiEvent({
    env,
    eventName,
    eventKey,
    projectKey: normalizeProjectKey(payload.project_key || env.AGENT_PROJECT_KEY || "beyoute"),
    eventId: firstString(payload.event_id, payload.eventId, `${eventKey}_${Date.now()}`),
    phone: firstString(payload.phone, payload.phone_e164),
    externalId: firstString(payload.external_id, payload.externalId, payload.customer_id, payload.contact_id, payload.name),
    fbp: firstString(payload.fbp, customFields.fbp),
    fbc: firstString(payload.fbc, customFields.fbc, customFields.ctwa_clid),
    userAgent: firstString(payload.user_agent, payload.userAgent, request?.headers?.get?.("user-agent")),
    customData
  });
}

async function buildMetaCapiEvent(input = {}) {
  const delegateInput = {
    phone: normalizePhoneDigits(input.phone),
    external_id: firstString(input.externalId),
    fbp: firstString(input.fbp),
    fbc: firstString(input.fbc),
    user_agent: firstString(input.userAgent)
  };
  const event = {
    event_name: input.eventName || "Lead",
    event_time: Math.floor(Date.now() / 1000),
    event_id: String(input.eventId || crypto.randomUUID()).replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 120),
    action_source: "business_messaging",
    user_data: {},
    custom_data: withoutUndefined(input.customData || {}),
    _delegate_input: withoutUndefined(delegateInput)
  };
  const phone = delegateInput.phone;
  if (phone) event.user_data.ph = [await sha256Hex(phone)];
  if (input.externalId) event.user_data.external_id = [await sha256Hex(String(input.externalId))];
  if (input.fbp) event.user_data.fbp = input.fbp;
  if (input.fbc) event.user_data.fbc = input.fbc;
  if (input.userAgent) event.user_data.client_user_agent = input.userAgent;
  if (!Object.keys(event.user_data).length) {
    event.user_data.external_id = [await sha256Hex(`${input.projectKey || "project"}:${event.event_id}`)];
  }
  return event;
}

async function sendMetaCapiEvent(env, event = {}, options = {}) {
  const config = options.config || metaCapiConfig(env);
  const wantsLiveSend = options.confirmMetaSend === true;
  const outboundEvent = stripPrivateMetaCapiEventFields(event);
  const payload = {
    data: [outboundEvent],
    ...(config.testEventCode ? { test_event_code: config.testEventCode } : {})
  };
  if (!wantsLiveSend) {
    const legacy = options.allowLegacyDelegate === false ? null : await fetchLegacyMetaCapiStatus(env);
    return {
      configured: config.configured || legacy?.configured === true,
      sent: false,
      preview_only: true,
      event_name: event.event_name,
      event_id: event.event_id,
      mode: config.source || "preview",
      reason: "confirmMetaSend=true is required to send to Meta.",
      payload_preview: publicMetaCapiPayload(payload)
    };
  }
  if (config.configured) {
    return sendMetaCapiPayloadDirect(config, payload, event);
  }
  if (options.allowLegacyDelegate) {
    const delegated = await sendMetaCapiViaLegacyWorker(env, event);
    if (delegated.attempted) return delegated;
  }
  return {
    configured: false,
    sent: false,
    preview_only: true,
    event_name: event.event_name,
    event_id: event.event_id,
    reason: "META_CAPI_PIXEL_ID and META_CAPI_ACCESS_TOKEN are required, and legacy delegate did not send."
  };
}

async function sendMetaCapiPayloadDirect(config, payload, event = {}) {
  const endpoint = new URL(config.endpoint);
  endpoint.searchParams.set("access_token", config.accessToken);
  try {
    const response = await fetch(endpoint.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const bodyText = await response.text();
    return {
      configured: true,
      sent: response.ok,
      status: response.status,
      event_name: event.event_name,
      event_id: event.event_id,
      mode: "direct",
      body: compactError(bodyText)
    };
  } catch (error) {
    return {
      configured: true,
      sent: false,
      status: 0,
      event_name: event.event_name,
      event_id: event.event_id,
      mode: "direct",
      error: compactError(error.message || String(error))
    };
  }
}

async function sendMetaCapiViaLegacyWorker(env, event = {}) {
  const bases = legacyMetaCapiBases(env);
  const adminToken = String(env.AGENT_RUNTIME_ADMIN_TOKEN || env.HERMAS_ADMIN_TOKEN || env.ADMIN_TOKEN || "").trim();
  if (!bases.length) {
    return { attempted: false, configured: false, sent: false, reason: "legacy_meta_capi_worker_not_configured" };
  }
  if (!adminToken) {
    return { attempted: true, configured: false, sent: false, mode: "legacy_delegate", reason: "legacy_meta_capi_admin_token_missing" };
  }
  const attempts = [];
  for (const base of bases) {
    try {
      const response = await fetch(`${base}/api/meta-capi/test`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "x-admin-token": adminToken,
          "user-agent": "Hermas-Agents-Meta-Delegate/1.0"
        },
        body: JSON.stringify({
          event_name: event.event_name,
          event_key: event.event_name === "Purchase" ? "payment_confirmed" : "manual_delegate",
          event_id: event.event_id,
          phone: event._delegate_input?.phone || "",
          external_id: event._delegate_input?.external_id || "",
          fbp: event._delegate_input?.fbp || "",
          fbc: event._delegate_input?.fbc || "",
          user_agent: event._delegate_input?.user_agent || "",
          custom_data: event.custom_data || {},
          confirmMetaSend: true
        })
      });
      const data = await response.json().catch(() => ({}));
      const result = data.result || data;
      const sent = data.sent === true || data.ok === true || result.sent === true;
      const output = {
        attempted: true,
        configured: true,
        sent,
        status: response.status,
        event_name: event.event_name,
        event_id: event.event_id,
        mode: "legacy_delegate",
        base_host: safeUrlHost(base),
        result: publicMetaCapiResult(result),
        reason: data.next || result.reason || data.error || ""
      };
      if (sent || response.ok) return output;
      attempts.push(output);
    } catch (error) {
      attempts.push({
        attempted: true,
        configured: true,
        sent: false,
        status: 0,
        event_name: event.event_name,
        event_id: event.event_id,
        mode: "legacy_delegate",
        base_host: safeUrlHost(base),
        error: compactError(error.message || String(error))
      });
    }
  }
  return attempts[0] || { attempted: true, configured: false, sent: false, mode: "legacy_delegate", reason: "legacy_delegate_failed" };
}

function publicMetaCapiResult(result = {}) {
  return withoutUndefined({
    configured: result.configured,
    attempted: result.attempted,
    sent: result.sent === true,
    deduped: result.deduped === true,
    already_sent: result.already_sent === true,
    preview_only: result.preview_only === true,
    status: result.status,
    event_name: result.event_name,
    event_id: result.event_id,
    mode: result.mode,
    reason: result.reason,
    error: result.error,
    result: result.result ? publicMetaCapiResult(result.result) : undefined
  });
}

function publicMetaCapiPayload(payload = {}) {
  const copy = JSON.parse(JSON.stringify(payload || {}));
  if (copy.access_token) copy.access_token = redactSecret(copy.access_token);
  return copy;
}

function stripPrivateMetaCapiEventFields(event = {}) {
  const { _delegate_input, ...publicEvent } = event || {};
  return publicEvent;
}

function legacyMetaCapiBases(env) {
  return uniqueTruthy([
    env.LEGACY_APPROVALS_API_BASE,
    "https://ctg-chatdaddy-pilot-worker.jiazhen-theadspert.workers.dev"
  ])
    .map((value) => String(value || "").trim().replace(/\/+$/, "").replace(/\/api$/i, ""))
    .filter(Boolean);
}

function safeUrlHost(value = "") {
  try {
    return new URL(value).host;
  } catch {
    return "";
  }
}

function normalizePhoneDigits(value = "") {
  const digits = String(value || "").replace(/\D+/g, "");
  return digits.length >= 8 ? digits : "";
}

function redactSecret(value = "") {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 8) return "****";
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

async function sendSupabaseApprovalViaLegacyChatDaddy(env, input = {}) {
  const base = String(env.LEGACY_APPROVALS_API_BASE || "").trim().replace(/\/$/, "");
  if (!base) {
    return { sent: false, reason: "legacy_chatdaddy_adapter_not_configured" };
  }
  try {
    const response = await fetch(`${base}/api/channels/chatdaddy/action`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Hermas-Agents-Live-Approval/1.0"
      },
      body: JSON.stringify({
        action: "send_message",
        force_live: true,
        to: input.target,
        contactId: input.target,
        text: input.text,
        parameters: {
          idempotencyId: `agents:${input.projectKey}:${input.caseId}:approve-send`,
          originalId: input.providerMessageId || input.caseId,
          source: "hermas_agents_dashboard"
        }
      })
    });
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { body: text };
    }
    const result = data.result || data;
    const mode = result.mode || data.provider || "legacy_chatdaddy_adapter";
    return {
      sent: Boolean(response.ok && (result.sent || data.ok) && mode !== "mock"),
      status: response.status,
      provider_message_id: result.provider_message_id || data.provider_message_id || "",
      reason: mode === "mock" ? "Legacy ChatDaddy adapter is still in mock mode." : (result.reason || data.error || ""),
      mode
    };
  } catch (error) {
    return { sent: false, error: error?.message || String(error) };
  }
}

function chatDaddyTargetFromCaseContext(row = {}, refs = {}) {
  const normalized = row.data?.normalized || {};
  const customer = refs.customer || {};
  const message = refs.message || {};
  const dataCustomer = row.data?.customer || {};
  const candidates = [
    normalized.external_conversation_id,
    normalized.external_customer_id,
    customer.external_customer_id,
    customer.profile?.external_conversation_id,
    customer.profile?.external_customer_id,
    dataCustomer.chat_id,
    dataCustomer.id,
    dataCustomer.phone,
    message.metadata?.external_conversation_id,
    message.metadata?.external_customer_id,
    message.content?.external_conversation_id,
    message.content?.external_customer_id,
    refs.recentMessages?.at?.(-1)?.metadata?.external_conversation_id,
    refs.recentMessages?.at?.(-1)?.metadata?.external_customer_id,
    customer.phone_e164
  ];
  for (const candidate of candidates) {
    const value = normalizeChatDaddyTarget(candidate);
    if (isSafeChatDaddyTarget(value)) {
      return { ok: true, value, type: value.replace(/\D/g, "").length >= 8 ? "phone_or_chat_id" : "chat_id" };
    }
  }
  return { ok: false, value: "", reason: "No safe ChatDaddy contact/chat id found on the case." };
}

function normalizeChatDaddyTarget(value) {
  return String(value || "").trim().replace(/\s+/g, "");
}

function isSafeChatDaddyTarget(value = "") {
  const text = normalizeChatDaddyTarget(value);
  if (!text) return false;
  if (/^(legacy:|appr_|case_|debug|demo|mock|test)/i.test(text)) return false;
  if (/(contact-fix|debug|demo|mock|test|selftest)/i.test(text)) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) return false;
  const digits = text.replace(/\D/g, "");
  if (digits.length >= 8) return true;
  return /^[A-Za-z0-9_.@:-]{8,}$/.test(text);
}

function publicSendResult(result = {}) {
  return withoutUndefined({
    sent: Boolean(result.sent),
    status: result.status,
    provider_message_id: result.provider_message_id || undefined,
    mode: result.mode || undefined,
    reason: result.reason || result.error || undefined
  });
}

function maskPublicTarget(value = "") {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 4) return "****";
  return `${text.slice(0, 2)}***${text.slice(-4)}`;
}

function normalizeMoneyAmount(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(String(value).replace(/[^\d.]/g, ""));
  return Number.isFinite(number) ? number : null;
}

function isSupabaseApprovalCaseClosed(row = {}) {
  const status = String(row.status || "").toLowerCase();
  const bucket = String(row.queue_bucket || "").toLowerCase();
  return ["sent", "manual_resolved", "closed", "auto_record"].includes(status) || bucket === "closed" || row.data?.purchase_confirmed === true;
}

function caseActionOperatorFromRequest(request, payload = {}) {
  const headerName = firstString(request.headers.get("x-operator-name"), request.headers.get("x-staff-name"));
  return {
    id: firstString(payload.operator_id, payload.operatorId, payload.user_id, payload.userId),
    name: firstString(payload.user, payload.approvedBy, payload.rejectedBy, payload.resolvedBy, payload.confirmedBy, headerName, "客服"),
    role: firstString(payload.role, "staff")
  };
}

function truthyValue(value) {
  if (value === true) return true;
  const text = String(value || "").trim().toLowerCase();
  return ["1", "true", "yes", "y", "confirm", "confirmed"].includes(text);
}

async function importLegacyApprovalItem(env, item = {}, options = {}) {
  const legacyId = firstString(item.id, item.inbound?.provider_message_id, item.inbound?.event_id);
  if (!legacyId) return { ok: false, status: "skipped", reason: "missing_legacy_id" };

  const normalized = legacyApprovalItemToNormalized(item, options);
  const intake = await persistLegacyApprovalCoreRecords(env, normalized, {
    source: "legacy_pilot_worker",
    legacy_approval_id: legacyId
  }, options.baseRefs || {});
  if (!intake?.refs?.customer_id) {
    return {
      ok: false,
      status: "failed",
      legacy_id: legacyId,
      reason: intake?.reason || intake?.error || "customer_import_failed"
    };
  }

  if (options.previewLimit > 0) {
    await importLegacyChatPreviewMessages(env, item, normalized, intake.refs, options.previewLimit);
  }

  const mapped = mapLegacyApprovalCaseState(item);
  const casePayload = withoutUndefined({
    ...withoutUndefined({ brand_id: intake.refs.brand_id || undefined }),
    project_key: options.projectKey,
    customer_id: intake.refs.customer_id,
    conversation_id: intake.refs.conversation_id || undefined,
    trigger_message_id: intake.refs.message_id || undefined,
    status: mapped.status,
    queue_bucket: mapped.queue_bucket,
    stage: normalized.stage || undefined,
    intent: mapped.intent || undefined,
    risk_level: mapped.risk_level,
    customer_last_text: normalized.text || "",
    suggested_reply: firstString(item.reply?.text, item.final_text),
    next_action: mapped.next_action,
    confidence: mapped.confidence,
    reason: mapped.reason,
    provider: "chatdaddy",
    provider_case_id: legacyId,
    idempotency_key: `legacy:${legacyId}`,
    closed_at: mapped.closed_at,
    data: {
      legacy_import: true,
      legacy_source: "pilot_worker",
      legacy_approval_id: legacyId,
      legacy_status: item.status || null,
      legacy_category: item.category || null,
      normalized,
      decision: {
        intent: mapped.intent,
        risk_level: mapped.risk_level,
        stage: normalized.stage || "",
        next_action: mapped.next_action,
        reply_text: firstString(item.reply?.text, item.final_text),
        reason: mapped.reason,
        source_refs: ["legacy:pilot_worker"]
      },
      chat_preview: Array.isArray(item.chat_preview) ? item.chat_preview.slice(-20) : [],
      source_ids: item.source_ids || {},
      customer: item.customer || {}
    },
    created_at: normalizeDate(item.created_at || normalized.message_at),
    updated_at: normalizeDate(item.updated_at || item.created_at || normalized.message_at)
  });

  const existing = await supabaseSelectRows(
    env,
    `approval_cases?project_key=eq.${encodeURIComponent(options.projectKey)}&idempotency_key=eq.${encodeURIComponent(`legacy:${legacyId}`)}&select=id,status&limit=1`
  );
  const write = existing[0]?.id
    ? await supabasePatch(env, `approval_cases?id=eq.${existing[0].id}`, casePayload)
    : await supabaseInsert(env, "approval_cases", casePayload);

  return {
    ok: Boolean(write?.ok),
    status: write?.ok ? (existing[0]?.id ? "updated" : "inserted") : "failed",
    legacy_id: legacyId,
    case_id: firstReturnedId(write) || existing[0]?.id || null,
    queue_bucket: mapped.queue_bucket,
    case_status: mapped.status,
    error: write?.ok ? null : write?.error || "write_failed"
  };
}

async function persistLegacyApprovalCoreRecords(env, normalized, rawPayload, baseRefs = {}) {
  const out = {
    attempted: false,
    ok: false,
    refs: {},
    customer: null,
    conversation: null,
    message: null
  };
  if (!hasSupabase(env)) return { ...out, reason: "supabase_not_configured" };

  out.attempted = true;
  out.customer = await upsertSupabaseCustomer(env, normalized, baseRefs.channel_connection_id || null);
  const customerId = firstReturnedId(out.customer);
  if (!customerId) return { ...out, reason: "customer_import_failed" };

  out.conversation = await upsertSupabaseConversation(env, normalized, {
    brand_id: baseRefs.brand_id || undefined,
    customer_id: customerId,
    channel_connection_id: baseRefs.channel_connection_id || null
  });
  const conversationId = firstReturnedId(out.conversation);

  const refs = {
    brand_id: baseRefs.brand_id || null,
    project_id: baseRefs.project_id || null,
    channel_connection_id: baseRefs.channel_connection_id || null,
    customer_id: customerId,
    conversation_id: conversationId || null
  };
  out.message = await persistSupabaseMessageWithRefs(env, normalized, rawPayload, refs);
  refs.message_id = firstReturnedId(out.message);
  out.refs = refs;
  out.ok = Boolean(out.message?.ok || out.message?.skipped_existing);
  return out;
}

function legacyApprovalItemToNormalized(item = {}, options = {}) {
  const inbound = typeof item.inbound === "object" && item.inbound ? item.inbound : {};
  const customer = typeof item.customer === "object" && item.customer ? item.customer : {};
  const text = typeof item.inbound === "string"
    ? item.inbound
    : firstString(inbound.text, item.customer_last_text);
  const displayName = sanitizeDisplayName(firstString(
    inbound.display_name,
    inbound.customer_name,
    inbound.contact_name,
    customer.display_name,
    customer.contact_name,
    customer.name
  ));
  const externalCustomerId = firstString(
    inbound.external_contact_id,
    inbound.external_customer_id,
    customer.contact_id,
    customer.chat_id,
    customer.thread_id,
    customer.phone
  );
  const externalConversationId = firstString(
    inbound.external_thread_id,
    inbound.external_conversation_id,
    customer.thread_id,
    customer.chat_id,
    customer.contact_id,
    externalCustomerId
  );
  const legacyId = firstString(item.id, inbound.provider_message_id, inbound.event_id);
  return {
    project_key: options.projectKey,
    provider: "chatdaddy",
    connection_id: options.connectionId,
    event_id: firstString(inbound.event_id, legacyId),
    event_type: firstString(inbound.event_type, item.status, "legacy_approval_import"),
    provider_message_id: firstString(inbound.provider_message_id, inbound.event_id, legacyId),
    external_customer_id: externalCustomerId || `legacy:${legacyId}`,
    external_conversation_id: externalConversationId || externalCustomerId || `legacy:${legacyId}`,
    phone: firstString(customer.phone, inbound.phone),
    display_name: displayName,
    text,
    direction: "inbound",
    message_type: text ? "text" : "attachment",
    attachments: [],
    message_at: normalizeDate(inbound.message_at || item.updated_at || item.created_at),
    stage: firstString(item.decision?.signals?.stage, item.reply?.stage_after, item.stage)
  };
}

async function importLegacyChatPreviewMessages(env, item = {}, baseNormalized = {}, refs = {}, previewLimit = 0) {
  const preview = Array.isArray(item.chat_preview) ? item.chat_preview.slice(-previewLimit) : [];
  let imported = 0;
  for (let index = 0; index < preview.length; index += 1) {
    const msg = preview[index] || {};
    const text = firstString(msg.text);
    if (!text) continue;
    const direction = String(msg.direction || "").toLowerCase() === "agent" ? "outbound" : "inbound";
    const normalized = {
      ...baseNormalized,
      direction,
      text,
      message_type: firstString(msg.type, "text"),
      message_at: normalizeDate(msg.at || msg.message_at || baseNormalized.message_at),
      event_id: `legacy-preview:${item.id}:${index}`,
      provider_message_id: `legacy-preview:${item.id}:${index}`
    };
    const result = await persistSupabaseMessageWithRefs(env, normalized, {
      source: "legacy_pilot_worker_preview",
      legacy_approval_id: item.id,
      preview_index: index
    }, refs);
    if (result?.ok || result?.skipped_existing) imported += 1;
  }
  return imported;
}

function mapLegacyApprovalCaseState(item = {}) {
  const legacyStatus = String(item.status || "").toLowerCase();
  const category = String(item.category || "").toLowerCase();
  const actionType = String(item.action?.type || item.reply?.next_action || "").toLowerCase();
  const signals = item.decision?.signals || {};
  const nowClosed = ["sent", "external_flow_continued", "auto_record", "closed"].includes(legacyStatus)
    ? normalizeDate(item.updated_at || item.created_at)
    : undefined;
  const risk = normalizeRiskLevel(firstString(signals.risk_level, signals.risk, item.risk_level));
  const confidence = Number(signals.confidence);

  if (legacyStatus === "external_flow_continued" || category === "auto") {
    return {
      status: "auto_record",
      queue_bucket: "auto_record",
      next_action: "record_auto_event",
      intent: firstString(signals.intent, "external_flow_continued"),
      risk_level: risk,
      confidence: Number.isFinite(confidence) ? confidence : undefined,
      reason: "ChatDaddy/External Flow already continued; read-only record.",
      closed_at: nowClosed
    };
  }

  if (legacyStatus === "sent") {
    return {
      status: "sent",
      queue_bucket: "closed",
      next_action: "sent_record",
      intent: firstString(signals.intent, actionType, "sent"),
      risk_level: risk,
      confidence: Number.isFinite(confidence) ? confidence : undefined,
      reason: firstString(item.action?.operator_instruction, item.action?.label, "Already sent in legacy runtime."),
      closed_at: nowClosed
    };
  }

  if (category === "human" || actionType.includes("handoff")) {
    return {
      status: "handoff",
      queue_bucket: "human",
      next_action: "handoff",
      intent: firstString(signals.intent, actionType, "human_required"),
      risk_level: risk,
      confidence: Number.isFinite(confidence) ? confidence : undefined,
      reason: firstString(item.action?.operator_instruction, item.action?.label, "Needs human handling.")
    };
  }

  if (category === "order" || /order|receipt|payment|paid/.test(actionType)) {
    return {
      status: "needs_approval",
      queue_bucket: "order_payment",
      next_action: "order_payment_review",
      intent: firstString(signals.intent, actionType, "order_payment"),
      risk_level: risk,
      confidence: Number.isFinite(confidence) ? confidence : undefined,
      reason: firstString(item.action?.operator_instruction, item.action?.label, "Order/payment needs staff confirmation.")
    };
  }

  return {
    status: "needs_approval",
    queue_bucket: "approvable",
    next_action: "create_approval_case",
    intent: firstString(signals.intent, actionType, "approval"),
    risk_level: risk,
    confidence: Number.isFinite(confidence) ? confidence : undefined,
    reason: firstString(item.action?.operator_instruction, item.action?.label, "Check before sending.")
  };
}

function normalizeRiskLevel(value) {
  const text = String(value || "").toLowerCase();
  if (text === "low" || text === "medium" || text === "high") return text;
  return "medium";
}

function mergeApprovalItems(primaryItems = [], legacyItems = []) {
  const seen = new Set();
  const out = [];
  for (const item of [...primaryItems, ...legacyItems]) {
    const key = approvalItemDedupeKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.sort((a, b) => new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0));
}

function approvalItemDedupeKey(item = {}) {
  return firstString(
    item.id,
    item.inbound?.provider_message_id,
    item.inbound?.event_id,
    item.raw?.provider_case_id,
    item.raw_approval?.inbound?.provider_message_id,
    item.raw_approval?.inbound?.event_id
  ) || [
    item.customer?.chat_id,
    item.customer?.phone,
    item.inbound?.text,
    item.inbound?.message_at
  ].map((value) => String(value || "")).join(":");
}

function approvalCaseRowToDashboardItem(row, refs = {}) {
  const decision = row.data?.decision || {};
  const normalized = row.data?.normalized || {};
  const isLegacyImport = row.data?.legacy_import === true;
  const customer = refs.customer || {};
  const message = refs.message || {};
  const storedRecentMessages = Array.isArray(refs.recentMessages) ? refs.recentMessages : [];
  const fallbackMessage = approvalCaseFallbackMessage(row, message, normalized);
  const recentMessages = storedRecentMessages.length ? storedRecentMessages : (fallbackMessage ? [fallbackMessage] : []);
  const latestCustomerMessage = latestVisibleCustomerMessage(recentMessages);
  const inboundText = firstString(latestCustomerMessage?.text, row.customer_last_text, message.text, normalized.text);
  const messageAt = firstString(latestCustomerMessage?.at, latestCustomerMessage?.message_at, message.message_at, normalized.message_at, row.created_at);
  const displayUpdatedAt = isLegacyImport
    ? firstString(messageAt, row.created_at, row.updated_at)
    : firstString(row.updated_at, messageAt, row.created_at);
  const displayName = sanitizeDisplayName(firstString(
    customer.display_name,
    customer.profile?.display_name,
    normalized.display_name
  ));
  const phone = firstString(customer.phone_e164, normalized.phone);
  const externalCustomerId = firstString(customer.external_customer_id, normalized.external_customer_id, row.customer_id);
  const alreadyHandled = isSupabaseApprovalCaseClosed(row);
  const safetyOverride = !alreadyHandled && isSafetyContradictionOrderText(inboundText);
  const storedReplyText = row.suggested_reply || decision.reply_text || "";
  const drinkUsageOverride = !alreadyHandled && !safetyOverride && isDrinkUsageQuestion(inboundText) && (!storedReplyText || isGenericConfirmationReply(storedReplyText));
  const fallbackHandoffReply = !storedReplyText && !drinkUsageOverride
    ? safeHandoffReplyFallback(inboundText, row.intent || decision.intent || "", row.next_action || decision.next_action || "")
    : "";
  const category = safetyOverride ? "human" : (drinkUsageOverride ? "approval" : dashboardCategoryFromApprovalCase(row));
  const actionType = safetyOverride ? "handoff" : (drinkUsageOverride ? "approve_reply" : dashboardActionTypeFromApprovalCase(row, decision));
  const dashboardStatus = safetyOverride ? "pending" : dashboardStatusFromApprovalCase(row);
  const riskLevel = safetyOverride ? "high" : (drinkUsageOverride ? "low" : (row.risk_level || decision.risk_level || "medium"));
  const intent = safetyOverride ? "health_boundary_pushback" : (drinkUsageOverride ? "faq_drink_usage" : (row.intent || decision.intent || "approval"));
  const reason = safetyOverride
    ? "Customer pushed back after a health boundary. Do not treat as order/payment; human must review."
    : drinkUsageOverride
      ? "Customer asked a direct drink-usage FAQ. Send the concrete FAQ answer after staff approval."
    : (row.reason || decision.reason || row.next_action || "等待客服确认");
  const operatorInstruction = safetyOverride
    ? "先人工接手：承认前面健康边界，不继续推配套，不叫顾客下单。"
    : drinkUsageOverride
      ? "检查喝法答案完整后发送；不要接 Flow，不要叫顾客下单。"
    : (row.reason || decision.reason || "检查后才发送。");
  const replyText = safetyOverride
    ? "亲，你说得对。既然已经涉及身体情况，我这边先不继续推配套，也不会叫你下单。我先把前面的情况核对清楚，再谨慎回复你。"
    : drinkUsageOverride
      ? beyouteDrinkUsageReply()
      : (storedReplyText || fallbackHandoffReply);

  return withoutUndefined({
    id: row.id,
    source: "approval",
    project_key: row.project_key,
    status: dashboardStatus,
    category,
    provider: row.provider || normalized.provider || "chatdaddy",
    created_at: row.created_at,
    updated_at: displayUpdatedAt,
    customer: {
      id: externalCustomerId || row.customer_id || "",
      chat_id: externalCustomerId || "",
      phone: phone || "",
      name: displayName || "",
      display_name: displayName || ""
    },
    inbound: {
      text: inboundText || "",
      message_at: messageAt || row.created_at,
      provider_message_id: firstString(message.provider_message_id, row.provider_case_id, normalized.provider_message_id),
      event_id: firstString(row.provider_case_id, normalized.event_id),
      phone: phone || "",
      chat_id: externalCustomerId || "",
      customer_name: displayName || "",
      display_name: displayName || ""
    },
    reply: {
      text: replyText,
      stage_after: row.stage || decision.stage || normalized.stage || "",
      model: row.data?.decision?.source_refs?.includes("model:openai_in_agent") ? "openai" : "hermas_agents"
    },
    action: {
      type: actionType,
      label: reason,
      operator_instruction: operatorInstruction
    },
    chat_preview: recentMessages.length ? recentMessages : undefined,
    conversation_context: recentMessages.length ? {
      messages: recentMessages,
      latest_customer_message: latestCustomerMessage || undefined
    } : undefined,
    latest_customer_message: latestCustomerMessage || undefined,
    decision: {
      signals: {
        intent,
        customer_intent: intent,
        risk_level: riskLevel,
        risk: riskLevel,
        stage: row.stage || decision.stage || normalized.stage || "",
        stage_key: row.stage || decision.stage || normalized.stage || "",
        tags: uniqueTruthy([
          intent,
          riskLevel,
          row.stage || decision.stage || normalized.stage
        ])
      },
      delivery: {
        mode: "approval_first",
        send_now: false,
        trigger_flow_now: false
      }
    },
    risk_level: riskLevel,
    source_status: safetyOverride ? "handoff" : row.status,
    next_action: safetyOverride ? "handoff" : (drinkUsageOverride ? "create_approval_case" : (row.next_action || decision.next_action || "")),
    raw: {
      case_id: row.id,
      conversation_id: row.conversation_id || undefined,
      queue_bucket: row.queue_bucket,
      confidence: row.confidence
    }
  });
}

function approvalCaseFallbackMessage(row = {}, message = {}, normalized = {}) {
  const text = firstString(row.customer_last_text, message.text, normalized.text);
  const intent = String(row.intent || row.data?.decision?.intent || "").toLowerCase();
  const stage = String(row.stage || row.data?.decision?.stage || "").toLowerCase();
  const messageType = String(message.message_type || message.content?.type || normalized.message_type || "").toLowerCase();
  const looksAttachment = /(receipt_upload|receipt|payment|upload|attachment|image|photo|file|audio|voice)/i.test(`${intent} ${stage} ${messageType}`);
  if (!text && !looksAttachment) return null;
  const type = text ? "text" : "attachment";
  return {
    id: firstString(message.id, row.trigger_message_id, row.provider_case_id, row.id),
    provider_message_id: firstString(message.provider_message_id, row.provider_case_id, normalized.provider_message_id),
    direction: "inbound",
    role: "customer",
    text: text || "顾客发送了附件",
    type,
    message_type: type,
    at: firstString(message.message_at, normalized.message_at, row.created_at),
    message_at: firstString(message.message_at, normalized.message_at, row.created_at),
    is_attachment: !text && looksAttachment
  };
}

function dashboardStatusFromApprovalCase(row) {
  const status = String(row.status || "").toLowerCase();
  const bucket = String(row.queue_bucket || "").toLowerCase();
  if (row.data?.purchase_confirmed === true) return "purchase_confirmed";
  if (bucket === "auto_record" || status === "auto_record") return "external_flow_continued";
  if (bucket === "human" || status === "handoff") return "pending";
  if (bucket === "order_payment" || bucket === "approvable" || status === "needs_approval") return "pending";
  if (status === "closed") return "sent";
  return status || "pending";
}

function dashboardCategoryFromApprovalCase(row) {
  if (row.queue_bucket === "human" || row.status === "handoff") return "human";
  if (row.queue_bucket === "order_payment") return "order";
  if (row.queue_bucket === "auto_record" || row.status === "auto_record") return "auto";
  return "approval";
}

function dashboardActionTypeFromApprovalCase(row, decision = {}) {
  const action = row.next_action || decision.next_action || "";
  if (row.queue_bucket === "human" || row.status === "handoff" || action === "handoff") return "handoff";
  if (row.queue_bucket === "order_payment" || action === "order_payment_review") return "receipt_review";
  return "approve_reply";
}

async function selectSupabaseRowsByIds(env, table, ids, select) {
  if (!ids.length) return [];
  const idList = ids.map((id) => String(id).trim()).filter(Boolean).join(",");
  if (!idList) return [];
  return supabaseSelectRows(env, `${table}?id=in.(${idList})&select=${encodeURIComponent(select)}`);
}

function objectById(rows) {
  const out = {};
  for (const row of rows || []) {
    if (row?.id) out[row.id] = row;
  }
  return out;
}

function uniqueTruthy(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

async function supabaseInsert(env, table, payload) {
  try {
    let response = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "content-type": "application/json",
        prefer: "return=representation"
      },
      body: JSON.stringify(payload)
    });
    let body = await response.text();
    if (!response.ok && payload?.brand_id && shouldRetryWithoutLegacyBrandId(body)) {
      const retryPayload = withoutKey(payload, "brand_id");
      response = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
        method: "POST",
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          "content-type": "application/json",
          prefer: "return=representation"
        },
        body: JSON.stringify(retryPayload)
      });
      body = await response.text();
    }
    if (!response.ok) {
      return { attempted: true, ok: false, table, status: response.status, error: compactError(body) };
    }
    const data = body ? JSON.parse(body) : [];
    return { attempted: true, ok: true, table, rows: Array.isArray(data) ? data.length : 0, data };
  } catch (error) {
    return { attempted: true, ok: false, table, error: error.message || String(error) };
  }
}

async function supabasePatch(env, tableAndQuery, payload) {
  try {
    let response = await fetch(`${env.SUPABASE_URL}/rest/v1/${tableAndQuery}`, {
      method: "PATCH",
      headers: supabaseHeaders(env, "return=representation"),
      body: JSON.stringify(payload)
    });
    let body = await response.text();
    if (!response.ok && payload?.brand_id && shouldRetryWithoutLegacyBrandId(body)) {
      response = await fetch(`${env.SUPABASE_URL}/rest/v1/${tableAndQuery}`, {
        method: "PATCH",
        headers: supabaseHeaders(env, "return=representation"),
        body: JSON.stringify(withoutKey(payload, "brand_id"))
      });
      body = await response.text();
    }
    if (!response.ok) {
      return { attempted: true, ok: false, table: tableAndQuery.split("?")[0], status: response.status, error: compactError(body) };
    }
    const data = body ? JSON.parse(body) : [];
    return { attempted: true, ok: true, table: tableAndQuery.split("?")[0], rows: Array.isArray(data) ? data.length : 0, data };
  } catch (error) {
    return { attempted: true, ok: false, table: tableAndQuery.split("?")[0], error: error.message || String(error) };
  }
}

async function supabaseUpsert(env, table, payload, conflictKey = "") {
  try {
    const query = conflictKey ? `?on_conflict=${encodeURIComponent(conflictKey)}` : "";
    const response = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}${query}`, {
      method: "POST",
      headers: supabaseHeaders(env, "resolution=merge-duplicates,return=representation"),
      body: JSON.stringify(payload)
    });
    const body = await response.text();
    if (!response.ok) {
      return { attempted: true, ok: false, table, status: response.status, error: compactError(body) };
    }
    const data = body ? JSON.parse(body) : [];
    return { attempted: true, ok: true, table, rows: Array.isArray(data) ? data.length : 0, data };
  } catch (error) {
    return { attempted: true, ok: false, table, error: error.message || String(error) };
  }
}

async function supabaseSelectRows(env, tableAndQuery) {
  if (!hasSupabase(env)) return [];
  try {
    const response = await fetch(`${env.SUPABASE_URL}/rest/v1/${tableAndQuery}`, {
      method: "GET",
      headers: supabaseHeaders(env)
    });
    if (!response.ok) return [];
    const data = await response.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function supabaseSelectResult(env, tableAndQuery) {
  if (!hasSupabase(env)) return { ok: false, status: 503, data: [], error: "supabase_not_configured" };
  try {
    const response = await fetch(`${env.SUPABASE_URL}/rest/v1/${tableAndQuery}`, {
      method: "GET",
      headers: supabaseHeaders(env)
    });
    const body = await response.text();
    if (!response.ok) {
      return { ok: false, status: response.status, data: [], error: compactError(body) };
    }
    const data = body ? JSON.parse(body) : [];
    return { ok: true, status: response.status, data: Array.isArray(data) ? data : [] };
  } catch (error) {
    return { ok: false, status: 0, data: [], error: error.message || String(error) };
  }
}

function supabaseHeaders(env, prefer = "") {
  const headers = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "content-type": "application/json"
  };
  if (prefer) headers.prefer = prefer;
  return headers;
}

function firstReturnedId(result) {
  return Array.isArray(result?.data) && result.data[0]?.id ? result.data[0].id : null;
}

function withoutUndefined(value) {
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item;
  }
  return out;
}

function withoutKey(value, keyToRemove) {
  const out = {};
  for (const [key, item] of Object.entries(value || {})) {
    if (key !== keyToRemove) out[key] = item;
  }
  return out;
}

function shouldRetryWithoutLegacyBrandId(body) {
  const text = typeof body === "string" ? body : JSON.stringify(body || "");
  return /brand_id/i.test(text) && /(schema cache|could not find|does not exist|unknown|column)/i.test(text);
}

function chatDaddyConfig(env) {
  return {
    apiKey: env.CHATDADDY_ACCESS_TOKEN || env.CHATDADDY_READ_TOKEN || env.CHATDADDY_API_KEY || "",
    accountId: env.CHATDADDY_ACCOUNT_ID || env.CHATDADDY_ACCOUNTID || "",
    sendUrl: env.CHATDADDY_SEND_URL || "",
    sendBase: trimTrailingSlash(env.CHATDADDY_SEND_BASE || "https://api.chatdaddy.tech/im"),
    contactsBase: trimTrailingSlash(env.CHATDADDY_CONTACTS_BASE || env.CHATDADDY_SEND_BASE || "https://api.chatdaddy.tech/im")
  };
}

async function fetchChatDaddyContact(config, contactId) {
  const response = await fetch(buildChatDaddyContactsUrl(config, contactId), {
    method: "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${config.apiKey}`
    }
  });
  const text = await safeResponseText(response);
  return {
    requested_id: contactId,
    ok: response.ok,
    status: response.status,
    body: safeJsonParse(text) || (text ? { text_preview: text.slice(0, 200) } : null)
  };
}

function normalizeChatDaddyContactResult(result = {}) {
  const row = firstChatDaddyContactRow(result.body, result.requested_id);
  const id = normalizeChatDaddyToContact(firstString(
    row?.id,
    row?._id,
    row?.contactId,
    row?.contact_id,
    row?.chatId,
    row?.chat_id,
    row?.phone,
    result.requested_id
  ));
  const name = firstNonGenericContactName(
    row?.name,
    row?.displayName,
    row?.display_name,
    row?.fullName,
    row?.full_name,
    row?.profileName,
    row?.profile_name,
    row?.pushName,
    row?.push_name,
    row?.whatsappName,
    row?.whatsapp_name,
    row?.nickname,
    row?.nickName,
    row?.username,
    row?.firstName && row?.lastName ? `${row.firstName} ${row.lastName}` : "",
    row?.first_name && row?.last_name ? `${row.first_name} ${row.last_name}` : "",
    row?.firstName,
    row?.first_name
  );
  const phone = normalizeChatDaddyToContact(firstString(row?.phone, row?.phoneNumber, row?.phone_number, row?.mobile, row?.whatsapp, row?.wa_id));
  return {
    id,
    requested_id: result.requested_id,
    ok: Boolean(result.ok),
    status: result.status || 0,
    name,
    phone,
    has_name: Boolean(name),
    raw_shape: chatDaddyShape(result.body)
  };
}

function firstChatDaddyContactRow(body, requestedId = "") {
  const candidates = [body?.contact, body?.contacts, body?.data, body?.items, body?.results, body];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const rows = Array.isArray(candidate) ? candidate : [candidate];
    const requested = normalizeChatDaddyToContact(requestedId);
    const matching = rows.find((row) => {
      const id = normalizeChatDaddyToContact(firstString(row?.id, row?._id, row?.contactId, row?.contact_id, row?.chatId, row?.chat_id, row?.phone));
      return id && requested && id === requested;
    });
    const row = matching || rows.find((item) => item && typeof item === "object");
    if (row) return row;
  }
  return {};
}

async function fetchChatDaddyRecentMessages(config, options = {}) {
  const url = new URL(buildChatDaddyMessagesUrl(config, config.accountId, options.chatId));
  url.searchParams.set("count", String(options.count || 30));
  if (options.beforeId) url.searchParams.set("beforeId", String(options.beforeId));
  if (options.status) url.searchParams.set("status", String(options.status));
  if (options.fromMe !== undefined && options.fromMe !== null && options.fromMe !== "") {
    url.searchParams.set("fromMe", String(options.fromMe));
  }
  if (options.fetchFromPlatform !== undefined) {
    url.searchParams.set("fetchFromPlatform", String(Boolean(options.fetchFromPlatform)));
  }
  url.searchParams.set("includeCursorMessage", "true");

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${config.apiKey}`
    }
  });
  const text = await safeResponseText(response);
  const body = safeJsonParse(text) || (text ? { text_preview: text.slice(0, 200) } : null);
  const rows = chatDaddyMessageRows(body);
  return {
    ok: response.ok,
    status: response.status,
    body,
    raw_shape: chatDaddyShape(body),
    row_shape: rows[0] ? chatDaddyShape(rows[0]) : "",
    customer_name: firstNonGenericContactName(
      body?.customer?.name,
      body?.contact?.name,
      body?.chat?.name,
      body?.conversation?.name
    )
  };
}

function normalizeChatDaddyRecentMessagesForImport(body, defaults = {}) {
  return chatDaddyMessageRows(body)
    .map((row, index) => normalizeChatDaddyRecentMessageForImport(row, defaults, index))
    .filter(Boolean);
}

function chatDaddyMessageRows(body) {
  const direct = firstArray(
    body?.messages,
    body?.items,
    body?.data,
    body?.results,
    body?.records,
    body?.messageList,
    body?.conversation?.messages,
    body?.chat?.messages
  );
  if (direct.length) return direct.filter((item) => item && typeof item === "object");
  if (Array.isArray(body)) return body.filter((item) => item && typeof item === "object");
  return [];
}

function normalizeChatDaddyRecentMessageForImport(row = {}, defaults = {}, index = 0) {
  if (!row || typeof row !== "object") return null;
  const nestedMessage = firstPlainObject(row.message, row.contentMessage, row.whatsappMessage);
  const nestedText = firstPlainObject(row.text, nestedMessage.text);
  const direction = normalizeChatDaddyRecentMessageDirection(row);
  const flowName = firstString(
    row.flow_name,
    row.flowName,
    row.message_flow_name,
    row.messageFlowName,
    row.workflow_name,
    row.workflowName,
    row.bot_name,
    row.botName,
    row.template_name,
    row.templateName,
    row.title,
    row.name,
    row.workflow?.name,
    row.bot?.name,
    row.messageFlow?.name,
    row.template?.name
  );
  const buttonText = firstString(row.button_text, row.buttonText, row.selected_button, row.selectedButton, row.button?.text, nestedMessage.button?.text);
  const rawText = firstString(
    row.body,
    typeof row.text === "string" ? row.text : "",
    typeof row.message === "string" ? row.message : "",
    typeof row.content === "string" ? row.content : "",
    row.caption,
    row.plainText,
    row.plain_text,
    row.messageText,
    row.message_text,
    nestedText.body,
    nestedText.text,
    nestedMessage.body,
    nestedMessage.text,
    nestedMessage.caption,
    row.template?.body
  );
  const hasAttachment = Boolean(
    row.attachment ||
    row.attachments ||
    row.media ||
    row.file ||
    row.files ||
    nestedMessage.attachment ||
    nestedMessage.attachments ||
    nestedMessage.media
  );
  const text = rawText || buttonText || (hasAttachment ? "[附件]" : "") || (flowName ? `[Flow] ${flowName}` : "");
  if (!text) return null;
  const messageAt = normalizeChatDaddyMessageDate(row) || new Date().toISOString();
  const providerMessageId = firstString(
    row.provider_message_id,
    row.providerMessageId,
    row.message_id,
    row.messageId,
    row.wa_message_id,
    row.waMessageId,
    row.whatsapp_message_id,
    row.whatsappMessageId,
    row.id,
    row._id,
    nestedMessage.id
  ) || syntheticProviderMessageId("chatdaddy_messages_get", defaults.projectKey, defaults.chatId, direction, messageAt, text, index);
  return {
    direction,
    text,
    message_at: messageAt,
    provider_message_id: providerMessageId,
    message_type: firstString(row.message_type, row.messageType, row.type, row.kind, flowName ? "flow" : hasAttachment ? "attachment" : buttonText ? "button" : "text"),
    button_text: buttonText,
    flow_name: flowName,
    flow_id: firstString(row.flow_id, row.flowId, row.workflow_id, row.workflowId, row.bot_id, row.botId),
    has_attachment: hasAttachment,
    source: "chatdaddy_messages_get",
    raw: row
  };
}

function normalizeHermasConversationHistoryImportPayload(payload = {}, defaults = {}) {
  const conversation = firstPlainObject(payload.conversation, payload.thread, payload.chat, payload.room);
  const contact = firstPlainObject(payload.contact, payload.customer, payload.profile);
  const provider = firstString(payload.provider, defaults.provider, "chatdaddy");
  const projectKey = normalizeProjectKey(defaults.projectKey || payload.project_key || payload.projectKey || "beyoute");
  const messagesSource = firstArray(payload.messages, payload.items, payload.history, payload.records, conversation.messages, conversation.items, conversation.history);
  const externalContactId = normalizeChatDaddyToContact(firstString(
    payload.contact_id,
    payload.contactId,
    payload.external_contact_id,
    payload.externalContactId,
    contact.id,
    contact.contact_id,
    contact.contactId,
    contact.phone,
    payload.phone
  ));
  const phone = normalizeChatDaddyPhone(firstString(payload.phone, payload.customer_phone, contact.phone, contact.phone_number, contact.whatsapp, externalContactId));
  const externalThreadId = normalizeChatDaddyToContact(firstString(
    payload.chat_id,
    payload.chatId,
    payload.thread_id,
    payload.threadId,
    payload.conversation_id,
    payload.conversationId,
    conversation.id,
    conversation.chat_id,
    conversation.chatId,
    conversation.thread_id,
    conversation.threadId,
    externalContactId,
    phone
  ));
  const displayName = firstNonGenericContactName(
    payload.customer_name,
    payload.customerName,
    payload.display_name,
    payload.displayName,
    payload.name,
    contact.name,
    contact.display_name,
    contact.displayName,
    contact.full_name,
    contact.fullName
  );

  return messagesSource.map((message, index) => {
    const row = typeof message === "object" && message ? message : { text: String(message || "") };
    const direction = normalizeDirection(firstString(row.direction, row.sender_type, row.senderType, row.role), row.from_me ?? row.fromMe);
    const text = firstString(row.text, row.body, row.message, row.caption);
    const attachments = normalizeAttachments(row, row.message || {}, row.content || {});
    const messageType = normalizeMessageType(firstString(row.message_type, row.messageType, row.type, row.kind), attachments);
    const messageAt = normalizeDate(firstString(row.message_at, row.messageAt, row.created_at, row.createdAt, row.timestamp, row.time, row.date));
    const providerMessageId = firstString(row.provider_message_id, row.providerMessageId, row.message_id, row.messageId, row.id, row._id)
      || syntheticProviderMessageId(provider, projectKey, externalThreadId || externalContactId || phone, direction, messageAt, text, index);
    const normalized = {
      schema_version: "hermas.channel_adapter.v1",
      event_id: firstString(row.event_id, row.eventId, providerMessageId),
      provider,
      project_key: projectKey,
      connection_id: firstString(payload.connection_id, payload.connectionId, "beyoute-chatdaddy"),
      provider_message_id: providerMessageId,
      external_customer_id: externalContactId || phone || null,
      external_conversation_id: externalThreadId || externalContactId || phone || null,
      phone,
      display_name: sanitizeDisplayName(firstString(row.customer_name, row.customerName, row.display_name, row.displayName, displayName)),
      direction,
      event_type: row.button_text || row.buttonText ? "button_click" : "message",
      message_type: messageType,
      text: text || (attachments.length ? "顾客发送了附件" : ""),
      button_text: firstString(row.button_text, row.buttonText),
      attachments,
      stage: normalizeStage(firstString(row.stage, row.step, row.step_name, row.stepName)),
      message_at: messageAt,
      metadata: {
        source: firstString(payload.source, row.source, "conversation_history_import"),
        flow_id: firstString(row.flow_id, row.flowId),
        flow_name: firstString(row.flow_name, row.flowName)
      }
    };
    return { normalized, raw: row };
  }).filter((item) => item.normalized.text || item.normalized.attachments.length);
}

function normalizeChatDaddyRecentMessageDirection(row = {}) {
  const raw = String(row.direction || row.sender_type || row.senderType || row.role || row.from || row.author_type || row.authorType || "").toLowerCase();
  if (
    row.fromMe === true ||
    row.from_me === true ||
    row.isFromMe === true ||
    row.is_from_me === true ||
    row.sentByUs === true ||
    row.sent_by_us === true ||
    row.author?.isMe === true ||
    /^(outbound|agent|assistant|bot|business|staff|operator|me|reply)$/i.test(raw)
  ) {
    return "outbound";
  }
  return "inbound";
}

function normalizeChatDaddyMessageDate(row = {}) {
  const raw = firstString(row.message_at, row.messageAt, row.created_at, row.createdAt, row.timestamp, row.time, row.date, row.sent_at, row.sentAt, row.updated_at, row.updatedAt);
  if (!raw) return "";
  if (/^\d{10,13}$/.test(raw)) {
    const num = Number(raw);
    const date = new Date(num < 100000000000 ? num * 1000 : num);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function firstNonGenericContactName(...values) {
  const generic = new Set(["whatsapp customer", "customer", "live case", "demo customer", "test customer", "未知顾客", "未命名顾客"]);
  for (const value of values) {
    const clean = String(value || "").trim();
    if (!clean || generic.has(clean.toLowerCase())) continue;
    if (/^(?:未知|未命名)?(?:顾客|客户|customer)\s*(?:#|no\.?|编号|id)?\s*\d{2,}$/i.test(clean)) continue;
    if (/^(?:顾客|客户|customer)(?:\s*(?:#|no\.?|编号|id)?\s*[\w-]+)?$/i.test(clean)) continue;
    if (/^\+?\d[\d\s-]{6,}$/.test(clean)) continue;
    return clean.slice(0, 120);
  }
  return "";
}

function buildChatDaddyMessagesUrl(config, accountId, chatId) {
  const template = config.sendUrl || `${config.sendBase}/messages/{accountId}/{chatId}`;
  return template
    .replace("{accountId}", encodeURIComponent(accountId))
    .replace("{chatId}", encodeURIComponent(chatId));
}

function buildChatDaddyContactsUrl(config, contactId) {
  const url = new URL(`${config.contactsBase || config.sendBase}/contacts`);
  url.searchParams.set("contacts", normalizeChatDaddyToContact(contactId));
  if (config.accountId) url.searchParams.append("accountId", config.accountId);
  return url.toString();
}

function normalizeChatDaddyToContact(value) {
  const text = String(value || "").trim();
  if (/^\+\d+$/.test(text)) return text.slice(1);
  return text;
}

function normalizeChatDaddyPhone(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const digits = text.replace(/\D+/g, "");
  return digits ? `+${digits}` : "";
}

function firstArray(...values) {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function firstPlainObject(...values) {
  for (const value of values) {
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  }
  return {};
}

function syntheticProviderMessageId(...values) {
  return `sync:${values.map((value) => String(value || "").replace(/\s+/g, "_").slice(0, 80)).join(":")}`;
}

function chatDaddyShape(value) {
  if (Array.isArray(value)) return `array(${value.length})`;
  if (!value || typeof value !== "object") return typeof value;
  for (const key of ["contact", "contacts", "messages", "data", "items", "results", "records"]) {
    if (Array.isArray(value[key])) return `${key}[]`;
    if (value[key] && typeof value[key] === "object") return key;
  }
  return Object.keys(value).slice(0, 16).join(",");
}

async function safeResponseText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function hasSupabase(env) {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY && !String(env.SUPABASE_URL).includes("YOUR_PROJECT"));
}

async function handleSupabaseAuthLogin(payload, env, request) {
  if (!hasSupabase(env)) {
    return authJson({ ok: false, error: "supabase_not_configured" }, 503, request);
  }
  const email = normalizeEmail(payload.email);
  const password = String(payload.password || "");
  if (!email || !password) return authJson({ ok: false, error: "email_and_password_required" }, 400, request);

  const users = await supabaseSelectRows(
    env,
    `users?email=eq.${encodeURIComponent(email)}&select=id,email,full_name,role,status,password_hash,last_login_at,created_at,updated_at&limit=1`
  );
  const user = users[0] || null;
  const passwordOk = user?.status === "active" && user.password_hash && await verifyPassword(password, user.password_hash);
  if (!passwordOk) return authJson({ ok: false, error: "invalid_email_or_password" }, 401, request);

  const now = new Date();
  const expires = new Date(now.getTime() + HERMAS_SESSION_TTL_SECONDS * 1000);
  const token = randomToken(36);
  const sessionHash = await sha256Hex(token);
  const sessionInsert = await supabaseInsert(env, "user_sessions", {
    user_id: user.id,
    session_hash: sessionHash,
    expires_at: expires.toISOString(),
    created_at: now.toISOString()
  });
  if (!sessionInsert.ok) {
    return authJson({ ok: false, error: "session_create_failed" }, 500, request);
  }

  await supabasePatch(env, `users?id=eq.${encodeURIComponent(user.id)}`, {
    last_login_at: now.toISOString(),
    updated_at: now.toISOString()
  });

  const safeUser = safeSupabaseUser({ ...user, last_login_at: now.toISOString() });
  const projects = await listSupabaseProjectsForUser(env, safeUser);
  return authJson({
    ok: true,
    authenticated: true,
    user: safeUser,
    projects,
    session: {
      expires_at: expires.toISOString(),
      auth_type: "cookie"
    }
  }, 200, request, {
    "set-cookie": sessionCookie(token, request)
  });
}

async function handleSupabaseAuthLogout(env, request) {
  if (hasSupabase(env)) {
    const token = cookieValue(request, HERMAS_SESSION_COOKIE);
    if (token) {
      const sessionHash = await sha256Hex(token);
      await supabasePatch(env, `user_sessions?session_hash=eq.${encodeURIComponent(sessionHash)}`, {
        revoked_at: new Date().toISOString()
      });
    }
  }
  return authJson({ ok: true, authenticated: false }, 200, request, {
    "set-cookie": clearSessionCookie(request)
  });
}

async function handleSupabaseAuthSession(env, request) {
  const auth = await getSupabaseSessionAuth(request, env);
  if (!auth?.ok) {
    return authJson({
      ok: true,
      authenticated: false,
      reason: auth?.error || "not_logged_in"
    }, 200, request);
  }
  return authJson({
    ok: true,
    authenticated: true,
    user: auth.user,
    projects: await listSupabaseProjectsForUser(env, auth.user)
  }, 200, request);
}

async function getSupabaseSessionAuth(request, env, options = {}) {
  if (!hasSupabase(env)) return null;
  const token = cookieValue(request, HERMAS_SESSION_COOKIE);
  if (!token) return null;

  const sessionHash = await sha256Hex(token);
  const sessions = await supabaseSelectRows(
    env,
    `user_sessions?session_hash=eq.${encodeURIComponent(sessionHash)}&select=id,user_id,expires_at,revoked_at,created_at&limit=1`
  );
  const session = sessions[0] || null;
  if (!session) return { ok: false, status: 401, error: "session_expired" };
  if (session.revoked_at) return { ok: false, status: 401, error: "session_revoked" };
  if (new Date(session.expires_at || 0).getTime() <= Date.now()) {
    return { ok: false, status: 401, error: "session_expired" };
  }

  const users = await supabaseSelectRows(
    env,
    `users?id=eq.${encodeURIComponent(session.user_id)}&select=id,email,full_name,role,status,last_login_at,created_at,updated_at&limit=1`
  );
  const user = safeSupabaseUser(users[0] || {});
  if (!user.user_id || user.status !== "active") return { ok: false, status: 401, error: "user_disabled" };

  const role = ["admin", "super_admin"].includes(String(user.role || "")) ? "admin" : "staff";
  const projectKey = options.projectKey || authProjectKeyFromRequest(request);
  if (projectKey && role !== "admin") {
    const membership = await activeSupabaseMembershipForUser(env, user.user_id, projectKey);
    if (!membership) {
      return { ok: false, status: 403, error: "project_access_denied", project_key: projectKey };
    }
  }

  return {
    ok: true,
    auth_type: "session",
    subject: user.email,
    user_id: user.user_id,
    display_name: user.name,
    role,
    project_key: projectKey || null,
    user,
    session_id: session.id
  };
}

async function activeSupabaseMembershipForUser(env, userId, projectKey) {
  const memberships = await supabaseSelectRows(
    env,
    `project_memberships?user_id=eq.${encodeURIComponent(userId)}&project_key=eq.${encodeURIComponent(normalizeProjectKey(projectKey))}&status=eq.active&select=id,project_key,user_id,role,status&limit=1`
  );
  return memberships[0] || null;
}

async function listSupabaseProjectsForUser(env, user = {}) {
  if (!hasSupabase(env) || !user?.user_id) return [];
  const adminLike = ["admin", "super_admin"].includes(String(user.role || ""));
  if (adminLike) {
    const projects = await supabaseSelectRows(
      env,
      "projects?select=project_key,name,display_name,status,updated_at&order=updated_at.desc&limit=200"
    );
    if (projects.length) {
      return projects.map((project) => ({
        project_key: normalizeProjectKey(project.project_key),
        project_name: project.display_name || project.name || project.project_key,
        role: "admin",
        status: project.status || "active"
      }));
    }
    return [{
      project_key: normalizeProjectKey(env.AGENT_PROJECT_KEY || "beyoute"),
      project_name: env.PROJECT_LABEL || env.AGENT_PROJECT_KEY || "Beyoute",
      role: "admin",
      status: "active"
    }];
  }

  const memberships = await supabaseSelectRows(
    env,
    `project_memberships?user_id=eq.${encodeURIComponent(user.user_id)}&status=eq.active&select=project_key,role,status&order=updated_at.desc&limit=200`
  );
  return memberships.map((membership) => ({
    project_key: normalizeProjectKey(membership.project_key),
    project_name: normalizeProjectKey(membership.project_key),
    role: membership.role || "staff",
    status: membership.status || "active"
  }));
}

function safeSupabaseUser(row = {}) {
  return {
    user_id: row.id || row.user_id || "",
    email: row.email || "",
    name: row.full_name || row.name || row.email || "Team Member",
    role: row.role || "staff",
    status: row.status || "active",
    last_login_at: row.last_login_at || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null
  };
}

function adminTokenMatches(request, env) {
  const expected = env.ADMIN_TOKEN || env.HERMAS_ADMIN_TOKEN;
  if (!expected) return false;
  const authorization = request.headers.get("authorization") || "";
  const bearer = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : "";
  const provided = request.headers.get("x-admin-token") || bearer;
  return Boolean(provided && provided === expected);
}

async function requireAdminAccess(request, env, options = {}) {
  if (adminTokenMatches(request, env)) {
    return {
      ok: true,
      auth: {
        auth_type: "admin_token",
        role: "admin",
        subject: "admin_token",
        display_name: "管理员"
      }
    };
  }

  const session = await getSupabaseSessionAuth(request, env, {
    projectKey: options.projectKey || authProjectKeyFromRequest(request)
  });
  if (session?.ok && session.role === "admin") return { ok: true, auth: session };
  if (session?.ok) {
    return {
      ok: false,
      response: authJson({ ok: false, error: "admin_only", message: "这个操作只给管理员使用。" }, 403, request)
    };
  }
  if (session && !session.ok) {
    return {
      ok: false,
      response: authJson({ ok: false, error: session.error || "session_invalid" }, session.status || 401, request)
    };
  }

  const expected = env.ADMIN_TOKEN || env.HERMAS_ADMIN_TOKEN;
  if (!expected && !hasSupabase(env)) {
    return { ok: false, response: json({ ok: false, error: "admin_auth_not_configured" }, 503) };
  }
  return {
    ok: false,
    response: authJson({ ok: false, error: "not_logged_in", message: "请用管理员账号登录。" }, 401, request)
  };
}

function verifyAdminToken(request, env) {
  if (!(env.ADMIN_TOKEN || env.HERMAS_ADMIN_TOKEN)) return json({ ok: false, error: "admin_token_not_configured" }, 503);
  if (adminTokenMatches(request, env)) return null;
  return json({ ok: false, error: "invalid_admin_token" }, 401);
}

async function verifyStaffOrAdminToken(request, env) {
  const expectedStaff = env.HERMAS_STAFF_TOKEN || env.STAFF_TOKEN || env.AGENT_STAFF_TOKEN;
  const expectedAdmin = env.ADMIN_TOKEN || env.HERMAS_ADMIN_TOKEN;

  const url = new URL(request.url);
  const authorization = request.headers.get("authorization") || "";
  const bearer = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : "";
  const providedStaff = request.headers.get("x-staff-token")
    || request.headers.get("x-operator-token")
    || url.searchParams.get("staff_token")
    || url.searchParams.get("operator_token");
  const providedAdmin = request.headers.get("x-admin-token")
    || bearer;

  if (expectedStaff && providedStaff && providedStaff === expectedStaff) return null;
  if (expectedAdmin && providedAdmin && providedAdmin === expectedAdmin) return null;

  const session = await getSupabaseSessionAuth(request, env, {
    projectKey: authProjectKeyFromRequest(request)
  });
  if (session?.ok) return null;
  if (session && !session.ok) {
    return authJson({ ok: false, error: session.error || "session_invalid" }, session.status || 401, request);
  }

  if (!expectedStaff && !expectedAdmin && !hasSupabase(env)) {
    return json({ ok: false, error: "staff_token_not_configured" }, 503);
  }
  return json({ ok: false, error: "invalid_staff_token" }, 401);
}

function authProjectKeyFromRequest(request) {
  const url = new URL(request.url);
  const hermasMatch = url.pathname.match(/^\/api\/hermas\/projects\/([^/]+)/);
  if (hermasMatch) return normalizeProjectKey(decodeURIComponent(hermasMatch[1]));
  const queryProject = url.searchParams.get("project_key") || url.searchParams.get("projectKey");
  return queryProject ? normalizeProjectKey(queryProject) : "";
}

function normalizeEmail(value = "") {
  return String(value || "").trim().toLowerCase();
}

function cookieValue(request, name) {
  const cookie = String(request.headers.get("cookie") || "");
  const parts = cookie.split(";").map((part) => part.trim()).filter(Boolean);
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    if (part.slice(0, eq) === name) return decodeURIComponent(part.slice(eq + 1));
  }
  return "";
}

function sessionCookie(token, request) {
  const url = new URL(request.url);
  const secure = url.protocol === "https:" ? "; Secure" : "";
  const sameSite = url.hostname === "localhost" ? "Lax" : "None";
  return `${HERMAS_SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${HERMAS_SESSION_TTL_SECONDS}; SameSite=${sameSite}${secure}`;
}

function clearSessionCookie(request) {
  const url = new URL(request.url);
  const secure = url.protocol === "https:" ? "; Secure" : "";
  const sameSite = url.hostname === "localhost" ? "Lax" : "None";
  return `${HERMAS_SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=${sameSite}${secure}`;
}

function randomToken(bytes = 32) {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return base64UrlEncode(values);
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value = "") {
  const source = String(value || "");
  const padded = source.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(source.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function adsVaultSecret(env = {}) {
  return String(env.HERMAS_ADS_VAULT_KEY || env.META_CAPI_VAULT_KEY || "").trim();
}

function adsVaultConfigured(env = {}) {
  return Boolean(adsVaultSecret(env));
}

async function adsVaultCryptoKey(env = {}) {
  const secret = adsVaultSecret(env);
  if (!secret) throw new Error("ads_vault_key_missing");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptAdsSecret(env = {}, value = "") {
  try {
    const iv = new Uint8Array(12);
    crypto.getRandomValues(iv);
    const key = await adsVaultCryptoKey(env);
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(String(value || ""))
    );
    return {
      ok: true,
      iv: base64UrlEncode(iv),
      ciphertext: base64UrlEncode(new Uint8Array(ciphertext))
    };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

async function decryptAdsSecret(env = {}, ciphertext = "", iv = "") {
  try {
    const key = await adsVaultCryptoKey(env);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64UrlDecode(iv) },
      key,
      base64UrlDecode(ciphertext)
    );
    return { ok: true, value: new TextDecoder().decode(plain) };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value || ""));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function verifyPassword(password, storedHash) {
  const parts = String(storedHash || "").split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2_sha256") return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations < 10000) return false;
  const salt = base64UrlDecode(parts[2]);
  const expected = base64UrlDecode(parts[3]);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(password || "")), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({
    name: "PBKDF2",
    salt,
    iterations,
    hash: "SHA-256"
  }, key, expected.length * 8);
  const actual = new Uint8Array(bits);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i += 1) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

function authJson(data, status = 200, request = null, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...(request ? corsHeadersForRequest(request) : CORS_HEADERS),
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders
    }
  });
}

function corsHeadersForRequest(request) {
  const origin = request?.headers?.get?.("origin") || "";
  if (!origin || origin === "null") {
    return {
      ...CORS_HEADERS,
      "access-control-allow-origin": origin || CORS_HEADERS["access-control-allow-origin"]
    };
  }
  return {
    ...CORS_HEADERS,
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    "vary": "Origin"
  };
}

function verifyWebhookSecret(request, env) {
  const expected = env.CHATDADDY_WEBHOOK_SECRET;
  if (!expected) return null;

  const url = new URL(request.url);
  const authorization = request.headers.get("authorization") || "";
  const bearer = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : "";
  const provided = request.headers.get("x-webhook-secret")
    || bearer
    || url.searchParams.get("webhook_secret")
    || url.searchParams.get("secret")
    || url.searchParams.get("token");

  if (provided && provided === expected) return null;
  return json({ ok: false, error: "invalid_webhook_secret" }, 401);
}

function webhookAckMode(env) {
  return env.HERMAS_WEBHOOK_ACK_MODE === "inline" ? "inline" : "fast";
}

function shouldFastAckWebhook(env, url) {
  if (url.searchParams.get("wait_for_decision") === "1") return false;
  return webhookAckMode(env) === "fast";
}

function toPayloadShape(value, depth = 0) {
  if (depth > 6) return { type: "max_depth" };
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      first: value.length ? toPayloadShape(value[0], depth + 1) : null
    };
  }
  if (typeof value !== "object") {
    return scalarShape(value);
  }

  const out = {};
  for (const key of Object.keys(value).sort().slice(0, 80)) {
    if (isSensitiveKey(key)) {
      out[key] = { type: "redacted" };
    } else {
      out[key] = toPayloadShape(value[key], depth + 1);
    }
  }
  return { type: "object", fields: out };
}

function scalarShape(value) {
  const type = typeof value;
  if (type !== "string") return { type };
  const text = value.trim();
  if (!text) return { type: "string", empty: true };
  if (/^https?:\/\//i.test(text)) return { type: "string", kind: "url" };
  if (/^\+?\d[\d\s().-]{6,}$/.test(text)) return { type: "string", kind: "phone_like" };
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(text)) return { type: "string", kind: "email_like" };
  return {
    type: "string",
    kind: text.length > 120 ? "long_text" : "short_text",
    length: text.length
  };
}

function isSensitiveKey(key) {
  return /(token|secret|authorization|password|api[_-]?key|access[_-]?key|refresh|cookie|signature|phone|mobile|email|address)/i.test(key);
}

function publicNormalizedEvent(normalized) {
  return {
    schema_version: normalized.schema_version,
    event_id: normalized.event_id,
    provider: normalized.provider,
    project_key: normalized.project_key,
    connection_id: normalized.connection_id,
    provider_message_id: normalized.provider_message_id,
    external_customer_id: normalized.external_customer_id,
    external_conversation_id: normalized.external_conversation_id,
    display_name: normalized.display_name,
    direction: normalized.direction,
    event_type: normalized.event_type,
    message_type: normalized.message_type,
    text: normalized.text,
    button_text: normalized.button_text,
    attachment_count: normalized.attachments.length,
    stage: normalized.stage,
    message_at: normalized.message_at
  };
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function stableContactKey(normalized) {
  const source = [
    normalized.external_customer_id,
    normalized.external_conversation_id,
    normalized.phone,
    normalized.display_name,
    normalized.provider_message_id,
    normalized.event_id
  ].find(Boolean) || "anonymous";
  const bytes = new TextEncoder().encode(String(source));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

function normalizeProjectKey(value) {
  return String(value || "beyoute").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_") || "beyoute";
}

function normalizeDirection(direction, fromMe) {
  if (fromMe === true || String(fromMe).toLowerCase() === "true") return "outbound";
  const clean = String(direction || "").toLowerCase();
  if (["out", "outbound", "sent", "from_me", "fromme"].includes(clean)) return "outbound";
  return "inbound";
}

function normalizeMessageType(type, attachments) {
  const clean = String(type || "").toLowerCase();
  if (clean.includes("audio") || clean.includes("voice")) return "audio";
  if (clean.includes("image") || clean.includes("photo")) return "image";
  if (clean.includes("video")) return "video";
  if (attachments.length) return attachments[0]?.type || "attachment";
  return "text";
}

function normalizeStage(value) {
  const clean = String(value || "").toLowerCase().replace(/\s+/g, "_");
  if (!clean) return null;
  if (/step[_-]?[1-9]/.test(clean)) return clean.replace(/step[_-]?/, "step_");
  return clean.slice(0, 40);
}

function normalizeDate(value) {
  if (!value) return new Date().toISOString();
  const date = new Date(Number.isFinite(Number(value)) ? Number(value) : value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function latestDateString(values = []) {
  let latest = null;
  for (const value of values.flat()) {
    const text = String(value || "").trim();
    if (!text) continue;
    const date = new Date(Number.isFinite(Number(text)) ? Number(text) : text);
    if (!Number.isFinite(date.getTime())) continue;
    if (!latest || date.getTime() > latest.getTime()) latest = date;
  }
  return latest ? latest.toISOString() : "";
}

function sanitizeDisplayName(value) {
  const clean = String(value || "").trim();
  if (!clean) return null;
  const lower = clean.toLowerCase();
  if (["unknown", "unknown customer", "customer", "whatsapp customer", "test customer"].includes(lower)) return null;
  return clean.slice(0, 120);
}

function firstString(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function containsAny(text, terms) {
  return terms.some((term) => text.includes(term.toLowerCase()));
}

function extractOpenAIText(data) {
  if (typeof data.output_text === "string") return data.output_text;
  const output = Array.isArray(data.output) ? data.output : [];
  for (const item of output) {
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (typeof part.text === "string") return part.text;
    }
  }
  return "{}";
}

async function readJson(request) {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    const contentType = String(request.headers.get("content-type") || "").toLowerCase();
    if (contentType.includes("application/x-www-form-urlencoded") || text.includes("=")) {
      const params = new URLSearchParams(text);
      const out = {};
      for (const [key, value] of params.entries()) {
        out[key] = value;
      }
      if (Object.keys(out).length) return out;
    }
    return { _raw_text: text };
  }
}

function compactError(value) {
  return String(value || "").replace(/\s+/g, " ").slice(0, 500);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...CORS_HEADERS,
      "content-type": "application/json; charset=utf-8"
    }
  });
}
