#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";

const checks = [];

checkFile("Agents Worker", "src/hermas-agents-worker.js", [
  ["用了 Cloudflare Agents SDK", /import\s+\{\s*Agent,\s*getAgentByName,\s*routeAgentRequest\s*\}\s+from\s+["']agents["']/],
  ["Webhook 会先进 ProjectAgent", /getAgentByName\(env\.HermasProjectAgent/],
  ["会把顾客写入 Supabase customers", /upsertSupabaseCustomer/],
  ["会把 conversation/message/case 连起来", /conversation_id[\s\S]*trigger_message_id/],
  ["默认不会自动发送", /send_now:\s*false|AGENT_AUTO_SEND/],
  ["默认不会自动接 Flow", /trigger_flow_now:\s*false|AGENT_AUTO_TRIGGER_FLOWS/]
]);

checkFile("Agents Wrangler config", "wrangler.agents.example.toml", [
  ["绑定 Project Agent", /HermasProjectAgent/],
  ["绑定 Conversation Agent", /HermasConversationAgent/],
  ["approval-first auto send 关闭", /AGENT_AUTO_SEND\s*=\s*"false"/],
  ["approval-first auto flow 关闭", /AGENT_AUTO_TRIGGER_FLOWS\s*=\s*"false"/],
  ["没有把 service role key 写进 config", not(/SUPABASE_SERVICE_ROLE_KEY\s*=/)]
]);

checkFile("Supabase schema", "migrations/0004_supabase_saas_scale.sql", [
  ["有 customers 表", /create table if not exists public\.customers/],
  ["有 messages 表", /create table if not exists public\.messages/],
  ["有 approval_cases 表", /create table if not exists public\.approval_cases/],
  ["有 background_jobs 表", /create table if not exists public\.background_jobs/],
  ["业务表有 project_key index", /idx_approval_cases_project_status_updated/]
]);

checkFile("Beyoute seed", "migrations/0005_beyoute_dev_seed.sql", [
  ["seed project_key=beyoute", /'beyoute'/],
  ["seed channel=beyoute-chatdaddy", /'beyoute-chatdaddy'/],
  ["seed approval_first", /'approval_first'/],
  ["seed 不含真实 secret", not(/sk_live|eyJhbGci|service_role|xoxb-|secret\s*[:=]\s*["'][^"']{8,}/i)]
]);

checkEnvPresence("SUPABASE_URL", Boolean(process.env.SUPABASE_URL), "本地测试或部署时需要。");
checkEnvPresence("SUPABASE_SERVICE_ROLE_KEY", Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY), "只放 server/Cloudflare secret。");
checkEnvPresence("CHATDADDY_WEBHOOK_SECRET", Boolean(process.env.CHATDADDY_WEBHOOK_SECRET), "接 live webhook 前建议设置。", { warningOnly: true });

const failed = checks.filter((item) => !item.ok && !item.warningOnly);
const warnings = checks.filter((item) => !item.ok && item.warningOnly);

console.log("==============================================");
console.log("Hermas Agents Live Launch Preflight");
console.log("==============================================");
for (const item of checks) {
  const mark = item.ok ? "PASS" : item.warningOnly ? "WARN" : "FAIL";
  console.log(`${mark} ${item.label}`);
  if (!item.ok && item.hint) console.log(`     ${item.hint}`);
}

console.log("");
if (failed.length) {
  console.log("结果：还不能接 live。先补上 FAIL 的项目。");
  process.exit(1);
}
if (warnings.length) {
  console.log("结果：代码可以继续准备；WARN 是上线前最好补上的安全项。");
  process.exit(0);
}
console.log("结果：Agents + Supabase + approval-first live 前检查通过。");

function checkFile(group, file, rules) {
  const body = read(file);
  if (!body) {
    checks.push({ ok: false, label: `${group}: 找不到 ${file}` });
    return;
  }
  for (const [label, matcher] of rules) {
    const ok = typeof matcher === "function" ? matcher(body) : matcher.test(body);
    checks.push({ ok, label: `${group}: ${label}`, hint: ok ? "" : file });
  }
}

function checkEnvPresence(name, ok, hint, options = {}) {
  checks.push({
    ok,
    label: `Env: ${name} ${ok ? "已提供" : "未提供"}`,
    hint,
    warningOnly: options.warningOnly || false
  });
}

function not(regex) {
  return (body) => !regex.test(body);
}

function read(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}
