const VERSION = "chatdaddy-ai-agent-starter-0.1.0";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,authorization,x-admin-token,x-webhook-secret",
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

    const url = new URL(request.url);
    const projectKey = url.searchParams.get("project_key") || env.PROJECT_KEY || "demo";

    try {
      if (url.pathname === "/health") {
        return json({
          ok: true,
          version: VERSION,
          project_key: projectKey,
          auto_send: env.AUTO_SEND === "true",
        });
      }

      if (url.pathname === "/api/channels/chatdaddy/webhook" && request.method === "POST") {
        return handleChatDaddyWebhook(request, env, projectKey);
      }

      if (url.pathname === "/api/cases" && request.method === "GET") {
        requireAdmin(request, env);
        return listCases(env, projectKey);
      }

      const approveMatch = url.pathname.match(/^\/api\/cases\/([^/]+)\/approve$/);
      if (approveMatch && request.method === "POST") {
        requireAdmin(request, env);
        return approveCase(request, env, projectKey, decodeURIComponent(approveMatch[1]));
      }

      const learnMatch = url.pathname.match(/^\/api\/cases\/([^/]+)\/learn$/);
      if (learnMatch && request.method === "POST") {
        requireAdmin(request, env);
        return learnCase(request, env, projectKey, decodeURIComponent(learnMatch[1]));
      }

      const handoffMatch = url.pathname.match(/^\/api\/cases\/([^/]+)\/handoff$/);
      if (handoffMatch && request.method === "POST") {
        requireAdmin(request, env);
        return markHandoff(request, env, projectKey, decodeURIComponent(handoffMatch[1]));
      }

      return json({ ok: false, error: "not_found" }, 404);
    } catch (error) {
      return json({ ok: false, error: error.message || String(error) }, error.status || 500);
    }
  },
};

async function handleChatDaddyWebhook(request, env, projectKey) {
  verifyWebhook(request, env);

  const payload = await readJson(request);
  const inbound = extractInboundMessage(payload);

  if (!inbound.text) {
    return json({ ok: true, ignored: true, reason: "no_customer_text" });
  }

  if (inbound.direction && inbound.direction !== "inbound") {
    return json({ ok: true, ignored: true, reason: "not_inbound" });
  }

  const decision = await decide(env, projectKey, inbound);
  const storedCase = await upsertCase(env, projectKey, inbound, decision, payload);

  let sendResult = { attempted: false, reason: "AUTO_SEND is off" };
  if (decision.send_now && env.AUTO_SEND === "true") {
    sendResult = await sendChatDaddyReply(env, inbound, decision.reply_message);
    await appendHistory(env, projectKey, storedCase.id, {
      type: sendResult.ok ? "auto_sent" : "send_failed",
      at: new Date().toISOString(),
      reply_message: decision.reply_message,
      send_result: sendResult,
    });
  }

  await logToGoogleSheet(env, projectKey, inbound, decision, storedCase, sendResult);

  return json({
    ok: true,
    case_id: storedCase.id,
    decision,
    send_result: sendResult,
  });
}

async function decide(env, projectKey, inbound) {
  if (isStepOneKeywordLead(inbound.text || "")) {
    return rulesDecision(inbound);
  }

  if (env.OPENAI_API_KEY && (env.AI_PROVIDER || "openai") === "openai") {
    try {
      const aiDecision = await decideWithOpenAI(env, projectKey, inbound);
      return enforceReplyPolicy(normalizeDecision(aiDecision, "openai"), inbound, env);
    } catch (error) {
      const fallback = rulesDecision(inbound);
      fallback.reason = `AI fallback: ${error.message || String(error)}`;
      return fallback;
    }
  }

  return rulesDecision(inbound);
}

async function decideWithOpenAI(env, projectKey, inbound) {
  const profile = safeJsonParse(env.PROJECT_PROFILE_JSON, {});
  const system = [
    "You are a WhatsApp sales/support AI Agent.",
    "Your job is not only to reply. You decide the next commercial action.",
    "Classify stage, intent, risk, and whether a human must approve.",
    "Use a concise Malaysian Chinese tone if the customer uses Chinese.",
    "Never make medical/legal/financial guarantees.",
    "Return valid JSON only.",
  ].join("\n");

  const user = {
    project_key: projectKey,
    project_profile: profile,
    customer: inbound.contact,
    customer_message: inbound.text,
    required_json_shape: {
      reply_message: "string",
      intent: "faq | price_objection | buy_intent | order_info | receipt | complaint | health_sensitive | unclear",
      stage: "S1 | S2 | S3 | CLOSING | ORDER | FOLLOW_UP | HUMAN",
      risk: "low | medium | high",
      action: "send_reply | approve_reply | ask_human | collect_order | review_receipt | trigger_flow | wait",
      send_now: "boolean",
      reason: "short reason",
      keywords: ["short word cloud keywords"],
    },
  };

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(user) },
      ],
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI error ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI returned empty content");
  return JSON.parse(content);
}

