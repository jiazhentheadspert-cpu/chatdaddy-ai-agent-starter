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
      await persistSupabaseMessage(this.env, normalized, payload);

      const contactKey = await stableContactKey(normalized);
      const conversationAgent = await getAgentByName(
        this.env.HermasConversationAgent,
        `conv:${projectKey}:${contactKey}`
      );
      const decisionResponse = await conversationAgent.fetch(new Request("https://agent.local/decide", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ normalized, payload })
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
        persistence: decisionBody.persistence || null
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
      const { normalized, payload } = await readJson(request);
      const deterministicDecision = decideApprovalFirst(normalized);
      const decision = await maybeImproveDraftWithModel(this.env, normalized, deterministicDecision);
      this.recordDecision(normalized, decision);
      const persistence = await persistSupabaseDecision(this.env, normalized, decision, payload);
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

    const webhookMatch = url.pathname.match(/^\/api\/channels\/chatdaddy\/webhook\/([^/]+)$/);
    if (request.method === "POST" && webhookMatch) {
      const connectionId = decodeURIComponent(webhookMatch[1]);
      const body = await request.text();
      const projectKey = normalizeProjectKey(url.searchParams.get("project_key") || env.AGENT_PROJECT_KEY || "beyoute");
      const projectAgent = await getAgentByName(env.HermasProjectAgent, `project:${projectKey}`);
      return projectAgent.fetch(new Request(`https://agent.local/intake/chatdaddy?connection_id=${encodeURIComponent(connectionId)}`, {
        method: "POST",
        headers: request.headers,
        body
      }));
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
  const payload = {
    project_key: normalized.project_key,
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
      raw_payload_shape_seen: Boolean(rawPayload)
    }
  };
  return supabaseInsert(env, "messages", payload);
}

async function persistSupabaseDecision(env, normalized, decision, rawPayload) {
  const out = {
    ai_decision: { attempted: false, reason: "supabase_not_configured" },
    approval_case: { attempted: false, reason: "not_required" }
  };
  if (!hasSupabase(env)) return out;

  out.ai_decision = await supabaseInsert(env, "ai_decisions", {
    project_key: normalized.project_key,
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
    out.approval_case = await supabaseInsert(env, "approval_cases", {
      project_key: normalized.project_key,
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
      project_key: normalized.project_key,
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

async function supabaseInsert(env, table, payload) {
  try {
    const response = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "content-type": "application/json",
        prefer: "return=representation"
      },
      body: JSON.stringify(payload)
    });
    const body = await response.text();
    if (!response.ok) {
      return { attempted: true, ok: false, table, status: response.status, error: compactError(body) };
    }
    return { attempted: true, ok: true, table, rows: body ? JSON.parse(body).length : 0 };
  } catch (error) {
    return { attempted: true, ok: false, table, error: error.message || String(error) };
  }
}

function hasSupabase(env) {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY && !String(env.SUPABASE_URL).includes("YOUR_PROJECT"));
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
