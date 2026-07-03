import { Agent, getAgentByName, routeAgentRequest } from "agents";

const VERSION = "hermas-cloudflare-agents-runtime-v0.1";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,authorization,x-webhook-secret,x-admin-token,x-staff-token,x-operator-token",
  "access-control-max-age": "86400"
};

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
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

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

    if (request.method === "GET" && url.pathname === "/api/approvals/pending") {
      const authError = verifyStaffOrAdminToken(request, env);
      if (authError) return authError;
      return handleSupabaseApprovalsPending(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/approvals/import-legacy-items") {
      const authError = verifyStaffOrAdminToken(request, env);
      if (authError) return authError;
      return handleLegacyApprovalItemsImport(request, env);
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
  const raw = payload || {};
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
  const rows = await supabaseSelectRows(
    env,
    `approval_cases?project_key=eq.${encodeURIComponent(projectKey)}&select=*&order=created_at.desc&limit=${limit}`
  );

  const customerIds = uniqueTruthy(rows.map((row) => row.customer_id));
  const messageIds = uniqueTruthy(rows.map((row) => row.trigger_message_id));
  const customers = await selectSupabaseRowsByIds(env, "customers", customerIds, "id,external_customer_id,phone_e164,display_name,profile");
  const messages = await selectSupabaseRowsByIds(env, "messages", messageIds, "id,provider_message_id,text,message_at,metadata,content,customer_id");
  const customerById = objectById(customers);
  const messageById = objectById(messages);

  const items = rows.map((row) => approvalCaseRowToDashboardItem(row, {
    customer: customerById[row.customer_id] || null,
    message: messageById[row.trigger_message_id] || null
  }));
  const legacy = await fetchLegacyApprovalItems(request, env, projectKey);
  const mergedItems = mergeApprovalItems(items, legacy.items);

  return json({
    ok: true,
    source: legacy.items.length ? "supabase_approval_cases_plus_legacy" : "supabase_approval_cases",
    runtime: "HermasProjectAgent",
    project_key: projectKey,
    items: mergedItems.slice(0, limit),
    count: mergedItems.length,
    supabase_count: items.length,
    legacy_count: legacy.items.length,
    legacy_error: legacy.error || null,
    auto_send_enabled: false,
    auto_trigger_flows_enabled: false
  });
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
  const inboundText = firstString(row.customer_last_text, message.text, normalized.text);
  const messageAt = firstString(message.message_at, normalized.message_at, row.created_at);
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
  const category = dashboardCategoryFromApprovalCase(row);
  const actionType = dashboardActionTypeFromApprovalCase(row, decision);

  return withoutUndefined({
    id: row.id,
    project_key: row.project_key,
    status: dashboardStatusFromApprovalCase(row),
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
      text: row.suggested_reply || decision.reply_text || "",
      stage_after: row.stage || decision.stage || normalized.stage || "",
      model: row.data?.decision?.source_refs?.includes("model:openai_in_agent") ? "openai" : "hermas_agents"
    },
    action: {
      type: actionType,
      label: row.reason || decision.reason || row.next_action || "等待客服确认",
      operator_instruction: row.reason || decision.reason || "检查后才发送。"
    },
    decision: {
      signals: {
        intent: row.intent || decision.intent || "approval",
        customer_intent: row.intent || decision.intent || "approval",
        risk_level: row.risk_level || decision.risk_level || "medium",
        risk: row.risk_level || decision.risk_level || "medium",
        stage: row.stage || decision.stage || normalized.stage || "",
        stage_key: row.stage || decision.stage || normalized.stage || "",
        tags: uniqueTruthy([
          row.intent || decision.intent,
          row.risk_level || decision.risk_level,
          row.stage || decision.stage || normalized.stage
        ])
      },
      delivery: {
        mode: "approval_first",
        send_now: false,
        trigger_flow_now: false
      }
    },
    risk_level: row.risk_level || decision.risk_level || "medium",
    source_status: row.status,
    next_action: row.next_action || decision.next_action || "",
    raw: {
      case_id: row.id,
      queue_bucket: row.queue_bucket,
      confidence: row.confidence
    }
  });
}

function dashboardStatusFromApprovalCase(row) {
  const status = String(row.status || "").toLowerCase();
  const bucket = String(row.queue_bucket || "").toLowerCase();
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
  if (row.queue_bucket === "human" || row.status === "handoff" || action === "handoff") return "ask_team";
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

function hasSupabase(env) {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY && !String(env.SUPABASE_URL).includes("YOUR_PROJECT"));
}

function verifyAdminToken(request, env) {
  const expected = env.ADMIN_TOKEN || env.HERMAS_ADMIN_TOKEN;
  if (!expected) return json({ ok: false, error: "admin_token_not_configured" }, 503);

  const authorization = request.headers.get("authorization") || "";
  const bearer = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : "";
  const provided = request.headers.get("x-admin-token") || bearer;

  if (provided && provided === expected) return null;
  return json({ ok: false, error: "invalid_admin_token" }, 401);
}

function verifyStaffOrAdminToken(request, env) {
  const expectedStaff = env.HERMAS_STAFF_TOKEN || env.STAFF_TOKEN || env.AGENT_STAFF_TOKEN;
  const expectedAdmin = env.ADMIN_TOKEN || env.HERMAS_ADMIN_TOKEN;
  if (!expectedStaff && !expectedAdmin) {
    return json({ ok: false, error: "staff_token_not_configured" }, 503);
  }

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
  return json({ ok: false, error: "invalid_staff_token" }, 401);
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
  return JSON.parse(text);
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
