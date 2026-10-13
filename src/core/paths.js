'use strict';
// 所有路径常量。契约见 spec.md 第 8 节。
// 纯 Node CommonJS —— 不要 require('electron')，方便 node --test 直接使用。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** 用户主目录，例如 C:\Users\ailuo */
const HOME = os.homedir();

/**
 * gpt++ 数据目录：默认 ~/.gptplus，可用 $GPTPLUS_HOME 覆盖。
 * 自动化验证与多套配置隔离都依赖这个覆盖点；正常运行时不设置该变量。
 */
function resolveAppDir() {
  const raw = typeof process.env.GPTPLUS_HOME === 'string' ? process.env.GPTPLUS_HOME.trim() : '';
  if (raw) return path.resolve(raw);
  return path.join(HOME, '.gptplus');
}

const APP_DIR = resolveAppDir();
/** 用户配置（磁盘契约见 spec.md 第 4 节） */
const CONFIG_PATH = path.join(APP_DIR, 'config.json');
/** Codex 配置备份目录，保留最近 10 份 */
const BACKUP_DIR = path.join(APP_DIR, 'backups');

/**
 * Codex 配置目录：支持 $CODEX_HOME 覆盖（与 codex CLI 行为一致）。
 * 绝不在模块加载时创建 / 修改该目录。
 */
function resolveCodexHome() {
  const raw = typeof process.env.CODEX_HOME === 'string' ? process.env.CODEX_HOME.trim() : '';
  if (raw) return path.resolve(raw);
  return path.join(HOME, '.codex');
}

const CODEX_HOME = resolveCodexHome();
const CODEX_CONFIG_PATH = path.join(CODEX_HOME, 'config.toml');
/** 我们生成的模型目录文件 */
const CATALOG_PATH = path.join(APP_DIR, 'model-catalog.json');
/** 网关日志 */
const LOG_PATH = path.join(APP_DIR, 'gateway.log');
/** 请求级使用量：一条请求一条记录，不受原始日志事件数量影响 */
const USAGE_PATH = path.join(APP_DIR, 'usage.jsonl');

/**
 * 建目录，幂等。只创建 gpt++ 自己的目录，不碰用户的 ~/.codex。
 * @returns {{ APP_DIR: string, BACKUP_DIR: string }}
 */
function ensureDirs() {
  for (const dir of [APP_DIR, BACKUP_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return { APP_DIR, BACKUP_DIR };
}

module.exports = {
  HOME,
  APP_DIR,
  CONFIG_PATH,
  BACKUP_DIR,
  CODEX_HOME,
  CODEX_CONFIG_PATH,
  CATALOG_PATH,
  LOG_PATH,
  USAGE_PATH,
  ensureDirs,
};
