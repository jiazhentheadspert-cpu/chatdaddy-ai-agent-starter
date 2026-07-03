#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const inputPath = process.argv[2] || "wrangler.agents.example.toml";
const outputPath = process.argv[3] || "wrangler.agents.local.toml";
const supabaseUrl = clean(process.env.SUPABASE_URL);
const projectKey = clean(process.env.HERMAS_PROJECT_KEY) || "beyoute";
const workerName = clean(process.env.HERMAS_WORKER_NAME);

if (!supabaseUrl || supabaseUrl.includes("YOUR_PROJECT")) {
  console.error("不能继续：缺少 SUPABASE_URL。");
  console.error("");
  console.error("小白版：先这样跑：");
  console.error("SUPABASE_URL='https://你的项目.supabase.co' ./setup/prepare_agents_live_config.command");
  process.exit(2);
}

let toml = fs.readFileSync(inputPath, "utf8");
toml = toml.replace(/AGENT_PROJECT_KEY\s*=\s*"[^"]*"/, `AGENT_PROJECT_KEY = "${escapeToml(projectKey)}"`);
toml = toml.replace(/SUPABASE_URL\s*=\s*"[^"]*"/, `SUPABASE_URL = "${escapeToml(supabaseUrl)}"`);
if (workerName) {
  toml = toml.replace(/^name\s*=\s*"[^"]*"/m, `name = "${escapeToml(workerName)}"`);
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, toml, "utf8");

console.log("OK：Agents live config 已建立。");
console.log(`Config: ${outputPath}`);
console.log(`Project: ${projectKey}`);
console.log("Secret 没有写进这个文件。");

function clean(value) {
  return String(value || "").trim();
}

function escapeToml(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