function rulesDecision(inbound) {
  const text = inbound.text || "";
  const lower = text.toLowerCase();

  if (isStepOneKeywordLead(text)) {
    return normalizeDecision({
      reply_message: "ChatDaddy 已经根据关键词进入 Step 1，AI 不额外发送文字。",
      intent: "keyword_lead",
      stage: "S1",
      risk: "low",
      action: "trigger_flow",
      send_now: false,
      reason: "顾客从广告关键词进来，由 ChatDaddy Step 1 自动流程处理，AI 不重复回复。",
      keywords: ["关键词进线", "Step 1", "不额外回复"],
    }, "rules");
  }

  if (/(投诉|生气|骗子|退款|退钱|cancel|refund|complaint)/i.test(text)) {
    return normalizeDecision({
      reply_message: "我先帮你转给人工同事处理，这类情况我们需要看清楚记录后再回复你。",
      intent: "complaint",
      stage: "HUMAN",
      risk: "high",
      action: "ask_human",
      send_now: false,
      reason: "投诉或退款需要人工处理",
      keywords: ["投诉", "转人工", "高风险"],
    }, "rules");
  }

  if (/(怀孕|药|病|医生|医院|diabetes|pregnant|medicine|medical)/i.test(text)) {
    return normalizeDecision({
      reply_message: "这个我不乱回答，我先帮你转给同事确认比较安全。",
      intent: "health_sensitive",
      stage: "HUMAN",
      risk: "high",
      action: "ask_human",
      send_now: false,
      reason: "健康敏感问题需要人工确认",
      keywords: ["健康", "安全", "转人工"],
    }, "rules");
  }

  if (/(receipt|收据|付款|转账|bank|transfer|paid|已付)/i.test(lower)) {
    return normalizeDecision({
      reply_message: "收到，我先帮你检查付款资料。确认好了会继续帮你处理订单。",
      intent: "receipt",
      stage: "ORDER",
      risk: "medium",
      action: "review_receipt",
      send_now: false,
      reason: "付款或 receipt 需要审核",
      keywords: ["付款", "审核", "订单"],
    }, "rules");
  }

  if (/(下单|我要|留一套|cod|地址|电话|名字|order|buy)/i.test(lower)) {
    return normalizeDecision({
      reply_message: "可以，我帮你处理。麻烦发我：名字、电话、地址、要的配套，我确认后再提交订单。",
      intent: "buy_intent",
      stage: "ORDER",
      risk: "medium",
      action: "collect_order",
      send_now: false,
      reason: "顾客有下单意图，需要收资料",
      keywords: ["下单", "收资料", "订单"],
    }, "rules");
  }

  if (/(贵|便宜|考虑|想想|问老公|问老婆|问家人|expensive|price|cheap|consider)/i.test(lower)) {
    return normalizeDecision({
      reply_message: "明白的，价钱会考虑是正常的。你先不要单看价格，重点是它能不能解决你现在最在意的问题。你最担心的是效果、价格，还是安全？",
      intent: "price_objection",
      stage: "CLOSING",
      risk: "medium",
      action: "approve_reply",
      send_now: false,
      reason: "看价后异议，建议人工批准成交话术",
      keywords: ["嫌贵", "考虑", "成交"],
    }, "rules");
  }

  if (/(多久|有效|效果|怎么用|一天|几次|how long|effect|use)/i.test(lower)) {
    return normalizeDecision({
      reply_message: "亲，效果会看个人体质和配合度。多数顾客会先感觉排便和肚子比较轻；认真配合的人通常 1-2 周会比较明显。我先帮你看它主要怎样帮你处理。",
      intent: "faq",
      stage: "S1",
      risk: "medium",
      action: "approve_reply",
      send_now: false,
      reason: "顾客开始问用法或效果，需要客服确认后再发，避免 AI 自动乱回。",
      keywords: ["顾客疑问", "效果", "待批准"],
    }, "rules");
  }

  return normalizeDecision({
    reply_message: "收到，我先看你的情况再回复你。你现在最在意的是效果、价格，还是安全感？",
    intent: "unclear",
    stage: "S1",
    risk: "medium",
    action: "approve_reply",
    send_now: false,
    reason: "顾客讯息需要人工确认语境，不自动回复。",
    keywords: ["需要判断", "手动回复", "待批准"],
  }, "rules");
}

