const VERSION = "chatdaddy-ai-agent-starter-0.1.0";

const CORS_HEADERS = {
  "access-control-allow-origin": "https://jiazhentheadspert-cpu.github.io",
  "access-control-allow-methods": "GET,POST,PATCH,OPTIONS",
  "access-control-allow-headers": "content-type,authorization,x-admin-token,x-staff-token,x-operator-token,x-webhook-secret",
  "access-control-allow-credentials": "true",
  vary: "Origin",
};

const HERMAS_SESSION_COOKIE = "hermas_session";
const HERMAS_SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const HERMAS_PASSWORD_ITERATIONS = 120000;

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeadersForRequest(request) });

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

      if (url.pathname === "/api/auth/login" && request.method === "POST") {
        const payload = await readJson(request);
        return handleAuthLogin(payload, env, request);
      }

      if (url.pathname === "/api/auth/logout" && request.method === "POST") {
        return handleAuthLogout(env, request);
      }

      if (url.pathname === "/api/auth/session" && request.method === "GET") {
        return handleAuthSession(env, request);
      }

      if (url.pathname === "/api/me/projects" && request.method === "GET") {
        const auth = await requireOperator(request, env, { returnAuth: true });
        return authJson({ ok: true, projects: await listProjectsForUser(env, auth.user || null, projectKey, auth.role) }, 200, request);
      }

      if (url.pathname === "/api/admin/users" && request.method === "GET") {
        await requireAdmin(request, env);
        return handleAdminUsersList(env, request);
      }

      if (url.pathname === "/api/admin/users" && request.method === "POST") {
        const auth = await requireAdmin(request, env, { returnAuth: true });
        const payload = await readJson(request);
        return handleAdminUserCreate(payload, env, request, auth);
      }

      const adminUserMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
      if (adminUserMatch && request.method === "PATCH") {
        const auth = await requireAdmin(request, env, { returnAuth: true });
        const payload = await readJson(request);
        return handleAdminUserPatch(decodeURIComponent(adminUserMatch[1]), payload, env, request, auth);
      }

      const adminUserResetMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/reset-password$/);
      if (adminUserResetMatch && request.method === "POST") {
        const auth = await requireAdmin(request, env, { returnAuth: true });
        const payload = await readJson(request);
        return handleAdminUserResetPassword(decodeURIComponent(adminUserResetMatch[1]), payload, env, request, auth);
      }

      const adminMemberMatch = url.pathname.match(/^\/api\/admin\/projects\/([^/]+)\/members$/);
      if (adminMemberMatch && request.method === "POST") {
        const auth = await requireAdmin(request, env, { returnAuth: true });
        const payload = await readJson(request);
        return handleAdminProjectMemberSave(decodeURIComponent(adminMemberMatch[1]), payload, env, request, auth);
      }

      if (url.pathname === "/api/channels/chatdaddy/webhook" && request.method === "POST") {
        return handleChatDaddyWebhook(request, env, projectKey);
      }

      if (url.pathname === "/api/cases" && request.method === "GET") {
        await requireAdmin(request, env);
        return listCases(env, projectKey);
      }

      if (url.pathname === "/api/approvals/pending" && request.method === "GET") {
        await requireOperator(request, env);
        return listApprovalItems(env, projectKey, url);
      }

      if (url.pathname === "/api/meta-capi/status" && request.method === "GET") {
        return metaCapiStatus(env);
      }

      if (url.pathname === "/api/usage/summary" && request.method === "GET") {
        await requireOperator(request, env);
        return usageSummary(env, projectKey);
      }

      const hermasMarkPurchaseMatch = url.pathname.match(/^\/api\/hermas\/projects\/([^/]+)\/cases\/([^/]+)\/mark-purchase$/);
      if (hermasMarkPurchaseMatch && request.method === "POST") {
        const auth = await requireOperator(request, env, { returnAuth: true });
        return markPurchaseCase(request, env, decodeURIComponent(hermasMarkPurchaseMatch[1]), decodeURIComponent(hermasMarkPurchaseMatch[2]), auth);
      }

      const hermasProjectMatch = url.pathname.match(/^\/api\/hermas\/projects\/([^/]+)\/(.+)$/);
      if (hermasProjectMatch) {
        return handleHermasProjectAdminApi(request, env, decodeURIComponent(hermasProjectMatch[1]), hermasProjectMatch[2], url);
      }

      const approveMatch = url.pathname.match(/^\/api\/cases\/([^/]+)\/approve$/);
      if (approveMatch && request.method === "POST") {
        const auth = await requireAdmin(request, env, { returnAuth: true });
        return approveCase(request, env, projectKey, decodeURIComponent(approveMatch[1]), auth);
      }

      const learnMatch = url.pathname.match(/^\/api\/cases\/([^/]+)\/learn$/);
      if (learnMatch && request.method === "POST") {
        await requireAdmin(request, env);
        return learnCase(request, env, projectKey, decodeURIComponent(learnMatch[1]));
      }

      const handoffMatch = url.pathname.match(/^\/api\/cases\/([^/]+)\/handoff$/);
      if (handoffMatch && request.method === "POST") {
        const auth = await requireAdmin(request, env, { returnAuth: true });
        return markHandoff(request, env, projectKey, decodeURIComponent(handoffMatch[1]), auth);
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
  const purchaseWebhook = extractPurchaseFromWebhook(payload, inbound, projectKey);

  if (purchaseWebhook.detected) {
    return handleChatDaddyPurchaseWebhook(env, projectKey, inbound, purchaseWebhook, payload);
  }

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

async function handleChatDaddyPurchaseWebhook(env, projectKey, inbound, purchaseWebhook, payload) {
  const config = metaCapiConfig(env);
  if (!purchaseWebhook.amount_rm) {
    return json({
      ok: true,
      ignored: true,
      purchase_detected: true,
      reason: "purchase_status_detected_but_amount_missing",
      required: ["amount_rm", "order_value", "currency", "order_id"],
    });
  }

  const now = new Date().toISOString();
  const purchase = {
    amount_rm: purchaseWebhook.amount_rm,
    value: purchaseWebhook.amount_rm,
    currency: purchaseWebhook.currency,
    order_id: purchaseWebhook.order_id,
    payment_status: purchaseWebhook.payment_status,
    purchase_status: purchaseWebhook.purchase_status,
    order_status: purchaseWebhook.order_status,
    confirmed_at: now,
    confirmed_by: "chatdaddy_webhook",
    source: "chatdaddy_paid_webhook",
  };
  const caseId = purchaseWebhook.case_id;
  const record = {
    id: caseId,
    project_key: projectKey,
    status: "purchase_confirmed",
    created_at: now,
    updated_at: now,
    contact: inbound.contact,
    messages: inbound.text ? [{
      id: inbound.messageId,
      direction: "inbound",
      text: inbound.text,
      at: inbound.createdAt,
    }] : [],
    last_message: inbound.text || purchaseWebhook.last_message || "",
    last_message_at: inbound.createdAt || now,
    latest_decision: {
      intent: "purchase_confirmed",
      stage: "ORDER",
      risk: "low",
      action: "purchase_confirmed",
      keywords: ["purchase", "paid", "confirmed"],
      source: "chatdaddy_webhook",
    },
    amount_rm: purchase.amount_rm,
    order_value: purchase.value,
    currency: purchase.currency,
    order_id: purchase.order_id,
    payment_status: purchase.payment_status,
    purchase_status: purchase.purchase_status,
    order_status: purchase.order_status,
    purchase,
    raw_webhook: payload,
    history: [{
      type: "chatdaddy_purchase_confirmed",
      at: now,
      amount_rm: purchase.amount_rm,
      currency: purchase.currency,
      order_id: purchase.order_id,
    }],
  };

  await getKV(env).put(caseKey(projectKey, caseId), JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 90 });
  const metaCapi = await sendPurchaseToMetaCapi(env, record, purchase, {
    confirmMetaSend: config.purchaseAutoTrack,
  });
  const updated = {
    ...record,
    meta_capi_purchase_result: metaCapi,
  };
  await getKV(env).put(caseKey(projectKey, caseId), JSON.stringify(updated), { expirationTtl: 60 * 60 * 24 * 90 });

  return json({
    ok: true,
    purchase_detected: true,
    project_key: projectKey,
    case_id: caseId,
    item: caseToApprovalItem(updated),
    purchase,
    meta_capi: metaCapi,
    next: config.purchaseAutoTrack
      ? "Purchase webhook was recorded and sent or attempted through Meta CAPI."
      : "Purchase webhook was recorded. META_CAPI_PURCHASE_AUTO_TRACK is off, so Meta was not sent.",
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
    "PWP/RM68/add-on is a special promo eligibility question. Do not answer with the normal package price ladder; ask staff to confirm eligibility/current order first.",
    "Return valid JSON only.",
  ].join("\n");

  const user = {
    project_key: projectKey,
    project_profile: profile,
    customer: inbound.contact,
    customer_message: inbound.text,
    required_json_shape: {
      reply_message: "string",
      intent: "faq | price_objection | buy_intent | order_info | receipt | complaint | health_sensitive | special_promo_addon | unclear",
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
  const decision = JSON.parse(content);
  await logAIUsage(env, {
    projectKey,
    provider: "openai",
    model: env.OPENAI_MODEL || "gpt-4o-mini",
    feature: "reply_decision",
    eventId: inbound.messageId || inbound.conversationId || "",
    intent: decision.intent || "",
    usage: data.usage || {},
  });
  return decision;
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
      reply_message: "亲，我先帮你看清楚记录再回复你。这类情况我不会乱承诺，确认后再给你准确处理。",
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
      reply_message: "亲，这个我不乱回答。我先确认清楚你的情况，安全一点再回复你。",
      intent: "health_sensitive",
      stage: "HUMAN",
      risk: "high",
      action: "ask_human",
      send_now: false,
      reason: "健康敏感问题需要人工确认",
      keywords: ["健康", "安全", "转人工"],
    }, "rules");
  }

  if (/(\bpwp\b|rm\s*68|rm68|add[\s-]?on|addon|加购|加購|换购|換購|only\s+can\s+buy\s+here|can\s+buy\s+here\s+only)/i.test(text)) {
    return normalizeDecision({
      reply_message: "PWP RM68 add-on 是特别加购，不是普通配套价钱。它通常只限指定活动或符合条件的订单，我先不要乱确认资格；我这边会先看当前活动和订单能不能加购，再继续安排。",
      intent: "special_promo_addon",
      stage: "CLOSING",
      risk: "medium",
      action: "approve_reply",
      send_now: false,
      reason: "PWP/RM68/add-on 需要确认活动资格和当前订单，不能套普通价格图。",
      keywords: ["PWP/RM68", "特别加购", "先确认资格"],
    }, "rules");
  }

  if (/(电子钱包|電子钱包|電子錢包|e\s*-?\s*wallet|ewallet|grab\s*pay|grabpay|tng|touch\s*['’]?\s*n\s*go|duitnow|fpx|qr\s*pay|payment\s*link|payex|有收.*(?:银行卡|銀行卡|信用卡|debit|credit|card)|(?:银行卡|銀行卡|信用卡|debit\s*card|credit\s*card|bank\s*card|card\s*payment).*(?:可以|能|收|accept|pay|payment)|(?:可以|能|收|accept).*(?:银行卡|銀行卡|信用卡|debit\s*card|credit\s*card|bank\s*card)|(?:can|could|do\s+you|u|you|accept|take|pay|payment|use).{0,30}(?:credit\s*card|debit\s*card|bank\s*card|card\s*payment|card|e\s*-?\s*wallet|ewallet|grab\s*pay|grabpay)|(?:credit\s*card|debit\s*card|bank\s*card|card\s*payment|e\s*-?\s*wallet|ewallet|grab\s*pay|grabpay).{0,30}(?:can|pay|accept|use|payment|ok|available|allowed|right|correct))/i.test(text)) {
    return normalizeDecision({
      reply_message: "付款方式我先不要乱确认。电子钱包/GrabPay、线上付款、银行卡、分期或 COD 都要看当前订单、金额、地区和付款渠道安排；我这边先确认清楚，避免你填错或重复付款。",
      intent: "payment_method_issue",
      stage: "ORDER",
      risk: "medium",
      action: "ask_human",
      send_now: false,
      reason: "付款方式需要确认当前订单、金额和渠道，不能直接承诺。",
      keywords: ["付款方式", "eWallet/GrabPay", "先确认"],
    }, "rules");
  }

  if (isExplicitPaymentReceiptMessage(text)) {
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

  if (isExplicitOrderIntent(text)) {
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

  if (/(贵|便宜|考虑|想想|问老公|问老婆|问家人|expensive|price|cheap|cheaper|discount|lower\s+price|best\s+price|think\s+about|think\s+first|decide\s+later|later\s+first|consider)/i.test(lower)) {
    if (looksMostlyEnglish(text)) {
      const isConsider = /(consider|think\s+about|think\s+first|decide\s+later|later)/i.test(lower);
      return normalizeDecision({
        reply_message: isConsider
          ? "No worries, you can think about it first. Beyoute Plus+ is more suitable when your goal is belly, bowel movement or weight management, because it supports carb control, fat-burning support, bowel movement and skin glow in one plan. To decide easier: 1 box RM150 is for trying first, 2 boxes RM258 is lighter on budget, and 3 boxes RM378 is better for a proper beginner course. Do you want me to reserve one first, or should I suggest based on your target?"
          : "I understand, budget is important. Beyoute Plus+ is not just about one box price; the value is that one plan supports carb control, fat-burning support, bowel movement and skin glow together. If you want to keep it light, start with 1 box RM150. If you want better value, 2 boxes RM258 is easier on budget. If you want a proper course, 3 boxes RM378 is the main beginner course. Which one would you like me to arrange for you?",
        intent: isConsider ? "consider" : "price_objection",
        stage: "CLOSING",
        risk: "medium",
        action: "approve_reply",
        send_now: false,
        reason: "English post-price objection/consideration should be handled in English with value proof and CTA.",
        keywords: ["English", "price objection", "CTA"],
      }, "rules");
    }
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

  if (looksMostlyEnglish(text) && /(what\s+is\s+(this|it|the\s+product)|what\s+does\s+it\s+do|explain|product|beyoute|kombucha)/i.test(lower)) {
    return normalizeDecision({
      reply_message: "Hi, let me explain it simply. Beyoute Plus+ is a slimming and beauty Kombucha. It mainly supports carb control, fat-burning support, bowel movement and skin glow in one plan. It is not a normal meal replacement, and you can check product details, brand info and customer feedback before deciding.",
      intent: "faq",
      stage: "S1",
      risk: "low",
      action: "trigger_flow",
      send_now: true,
      reason: "English product-intro question can be answered in English before continuing the education flow.",
      keywords: ["English", "product intro", "Step 1"],
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

function looksMostlyEnglish(text = "") {
  const value = String(text || "");
  const chineseChars = (value.match(/[\u4e00-\u9fff]/g) || []).length;
  const englishWords = (value.match(/[a-zA-Z]{2,}/g) || []).length;
  return chineseChars === 0 && englishWords >= 2;
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
      reason: `顾客有疑问或需要语境判断，先人工检查。原判断：${decision.reason}`,
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

function isExplicitPaymentReceiptMessage(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  if (/^\s*[\[【(（]?\s*(?:付款截图|付款證明|付款证明|收据|收據|receipt|payment\s*proof|image|photo)\s*[\]】)）]?\s*$/i.test(value)) {
    return false;
  }
  return /(?:我|已|已经|已經|刚|剛|刚刚|剛剛).{0,12}(?:付款|付钱|付錢|转账|轉賬|汇款|匯款|bank\s*in|transfer|paid)|(?:付款|付钱|付錢|转账|轉賬|汇款|匯款).{0,12}(?:了|啦|咯|好了|过了|過了|done|completed)|\b(?:paid|already\s+paid|paid\s+already|banked\s*in|transferred|payment\s*(?:already\s*)?made|payment\s*done|payment\s*completed)\b/i.test(value);
}

function isExplicitOrderIntent(text) {
  const value = String(text || "").trim();
  if (!value || isStepOneKeywordLead(value)) return false;
  if (/我要了解|想了解|了解\s*beyoute|beyoute\+?阻碳|阻碳\s*kombucha/i.test(value)) return false;
  return /(?:我要|要|想|帮我|幫我|可以).{0,10}(?:下单|下單|买|買|订|訂|order|购买|購買|安排)(?:.{0,12}(?:一套|一盒|配套|cod|货到付款|貨到付款))?|(?:下单|下單|留一套|留一盒|帮我安排|幫我安排|cod|货到付款|貨到付款|order\s+now|i\s+want\s+to\s+(?:order|buy)|i['’]?ll\s+(?:take|buy|order))/i.test(value);
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

async function listApprovalItems(env, projectKey, url) {
  const kv = getKV(env);
  const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") || 30), 100));
  const listed = await kv.list({ prefix: `case:${projectKey}:`, limit: 1000 });
  const items = [];

  for (const item of listed.keys) {
    const record = safeJsonParse(await kv.get(item.name), null);
    if (record) items.push(caseToApprovalItem(record));
  }

  items.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));

  return json({
    ok: true,
    project_key: projectKey,
    count: items.length,
    items: items.slice(0, limit),
  });
}

async function approveCase(request, env, projectKey, caseId, auth = null) {
  const kv = getKV(env);
  const key = caseKey(projectKey, caseId);
  const record = safeJsonParse(await kv.get(key), null);
  if (!record) return json({ ok: false, error: "case_not_found" }, 404);

  const body = await readJson(request);
  const operator = runtimeOperatorIdentity(auth, body);
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
    approved_at: now,
    approved_by: operator.name,
    approved_by_id: operator.id,
    operator_id: operator.id,
    operator_name: operator.name,
    operator_role: operator.role,
    latest_reply_sent: reply,
    history: [...(record.history || []), {
      type: sendResult.ok ? "approved_sent" : "approved_send_failed",
      at: now,
      operator_id: operator.id,
      operator_name: operator.name,
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

async function markHandoff(request, env, projectKey, caseId, auth = null) {
  const kv = getKV(env);
  const key = caseKey(projectKey, caseId);
  const record = safeJsonParse(await kv.get(key), null);
  if (!record) return json({ ok: false, error: "case_not_found" }, 404);

  const body = await readJson(request);
  const operator = runtimeOperatorIdentity(auth, body);
  const now = new Date().toISOString();
  const updated = {
    ...record,
    status: "human_required",
    updated_at: now,
    handoff_at: now,
    handoff_by: operator.name,
    handoff_by_id: operator.id,
    operator_id: operator.id,
    operator_name: operator.name,
    operator_role: operator.role,
    history: [...(record.history || []), {
      type: "marked_handoff",
      at: now,
      operator_id: operator.id,
      operator_name: operator.name,
      note: body.note || "",
    }].slice(-50),
  };

  await kv.put(key, JSON.stringify(updated), { expirationTtl: 60 * 60 * 24 * 90 });
  return json({ ok: true, case: updated });
}

async function markPurchaseCase(request, env, projectKey, caseId, auth = null) {
  const kv = getKV(env);
  const key = caseKey(projectKey, caseId);
  const record = safeJsonParse(await kv.get(key), null);
  if (!record) return json({ ok: false, error: "case_not_found" }, 404);

  const body = await readJson(request);
  const operator = runtimeOperatorIdentity(auth, body);
  const amount = purchaseAmountFromBody(body);
  if (!amount) {
    return json({ ok: false, error: "purchase_amount_required", next: "Enter amount_rm, for example 378." }, 400);
  }

  const now = new Date().toISOString();
  const currency = normalizeCurrency(body.currency || record.currency || record.purchase?.currency || "MYR");
  const orderId = String(body.order_id || body.orderId || record.order_id || record.purchase?.order_id || `${projectKey}_${caseId}`).replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 120);
  const purchase = {
    amount_rm: amount,
    value: amount,
    currency,
    order_id: orderId,
    payment_status: "paid",
    purchase_status: "confirmed",
    order_status: "confirmed",
    confirmed_at: now,
    confirmed_by: operator.name,
    confirmed_by_id: operator.id,
    source: body.source || "dashboard_mark_purchase",
  };

  const baseUpdated = {
    ...record,
    status: "purchase_confirmed",
    updated_at: now,
    purchase_confirmed_at: now,
    purchase_confirmed_by: operator.name,
    purchase_confirmed_by_id: operator.id,
    operator_id: operator.id,
    operator_name: operator.name,
    operator_role: operator.role,
    amount_rm: amount,
    order_value: amount,
    currency,
    order_id: orderId,
    purchase_status: purchase.purchase_status,
    payment_status: purchase.payment_status,
    order_status: purchase.order_status,
    purchase,
    history: [...(record.history || []), {
      type: "case_purchase_confirmed",
      at: now,
      amount_rm: amount,
      currency,
      order_id: orderId,
      operator_id: operator.id,
      operator_name: operator.name,
    }].slice(-50),
  };

  await kv.put(key, JSON.stringify(baseUpdated), { expirationTtl: 60 * 60 * 24 * 90 });

  const metaCapi = await sendPurchaseToMetaCapi(env, baseUpdated, purchase, body);
  const updated = {
    ...baseUpdated,
    meta_capi_purchase_result: metaCapi,
  };

  await kv.put(key, JSON.stringify(updated), { expirationTtl: 60 * 60 * 24 * 90 });

  return json({
    ok: true,
    item: caseToApprovalItem(updated),
    case: updated,
    purchase,
    meta_capi: metaCapi,
    next: metaCapi.sent
      ? "Purchase and amount were recorded and sent to Meta CAPI."
      : metaCapi.deduped
        ? "Purchase was recorded. Meta CAPI duplicate was blocked."
        : metaCapi.configured
          ? "Purchase was recorded, but Meta CAPI did not confirm send."
          : "Purchase was recorded. Add Meta Pixel ID and CAPI Access Token, then resend Meta CAPI if needed.",
  });
}

function caseToApprovalItem(record = {}) {
  const decision = record.latest_decision || {};
  const contact = record.contact || {};
  const status = approvalStatusFromCase(record);
  const category = approvalCategoryFromCase(record);
  return {
    id: record.id,
    project_key: record.project_key,
    status,
    category,
    created_at: record.created_at,
    updated_at: record.updated_at,
    customer: {
      name: contact.name || "Customer",
      phone: contact.phone || "",
      chat_id: contact.id || contact.phone || record.id,
    },
    inbound: {
      text: record.last_message || record.messages?.find((msg) => msg.direction === "inbound")?.text || "",
      message_at: record.last_message_at || record.created_at,
      event_id: record.id,
      provider_message_id: record.messages?.[0]?.id || record.id,
    },
    reply: {
      text: record.latest_reply_sent || decision.reply_message || "",
      stage_after: decision.stage || "S1",
      model: decision.source || "starter",
    },
    action: {
      type: decision.action || "approve_reply",
      label: actionLabel(decision.action),
      headline: actionLabel(decision.action),
      badges: record.word_cloud || decision.keywords || [],
    },
    decision: {
      signals: {
        intent: decision.intent || "unclear",
        stage: decision.stage || "S1",
        risk_level: decision.risk || "medium",
        needs_approval: status === "pending",
      },
      delivery: {
        mode: decision.send_now ? "auto_send" : "approval",
        will_send_now: false,
        will_trigger_flow_now: false,
      },
      ui: {
        headline: actionLabel(decision.action),
        operator_instruction: decision.reason || "",
      },
    },
    final_text: record.latest_reply_sent || "",
    approved_at: record.approved_at || null,
    approved_by: record.approved_by || null,
    send_result: record.send_result || null,
    purchase: record.purchase || null,
    amount_rm: record.amount_rm || record.purchase?.amount_rm || null,
    order_value: record.order_value || record.purchase?.value || null,
    currency: record.currency || record.purchase?.currency || null,
    order_id: record.order_id || record.purchase?.order_id || null,
    purchase_status: record.purchase_status || record.purchase?.purchase_status || null,
    payment_status: record.payment_status || record.purchase?.payment_status || null,
    order_status: record.order_status || record.purchase?.order_status || null,
    meta_capi_purchase_result: record.meta_capi_purchase_result || null,
  };
}

function approvalStatusFromCase(record = {}) {
  if (record.status === "purchase_confirmed") return "purchase_confirmed";
  if (record.status === "sent") return "sent";
  if (record.status === "send_failed") return "send_failed";
  if (record.status === "sending") return "sending";
  if (record.status === "human_required") return "pending";
  if (record.status === "order") return "pending";
  if (record.status === "auto") return "sent";
  return "pending";
}

function approvalCategoryFromCase(record = {}) {
  if (record.status === "human_required") return "human";
  if (record.status === "order" || /order|receipt|payment/i.test(record.latest_decision?.action || "")) return "order";
  if (record.status === "auto") return "auto";
  if (record.status === "purchase_confirmed") return "order";
  return "approval";
}

function actionLabel(action) {
  if (action === "ask_human") return "转人工";
  if (action === "collect_order") return "收资料";
  if (action === "review_receipt") return "审付款截图";
  if (action === "trigger_flow") return "接 Flow";
  if (action === "send_reply") return "AI 自动回复";
  return "批准发送";
}

function purchaseAmountFromBody(body = {}) {
  const candidates = [body.amount_rm, body.amount, body.order_value, body.value];
  for (const candidate of candidates) {
    const value = Number(String(candidate ?? "").replace(/rm/ig, "").replace(/,/g, "").trim());
    if (Number.isFinite(value) && value > 0) return Math.round(value * 100) / 100;
  }
  return null;
}

function normalizeCurrency(value) {
  return String(value || "MYR").trim().toUpperCase().replace(/[^A-Z]/g, "") || "MYR";
}

function metaCapiConfig(env) {
  const pixelId = String(env.META_CAPI_PIXEL_ID || "").trim();
  const accessToken = String(env.META_CAPI_ACCESS_TOKEN || "").trim();
  const graphVersion = String(env.META_CAPI_GRAPH_VERSION || "v23.0").trim() || "v23.0";
  return {
    configured: Boolean(pixelId && accessToken),
    pixelId,
    accessToken,
    graphVersion,
    endpoint: `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(pixelId)}/events`,
    autoTrack: env.META_CAPI_AUTO_TRACK === "true",
    purchaseAutoTrack: env.META_CAPI_PURCHASE_AUTO_TRACK === "true",
  };
}

function metaCapiStatus(env) {
  const config = metaCapiConfig(env);
  return json({
    ok: true,
    meta_capi: {
      configured: config.configured,
      auto_track_enabled: config.autoTrack,
      purchase_auto_track_enabled: config.purchaseAutoTrack,
      pixel_id_present: Boolean(config.pixelId),
      access_token_present: Boolean(config.accessToken),
      graph_version: config.graphVersion,
    },
  });
}

async function handleHermasProjectAdminApi(request, env, projectKey, routePath, url) {
  const route = String(routePath || "").replace(/^\/+|\/+$/g, "");
  if (route === "learning-notes" && request.method === "POST") {
    await requireAdmin(request, env);
    return createHermasLearningNote(request, env, projectKey);
  }

  if (request.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);
  await requireAdmin(request, env);

  if (route === "learning-notes") {
    return listHermasLearningNotes(env, projectKey, url);
  }

  if (route === "package/versions") {
    return hermasDashboardReport(env, projectKey, "package_versions");
  }

  const routeToReport = {
    "quality-review": "quality_review",
    "handoff-learning-review": "handoff_learning_review",
    "owner-review-workbench": "owner_review_workbench",
    "owner-decision-signoff-packet": "owner_decision_signoff_packet",
    "owner-decision-signoff-audit": "owner_decision_signoff_audit",
    "daily-operating-brief": "daily_operating_brief",
    "operating-action-queue": "operating_action_queue",
    "quality-lift-repair-queue": "quality_lift_repair_queue",
  };
  const reportKey = routeToReport[route];
  if (!reportKey) return json({ ok: false, error: "not_found" }, 404);
  return hermasDashboardReport(env, projectKey, reportKey);
}

async function hermasDashboardReport(env, projectKey, reportKey) {
  const config = HERMAS_REPORT_CONFIG[reportKey];
  if (!config) return json({ ok: false, error: "unknown_report" }, 404);
  const raw = await readHermasDashboardReport(env, projectKey, config);
  const fallback = config.empty ? config.empty(projectKey) : {};
  const payload = raw ? sanitizeDashboardReport(raw) : fallback;
  return json({
    ok: true,
    project_key: projectKey,
    configured: Boolean(raw),
    ...payload,
    sends_messages: false,
    uses_openai: false,
    writes_dashboard: false,
    writes_decisions: false,
    changes_business_brain: false,
    changes_runtime: false,
    pushes_git: false,
  });
}

const HERMAS_REPORT_CONFIG = {
  package_versions: {
    key: "package_versions",
    env: "HERMAS_PACKAGE_VERSIONS_JSON",
    empty: () => ({ versions: [] }),
  },
  quality_review: {
    key: "quality_review",
    env: "HERMAS_QUALITY_REVIEW_JSON",
    empty: () => ({ summary: {}, scorecard: null, reviews: [] }),
  },
  handoff_learning_review: {
    key: "handoff_learning_review",
    env: "HERMAS_HANDOFF_LEARNING_REVIEW_JSON",
    empty: () => ({ summary: {}, needs_fix: [], recommendations: [] }),
  },
  owner_review_workbench: {
    key: "owner_review_workbench",
    env: "HERMAS_OWNER_REVIEW_WORKBENCH_JSON",
    empty: () => ({ summary: {}, decision_cards: [], review_batches: [], owner_fast_queue: { items: [] } }),
  },
  owner_decision_signoff_packet: {
    key: "owner_decision_signoff_packet",
    env: "HERMAS_OWNER_DECISION_SIGNOFF_PACKET_JSON",
    empty: () => ({
      preview_only: true,
      owner_signoff: { required: true, present: false },
      summary: {
        owner_signature_present: false,
        ready_for_owner_signature: false,
        ready_for_it_manual_template_edit_after_owner_signature: false,
        source_pending: 0,
        pending_after_preview: 0,
        source_p0_pending: 0,
        p0_pending_after_preview: 0,
      },
    }),
  },
  owner_decision_signoff_audit: {
    key: "owner_decision_signoff_audit",
    env: "HERMAS_OWNER_DECISION_SIGNOFF_AUDIT_JSON",
    empty: () => ({
      preview_only: true,
      summary: {
        audit_status: "WAITING_OWNER_SIGNOFF_DATA",
        owner_signature_present: false,
        blocked_signature_count: 0,
        official_template_pending_decisions: 0,
        ready_for_completion_gate_rerun: false,
        ready_for_learning_preview: false,
      },
      audit_items: [],
    }),
  },
  daily_operating_brief: {
    key: "daily_operating_brief",
    env: "HERMAS_DAILY_OPERATING_BRIEF_JSON",
    empty: () => ({ summary: {}, owner_today: {}, staff_today: {}, it_today: {} }),
  },
  operating_action_queue: {
    key: "operating_action_queue",
    env: "HERMAS_OPERATING_ACTION_QUEUE_JSON",
    empty: () => ({ summary: {}, today_sequence: [], operating_contract: {} }),
  },
  quality_lift_repair_queue: {
    key: "quality_lift_repair_queue",
    env: "HERMAS_QUALITY_LIFT_REPAIR_QUEUE_JSON",
    empty: () => ({
      summary: {},
      queue_items: [],
      handoff_self_optimization_contract: { stages: [] },
    }),
  },
};

async function readHermasDashboardReport(env, projectKey, config) {
  const kvValue = await readHermasDashboardReportFromKv(env, projectKey, config);
  if (kvValue) return kvValue;
  for (const envName of hermasReportEnvNames(projectKey, config.env)) {
    const value = env[envName];
    const parsed = safeJsonParse(value, null);
    if (parsed) return parsed;
  }
  return null;
}

async function readHermasDashboardReportFromKv(env, projectKey, config) {
  if (!env.AGENT_KV) return null;
  const keys = [
    `hermas:${projectKey}:${config.key}`,
    `hermas:${projectKey}:${config.key.replace(/_/g, "-")}`,
    `hermas_report:${projectKey}:${config.key}`,
  ];
  for (const key of keys) {
    const parsed = safeJsonParse(await env.AGENT_KV.get(key), null);
    if (parsed) return parsed;
  }
  return null;
}

function hermasReportEnvNames(projectKey, envName) {
  const project = String(projectKey || "demo").toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const suffix = String(envName || "").replace(/^HERMAS_/, "");
  return [`HERMAS_${project}_${suffix}`, envName];
}

function sanitizeDashboardReport(value, key = "", depth = 0) {
  if (depth > 20) return null;
  if (Array.isArray(value)) return value.map((item) => sanitizeDashboardReport(item, key, depth + 1));
  if (value && typeof value === "object") {
    const output = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      if (isDashboardReportInternalKey(entryKey)) continue;
      const sanitized = sanitizeDashboardReport(entryValue, entryKey, depth + 1);
      if (sanitized !== undefined) output[entryKey] = sanitized;
    }
    return output;
  }
  if (typeof value === "string" && looksLikeLocalOrSecretPath(value)) return "";
  return value;
}

function isDashboardReportInternalKey(key = "") {
  return /^(schema_version|source_.+|artifacts?|raw_.+|secret|token)$/i.test(String(key || ""));
}

function looksLikeLocalOrSecretPath(value = "") {
  const text = String(value || "");
  return /\/Users\/|\/var\/folders\/|\\Users\\|hermas_ai\/|secrets\/|\.env\b/i.test(text);
}

async function listHermasLearningNotes(env, projectKey, url) {
  const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") || 6), 50));
  const report = await readHermasDashboardReport(env, projectKey, {
    key: "learning_notes",
    env: "HERMAS_LEARNING_NOTES_JSON",
  });
  const notes = Array.isArray(report?.learning_notes)
    ? report.learning_notes
    : Array.isArray(report)
      ? report
      : [];
  return json({
    ok: true,
    project_key: projectKey,
    learning_notes: sanitizeDashboardReport(notes).slice(0, limit),
    sends_messages: false,
    writes_decisions: false,
    changes_runtime: false,
  });
}

async function createHermasLearningNote(request, env, projectKey) {
  const body = await readJson(request);
  const now = new Date().toISOString();
  const note = sanitizeDashboardReport({
    ...body,
    note_id: body.note_id || crypto.randomUUID(),
    project_key: projectKey,
    status: body.status || "reviewed",
    created_at: body.created_at || now,
    sends_messages: false,
    writes_decisions: false,
    changes_runtime: false,
  });

  if (env.AGENT_KV) {
    const key = `hermas:${projectKey}:learning_notes`;
    const existing = safeJsonParse(await env.AGENT_KV.get(key), {});
    const current = Array.isArray(existing.learning_notes) ? existing.learning_notes : Array.isArray(existing) ? existing : [];
    const learningNotes = [note, ...current].slice(0, 100);
    await env.AGENT_KV.put(key, JSON.stringify({ learning_notes: learningNotes, updated_at: now }));
    return json({ ok: true, recorded: true, storage: "kv", learning_note: note });
  }

  return json({
    ok: true,
    recorded: false,
    storage: "none",
    learning_note: note,
    next: "Bind AGENT_KV or set HERMAS_LEARNING_NOTES_JSON to persist learning notes.",
  });
}

async function sendPurchaseToMetaCapi(env, record, purchase, body = {}) {
  const config = metaCapiConfig(env);
  const wantsLiveSend = body.confirmMetaSend !== false;
  const event = await buildPurchaseCapiEvent(record, purchase);
  const capiPayload = { data: [event] };

  if (!wantsLiveSend || !config.configured) {
    return {
      configured: config.configured,
      sent: false,
      preview_only: true,
      event_name: "Purchase",
      event_id: event.event_id,
      reason: wantsLiveSend
        ? "META_CAPI_PIXEL_ID and META_CAPI_ACCESS_TOKEN are required."
        : "confirmMetaSend=true is required to send Purchase to Meta.",
    };
  }

  const dedupe = await claimPurchaseDedupe(env, purchase);
  if (dedupe.duplicate) {
    return {
      configured: true,
      sent: false,
      skipped: true,
      deduped: true,
      already_sent: dedupe.existing?.status === "sent",
      dedupe_key: dedupe.key,
      reason: "Duplicate Purchase blocked: this order_id + amount + currency was already queued or sent.",
      event_name: "Purchase",
      event_id: event.event_id,
    };
  }

  const endpoint = new URL(config.endpoint);
  endpoint.searchParams.set("access_token", config.accessToken);
  try {
    const response = await fetch(endpoint.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(capiPayload),
    });
    const result = {
      configured: true,
      sent: response.ok,
      status: response.status,
      body: (await response.text()).slice(0, 1000),
      event_name: "Purchase",
      event_id: event.event_id,
      dedupe_key: dedupe.key || undefined,
    };
    await finalizePurchaseDedupe(env, dedupe, result);
    return result;
  } catch (error) {
    await finalizePurchaseDedupe(env, dedupe, { sent: false });
    throw error;
  }
}

async function buildPurchaseCapiEvent(record = {}, purchase = {}) {
  const phone = String(record.contact?.phone || "").replace(/\D/g, "");
  const userData = {};
  if (phone) userData.ph = [await sha256Hex(phone)];
  if (record.contact?.id || record.id) userData.external_id = [await sha256Hex(String(record.contact?.id || record.id))];

  return {
    event_name: "Purchase",
    event_time: Math.floor(Date.now() / 1000),
    event_id: `purchase_${record.id}_${purchase.order_id}`,
    action_source: "business_messaging",
    user_data: userData,
    custom_data: {
      currency: purchase.currency,
      value: purchase.value,
      order_id: purchase.order_id,
      content_name: record.project_key || "WhatsApp Purchase",
      source: "chatdaddy_ai_agent_starter",
    },
  };
}

async function claimPurchaseDedupe(env, purchase = {}) {
  const key = purchaseDedupeKey(purchase);
  const kv = getKV(env);
  const existing = safeJsonParse(await kv.get(key), null);
  if (existing?.status === "pending" || existing?.status === "sent") {
    return { key, duplicate: true, existing };
  }
  await kv.put(key, JSON.stringify({
    status: "pending",
    order_id: purchase.order_id,
    value: purchase.value,
    currency: purchase.currency,
    claimed_at: new Date().toISOString(),
  }), { expirationTtl: 60 * 60 * 24 * 3 });
  return { key, claimed: true };
}

async function finalizePurchaseDedupe(env, claim, result) {
  if (!claim?.claimed || !claim.key) return;
  const kv = getKV(env);
  if (result?.sent) {
    await kv.put(claim.key, JSON.stringify({
      status: "sent",
      sent_at: new Date().toISOString(),
    }), { expirationTtl: 60 * 60 * 24 * 90 });
    return;
  }
  await kv.delete(claim.key);
}

function purchaseDedupeKey(purchase = {}) {
  return [
    "meta_capi_purchase_dedupe",
    normalizeCurrency(purchase.currency),
    String(purchase.order_id || "").replace(/[^a-zA-Z0-9_-]+/g, "_"),
    Number(purchase.value || purchase.amount_rm || 0).toFixed(2),
  ].join(":");
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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

function extractPurchaseFromWebhook(payload = {}, inbound = {}, projectKey = "demo") {
  const fields = extractWebhookCustomFields(payload);
  const paymentStatus = normalizeStatus(firstString(
    fields.payment_status,
    fields.paymentStatus,
    payload.payment_status,
    payload.paymentStatus,
    payload.data?.payment_status,
  ));
  const purchaseStatus = normalizeStatus(firstString(
    fields.purchase_status,
    fields.purchaseStatus,
    payload.purchase_status,
    payload.purchaseStatus,
    payload.data?.purchase_status,
  ));
  const orderStatus = normalizeStatus(firstString(
    fields.order_status,
    fields.orderStatus,
    payload.order_status,
    payload.orderStatus,
    payload.data?.order_status,
  ));
  const amount = purchaseAmountFromBody({
    amount_rm: fields.amount_rm ?? fields.amountRm ?? payload.amount_rm ?? payload.data?.amount_rm,
    amount: fields.amount ?? payload.amount,
    order_value: fields.order_value ?? fields.orderValue ?? payload.order_value ?? payload.data?.order_value,
    value: fields.value ?? payload.value,
  });
  const currency = normalizeCurrency(firstString(fields.currency, payload.currency, payload.data?.currency, "MYR"));
  const orderId = firstString(
    fields.order_id,
    fields.orderId,
    payload.order_id,
    payload.orderId,
    payload.data?.order_id,
    payload.data?.orderId,
  );
  const explicitPaid = ["paid", "payment_paid", "payment_confirmed", "cod_confirmed", "cash_on_delivery_confirmed"].includes(paymentStatus);
  const explicitPurchase = ["confirmed", "purchase_confirmed", "purchased", "complete", "completed", "won"].includes(purchaseStatus);
  const explicitOrder = ["confirmed", "paid", "cod_confirmed", "complete", "completed"].includes(orderStatus);
  const eventText = normalizeStatus(firstString(payload.event, payload.type, payload.data?.event_type, payload.data?.eventType));
  const eventLooksPurchase = /purchase|payment_confirmed|paid|cod_confirmed|order_confirmed/.test(eventText);
  const statusDetected = explicitPaid || explicitPurchase || explicitOrder || eventLooksPurchase;
  const fallbackId = firstString(
    payload.data?.event_id,
    payload.event_id,
    payload.id,
    inbound.messageId,
    orderId,
  ) || crypto.randomUUID();
  const safeOrderId = String(orderId || `${projectKey}_${fallbackId}`)
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .slice(0, 120);

  return {
    detected: statusDetected,
    amount_rm: amount,
    currency,
    order_id: safeOrderId,
    payment_status: paymentStatus || (explicitPurchase ? "paid" : ""),
    purchase_status: purchaseStatus || (explicitPaid ? "confirmed" : ""),
    order_status: orderStatus || "confirmed",
    case_id: `purchase_${safeOrderId}`.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 140),
    last_message: firstString(payload.data?.message?.text, payload.message?.text, payload.text, ""),
    custom_fields: fields,
  };
}

function extractWebhookCustomFields(payload = {}) {
  const contact = payload.contact || payload.customer || payload.data?.contact || {};
  const data = payload.data || {};
  const candidates = [
    payload.custom_fields,
    payload.customFields,
    payload.fields,
    payload.customFieldValues,
    data.custom_fields,
    data.customFields,
    data.fields,
    data.customFieldValues,
    contact.custom_fields,
    contact.customFields,
    contact.fields,
    contact.customFieldValues,
  ];
  const output = {};
  for (const candidate of candidates) {
    Object.assign(output, normalizeCustomFieldObject(candidate));
  }
  return output;
}

function normalizeCustomFieldObject(value) {
  if (!value) return {};
  if (Array.isArray(value)) {
    return value.reduce((acc, field) => {
      const key = firstString(field?.name, field?.key, field?.id, field?.field);
      if (key) acc[key] = field?.value ?? field?.text ?? field?.raw_value ?? "";
      return acc;
    }, {});
  }
  if (typeof value === "object") return { ...value };
  return {};
}

function normalizeStatus(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_/-]+/g, "");
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

async function logAIUsage(env, record) {
  if (!env.APPROVAL_DB) return { ok: false, skipped: true };
  await ensureUsageSchema(env);
  const usage = normalizeUsage(record.usage);
  const inputRate = positiveNumber(env.OPENAI_SALES_BRAIN_INPUT_USD_PER_MTOK, 1);
  const outputRate = positiveNumber(env.OPENAI_SALES_BRAIN_OUTPUT_USD_PER_MTOK, 8);
  const estimatedCost = roundCost((usage.input_tokens / 1000000) * inputRate + (usage.output_tokens / 1000000) * outputRate);
  const now = new Date().toISOString();
  const id = `usage:${record.projectKey}:${record.provider}:${record.eventId || crypto.randomUUID()}:${now}`;
  await env.APPROVAL_DB.prepare(`
    INSERT INTO ai_usage_logs (
      id, project_key, provider, model, feature, case_id, event_id, intent,
      input_tokens, output_tokens, total_tokens, estimated_cost_usd, created_at, data
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id.slice(0, 240),
    record.projectKey,
    record.provider,
    record.model,
    record.feature,
    record.eventId || "",
    record.eventId || "",
    record.intent || "",
    usage.input_tokens,
    usage.output_tokens,
    usage.total_tokens,
    estimatedCost,
    now,
    JSON.stringify({
      feature: record.feature,
      intent: record.intent || "",
      pricing_unit: "usd_per_million_tokens",
      input_usd_per_mtok: inputRate,
      output_usd_per_mtok: outputRate,
    }),
  ).run();
  return { ok: true, estimated_cost_usd: estimatedCost };
}

async function usageSummary(env, projectKey) {
  if (!env.APPROVAL_DB) {
    return json({
      ok: true,
      project_key: projectKey,
      available: false,
      currency: "USD",
      mode_label: "省钱模式",
      today: emptyUsageSummary(),
      month: emptyUsageSummary(),
      note: "省钱模式已开；成本记录需要连接资料库后显示。",
    });
  }

  await ensureUsageSchema(env);
  const todayStart = usageWindowStartIso(env, "day");
  const monthStart = usageWindowStartIso(env, "month");
  const [today, month] = await Promise.all([
    usageSince(env, projectKey, todayStart),
    usageSince(env, projectKey, monthStart),
  ]);

  return json({
    ok: true,
    project_key: projectKey,
    available: true,
    currency: "USD",
    mode_label: "省钱模式",
    today,
    month,
    note: "普通问题先走规则；复杂成交问题才调用增强 AI。",
  });
}

async function usageSince(env, projectKey, sinceIso) {
  const row = await env.APPROVAL_DB.prepare(`
    SELECT COUNT(*) AS enhanced_replies, COALESCE(SUM(estimated_cost_usd), 0) AS estimated_cost_usd
    FROM ai_usage_logs
    WHERE project_key = ? AND created_at >= ?
  `).bind(projectKey, sinceIso).first();
  return {
    enhanced_replies: positiveInteger(row?.enhanced_replies),
    estimated_cost_usd: roundCost(row?.estimated_cost_usd || 0),
  };
}

async function ensureUsageSchema(env) {
  await env.APPROVAL_DB.prepare(`
    CREATE TABLE IF NOT EXISTS ai_usage_logs (
      id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      feature TEXT,
      case_id TEXT,
      event_id TEXT,
      intent TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      estimated_cost_usd REAL DEFAULT 0,
      created_at TEXT NOT NULL,
      data TEXT
    )
  `).run();
  await env.APPROVAL_DB.prepare(`
    CREATE INDEX IF NOT EXISTS ai_usage_project_created_idx
    ON ai_usage_logs (project_key, created_at DESC)
  `).run();
  await env.APPROVAL_DB.prepare(`
    CREATE INDEX IF NOT EXISTS ai_usage_project_feature_created_idx
    ON ai_usage_logs (project_key, feature, created_at DESC)
  `).run();
}

function normalizeUsage(usage = {}) {
  const inputTokens = positiveInteger(usage.input_tokens ?? usage.prompt_tokens);
  const outputTokens = positiveInteger(usage.output_tokens ?? usage.completion_tokens);
  const totalTokens = positiveInteger(usage.total_tokens ?? inputTokens + outputTokens);
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens || inputTokens + outputTokens,
  };
}

function emptyUsageSummary() {
  return {
    enhanced_replies: 0,
    estimated_cost_usd: 0,
  };
}

function usageWindowStartIso(env, unit) {
  const offsetHours = positiveNumber(env.OPERATING_TIMEZONE_OFFSET_HOURS, 8);
  const offsetMs = offsetHours * 60 * 60 * 1000;
  const shifted = new Date(Date.now() + offsetMs);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth();
  const day = shifted.getUTCDate();
  const localStartMs = unit === "month" ? Date.UTC(year, month, 1) : Date.UTC(year, month, day);
  return new Date(localStartMs - offsetMs).toISOString();
}

function positiveInteger(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.round(number);
}

function positiveNumber(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return number;
}

function roundCost(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * 10000) / 10000;
}

async function ensureAuthSchema(env) {
  if (!env.APPROVAL_DB) return;
  await env.APPROVAL_DB.prepare(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      password_hash TEXT NOT NULL,
      password_updated_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT,
      data TEXT NOT NULL DEFAULT '{}'
    )
  `).run();
  await env.APPROVAL_DB.prepare(`
    CREATE TABLE IF NOT EXISTS user_sessions (
      session_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      session_hash TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT,
      data TEXT NOT NULL DEFAULT '{}'
    )
  `).run();
  await env.APPROVAL_DB.prepare(`
    CREATE TABLE IF NOT EXISTS project_memberships (
      membership_id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}',
      UNIQUE(project_key, user_id)
    )
  `).run();
  await env.APPROVAL_DB.prepare(`
    CREATE TABLE IF NOT EXISTS audit_events (
      event_id TEXT PRIMARY KEY,
      project_key TEXT,
      actor_id TEXT,
      actor_role TEXT,
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_id TEXT,
      event_at TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}'
    )
  `).run();
  await env.APPROVAL_DB.prepare(`CREATE INDEX IF NOT EXISTS users_email_idx ON users (email)`).run();
  await env.APPROVAL_DB.prepare(`CREATE INDEX IF NOT EXISTS user_sessions_hash_idx ON user_sessions (session_hash)`).run();
  await env.APPROVAL_DB.prepare(`CREATE INDEX IF NOT EXISTS project_memberships_user_idx ON project_memberships (user_id, status)`).run();
  await env.APPROVAL_DB.prepare(`CREATE INDEX IF NOT EXISTS project_memberships_project_idx ON project_memberships (project_key, status)`).run();
  await env.APPROVAL_DB.prepare(`CREATE INDEX IF NOT EXISTS audit_events_project_time_idx ON audit_events (project_key, event_at DESC)`).run();
}

function corsHeadersForRequest(request) {
  const origin = request?.headers?.get?.("origin") || "";
  if (!origin || origin === "null") return { ...CORS_HEADERS, "access-control-allow-credentials": "true" };
  return { ...CORS_HEADERS, "access-control-allow-origin": origin, "access-control-allow-credentials": "true", vary: "Origin" };
}

function authJson(data, status = 200, request = null, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...(request ? corsHeadersForRequest(request) : CORS_HEADERS),
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function normalizeEmail(value = "") {
  return String(value || "").trim().toLowerCase();
}

function cleanProjectKey(value = "") {
  return String(value || "demo").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_") || "demo";
}

function cookieValue(request, name) {
  const cookie = String(request.headers.get("cookie") || "");
  for (const part of cookie.split(";").map((item) => item.trim())) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq) === name) return decodeURIComponent(part.slice(eq + 1));
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

function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value = "") {
  const padded = String(value || "").replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(String(value || "").length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function randomToken(bytes = 32) {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return base64UrlEncode(values);
}

function temporaryPassword() {
  return `${randomToken(9)}A1`;
}

async function hashPassword(password) {
  const clean = String(password || "");
  if (clean.length < 8) {
    const error = new Error("PASSWORD_TOO_SHORT");
    error.status = 400;
    throw error;
  }
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(clean), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: HERMAS_PASSWORD_ITERATIONS, hash: "SHA-256" }, key, 256);
  return `pbkdf2_sha256$${HERMAS_PASSWORD_ITERATIONS}$${base64UrlEncode(salt)}$${base64UrlEncode(new Uint8Array(bits))}`;
}

async function verifyPassword(password, storedHash) {
  const parts = String(storedHash || "").split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2_sha256") return false;
  const iterations = Number(parts[1]);
  const salt = base64UrlDecode(parts[2]);
  const expected = base64UrlDecode(parts[3]);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(password || "")), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, expected.length * 8);
  const actual = new Uint8Array(bits);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i += 1) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

function safeUser(row = {}) {
  return {
    user_id: row.user_id,
    email: row.email,
    name: row.name,
    role: row.role,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_login_at: row.last_login_at || null,
  };
}

function requestProjectKey(request) {
  const url = new URL(request.url);
  const hermasMatch = url.pathname.match(/^\/api\/hermas\/projects\/([^/]+)/);
  if (hermasMatch) return cleanProjectKey(decodeURIComponent(hermasMatch[1]));
  const adminProjectMatch = url.pathname.match(/^\/api\/admin\/projects\/([^/]+)/);
  if (adminProjectMatch) return cleanProjectKey(decodeURIComponent(adminProjectMatch[1]));
  return cleanProjectKey(url.searchParams.get("project_key") || envProjectFallback(url));
}

function envProjectFallback(url) {
  return url.searchParams.get("projectKey") || "demo";
}

async function listProjectsForUser(env, user, fallbackProject = "demo", fallbackRole = "staff") {
  await ensureAuthSchema(env);
  if (user?.role === "admin") {
    const rows = await env.APPROVAL_DB.prepare(`SELECT project_key, project_name FROM projects ORDER BY updated_at DESC LIMIT 200`).all().catch(() => ({ results: [] }));
    const projects = (rows?.results || []).map((row) => ({
      project_key: cleanProjectKey(row.project_key),
      project_name: row.project_name || row.project_key,
      role: "admin",
      status: "active",
    }));
    if (projects.length) return projects;
  }
  if (user?.user_id) {
    const rows = await env.APPROVAL_DB.prepare(`
      SELECT project_key, role, status FROM project_memberships
      WHERE user_id = ? AND status = 'active'
      ORDER BY updated_at DESC
    `).bind(user.user_id).all();
    const projects = (rows?.results || []).map((row) => ({
      project_key: cleanProjectKey(row.project_key),
      project_name: cleanProjectKey(row.project_key),
      role: row.role || user.role || "staff",
      status: row.status || "active",
    }));
    if (projects.length) return projects;
  }
  return [{
    project_key: cleanProjectKey(fallbackProject),
    project_name: cleanProjectKey(fallbackProject),
    role: fallbackRole || "staff",
    status: "active",
  }];
}

async function sessionAuth(request, env, options = {}) {
  if (!env.APPROVAL_DB) return null;
  const token = cookieValue(request, HERMAS_SESSION_COOKIE);
  if (!token) return null;
  await ensureAuthSchema(env);
  const sessionHash = await sha256Hex(token);
  const row = await env.APPROVAL_DB.prepare(`
    SELECT s.session_id, s.user_id, s.role AS session_role, s.status AS session_status, s.expires_at,
           u.email, u.name, u.role, u.status, u.created_at, u.updated_at, u.last_login_at
    FROM user_sessions s
    JOIN users u ON u.user_id = s.user_id
    WHERE s.session_hash = ?
    LIMIT 1
  `).bind(sessionHash).first();
  if (!row || row.session_status !== "active" || row.status !== "active" || new Date(row.expires_at).getTime() <= Date.now()) {
    return { ok: false, status: 401, error: "Session expired. Please login again." };
  }
  const user = safeUser(row);
  const role = user.role === "admin" ? "admin" : "staff";
  if (options.requireAdmin && role !== "admin") return { ok: false, status: 403, error: "Admin access required." };
  const projectKey = requestProjectKey(request);
  if (projectKey && role !== "admin") {
    const member = await env.APPROVAL_DB.prepare(`
      SELECT role FROM project_memberships
      WHERE user_id = ? AND project_key = ? AND status = 'active'
      LIMIT 1
    `).bind(user.user_id, projectKey).first();
    if (!member) return { ok: false, status: 403, error: "No access to this project.", project_key: projectKey };
  }
  await env.APPROVAL_DB.prepare(`UPDATE user_sessions SET last_seen_at = ? WHERE session_id = ?`).bind(new Date().toISOString(), row.session_id).run().catch(() => null);
  return { ok: true, subject: user.email, user_id: user.user_id, display_name: user.name, role, user, auth_type: "session" };
}

async function handleAuthLogin(payload, env, request) {
  if (!env.APPROVAL_DB) return authJson({ ok: false, error: "APPROVAL_DB D1 is not configured." }, 503, request);
  await ensureAuthSchema(env);
  const email = normalizeEmail(payload.email);
  const password = String(payload.password || "");
  const row = email ? await env.APPROVAL_DB.prepare(`SELECT * FROM users WHERE email = ? LIMIT 1`).bind(email).first() : null;
  if (!row || row.status !== "active" || !(await verifyPassword(password, row.password_hash))) {
    return authJson({ ok: false, error: "Invalid email or password." }, 401, request);
  }
  const now = new Date();
  const token = randomToken(36);
  const sessionId = randomId("sess");
  await env.APPROVAL_DB.prepare(`
    INSERT INTO user_sessions (session_id, user_id, session_hash, role, status, expires_at, created_at, last_seen_at, data)
    VALUES (?, ?, ?, ?, 'active', ?, ?, ?, '{}')
  `).bind(sessionId, row.user_id, await sha256Hex(token), row.role, new Date(now.getTime() + HERMAS_SESSION_TTL_SECONDS * 1000).toISOString(), now.toISOString(), now.toISOString()).run();
  await env.APPROVAL_DB.prepare(`UPDATE users SET last_login_at = ?, updated_at = ? WHERE user_id = ?`).bind(now.toISOString(), now.toISOString(), row.user_id).run();
  const user = safeUser({ ...row, last_login_at: now.toISOString() });
  return authJson({ ok: true, authenticated: true, user, projects: await listProjectsForUser(env, user) }, 200, request, { "set-cookie": sessionCookie(token, request) });
}

async function handleAuthLogout(env, request) {
  if (env.APPROVAL_DB) {
    const token = cookieValue(request, HERMAS_SESSION_COOKIE);
    if (token) {
      await ensureAuthSchema(env);
      await env.APPROVAL_DB.prepare(`UPDATE user_sessions SET status = 'revoked', last_seen_at = ? WHERE session_hash = ?`).bind(new Date().toISOString(), await sha256Hex(token)).run().catch(() => null);
    }
  }
  return authJson({ ok: true, authenticated: false }, 200, request, { "set-cookie": clearSessionCookie(request) });
}

async function handleAuthSession(env, request) {
  const auth = await sessionAuth(request, env);
  if (!auth?.ok) return authJson({ ok: true, authenticated: false, reason: auth?.error || "not_logged_in" }, 200, request);
  return authJson({ ok: true, authenticated: true, user: auth.user, projects: await listProjectsForUser(env, auth.user) }, 200, request);
}

async function upsertMembership(env, projectKey, userId, role = "staff", status = "active") {
  await env.APPROVAL_DB.prepare(`
    INSERT INTO project_memberships (membership_id, project_key, user_id, role, status, created_at, updated_at, data)
    VALUES (?, ?, ?, ?, ?, ?, ?, '{}')
    ON CONFLICT(project_key, user_id)
    DO UPDATE SET role = excluded.role, status = excluded.status, updated_at = excluded.updated_at
  `).bind(randomId("member"), cleanProjectKey(projectKey), userId, role === "admin" ? "admin" : "staff", status === "active" ? "active" : "disabled", new Date().toISOString(), new Date().toISOString()).run();
}

async function handleAdminUsersList(env, request) {
  await ensureAuthSchema(env);
  const result = await env.APPROVAL_DB.prepare(`SELECT user_id, email, name, role, status, created_at, updated_at, last_login_at FROM users ORDER BY updated_at DESC LIMIT 300`).all();
  return authJson({ ok: true, users: (result?.results || []).map(safeUser) }, 200, request);
}

async function handleAdminUserCreate(payload, env, request, auth) {
  await ensureAuthSchema(env);
  const email = normalizeEmail(payload.email);
  if (!email) return authJson({ ok: false, error: "email_required" }, 400, request);
  const password = String(payload.password || "") || temporaryPassword();
  const userId = randomId("user");
  const now = new Date().toISOString();
  const role = String(payload.role || "staff") === "admin" ? "admin" : "staff";
  await env.APPROVAL_DB.prepare(`
    INSERT INTO users (user_id, email, name, role, status, password_hash, password_updated_at, created_at, updated_at, data)
    VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
  `).bind(userId, email, String(payload.name || email.split("@")[0]), role, await hashPassword(password), now, now, now, JSON.stringify({ created_by: auth?.subject || "admin" })).run();
  const projects = Array.isArray(payload.project_keys) ? payload.project_keys : payload.project_key ? [payload.project_key] : [];
  for (const project of projects) await upsertMembership(env, project, userId, role);
  return authJson({ ok: true, user: safeUser({ user_id: userId, email, name: payload.name || email, role, status: "active", created_at: now, updated_at: now }), temporary_password: payload.password ? null : password }, 201, request);
}

async function handleAdminUserPatch(rawUserId, payload, env, request) {
  await ensureAuthSchema(env);
  const key = String(rawUserId || "").trim();
  const row = await env.APPROVAL_DB.prepare(`SELECT * FROM users WHERE user_id = ? OR email = ? LIMIT 1`).bind(key, normalizeEmail(key)).first();
  if (!row) return authJson({ ok: false, error: "user_not_found" }, 404, request);
  const role = payload.role !== undefined ? (String(payload.role) === "admin" ? "admin" : "staff") : row.role;
  const status = payload.status !== undefined && String(payload.status) !== "active" ? "disabled" : "active";
  const name = payload.name !== undefined ? String(payload.name || row.name).trim() : row.name;
  const now = new Date().toISOString();
  await env.APPROVAL_DB.prepare(`UPDATE users SET name = ?, role = ?, status = ?, updated_at = ? WHERE user_id = ?`).bind(name, role, status, now, row.user_id).run();
  if (status !== "active") await env.APPROVAL_DB.prepare(`UPDATE user_sessions SET status = 'revoked' WHERE user_id = ?`).bind(row.user_id).run();
  return authJson({ ok: true, user: safeUser({ ...row, name, role, status, updated_at: now }) }, 200, request);
}

async function handleAdminUserResetPassword(rawUserId, payload, env, request) {
  await ensureAuthSchema(env);
  const key = String(rawUserId || "").trim();
  const row = await env.APPROVAL_DB.prepare(`SELECT * FROM users WHERE user_id = ? OR email = ? LIMIT 1`).bind(key, normalizeEmail(key)).first();
  if (!row) return authJson({ ok: false, error: "user_not_found" }, 404, request);
  const password = String(payload.password || "") || temporaryPassword();
  const now = new Date().toISOString();
  await env.APPROVAL_DB.prepare(`UPDATE users SET password_hash = ?, password_updated_at = ?, updated_at = ? WHERE user_id = ?`).bind(await hashPassword(password), now, now, row.user_id).run();
  await env.APPROVAL_DB.prepare(`UPDATE user_sessions SET status = 'revoked' WHERE user_id = ?`).bind(row.user_id).run();
  return authJson({ ok: true, user: safeUser(row), temporary_password: payload.password ? null : password }, 200, request);
}

async function handleAdminProjectMemberSave(rawProjectKey, payload, env, request) {
  await ensureAuthSchema(env);
  const key = String(payload.user_id || payload.email || "").trim();
  const row = await env.APPROVAL_DB.prepare(`SELECT * FROM users WHERE user_id = ? OR email = ? LIMIT 1`).bind(key, normalizeEmail(key)).first();
  if (!row) return authJson({ ok: false, error: "user_not_found" }, 404, request);
  await upsertMembership(env, rawProjectKey, row.user_id, payload.role || row.role || "staff", payload.status || "active");
  return authJson({ ok: true, project_key: cleanProjectKey(rawProjectKey), member: { user: safeUser(row), role: payload.role || row.role || "staff", status: payload.status || "active" } }, 200, request);
}

async function requireAdmin(request, env, options = {}) {
  if (!env.ADMIN_TOKEN) {
    const session = await sessionAuth(request, env, { requireAdmin: true });
    if (session?.ok) return options.returnAuth ? session : undefined;
    const error = new Error(session?.error || "ADMIN_TOKEN is not configured");
    error.status = session?.status || 500;
    throw error;
  }

  const url = new URL(request.url);
  const token = request.headers.get("x-admin-token") || url.searchParams.get("token");
  if (token === env.ADMIN_TOKEN) return options.returnAuth ? { ok: true, subject: "runtime_admin", role: "admin", auth_type: "legacy_token" } : undefined;
  const session = await sessionAuth(request, env, { requireAdmin: true });
  if (session?.ok) return options.returnAuth ? session : undefined;
  if (token !== env.ADMIN_TOKEN) {
    const error = new Error("unauthorized");
    error.status = 401;
    throw error;
  }
}

async function requireOperator(request, env, options = {}) {
  const url = new URL(request.url);
  const adminToken = request.headers.get("x-admin-token") || url.searchParams.get("token");
  const staffToken = request.headers.get("x-staff-token") || url.searchParams.get("staff_token");
  if (env.ADMIN_TOKEN && adminToken === env.ADMIN_TOKEN) return options.returnAuth ? { ok: true, subject: "runtime_admin", role: "admin", auth_type: "legacy_token" } : undefined;
  if (env.STAFF_TOKEN && staffToken === env.STAFF_TOKEN) return options.returnAuth ? { ok: true, subject: "staff_operator", role: "staff", auth_type: "legacy_token" } : undefined;
  const session = await sessionAuth(request, env);
  if (session?.ok) return options.returnAuth ? session : undefined;
  const error = new Error("unauthorized");
  error.status = session?.status || 401;
  throw error;
}

function firstText(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function runtimeOperatorIdentity(auth = null, payload = {}) {
  const sessionBacked = auth?.auth_type === "session" || Boolean(auth?.user_id || auth?.user?.user_id);
  const fallbackName = firstText(
    payload.operator_name,
    payload.operatorName,
    payload.display_name,
    payload.displayName,
    payload.approvedBy,
    payload.rejectedBy,
    payload.resolvedBy,
    payload.confirmedBy,
    payload.user,
    payload.staff,
  );
  const fallbackId = firstText(
    payload.operator_id,
    payload.operatorId,
    payload.user_id,
    payload.userId,
    payload.staff_id,
    payload.staffId,
    fallbackName,
  );
  const id = firstText(
    sessionBacked ? auth?.user_id : "",
    sessionBacked ? auth?.user?.user_id : "",
    sessionBacked ? auth?.subject : "",
    fallbackId,
    auth?.subject,
    "operator",
  );
  const name = firstText(
    sessionBacked ? auth?.display_name : "",
    sessionBacked ? auth?.user?.name : "",
    fallbackName,
    auth?.display_name,
    auth?.subject,
    id,
  );
  return {
    id: id || "operator",
    name: name || id || "operator",
    role: auth?.role || payload.operator_role || payload.operatorRole || "operator",
    auth_type: auth?.auth_type || "unknown",
  };
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
    if (typeof value === "string" && value.trim()) {
      const text = value.trim();
      if (/^\{\{[^}]+\}\}$/.test(text) || /^%7B%7B.+%7D%7D$/i.test(text)) continue;
      if (/^(message|chat|contact|conversation|lastMessage|last_message)\.[A-Za-z0-9_.]+$/.test(text)) continue;
      if (/^(Unique ID|Phone Number|Name|Email)$/i.test(text)) continue;
      return text;
    }
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
