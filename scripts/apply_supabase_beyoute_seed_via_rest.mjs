#!/usr/bin/env node
import process from "node:process";

const SUPABASE_URL = clean(process.env.SUPABASE_URL);
const SUPABASE_SERVICE_ROLE_KEY = clean(process.env.SUPABASE_SERVICE_ROLE_KEY);

const COMPANY_KEY = process.env.HERMAS_COMPANY_KEY || "ctg";
const COMPANY_NAME = process.env.HERMAS_COMPANY_NAME || "CTG Business";
const PROJECT_KEY = process.env.HERMAS_PROJECT_KEY || "beyoute";
const PROJECT_NAME = process.env.HERMAS_PROJECT_NAME || "Beyoute";
const CONNECTION_KEY = process.env.HERMAS_CONNECTION_KEY || "beyoute-chatdaddy";
const CONNECTION_NAME = process.env.HERMAS_CONNECTION_NAME || "Beyoute ChatDaddy";

main().catch((error) => {
  console.error("");
  console.error("不能继续：Supabase seed 失败。");
  console.error(error?.message || String(error));
  process.exit(1);
});

async function main() {
  if (!SUPABASE_URL || SUPABASE_URL.includes("YOUR_PROJECT")) {
    stopWithSetupHelp("缺少 SUPABASE_URL。");
  }
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    stopWithSetupHelp("缺少 SUPABASE_SERVICE_ROLE_KEY。");
  }

  console.log("==============================================");
  console.log("Hermas Supabase Beyoute Seed");
  console.log("==============================================");
  console.log("会建立：公司、Beyoute 项目、ChatDaddy 连接占位。");
  console.log("不会打印、保存或上传任何 secret。");
  console.log("");

  const company = await upsertByUnique("companies", "company_key", {
    company_key: COMPANY_KEY,
    name: COMPANY_NAME,
    status: "active",
    timezone: "Asia/Kuala_Lumpur",
    settings: { managed_saas: true }
  });
  const companyId = company.id;
  if (!companyId) throw new Error("companies seed 没有返回 id。");

  const project = await upsertByUnique("projects", "project_key", {
    company_id: companyId,
    project_key: PROJECT_KEY,
    name: PROJECT_NAME,
    status: "active",
    automation_mode: "approval_first",
    timezone: "Asia/Kuala_Lumpur",
    currency: "MYR",
    default_language: "zh-MY",
    readiness_status: "testing",
    settings: {
      pilot: true,
      approval_first: true,
      auto_send_enabled: false,
      auto_trigger_flows_enabled: false
    }
  });
  if (!project.id) throw new Error("projects seed 没有返回 id。");

  const existingConnection = await selectOne(
    `channel_connections?project_key=eq.${encode(PROJECT_KEY)}&connection_key=eq.${encode(CONNECTION_KEY)}&select=id,project_key,connection_key&limit=1`
  );
  const connectionPayload = {
    project_key: PROJECT_KEY,
    connection_key: CONNECTION_KEY,
    provider: "chatdaddy",
    provider_connection_id: CONNECTION_KEY,
    display_name: CONNECTION_NAME,
    status: "testing",
    config: {
      approval_first: true,
      notes: "Non-secret placeholder. Keep real provider ids/secrets in Cloudflare or provider vault only."
    },
    rate_limit: { initial_target_messages_per_day: 100 }
  };
  const connection = existingConnection?.id
    ? await patchRows(`channel_connections?id=eq.${existingConnection.id}`, connectionPayload)
    : await insertRows("channel_connections", connectionPayload);
  const connectionId = first(connection)?.id || existingConnection?.id;
  if (!connectionId) throw new Error("channel_connections seed 没有返回 id。");

  console.log("OK：Supabase 基础资料已经准备好。");
  console.log(`- company: ${COMPANY_KEY}`);
  console.log(`- project: ${PROJECT_KEY} (${PROJECT_NAME})`);
  console.log(`- channel: ${CONNECTION_KEY}`);
  console.log("- mode: approval_first，auto send / auto flow 默认关闭");
  console.log("");
  console.log("下一步：把同一个 SUPABASE_URL 和 SERVICE_ROLE_KEY 放进 Cloudflare Worker secret/vars，再跑 Agents preflight。");
}

async function upsertByUnique(table, conflictColumn, payload) {
  const rows = await fetchJson(`${rest(table)}?on_conflict=${encode(conflictColumn)}`, {
    method: "POST",
    headers: headers("resolution=merge-duplicates,return=representation"),
    body: JSON.stringify(payload)
  });
  const row = first(rows);
  if (row) return row;

  const key = payload[conflictColumn];
  const selected = await selectOne(`${table}?${conflictColumn}=eq.${encode(key)}&select=*&limit=1`);
  if (selected) return selected;
  throw new Error(`${table} upsert 没有返回资料。`);
}

async function selectOne(tableAndQuery) {
  const rows = await fetchJson(`${SUPABASE_URL}/rest/v1/${tableAndQuery}`, {
    method: "GET",
    headers: headers()
  });
  return first(rows) || null;
}

async function insertRows(table, payload) {
  return fetchJson(rest(table), {
    method: "POST",
    headers: headers("return=representation"),
    body: JSON.stringify(payload)
  });
}

async function patchRows(tableAndQuery, payload) {
  return fetchJson(`${SUPABASE_URL}/rest/v1/${tableAndQuery}`, {
    method: "PATCH",
    headers: headers("return=representation"),
    body: JSON.stringify(payload)
  });
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Supabase API ${response.status}: ${compact(text)}`);
  }
  return text ? JSON.parse(text) : [];
}

function rest(table) {
  return `${SUPABASE_URL}/rest/v1/${table}`;
}

function headers(prefer = "") {
  const out = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "content-type": "application/json"
  };
  if (prefer) out.prefer = prefer;
  return out;
}

function first(value) {
  return Array.isArray(value) ? value[0] : null;
}

function clean(value) {
  return String(value || "").trim();
}

function encode(value) {
  return encodeURIComponent(String(value));
}

function compact(value) {
  return String(value || "").replace(/\s+/g, " ").slice(0, 700);
}

function stopWithSetupHelp(reason) {
  console.error("不能继续：" + reason);
  console.error("");
  console.error("小白版：这个按钮需要你先给电脑两个 Supabase 资料：");
  console.error("1. SUPABASE_URL：项目网址，例如 https://xxx.supabase.co");
  console.error("2. SUPABASE_SERVICE_ROLE_KEY：服务端 key，只能给系统用，不能放前端/GitHub");
  console.error("");
  console.error("拿到后，在 Terminal 临时输入：");
  console.error("export SUPABASE_URL='你的 Supabase URL'");
  console.error("export SUPABASE_SERVICE_ROLE_KEY='你的 service role key'");
  console.error("./RUN_Hermas_Supabase_Beyoute_Seed.command");
  process.exit(2);
}