function normalizeDecision(input, source) {
  const risk = ["low", "medium", "high"].includes(input.risk) ? input.risk : "medium";
  const action = input.action || (risk === "high" ? "ask_human" : risk === "medium" ? "approve_reply" : "send_reply");
  const sendNow = Boolean(input.send_now) && risk === "low" && action === "send_reply";

  return {
    reply_message: String(input.reply_message || "我先帮你确认一下。").trim(),
    intent: input.intent || "unclear",
    stage: input.stage || "S1",
    risk,
    action,
    send_now: sendNow,
    reason: input.reason || "No reason provided",
    keywords: Array.isArray(input.keywords) ? input.keywords.slice(0, 8) : [],
    source,
  };
}

function enforceReplyPolicy(decision, inbound, env) {
  const text = inbound.text || "";
  if (isStepOneKeywordLead(text)) {
    return normalizeDecision({
      reply_message: "ChatDaddy 已经根据关键词进入 Step 1，AI 不额外发送文字。",
      intent: "keyword_lead",
      stage: "S1",
      risk: "low",
      action: "trigger_flow",
      send_now: false,
      reason: "顾客从广告关键词进来，由 ChatDaddy Step 1 自动流程处理，AI 不重复回复。",
      keywords: ["关键词进线", "Step 1", "不额外回复"],
    }, decision.source || "policy");
  }

  if (decision.send_now && env.ALLOW_AI_AUTO_REPLY !== "true") {
    return {
      ...decision,
      risk: decision.risk === "high" ? "high" : "medium",
      action: decision.action === "ask_human" ? "ask_human" : "approve_reply",
      send_now: false,
      reason: `顾客有疑问或需要语境判断，先让客服确认。原判断：${decision.reason}`,
      keywords: uniqueWords([...(decision.keywords || []), "手动回复", "待批准"]).slice(0, 8),
    };
  }

  return decision;
}

function isStepOneKeywordLead(text) {
  const value = normalizeText(text);
  if (!value) return false;

  const hasQuestionOrConcern = /(？|\?|吗|怎样|怎么|多久|效果|可以|没有|怕|担心|贵|考虑|试过|产品|下单|地址|电话|付款|receipt|refund|投诉|药|怀孕|病|医生)/i.test(value);
  if (hasQuestionOrConcern) return false;

  const keywordLeads = [
    "我要了解beyoute",
    "我要了解beyoute+阻碳kombucha",
    "了解beyoute",
    "beyoute+阻碳kombucha",
    "beyoute阻碳kombucha",
    "阻碳kombucha",
  ];

  return keywordLeads.some((keyword) => value.includes(keyword));
}

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[💚💕❤️❤🌹🎉✨\s]/g, "")
    .trim();
}

function uniqueWords(words) {
  return [...new Set(words.filter(Boolean))];
}

async function upsertCase(env, projectKey, inbound, decision, rawPayload) {
  const kv = getKV(env);
  const caseId = inbound.conversationId || inbound.messageId || crypto.randomUUID();
  const key = caseKey(projectKey, caseId);
  const now = new Date().toISOString();
  const existing = safeJsonParse(await kv.get(key), null);

  const status = decision.risk === "high"
    ? "human_required"
    : decision.action === "collect_order" || decision.action === "review_receipt"
      ? "order"
      : decision.action === "trigger_flow" || decision.action === "wait"
        ? "auto"
      : decision.send_now
        ? "auto"
        : "approval_required";

  const nextCase = {
    id: caseId,
    project_key: projectKey,
    status,
    contact: inbound.contact,
    last_message: inbound.text,
    last_message_at: inbound.createdAt || now,
    updated_at: now,
    created_at: existing?.created_at || now,
    latest_decision: decision,
    word_cloud: buildWordCloud(inbound.text, decision),
    messages: [...(existing?.messages || []), {
      id: inbound.messageId,
      direction: "inbound",
      text: inbound.text,
      at: inbound.createdAt || now,
    }].slice(-20),
    history: [...(existing?.history || []), {
      type: "ai_decision",
      at: now,
      decision,
    }].slice(-50),
    raw_payload_sample: rawPayload,
  };

  await kv.put(key, JSON.stringify(nextCase), { expirationTtl: 60 * 60 * 24 * 90 });
  return nextCase;
}

async function listCases(env, projectKey) {
  const kv = getKV(env);
  const listed = await kv.list({ prefix: `case:${projectKey}:`, limit: 1000 });
  const cases = [];

  for (const item of listed.keys) {
    const record = safeJsonParse(await kv.get(item.name), null);
    if (record) cases.push(record);
  }

  cases.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));

  return json({
    ok: true,
    project_key: projectKey,
    count: cases.length,
    cases,
  });
}

async function approveCase(request, env, projectKey, caseId) {
  const kv = getKV(env);
  const key = caseKey(projectKey, caseId);
  const record = safeJsonParse(await kv.get(key), null);
  if (!record) return json({ ok: false, error: "case_not_found" }, 404);

  const body = await readJson(request);
  const reply = String(body.reply_message || record.latest_decision?.reply_message || "").trim();
  if (!reply) return json({ ok: false, error: "reply_message_required" }, 400);

  const inbound = {
    contact: record.contact,
    conversationId: record.id,
  };

  const sendResult = await sendChatDaddyReply(env, inbound, reply);
  const now = new Date().toISOString();
  const updated = {
    ...record,
    status: sendResult.ok ? "sent" : "send_failed",
    updated_at: now,
    latest_reply_sent: reply,
    history: [...(record.history || []), {
      type: sendResult.ok ? "approved_sent" : "approved_send_failed",
      at: now,
      reply_message: reply,
      send_result: sendResult,
    }].slice(-50),
  };

  await kv.put(key, JSON.stringify(updated), { expirationTtl: 60 * 60 * 24 * 90 });
  return json({ ok: sendResult.ok, case: updated, send_result: sendResult });
}

async function learnCase(request, env, projectKey, caseId) {
  const kv = getKV(env);
  const key = caseKey(projectKey, caseId);
  const record = safeJsonParse(await kv.get(key), null);
  if (!record) return json({ ok: false, error: "case_not_found" }, 404);

  const now = new Date().toISOString();
  const rule = {
    id: crypto.randomUUID(),
    project_key: projectKey,
    created_at: now,
    source_case_id: caseId,
    keywords: record.word_cloud || record.latest_decision?.keywords || [],
    intent: record.latest_decision?.intent,
    risk: record.latest_decision?.risk,
    reply_message: record.latest_reply_sent || record.latest_decision?.reply_message,
    note: "Human marked this pattern as safe to reuse. Review before using for full auto-send.",
  };

  await kv.put(`learned_rule:${projectKey}:${rule.id}`, JSON.stringify(rule));
  await appendHistory(env, projectKey, caseId, {
    type: "learned_rule_created",
    at: now,
    rule_id: rule.id,
  });

  return json({ ok: true, rule });
}

async function markHandoff(request, env, projectKey, caseId) {
  const kv = getKV(env);
  const key = caseKey(projectKey, caseId);
  const record = safeJsonParse(await kv.get(key), null);
  if (!record) return json({ ok: false, error: "case_not_found" }, 404);

  const body = await readJson(request);
  const now = new Date().toISOString();
  const updated = {
    ...record,
    status: "human_required",
    updated_at: now,
    history: [...(record.history || []), {
      type: "marked_handoff",
      at: now,
      note: body.note || "",
    }].slice(-50),
  };

  await kv.put(key, JSON.stringify(updated), { expirationTtl: 60 * 60 * 24 * 90 });
  return json({ ok: true, case: updated });
}

async function appendHistory(env, projectKey, caseId, event) {
  const kv = getKV(env);
  const key = caseKey(projectKey, caseId);
  const record = safeJsonParse(await kv.get(key), null);
  if (!record) return;
  record.history = [...(record.history || []), event].slice(-50);
  record.updated_at = event.at || new Date().toISOString();
  await kv.put(key, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 90 });
}

async function sendChatDaddyReply(env, inbound, replyMessage) {
  if (!env.CHATDADDY_API_KEY) {
    return { ok: false, attempted: false, reason: "CHATDADDY_API_KEY missing" };
  }

  if (!env.CHATDADDY_REPLY_BOT_ID) {
    return { ok: false, attempted: false, reason: "CHATDADDY_REPLY_BOT_ID missing" };
  }

  const toContact = inbound.contact?.id || inbound.contact?.phone;
  if (!toContact) {
    return { ok: false, attempted: false, reason: "contact id or phone missing" };
  }

  const base = env.CHATDADDY_BOTS_FIRE_BASE || "https://api-bots.chatdaddy.tech";
  const url = `${base.replace(/\/$/, "")}/bots/${encodeURIComponent(env.CHATDADDY_REPLY_BOT_ID)}/fire`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.CHATDADDY_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      accountId: env.CHATDADDY_ACCOUNT_ID || undefined,
      toContact,
      parameters: {
        reply_message: replyMessage,
        text: replyMessage,
      },
      metadata: {
        source: "chatdaddy-ai-agent-starter",
        conversation_id: inbound.conversationId,
      },
    }),
  });

  const text = await response.text();
  return {
    ok: response.ok,
    attempted: true,
    status: response.status,
    response: text.slice(0, 1000),
  };
}

async function logToGoogleSheet(env, projectKey, inbound, decision, storedCase, sendResult) {
  if (!env.GOOGLE_SHEET_WEB_APP_URL || !env.GOOGLE_SHEET_SECRET) return;

  const url = new URL(env.GOOGLE_SHEET_WEB_APP_URL);
  url.searchParams.set("secret", env.GOOGLE_SHEET_SECRET);

  await fetch(url.toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      project_key: projectKey,
      case_id: storedCase.id,
      contact_name: inbound.contact?.name || "",
      contact_phone: inbound.contact?.phone || "",
      customer_message: inbound.text,
      ai_reply: decision.reply_message,
      intent: decision.intent,
      risk: decision.risk,
      stage: decision.stage,
      action: decision.action,
      send_status: sendResult.ok ? "sent" : sendResult.attempted ? "failed" : "pending",
      reason: decision.reason,
      created_at: new Date().toISOString(),
    }),
  });
}

function extractInboundMessage(payload) {
  const message = payload.message || payload.data?.message || payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0] || {};
  const contact = payload.contact || payload.customer || payload.data?.contact || {};
  const conversation = payload.conversation || payload.chat || payload.data?.conversation || {};

  const text = firstString(
    message.text,
    message.body,
    message.content,
    message.text?.body,
    payload.text,
    payload.body,
  );

  return {
    messageId: firstString(message.id, payload.messageId, payload.id) || crypto.randomUUID(),
    conversationId: firstString(conversation.id, payload.conversationId, payload.chatId, contact.id, contact.phone),
    direction: firstString(message.direction, payload.direction) || "inbound",
    text,
    createdAt: firstString(message.createdAt, message.timestamp, payload.createdAt) || new Date().toISOString(),
    contact: {
      id: firstString(contact.id, contact.contactId, payload.contactId),
      name: firstString(contact.name, contact.displayName, payload.name) || "Customer",
      phone: firstString(contact.phone, contact.phoneNumber, contact.whatsapp, payload.phone),
    },
  };
}

function verifyWebhook(request, env) {
  if (!env.CHATDADDY_WEBHOOK_SECRET) return;
  const url = new URL(request.url);
  const incoming = request.headers.get("x-webhook-secret") || url.searchParams.get("secret");
  if (incoming !== env.CHATDADDY_WEBHOOK_SECRET) {
    const error = new Error("invalid_webhook_secret");
    error.status = 401;
    throw error;
  }
}

function requireAdmin(request, env) {
  if (!env.ADMIN_TOKEN) {
    const error = new Error("ADMIN_TOKEN is not configured");
    error.status = 500;
    throw error;
  }

  const url = new URL(request.url);
  const token = request.headers.get("x-admin-token") || url.searchParams.get("token");
  if (token !== env.ADMIN_TOKEN) {
    const error = new Error("unauthorized");
    error.status = 401;
    throw error;
  }
}

function getKV(env) {
  if (!env.AGENT_KV) {
    const error = new Error("AGENT_KV binding is missing");
    error.status = 500;
    throw error;
  }
  return env.AGENT_KV;
}

function caseKey(projectKey, caseId) {
  return `case:${projectKey}:${caseId}`;
}

function buildWordCloud(text, decision) {
  const words = [...(decision.keywords || [])];
  const candidates = [
    ["贵", "嫌贵"],
    ["考虑", "考虑"],
    ["多久", "多久有效"],
    ["效果", "效果"],
    ["下单", "下单"],
    ["地址", "资料"],
    ["receipt", "Receipt"],
    ["付款", "付款"],
    ["投诉", "投诉"],
  ];

  for (const [needle, label] of candidates) {
    if (String(text).toLowerCase().includes(needle.toLowerCase()) && !words.includes(label)) {
      words.push(label);
    }
  }

  if (!words.includes(decision.stage)) words.push(decision.stage);
  return words.slice(0, 8);
}

async function readJson(request) {
  const text = await request.text();
  if (!text) return {};
  return JSON.parse(text);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...CORS_HEADERS,
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return "";
}

function safeJsonParse(value, fallback) {
  try {
    if (!value) return fallback;
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
