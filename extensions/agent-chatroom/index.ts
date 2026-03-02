/**
 * Agent Chatroom Plugin for FirstClaw / OpenClaw
 *
 * Provides:
 *   1. Tools for LLM agents to interact with the multi-agent chatroom.
 *   2. A background daemon that polls the NAS inbox and **automatically
 *      dispatches** incoming messages through the LLM.
 *   3. A reliable **Task Dispatch Protocol** with system-level ACK handshake:
 *
 *        Orchestrator                Target Agent
 *             │                           │
 *             │── TASK_DISPATCH ─────────>│  ① assign task
 *             │                           │
 *             │<── TASK_ACK (system) ─────│  ② instant ACK (no LLM)
 *             │                           │
 *             │    [LLM processes task]   │
 *             │                           │
 *             │<── RESULT_REPORT ─────────│  ③ deliver result
 *             │                           │
 */

import type { FirstClawPluginApi } from "firstclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { createReplyPrefixContext, type ReplyPayload } from "firstclaw/plugin-sdk";
import { execSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================================
// Types
// ============================================================================

interface ChatroomConfig {
  nasRoot: string;
  agentId: string;
  localDir: string;
  role: "orchestrator" | "worker";
  repoRoot: string | null;
}

interface AgentRegistryEntry {
  agent_id: string;
  display_name: string;
  type: string;
  status: string;
  channels: string[];
}

interface InboxMessage {
  message_id: string;
  channel_id: string;
  from: string;
  type: string;
  content: { text: string; mentions: string[] };
  timestamp: string;
  seq: number;
  metadata?: Record<string, any>;
}

type TaskStatus =
  | "DISPATCHED"
  | "ACKED"
  | "PROCESSING"
  | "DONE"
  | "FAILED"
  | "TIMEOUT"
  | "ABANDONED"
  | "CANCELLED"
  | "RETRYING"
  | "PARKED";

type TaskErrorType = "CONTEXT_OVERFLOW" | "RATE_LIMITED" | "LLM_ERROR" | "TOOL_ERROR";

interface ProgressEntry {
  timestamp: string;
  phase: string;
  detail?: string;
}

interface TaskRecord {
  task_id: string;
  from: string;
  to: string;
  channel_id: string;
  status: TaskStatus;
  instruction: string;
  dispatched_at: string;
  acked_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  result_summary: string | null;
  asset_paths: string[];
  retries: number;
  max_retries: number;
  ack_timeout_ms: number;
  task_timeout_ms: number;
  error_type?: TaskErrorType | null;
  error_detail?: string | null;
  progress_log?: ProgressEntry[];
  current_phase?: string | null;
  plan_id?: string | null;
  current_step?: number | null;
  total_steps?: number | null;
}

// ── Plan Mode types ──────────────────────────────────────────────────────────

type PlanStatus =
  | "DRAFT"
  | "PENDING_REVIEW"
  | "APPROVED"
  | "EXECUTING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

type PlanStepStatus = "PENDING" | "IN_PROGRESS" | "COMPLETED" | "FAILED" | "SKIPPED";

interface StepComment {
  comment_id: string;
  step_id: string;
  from: string;
  text: string;
  timestamp: string;
  type: "suggestion" | "approval" | "warning" | "rejection";
}

interface PlanStep {
  step_id: string;
  order: number;
  title: string;
  description: string;
  status: PlanStepStatus;
  estimated_minutes: number;
  timeout_minutes: number;
  result_summary: string | null;
  output_files: string[];
  started_at: string | null;
  completed_at: string | null;
  error_detail: string | null;
  comments: StepComment[];
}

interface PlanApproval {
  mode: "orchestrator" | "human";
  approved_by: string | null;
  decision: "pending" | "approved" | "rejected" | "revision_requested" | null;
  decision_reason: string | null;
  decided_at: string | null;
}

interface TaskPlan {
  plan_id: string;
  task_id: string;
  agent_id: string;
  status: PlanStatus;
  summary: string;
  estimated_total_minutes: number;
  steps: PlanStep[];
  approval: PlanApproval;
  created_at: string;
  approved_at: string | null;
  completed_at: string | null;
  revision: number;
}

interface StepResult {
  success: boolean;
  result_summary: string;
  output_files: string[];
  error_detail?: string;
}

const PLANNING_TIMEOUT_MS = 3 * 60_000;
const DEFAULT_STEP_TIMEOUT_MS = 10 * 60_000;
const MAX_STEP_TIMEOUT_MS = 30 * 60_000;

type ParkWatchType = "shell" | "file" | "poll_url" | "permission";

interface ParkedTaskInfo {
  task_id: string;
  agent_id: string;
  channel_id: string;
  original_instruction: string;
  resume_prompt: string;
  watch_type: ParkWatchType;
  watch_config: {
    command?: string;
    file_path?: string;
    url?: string;
    expected_status?: number;
    permission_id?: string;
  };
  poll_interval_ms: number;
  max_wait_ms: number;
  parked_at: string;
  last_poll_at: string | null;
  poll_count: number;
}

interface PermissionRecord {
  permission_id: string;
  task_id: string;
  agent_id: string;
  channel_id: string;
  status: "pending" | "approved" | "rejected" | "allowlisted";
  operation: {
    type: string;
    command?: string;
    path?: string;
    url?: string;
    pattern: string;
    working_dir?: string;
  };
  summary: string;
  context_snapshot: {
    original_instruction: string;
    resume_prompt: string;
  };
  requested_at: string;
  decided_at: string | null;
  decided_by: string | null;
  decision: string | null;
  decision_reason: string | null;
}

interface Logger {
  info: (...a: any[]) => void;
  warn: (...a: any[]) => void;
  error: (...a: any[]) => void;
}

// ============================================================================
// NAS file helpers
// ============================================================================

function readJson(filePath: string): any {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function writeJson(filePath: string, data: any): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function randomUUID(): string {
  return crypto.randomUUID();
}

function nowISO(): string {
  return new Date().toISOString();
}

// ============================================================================
// File lock
// ============================================================================

function acquireLock(lockPath: string, holder: string, timeoutSec = 30, retries = 5): boolean {
  for (let i = 0; i < retries; i++) {
    try {
      const fd = fs.openSync(
        lockPath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      );
      fs.writeSync(fd, JSON.stringify({ holder, timestamp: nowISO(), expires: timeoutSec }));
      fs.closeSync(fd);
      return true;
    } catch {
      try {
        const lock = readJson(lockPath);
        if (lock?.timestamp) {
          const age = (Date.now() - new Date(lock.timestamp).getTime()) / 1000;
          if (age > timeoutSec) {
            fs.unlinkSync(lockPath);
            continue;
          }
        }
      } catch {
        /* ignore */
      }
      if (i < retries - 1) {
        const start = Date.now();
        while (Date.now() - start < 1000) {
          /* busy wait */
        }
      }
    }
  }
  return false;
}

function releaseLock(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    /* ignore */
  }
}

// ============================================================================
// Core chatroom operations
// ============================================================================

function chatroomRoot(cfg: ChatroomConfig): string {
  return path.join(cfg.nasRoot, "chatroom");
}

function tasksDir(cfg: ChatroomConfig): string {
  return path.join(chatroomRoot(cfg), "tasks");
}

function plansDir(cfg: ChatroomConfig): string {
  return path.join(chatroomRoot(cfg), "plans");
}

function configDir(cfg: ChatroomConfig): string {
  return path.join(chatroomRoot(cfg), "config");
}

// ── Plan NAS helpers ─────────────────────────────────────────────────────────

function readPlan(cfg: ChatroomConfig, taskId: string): TaskPlan | null {
  return readJson(path.join(plansDir(cfg), `${taskId}.json`));
}

function writePlan(cfg: ChatroomConfig, plan: TaskPlan): void {
  const dir = plansDir(cfg);
  ensureDir(dir);
  writeJson(path.join(dir, `${plan.task_id}.json`), plan);
}

function updatePlan(
  cfg: ChatroomConfig,
  taskId: string,
  patch: Partial<TaskPlan>,
): TaskPlan | null {
  const plan = readPlan(cfg, taskId);
  if (!plan) return null;
  const updated = { ...plan, ...patch };
  writePlan(cfg, updated);
  return updated;
}

function updatePlanStep(
  cfg: ChatroomConfig,
  taskId: string,
  stepId: string,
  patch: Partial<PlanStep>,
): TaskPlan | null {
  const plan = readPlan(cfg, taskId);
  if (!plan) return null;
  plan.steps = plan.steps.map((s) => (s.step_id === stepId ? { ...s, ...patch } : s));
  writePlan(cfg, plan);
  return plan;
}

function createNewPlan(
  cfg: ChatroomConfig,
  taskId: string,
  agentId: string,
  summary: string,
  steps: Omit<
    PlanStep,
    | "step_id"
    | "status"
    | "result_summary"
    | "output_files"
    | "started_at"
    | "completed_at"
    | "error_detail"
    | "comments"
  >[],
  approvalMode: "orchestrator" | "human",
): TaskPlan {
  const plan: TaskPlan = {
    plan_id: randomUUID(),
    task_id: taskId,
    agent_id: agentId,
    status: "DRAFT",
    summary,
    estimated_total_minutes: steps.reduce((sum, s) => sum + s.estimated_minutes, 0),
    steps: steps.map((s, i) => ({
      step_id: randomUUID(),
      order: s.order ?? i + 1,
      title: s.title,
      description: s.description,
      status: "PENDING" as PlanStepStatus,
      estimated_minutes: s.estimated_minutes,
      timeout_minutes: Math.min(
        s.timeout_minutes ?? DEFAULT_STEP_TIMEOUT_MS / 60_000,
        MAX_STEP_TIMEOUT_MS / 60_000,
      ),
      result_summary: null,
      output_files: [],
      started_at: null,
      completed_at: null,
      error_detail: null,
      comments: [],
    })),
    approval: {
      mode: approvalMode,
      approved_by: null,
      decision: "pending",
      decision_reason: null,
      decided_at: null,
    },
    created_at: nowISO(),
    approved_at: null,
    completed_at: null,
    revision: 1,
  };
  writePlan(cfg, plan);
  return plan;
}

function readGlobalSettings(cfg: ChatroomConfig): Record<string, any> {
  const settingsPath = path.join(configDir(cfg), "settings.json");
  return readJson(settingsPath) ?? { allow_orchestrator_decisions: true };
}

function getApprovalMode(cfg: ChatroomConfig): "orchestrator" | "human" {
  const settings = readGlobalSettings(cfg);
  return settings.allow_orchestrator_decisions ? "orchestrator" : "human";
}

function assetsDir(cfg: ChatroomConfig, agentId?: string): string {
  const base = path.join(chatroomRoot(cfg), "assets");
  return agentId ? path.join(base, agentId) : base;
}

function taskAssetsDir(cfg: ChatroomConfig, agentId: string, taskId: string): string {
  return path.join(assetsDir(cfg, agentId), taskId);
}

function toForwardSlash(p: string): string {
  return p.replace(/\\/g, "/");
}

function scanOutputDir(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile()) files.push(toForwardSlash(path.join(dir, entry.name)));
  }
  return files;
}

// ============================================================================
// Reliable file transfer helpers
// ============================================================================

function md5File(filePath: string): string {
  const data = fs.readFileSync(filePath);
  return createHash("md5").update(data).digest("hex");
}

interface PublishResult {
  nasPath: string;
  sourceSize: number;
  destSize: number;
  md5: string;
  verified: boolean;
}

/**
 * Binary-safe copy from local filesystem to NAS with integrity verification.
 * Uses fs.copyFileSync (kernel-level copy) — never passes content through LLM context.
 */
function publishFileToNAS(sourcePath: string, destDir: string, filename?: string): PublishResult {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source file does not exist: ${sourcePath}`);
  }
  const stat = fs.statSync(sourcePath);
  if (!stat.isFile()) {
    throw new Error(`Source is not a file: ${sourcePath}`);
  }
  if (stat.size === 0) {
    throw new Error(`Source file is empty (0 bytes): ${sourcePath}`);
  }

  const targetName = filename ?? path.basename(sourcePath);
  ensureDir(destDir);
  const destPath = toForwardSlash(path.join(destDir, targetName));

  const sourceMd5 = md5File(sourcePath);
  fs.copyFileSync(sourcePath, destPath);

  const destStat = fs.statSync(destPath);
  const destMd5 = md5File(destPath);

  if (destStat.size !== stat.size || destMd5 !== sourceMd5) {
    // Retry once
    fs.copyFileSync(sourcePath, destPath);
    const retryStat = fs.statSync(destPath);
    const retryMd5 = md5File(destPath);
    if (retryStat.size !== stat.size || retryMd5 !== sourceMd5) {
      throw new Error(
        `File verification failed after retry. ` +
          `Source: ${stat.size}b/${sourceMd5}, Dest: ${retryStat.size}b/${retryMd5}`,
      );
    }
  }

  return {
    nasPath: destPath,
    sourceSize: stat.size,
    destSize: destStat.size,
    md5: sourceMd5,
    verified: true,
  };
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".ico",
  ".svg",
  ".tiff",
  ".tif",
  ".mp3",
  ".wav",
  ".ogg",
  ".flac",
  ".aac",
  ".m4a",
  ".wma",
  ".mp4",
  ".avi",
  ".mov",
  ".mkv",
  ".webm",
  ".flv",
  ".wmv",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".zip",
  ".tar",
  ".gz",
  ".bz2",
  ".7z",
  ".rar",
  ".obj",
  ".fbx",
  ".gltf",
  ".glb",
  ".stl",
  ".blend",
  ".psd",
  ".ai",
  ".sketch",
  ".fig",
  ".ttf",
  ".otf",
  ".woff",
  ".woff2",
  ".bin",
  ".dat",
  ".db",
  ".sqlite",
]);

/**
 * Detect if a "content" string is actually a file path that the LLM mistakenly
 * passed instead of actual file content. Returns the resolved path if it looks
 * like an existing file, or null.
 */
function detectMisusedFilePath(content: string): string | null {
  const trimmed = content.trim();
  if (trimmed.length > 1024) return null;
  if (trimmed.includes("\n")) return null;

  const looksLikePath =
    trimmed.startsWith("/") ||
    trimmed.startsWith("\\\\") ||
    trimmed.startsWith("~/") ||
    /^[A-Za-z]:[/\\]/.test(trimmed);

  if (!looksLikePath) return null;

  try {
    if (fs.existsSync(trimmed) && fs.statSync(trimmed).isFile()) {
      return trimmed;
    }
  } catch {
    /* ignore */
  }
  return null;
}

// ============================================================================
// Permission helpers
// ============================================================================

function permissionsDir(cfg: ChatroomConfig): string {
  return path.join(chatroomRoot(cfg), "permissions");
}

function permissionAllowlistPath(cfg: ChatroomConfig): string {
  return path.join(chatroomRoot(cfg), "config", "permission_allowlist.json");
}

function writePermissionRecord(cfg: ChatroomConfig, record: PermissionRecord): void {
  const dir = permissionsDir(cfg);
  ensureDir(dir);
  writeJson(path.join(dir, `${record.permission_id}.json`), record);
}

function readPermissionRecord(cfg: ChatroomConfig, permissionId: string): PermissionRecord | null {
  return readJson(path.join(permissionsDir(cfg), `${permissionId}.json`));
}

function readAllowlist(cfg: ChatroomConfig): {
  patterns: Array<{ pattern: string; added_by: string; added_at: string }>;
} {
  const data = readJson(permissionAllowlistPath(cfg));
  return data?.patterns ? data : { patterns: [] };
}

function buildOperationPattern(opType: string, opDetail: string): string {
  const typeName = opType.charAt(0).toUpperCase() + opType.slice(1);
  if (opType === "shell") {
    const cmd = opDetail.split(/\s+/)[0] ?? opDetail;
    return `${typeName}(${cmd}:*)`;
  }
  // For file operations, create a directory-level glob
  const normalized = opDetail.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  const dirPart = lastSlash > 0 ? normalized.slice(0, lastSlash) : normalized;
  return `${typeName}(${dirPart}/**)`;
}

function matchesAllowlist(cfg: ChatroomConfig, opType: string, opDetail: string): boolean {
  const allowlist = readAllowlist(cfg);
  if (allowlist.patterns.length === 0) return false;

  const typeName = opType.charAt(0).toUpperCase() + opType.slice(1);

  for (const entry of allowlist.patterns) {
    const pat = entry.pattern;
    // Parse pattern: Type(glob)
    const match = pat.match(/^(\w+)\((.+)\)$/);
    if (!match) continue;
    const [, patType, patGlob] = match;
    if (patType !== typeName) continue;

    if (opType === "shell") {
      // Shell patterns: "Shell(cmd:argGlob)" or "Shell(cmd:*)"
      const colonIdx = patGlob.indexOf(":");
      if (colonIdx === -1) {
        // Simple command match: Shell(git)
        const cmd = opDetail.split(/\s+/)[0] ?? "";
        if (cmd === patGlob) return true;
      } else {
        const patCmd = patGlob.slice(0, colonIdx);
        const patArgGlob = patGlob.slice(colonIdx + 1);
        const cmd = opDetail.split(/\s+/)[0] ?? "";
        if (cmd !== patCmd) continue;
        if (patArgGlob === "*") return true;
        // Simple prefix match for arg patterns
        const args = opDetail.slice(cmd.length).trim();
        const argPrefix = patArgGlob.replace(/\*+$/, "");
        if (args.startsWith(argPrefix)) return true;
      }
    } else {
      // File/network patterns: glob matching on paths
      const normalized = opDetail.replace(/\\/g, "/");
      const globPrefix = patGlob.replace(/\*+$/, "");
      if (normalized.startsWith(globPrefix)) return true;
    }
  }
  return false;
}

function createPermissionRequest(
  cfg: ChatroomConfig,
  taskId: string,
  agentId: string,
  channelId: string,
  opType: string,
  opDetail: string,
  summary: string,
  originalInstruction: string,
  resumePrompt: string,
  logger: Logger,
): PermissionRecord {
  const permissionId = randomUUID();
  const pattern = buildOperationPattern(opType, opDetail);

  const operation: PermissionRecord["operation"] = {
    type: opType,
    pattern,
  };
  if (opType === "shell") operation.command = opDetail;
  else if (opType === "write" || opType === "read") operation.path = opDetail;
  else if (opType === "network") operation.url = opDetail;
  else operation.command = opDetail;

  const record: PermissionRecord = {
    permission_id: permissionId,
    task_id: taskId,
    agent_id: agentId,
    channel_id: channelId,
    status: "pending",
    operation,
    summary,
    context_snapshot: {
      original_instruction: originalInstruction,
      resume_prompt: resumePrompt,
    },
    requested_at: nowISO(),
    decided_at: null,
    decided_by: null,
    decision: null,
    decision_reason: null,
  };

  writePermissionRecord(cfg, record);

  // Post PERMISSION_REQUEST message to #permission channel
  const msgText = [
    `**Permission Required** for task \`${taskId.slice(0, 8)}...\``,
    `**Agent:** ${agentId}`,
    `**Operation:** \`${opDetail}\``,
    ``,
    summary,
  ].join("\n");

  sendMessageToNAS(cfg, "permission", msgText, "PERMISSION_REQUEST", [], undefined, {
    permission_id: permissionId,
    permission_status: "pending",
    permission_operation: operation,
    permission_summary: summary,
    task_id: taskId,
  });

  logger.info(
    `Permission request ${permissionId} created for task ${taskId} (${opType}: ${opDetail.slice(0, 60)})`,
  );
  return record;
}

function readAgentRegistry(cfg: ChatroomConfig): AgentRegistryEntry[] {
  const regDir = path.join(chatroomRoot(cfg), "registry");
  if (!fs.existsSync(regDir)) return [];
  const agents: AgentRegistryEntry[] = [];
  for (const file of fs.readdirSync(regDir)) {
    if (!file.endsWith(".json")) continue;
    const data = readJson(path.join(regDir, file));
    if (data?.agent_id) agents.push(data);
  }
  return agents;
}

function parseAtMentions(text: string): string[] {
  const matches = text.match(/@(\w+)/g);
  if (!matches) return [];
  return [...new Set(matches.map((m) => m.slice(1)))];
}

function sendMessageToNAS(
  cfg: ChatroomConfig,
  channelId: string,
  text: string,
  msgType: string = "CHAT",
  mentions: string[] = [],
  replyTo?: string,
  metadata?: Record<string, any>,
): { message_id: string; seq: number } {
  const root = chatroomRoot(cfg);
  const chDir = path.join(root, "channels", channelId);
  const msgDir = path.join(chDir, "messages");
  const metaPath = path.join(chDir, "meta.json");
  const lockPath = path.join(chDir, ".lock");

  ensureDir(msgDir);

  if (!acquireLock(lockPath, cfg.agentId)) {
    throw new Error(`Failed to acquire lock for channel ${channelId}`);
  }

  try {
    const meta = readJson(metaPath) ?? { last_message_seq: 0, message_count: 0 };
    const seq = (meta.last_message_seq ?? 0) + 1;
    const messageId = randomUUID();
    const timestamp = nowISO();
    const tsCompact = timestamp.replace(/[-:]/g, "").replace(/\.\d+/, "").replace("T", "T");

    const msg = {
      message_id: messageId,
      seq,
      timestamp,
      channel_id: channelId,
      from: cfg.agentId,
      type: msgType,
      content: { text, mentions, attachments: [] },
      reply_to: replyTo ?? null,
      metadata: { priority: "normal", ...(metadata ?? {}) },
    };

    const filename = `${String(seq).padStart(6, "0")}_${tsCompact}_${messageId}.json`;
    writeJson(path.join(msgDir, filename), msg);

    meta.last_message_seq = seq;
    meta.message_count = (meta.message_count ?? 0) + 1;
    writeJson(metaPath, meta);

    const members: string[] = meta.members ?? [];
    const notifySet = new Set(members);
    for (const m of mentions) notifySet.add(m);
    notifySet.delete(cfg.agentId);

    for (const target of notifySet) {
      const isMentioned = mentions.includes(target);
      const inboxDir = path.join(root, "inbox", target);
      ensureDir(inboxDir);
      const notif = {
        notification_id: randomUUID(),
        timestamp,
        channel_id: channelId,
        message_seq: seq,
        from: cfg.agentId,
        preview: text.slice(0, 120),
        priority: isMentioned ? "high" : "normal",
        mentioned: isMentioned,
      };
      writeJson(
        path.join(inboxDir, `${String(seq).padStart(6, "0")}_${notif.notification_id}.json`),
        notif,
      );
    }

    return { message_id: messageId, seq };
  } finally {
    releaseLock(lockPath);
  }
}

function listAgentChannels(cfg: ChatroomConfig): any[] {
  const indexPath = path.join(chatroomRoot(cfg), "channels", "_index.json");
  const idx = readJson(indexPath);
  if (!idx?.channels) return [];
  return idx.channels.filter(
    (ch: any) => Array.isArray(ch.members) && ch.members.includes(cfg.agentId),
  );
}

function updateHeartbeat(cfg: ChatroomConfig): void {
  const regPath = path.join(chatroomRoot(cfg), "registry", `${cfg.agentId}.json`);
  const info = readJson(regPath);
  if (!info) return;
  info.last_heartbeat = nowISO();
  if (info.status === "offline") info.status = "idle";
  writeJson(regPath, info);
}

// ============================================================================
// Self-update: git pull → exit(42) → run-node.mjs handles install + build + relaunch
// ============================================================================

const UPGRADE_CHANNEL_ID = "upgrade";
const SURVIVAL_CHANNEL_ID = "survival";
const SELF_UPDATE_MARKER = ".self-update-pending.json";

function resolveGitRoot(): string | null {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

function resolveProjectRoot(repoRoot?: string | null): string {
  if (repoRoot) return repoRoot;
  return resolveGitRoot() ?? process.cwd();
}

function readProjectVersion(repoRoot?: string | null): string {
  const root = resolveProjectRoot(repoRoot);
  const buildInfo = readJson(path.join(root, "dist", "build-info.json"));
  if (buildInfo?.version) return buildInfo.version;
  const pkg = readJson(path.join(root, "package.json"));
  if (pkg?.version) return pkg.version;
  return "unknown";
}

function readProjectCommit(repoRoot?: string | null): string {
  const root = resolveProjectRoot(repoRoot);
  const buildInfo = readJson(path.join(root, "dist", "build-info.json"));
  if (buildInfo?.commit) return String(buildInfo.commit).slice(0, 8);
  try {
    return execSync("git rev-parse --short HEAD", {
      cwd: root,
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return "unknown";
  }
}

function writeSelfUpdateMarker(cfg: ChatroomConfig, requestedBy: string): void {
  const markerPath = path.join(resolveProjectRoot(cfg.repoRoot), SELF_UPDATE_MARKER);
  writeJson(markerPath, {
    agent_id: cfg.agentId,
    previous_version: readProjectVersion(cfg.repoRoot),
    requested_by: requestedBy,
    timestamp: nowISO(),
  });
}

function readAndClearSelfUpdateMarker(repoRoot?: string | null): {
  agent_id: string;
  previous_version: string;
  requested_by: string;
  timestamp: string;
} | null {
  const markerPath = path.join(resolveProjectRoot(repoRoot), SELF_UPDATE_MARKER);
  const data = readJson(markerPath);
  if (!data) return null;
  try {
    fs.unlinkSync(markerPath);
  } catch {
    /* ignore */
  }
  return data;
}

function ensureUpgradeChannel(cfg: ChatroomConfig): void {
  const root = chatroomRoot(cfg);

  // Always ensure the channel directory and meta.json exist, even if
  // _index.json is missing or unreadable — this guarantees sendMessageToNAS
  // can write messages and the web UI can discover the channel.
  const allAgents = readAgentRegistry(cfg).map((a) => a.agent_id);
  if (!allAgents.includes(cfg.agentId)) allAgents.push(cfg.agentId);

  const chDir = path.join(root, "channels", UPGRADE_CHANNEL_ID);
  ensureDir(path.join(chDir, "messages"));
  const metaPath = path.join(chDir, "meta.json");
  if (!fs.existsSync(metaPath)) {
    writeJson(metaPath, {
      channel_id: UPGRADE_CHANNEL_ID,
      display_name: "#upgrade",
      type: "group",
      members: allAgents,
      message_count: 0,
      last_message_seq: 0,
    });
  } else {
    const meta = readJson(metaPath);
    if (meta && !meta.members?.includes(cfg.agentId)) {
      meta.members = meta.members ?? [];
      meta.members.push(cfg.agentId);
      writeJson(metaPath, meta);
    }
  }

  // Also update _index.json if it exists
  try {
    const indexPath = path.join(root, "channels", "_index.json");
    const idx = readJson(indexPath);
    if (idx?.channels) {
      const existing = idx.channels.find((ch: any) => ch.channel_id === UPGRADE_CHANNEL_ID);
      if (!existing) {
        idx.channels.push({
          channel_id: UPGRADE_CHANNEL_ID,
          display_name: "#upgrade",
          type: "group",
          members: allAgents,
        });
        writeJson(indexPath, idx);
      } else if (!existing.members?.includes(cfg.agentId)) {
        existing.members = existing.members ?? [];
        existing.members.push(cfg.agentId);
        writeJson(indexPath, idx);
      }
    }
  } catch {
    /* _index.json update is best-effort */
  }
}

function ensureSurvivalChannel(cfg: ChatroomConfig): void {
  const root = chatroomRoot(cfg);
  const allAgents = readAgentRegistry(cfg).map((a) => a.agent_id);
  if (!allAgents.includes(cfg.agentId)) allAgents.push(cfg.agentId);

  const chDir = path.join(root, "channels", SURVIVAL_CHANNEL_ID);
  ensureDir(path.join(chDir, "messages"));
  const metaPath = path.join(chDir, "meta.json");
  if (!fs.existsSync(metaPath)) {
    writeJson(metaPath, {
      channel_id: SURVIVAL_CHANNEL_ID,
      display_name: "#survival",
      type: "group",
      members: allAgents,
      message_count: 0,
      last_message_seq: 0,
    });
  } else {
    const meta = readJson(metaPath);
    if (meta && !meta.members?.includes(cfg.agentId)) {
      meta.members = meta.members ?? [];
      meta.members.push(cfg.agentId);
      writeJson(metaPath, meta);
    }
  }

  try {
    const indexPath = path.join(root, "channels", "_index.json");
    const idx = readJson(indexPath);
    if (idx?.channels) {
      const existing = idx.channels.find((ch: any) => ch.channel_id === SURVIVAL_CHANNEL_ID);
      if (!existing) {
        idx.channels.push({
          channel_id: SURVIVAL_CHANNEL_ID,
          display_name: "#survival",
          type: "group",
          members: allAgents,
        });
        writeJson(indexPath, idx);
      } else if (!existing.members?.includes(cfg.agentId)) {
        existing.members = existing.members ?? [];
        existing.members.push(cfg.agentId);
        writeJson(indexPath, idx);
      }
    }
  } catch {
    /* _index.json update is best-effort */
  }
}

function isSurvivalCheckCommand(msg: InboxMessage): boolean {
  if (msg.metadata?.system_command === "survival_check") return true;
  const text = msg.content?.text?.trim() ?? "";
  if (/^\/survival\b/i.test(text)) return true;
  return false;
}

function handleSurvivalCheck(cfg: ChatroomConfig, msg: InboxMessage, logger: Logger): void {
  ensureSurvivalChannel(cfg);
  const channelId =
    msg.channel_id === SURVIVAL_CHANNEL_ID ? SURVIVAL_CHANNEL_ID : SURVIVAL_CHANNEL_ID;
  const timestamp = new Date().toISOString();
  const text = `[${cfg.agentId}] 🟢 I am listening. (${timestamp})`;
  logger.info(`[survival] Responding to survival check from ${msg.from}`);
  sendMessageToNAS(cfg, channelId, text, "STATUS_UPDATE");
}

function pauseActiveTasksForUpgrade(cfg: ChatroomConfig, logger: Logger): number {
  const activeTasks = listTasksByStatus(cfg, "DISPATCHED", "ACKED", "PROCESSING");
  const myTasks = activeTasks.filter((t) => t.to === cfg.agentId || t.from === cfg.agentId);
  for (const task of myTasks) {
    updateTaskRecord(cfg, task.task_id, {
      status: "PARKED",
      current_phase: "system_upgrade",
    } as Partial<TaskRecord>);
    logger.info(`[self-update] Parked task ${task.task_id} (was ${task.status})`);
  }
  return myTasks.length;
}

function isSelfUpdateCommand(msg: InboxMessage): boolean {
  if (msg.metadata?.system_command === "self_update") return true;
  const text = msg.content?.text?.trim() ?? "";
  if (/^\/system-update\b/i.test(text)) return true;
  // #upgrade is a dedicated channel: any non-report message is an update trigger
  if (msg.channel_id === UPGRADE_CHANNEL_ID && msg.type !== "STATUS_UPDATE") return true;
  return false;
}

function isSelfUpdateAuthorized(msg: InboxMessage): boolean {
  const from = msg.from ?? "";
  if (from.startsWith("human:")) return true;
  if (from === "firstclaw") return true;
  if (msg.metadata?.system_command === "self_update") return true;
  return false;
}

function reportVersionToUpgrade(cfg: ChatroomConfig, extra?: string): void {
  ensureUpgradeChannel(cfg);
  const root = cfg.repoRoot ?? resolveGitRoot() ?? process.cwd();
  const version = readProjectVersion(root);
  const commit = readProjectCommit(root);
  let text = `[${cfg.agentId}] Current version: v${version} (${commit})`;
  if (!cfg.repoRoot) text += `\n⚠ repoRoot not configured (using auto-detected: ${root})`;
  if (extra) text += `\n${extra}`;
  sendMessageToNAS(cfg, UPGRADE_CHANNEL_ID, text, "STATUS_UPDATE");
}

async function handleSelfUpdate(
  cfg: ChatroomConfig,
  msg: InboxMessage,
  logger: Logger,
): Promise<void> {
  ensureUpgradeChannel(cfg);

  const projectRoot = cfg.repoRoot ?? resolveGitRoot() ?? process.cwd();

  if (!cfg.repoRoot) {
    logger.warn(
      `[self-update] repoRoot not configured — falling back to auto-detected "${projectRoot}". ` +
        `For reliability, run: firstclaw config set plugins.entries.agent-chatroom.config.repoRoot ${projectRoot}`,
    );
  }

  logger.info(
    `[self-update] Received update command from ${msg.from} in #${msg.channel_id} (root: ${projectRoot})`,
  );

  const sendStatus = (text: string) => {
    try {
      sendMessageToNAS(cfg, UPGRADE_CHANNEL_ID, text, "STATUS_UPDATE");
    } catch (err) {
      logger.warn(`[self-update] Failed to send status: ${err}`);
    }
  };

  try {
    // ── Step 1: git pull ──
    logger.info("[self-update] Running git pull...");
    const pullOutput = execSync("git pull --ff-only", {
      cwd: projectRoot,
      encoding: "utf-8",
      timeout: 60_000,
    }).trim();
    logger.info(`[self-update] git pull: ${pullOutput}`);

    if (/already up[- ]to[- ]date/i.test(pullOutput)) {
      try {
        reportVersionToUpgrade(cfg, "Already up to date.");
        logger.info("[self-update] Version report sent to #upgrade");
      } catch (reportErr) {
        logger.error(`[self-update] Failed to report version: ${reportErr}`);
      }
      return;
    }

    // ── Step 2: pause tasks ──
    const parkedCount = pauseActiveTasksForUpgrade(cfg, logger);
    const parkedNote = parkedCount > 0 ? ` (${parkedCount} active task(s) parked)` : "";

    // ── Step 3: install + build (safe while gateway runs — modules cached in memory) ──
    sendStatus(`[${cfg.agentId}] Code pulled. Installing dependencies...${parkedNote}`);
    logger.info("[self-update] Running pnpm install...");
    execSync("pnpm install --frozen-lockfile", {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 120_000,
    });

    sendStatus(`[${cfg.agentId}] Building project...`);
    logger.info("[self-update] Running pnpm build...");
    execSync("pnpm build", {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 120_000,
    });
    logger.info("[self-update] Build complete.");

    // ── Step 4: write marker for post-restart version report ──
    writeSelfUpdateMarker(cfg, msg.from);

    sendStatus(`[${cfg.agentId}] Build complete. Restarting gateway...`);

    // ── Step 5: spawn a restart helper and exit ──
    // The helper waits for this process to release the port/lock, then
    // relaunches with the exact same arguments so it stays in the terminal.
    scheduleGatewayRestart(projectRoot, logger);

    await new Promise((r) => setTimeout(r, 500));
    process.exit(0);
  } catch (err: any) {
    const stderr = err.stderr?.toString?.() ?? "";
    const stdout = err.stdout?.toString?.() ?? "";
    const detail = stderr || stdout || err.message || String(err);
    logger.error(`[self-update] Update failed: ${detail}`);
    sendStatus(`[${cfg.agentId}] Update failed:\n${detail.slice(0, 500)}`);
  }
}

function scheduleGatewayRestart(projectRoot: string, logger: Logger): void {
  const argv = process.argv;
  const cwd = process.cwd();

  // Inline Node.js script that waits for this process to exit, then relaunches.
  const script = [
    `const { spawn: _spawn } = require("child_process");`,
    `const exe = ${JSON.stringify(argv[0])};`,
    `const args = ${JSON.stringify(argv.slice(1))};`,
    `const cwd = ${JSON.stringify(cwd)};`,
    `setTimeout(() => {`,
    `  const child = _spawn(exe, args, { cwd, stdio: "inherit" });`,
    `  child.on("exit", (code) => process.exit(code ?? 0));`,
    `}, 3000);`,
  ].join("\n");

  const helper = spawn(process.execPath, ["-e", script], {
    cwd,
    env: { ...process.env },
    detached: true,
    stdio: "inherit",
  });
  helper.unref();
  logger.info(`[self-update] Restart helper spawned (pid=${helper.pid}), relaunching in 3s`);
}

function pollInbox(cfg: ChatroomConfig, logger?: Logger): InboxMessage[] {
  const root = chatroomRoot(cfg);
  const inboxDir = path.join(root, "inbox", cfg.agentId);
  if (!fs.existsSync(inboxDir)) return [];

  const files = fs
    .readdirSync(inboxDir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const messages: InboxMessage[] = [];

  for (const file of files) {
    const filePath = path.join(inboxDir, file);
    try {
      const notif = readJson(filePath);
      if (!notif) {
        logger?.warn(`[pollInbox] Unreadable notification (null JSON): ${file}`);
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* best-effort cleanup */
        }
        continue;
      }

      let resolved = false;

      // Try to read the original message from the channel
      if (notif.message_seq && notif.message_seq > 0) {
        const msgDir = path.join(root, "channels", notif.channel_id, "messages");
        if (fs.existsSync(msgDir)) {
          const prefix = String(notif.message_seq).padStart(6, "0");
          const msgFiles = fs.readdirSync(msgDir).filter((f) => f.startsWith(prefix));
          if (msgFiles.length > 0) {
            const fullMsg = readJson(path.join(msgDir, msgFiles[0]));
            if (fullMsg) {
              messages.push(fullMsg);
              resolved = true;
            }
          }
        }
      }

      // Fallback: retry notifications or missing message files — construct
      // a synthetic InboxMessage from the notification itself so it can still
      // be routed (e.g. as a TASK_DISPATCH retry).
      if (!resolved && notif.retry_for_task) {
        const taskData = readJson(path.join(tasksDir(cfg), `${notif.retry_for_task}.json`));
        if (taskData) {
          messages.push({
            message_id: notif.notification_id ?? randomUUID(),
            channel_id: notif.channel_id,
            from: notif.from ?? taskData.from,
            type: "TASK_DISPATCH",
            content: {
              text: taskData.instruction ?? notif.preview ?? "",
              mentions: [cfg.agentId],
            },
            timestamp: notif.timestamp ?? nowISO(),
            seq: 0,
            metadata: {
              task_id: notif.retry_for_task,
              priority: "urgent",
              output_dir: taskData.asset_paths?.[0]
                ? path.dirname(taskData.asset_paths[0])
                : taskAssetsDir(cfg, cfg.agentId, notif.retry_for_task),
              is_retry: true,
            },
          });
          resolved = true;
        }
      }

      // Fallback: construct minimal message from notification preview
      if (!resolved && notif.preview) {
        messages.push({
          message_id: notif.notification_id ?? randomUUID(),
          channel_id: notif.channel_id,
          from: notif.from ?? "unknown",
          type: "CHAT",
          content: {
            text: notif.preview,
            mentions: notif.mentioned ? [cfg.agentId] : [],
          },
          timestamp: notif.timestamp ?? nowISO(),
          seq: notif.message_seq ?? 0,
          metadata: {},
        });
      }

      if (!resolved) {
        logger?.warn(
          `[pollInbox] Could not resolve notification ${file} (ch=${notif.channel_id}, seq=${notif.message_seq}) — skipping`,
        );
      }

      fs.unlinkSync(filePath);
    } catch (err) {
      logger?.error(`[pollInbox] Error processing ${file}: ${err}`);
    }
  }

  return messages;
}

// ============================================================================
// Task Registry — persistent task state on NAS
// ============================================================================

function createTaskRecord(
  cfg: ChatroomConfig,
  to: string,
  channelId: string,
  instruction: string,
  opts?: { ackTimeoutMs?: number; taskTimeoutMs?: number; maxRetries?: number },
): TaskRecord {
  const dir = tasksDir(cfg);
  ensureDir(dir);

  const task: TaskRecord = {
    task_id: randomUUID(),
    from: cfg.agentId,
    to,
    channel_id: channelId,
    status: "DISPATCHED",
    instruction,
    dispatched_at: nowISO(),
    acked_at: null,
    started_at: null,
    completed_at: null,
    result_summary: null,
    asset_paths: [],
    retries: 0,
    max_retries: opts?.maxRetries ?? 3,
    ack_timeout_ms: opts?.ackTimeoutMs ?? 60_000,
    task_timeout_ms: opts?.taskTimeoutMs ?? 3_600_000,
  };

  writeJson(path.join(dir, `${task.task_id}.json`), task);
  return task;
}

function readTaskRecord(cfg: ChatroomConfig, taskId: string): TaskRecord | null {
  return readJson(path.join(tasksDir(cfg), `${taskId}.json`));
}

function updateTaskRecord(cfg: ChatroomConfig, taskId: string, patch: Partial<TaskRecord>): void {
  const filePath = path.join(tasksDir(cfg), `${taskId}.json`);
  const existing = readJson(filePath);
  if (!existing) return;
  writeJson(filePath, { ...existing, ...patch });
}

function listTasksByStatus(cfg: ChatroomConfig, ...statuses: TaskStatus[]): TaskRecord[] {
  const dir = tasksDir(cfg);
  if (!fs.existsSync(dir)) return [];

  const statusSet = new Set(statuses);
  const tasks: TaskRecord[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const task = readJson(path.join(dir, file)) as TaskRecord | null;
    if (task && statusSet.has(task.status)) tasks.push(task);
  }
  return tasks;
}

// ============================================================================
// Task Protocol: dispatch, ACK, result
// ============================================================================

function dispatchTask(
  cfg: ChatroomConfig,
  to: string,
  instruction: string,
  logger: Logger,
  opts?: { ackTimeoutMs?: number; taskTimeoutMs?: number; maxRetries?: number },
): TaskRecord {
  const channelId = `dm_${to}`;
  const task = createTaskRecord(cfg, to, channelId, instruction, opts);

  const outputDir = taskAssetsDir(cfg, to, task.task_id);
  ensureDir(outputDir);

  sendMessageToNAS(cfg, channelId, instruction, "TASK_DISPATCH", [to], undefined, {
    task_id: task.task_id,
    priority: "urgent",
    output_dir: outputDir,
    task_timeout_ms: task.task_timeout_ms,
  });

  logger.info(`Task ${task.task_id} dispatched to ${to} via #${channelId} (output: ${outputDir})`);
  return task;
}

function sendSystemAck(cfg: ChatroomConfig, task: TaskRecord, logger: Logger): void {
  const ackText = `[SYSTEM] Task ${task.task_id} acknowledged by ${cfg.agentId}`;
  sendMessageToNAS(cfg, task.channel_id, ackText, "TASK_ACK", [task.from], undefined, {
    task_id: task.task_id,
  });
  updateTaskRecord(cfg, task.task_id, { status: "ACKED", acked_at: nowISO() });
  logger.info(`ACK sent for task ${task.task_id} → ${task.from}`);
}

function sendTaskResult(
  cfg: ChatroomConfig,
  taskId: string,
  resultText: string,
  status: "DONE" | "FAILED",
  logger: Logger,
  assetPaths: string[] = [],
  errorType?: TaskErrorType | null,
): void {
  finalizeTaskProgress(cfg, taskId);

  const task = readTaskRecord(cfg, taskId);
  if (!task) {
    logger.warn(`Cannot send result — task ${taskId} not found`);
    return;
  }
  sendMessageToNAS(cfg, task.channel_id, resultText, "RESULT_REPORT", [task.from], undefined, {
    task_id: taskId,
    status,
    asset_paths: assetPaths,
    error_type: errorType ?? undefined,
  });
  const patch: Partial<TaskRecord> = {
    status,
    completed_at: nowISO(),
    result_summary: resultText.slice(0, 500),
    asset_paths: assetPaths,
  };
  if (errorType) {
    patch.error_type = errorType;
    patch.error_detail = resultText.slice(0, 2000);
  }
  patch.current_phase = status === "DONE" ? "completed" : "failed";
  updateTaskRecord(cfg, taskId, patch);
  resetAgentStatus(cfg, task.to, logger);
  logger.info(
    `Result sent for task ${taskId} (${status}${errorType ? ` [${errorType}]` : ""}) → ${task.from}`,
  );
}

function cancelTask(
  cfg: ChatroomConfig,
  taskId: string,
  reason: string,
  logger: Logger,
): TaskRecord | null {
  const task = readTaskRecord(cfg, taskId);
  if (!task) return null;

  const terminalStatuses: TaskStatus[] = ["DONE", "FAILED", "ABANDONED", "CANCELLED"];
  if (terminalStatuses.includes(task.status)) return task;

  updateTaskRecord(cfg, taskId, {
    status: "CANCELLED",
    completed_at: nowISO(),
    result_summary: `Cancelled: ${reason}`.slice(0, 500),
  });

  sendMessageToNAS(
    cfg,
    task.channel_id,
    `[SYSTEM] Task ${taskId} cancelled by ${cfg.agentId}. Reason: ${reason}`,
    "SYSTEM",
    [task.to],
    undefined,
    { task_id: taskId, status: "CANCELLED" },
  );

  resetAgentStatus(cfg, task.to, logger);
  logger.info(`Task ${taskId} cancelled (was ${task.status}) → ${task.to}`);
  return { ...task, status: "CANCELLED", completed_at: nowISO() };
}

function setAgentWorking(
  cfg: ChatroomConfig,
  agentId: string,
  taskId: string,
  logger: Logger,
): void {
  const regPath = path.join(chatroomRoot(cfg), "registry", `${agentId}.json`);
  const info = readJson(regPath);
  if (!info) return;
  info.status = "working";
  info.current_task = taskId;
  info.last_heartbeat = nowISO();
  writeJson(regPath, info);
  logger.info(`Agent ${agentId} status → working (task: ${taskId.slice(0, 8)})`);
}

function resetAgentStatus(cfg: ChatroomConfig, agentId: string, logger: Logger): void {
  const regPath = path.join(chatroomRoot(cfg), "registry", `${agentId}.json`);
  const info = readJson(regPath);
  if (!info) return;
  if (info.status === "working" || info.status === "waiting") {
    info.status = "idle";
    info.current_task = null;
    writeJson(regPath, info);
    logger.info(`Reset ${agentId} status to idle`);
  }
}

// ============================================================================
// Error classification
// ============================================================================

const ERROR_PATTERNS: Array<{ type: TaskErrorType; patterns: RegExp[] }> = [
  {
    type: "CONTEXT_OVERFLOW",
    patterns: [
      /context overflow/i,
      /prompt too large/i,
      /compaction.?fail/i,
      /context.?window.?too small/i,
      /maximum context length/i,
      /token limit/i,
    ],
  },
  {
    type: "RATE_LIMITED",
    patterns: [
      /rate.?limit/i,
      /too many requests/i,
      /\b429\b/,
      /resource.?exhausted/i,
      /quota.?exceeded/i,
      /throttl/i,
    ],
  },
  {
    type: "TOOL_ERROR",
    patterns: [/tool.+(?:fail|error)/i, /(?:fail|error).+tool/i, /tool execution/i],
  },
];

function classifyError(text: string): TaskErrorType {
  for (const { type, patterns } of ERROR_PATTERNS) {
    for (const re of patterns) {
      if (re.test(text)) return type;
    }
  }
  return "LLM_ERROR";
}

// ============================================================================
// Task progress tracking (buffered NAS writes)
// ============================================================================

const _progressBuffers = new Map<
  string,
  { entries: ProgressEntry[]; phase: string; flushTimer: ReturnType<typeof setTimeout> | null }
>();

const PROGRESS_FLUSH_INTERVAL_MS = 5_000;

function _flushProgress(cfg: ChatroomConfig, taskId: string): void {
  const buf = _progressBuffers.get(taskId);
  if (!buf || buf.entries.length === 0) return;

  const task = readTaskRecord(cfg, taskId);
  if (!task) return;

  const existing = task.progress_log ?? [];
  const merged = [...existing, ...buf.entries];
  updateTaskRecord(cfg, taskId, {
    progress_log: merged,
    current_phase: buf.phase,
  } as Partial<TaskRecord>);

  buf.entries = [];
}

function appendTaskProgress(
  cfg: ChatroomConfig,
  taskId: string,
  entry: { phase: string; detail?: string },
): void {
  let buf = _progressBuffers.get(taskId);
  if (!buf) {
    buf = { entries: [], phase: entry.phase, flushTimer: null };
    _progressBuffers.set(taskId, buf);
  }
  buf.entries.push({ timestamp: nowISO(), ...entry });
  buf.phase = entry.phase;

  if (!buf.flushTimer) {
    buf.flushTimer = setTimeout(() => {
      _flushProgress(cfg, taskId);
      buf!.flushTimer = null;
    }, PROGRESS_FLUSH_INTERVAL_MS);
  }
}

function finalizeTaskProgress(cfg: ChatroomConfig, taskId: string): void {
  const buf = _progressBuffers.get(taskId);
  if (buf) {
    if (buf.flushTimer) clearTimeout(buf.flushTimer);
    _flushProgress(cfg, taskId);
    _progressBuffers.delete(taskId);
  }
}

// ============================================================================
// Task Parking — suspend long-running tasks without holding LLM sessions
// ============================================================================

function parkedTasksDir(cfg: ChatroomConfig): string {
  return path.join(chatroomRoot(cfg), "parked_tasks");
}

function writeParkedTask(cfg: ChatroomConfig, info: ParkedTaskInfo): void {
  const dir = parkedTasksDir(cfg);
  ensureDir(dir);
  writeJson(path.join(dir, `${info.task_id}.json`), info);
}

function readParkedTask(cfg: ChatroomConfig, taskId: string): ParkedTaskInfo | null {
  return readJson(path.join(parkedTasksDir(cfg), `${taskId}.json`));
}

function removeParkedTask(cfg: ChatroomConfig, taskId: string): void {
  const filePath = path.join(parkedTasksDir(cfg), `${taskId}.json`);
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* ignore */
  }
}

function listParkedTasks(cfg: ChatroomConfig): ParkedTaskInfo[] {
  const dir = parkedTasksDir(cfg);
  if (!fs.existsSync(dir)) return [];
  const results: ParkedTaskInfo[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const info = readJson(path.join(dir, file)) as ParkedTaskInfo | null;
    if (info) results.push(info);
  }
  return results;
}

function checkParkCondition(
  cfg: ChatroomConfig,
  info: ParkedTaskInfo,
  logger: Logger,
): { met: boolean; result: string } {
  try {
    switch (info.watch_type) {
      case "file": {
        const filePath = info.watch_config.file_path;
        if (!filePath) return { met: false, result: "No file_path configured" };
        if (fs.existsSync(filePath)) {
          const stat = fs.statSync(filePath);
          return {
            met: true,
            result: `File appeared: ${filePath} (${stat.size} bytes, modified ${stat.mtime.toISOString()})`,
          };
        }
        return { met: false, result: `Waiting for file: ${filePath}` };
      }
      case "shell": {
        const command = info.watch_config.command;
        if (!command) return { met: false, result: "No command configured" };
        const { execSync } = require("child_process");
        try {
          const output = execSync(command, {
            timeout: 30_000,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          });
          return { met: true, result: `Command succeeded:\n${(output as string).slice(0, 2000)}` };
        } catch (err: any) {
          return {
            met: false,
            result: `Command still failing: exit ${err.status ?? "unknown"}`,
          };
        }
      }
      case "poll_url": {
        // Synchronous HTTP check via child_process curl
        const url = info.watch_config.url;
        if (!url) return { met: false, result: "No url configured" };
        const expectedStatus = info.watch_config.expected_status ?? 200;
        const { execSync } = require("child_process");
        try {
          const output = execSync(
            `curl -s -o /dev/null -w "%{http_code}" --max-time 10 ${JSON.stringify(url)}`,
            { encoding: "utf-8", timeout: 15_000, stdio: ["pipe", "pipe", "pipe"] },
          );
          const statusCode = parseInt((output as string).trim(), 10);
          if (statusCode === expectedStatus) {
            return { met: true, result: `URL returned ${statusCode} (expected ${expectedStatus})` };
          }
          return {
            met: false,
            result: `URL returned ${statusCode}, waiting for ${expectedStatus}`,
          };
        } catch {
          return { met: false, result: `URL unreachable` };
        }
      }
      case "permission": {
        const permId = info.watch_config.permission_id;
        if (!permId) return { met: false, result: "No permission_id configured" };
        const permFile = path.join(permissionsDir(cfg), `${permId}.json`);
        const perm = readJson(permFile) as PermissionRecord | null;
        if (!perm) return { met: false, result: "Permission record not found" };
        if (perm.status === "approved" || perm.status === "allowlisted") {
          return {
            met: true,
            result: `Permission ${perm.status} by ${perm.decided_by ?? "admin"}`,
          };
        }
        if (perm.status === "rejected") {
          return {
            met: true,
            result: `Permission REJECTED by ${perm.decided_by ?? "admin"}: ${perm.decision_reason ?? "no reason given"}`,
          };
        }
        return { met: false, result: `Waiting for human approval (${perm.status})` };
      }
      default:
        return { met: false, result: `Unknown watch_type: ${info.watch_type}` };
    }
  } catch (err) {
    logger.error(`Park condition check failed for ${info.task_id}: ${err}`);
    return { met: false, result: `Check error: ${err}` };
  }
}

function monitorParkedTasks(cfg: ChatroomConfig, runtime: any, config: any, logger: Logger): void {
  const parked = listParkedTasks(cfg);
  if (parked.length === 0) return;

  const now = Date.now();

  for (const info of parked) {
    if (info.agent_id !== cfg.agentId) continue;

    const parkedAt = new Date(info.parked_at).getTime();
    const elapsed = now - parkedAt;

    if (elapsed > info.max_wait_ms) {
      logger.warn(`Parked task ${info.task_id} exceeded max wait (${info.max_wait_ms}ms)`);
      removeParkedTask(cfg, info.task_id);
      updateTaskRecord(cfg, info.task_id, {
        status: "FAILED",
        completed_at: nowISO(),
        error_type: "LLM_ERROR",
        error_detail: `Parked task timed out after ${Math.round(elapsed / 60000)} minutes`,
        current_phase: "park_timeout",
      } as Partial<TaskRecord>);
      sendMessageToNAS(
        cfg,
        info.channel_id,
        `[SYSTEM] Parked task ${info.task_id} timed out — waited ${Math.round(elapsed / 60000)}min for condition`,
        "SYSTEM",
        [],
      );
      continue;
    }

    const lastPoll = info.last_poll_at ? new Date(info.last_poll_at).getTime() : 0;
    if (now - lastPoll < info.poll_interval_ms) continue;

    info.last_poll_at = nowISO();
    info.poll_count++;
    writeParkedTask(cfg, info);

    const { met, result } = checkParkCondition(cfg, info, logger);
    appendTaskProgress(cfg, info.task_id, {
      phase: "parked_poll",
      detail: `[poll #${info.poll_count}] ${result.slice(0, 200)}`,
    });

    if (met) {
      logger.info(`Parked task ${info.task_id} condition met: ${result.slice(0, 100)}`);
      removeParkedTask(cfg, info.task_id);

      // Handle permission rejection: fail the task instead of resuming
      if (info.watch_type === "permission" && result.includes("REJECTED")) {
        updateTaskRecord(cfg, info.task_id, {
          status: "FAILED",
          completed_at: nowISO(),
          error_detail: `Permission denied: ${result}`,
          current_phase: "permission_rejected",
        } as Partial<TaskRecord>);

        sendMessageToNAS(
          cfg,
          info.channel_id,
          `[SYSTEM] Task ${info.task_id} — permission was denied by admin. The requested operation will not be executed.\n\nRejection: ${result}`,
          "SYSTEM",
          [],
          undefined,
          { task_id: info.task_id },
        );

        resetAgentStatus(cfg, info.agent_id, logger);
        logger.info(`Task ${info.task_id} failed due to permission rejection`);
        continue;
      }

      updateTaskRecord(cfg, info.task_id, {
        status: "PROCESSING",
        current_phase: "resuming_from_park",
      } as Partial<TaskRecord>);

      const isPermissionResume = info.watch_type === "permission";
      const resumeInstruction = isPermissionResume
        ? [
            `[TASK RESUMED — PERMISSION GRANTED]`,
            `task_id: ${info.task_id}`,
            `original_instruction: ${info.original_instruction}`,
            ``,
            `Your previously requested sensitive operation has been APPROVED by the admin.`,
            `${result}`,
            ``,
            `You may now proceed with the operation. Resume instructions:`,
            info.resume_prompt,
            ``,
            `Continue processing this task. For binary files use chatroom_publish_file(source_path="...", task_id="${info.task_id}"), for text use chatroom_save_asset(task_id="${info.task_id}").`,
            `Your final text response will be delivered as the task result.`,
          ].join("\n")
        : [
            `[TASK RESUMED FROM PARK]`,
            `task_id: ${info.task_id}`,
            `original_instruction: ${info.original_instruction}`,
            ``,
            `The long-running operation has completed. Here is the result:`,
            result,
            ``,
            `Resume instructions from the agent:`,
            info.resume_prompt,
            ``,
            `Continue processing this task. For binary files use chatroom_publish_file(source_path="...", task_id="${info.task_id}"), for text use chatroom_save_asset(task_id="${info.task_id}").`,
            `Your final text response will be delivered as the task result.`,
          ].join("\n");

      const syntheticMsg: InboxMessage = {
        message_id: `resume_${info.task_id}_${randomUUID()}`,
        timestamp: nowISO(),
        channel_id: info.channel_id,
        from: "system",
        content: { text: resumeInstruction, mentions: [info.agent_id] },
        type: "TASK_DISPATCH",
        metadata: {
          task_id: info.task_id,
          output_dir: taskAssetsDir(cfg, info.agent_id, info.task_id),
        },
        seq: 0,
      };

      autoDispatchForTask(cfg, syntheticMsg, info.task_id, runtime, config, logger);
    }
  }
}

// ============================================================================
// Sensitivity screening — programmatic pre-filter for the orchestrator
// ============================================================================

const SENSITIVE_PATTERNS: Array<{ re: RegExp; type: string; label: string }> = [
  { re: /\brm\s+(-[a-zA-Z]*\s+)*\//, type: "shell", label: "rm with absolute path" },
  { re: /\bsudo\b/, type: "shell", label: "sudo command" },
  { re: /\bchmod\b/, type: "system", label: "permission change" },
  { re: /\bchown\b/, type: "system", label: "ownership change" },
  { re: /\/etc\//, type: "read", label: "system config access" },
  { re: /\/usr\/(?:local|bin|sbin)\//, type: "write", label: "system directory write" },
  { re: /\.env\b/, type: "read", label: ".env file access" },
  {
    re: /(?:password|secret|credential|api_key|private_key)\s*[:=]/i,
    type: "read",
    label: "credential handling",
  },
  {
    re: /\bcurl\b.*(?:-d\b|-X\s*(?:POST|PUT|DELETE))/i,
    type: "network",
    label: "network mutation",
  },
  { re: /\bwget\b/, type: "network", label: "network download" },
  { re: /\bsystemctl\b|\bservice\s+/, type: "system", label: "system service operation" },
  { re: /\bkill\b|\bkillall\b/, type: "system", label: "process termination" },
  { re: /\biptables\b|\bufw\b/, type: "system", label: "firewall modification" },
  {
    re: /\bdocker\s+(?:rm|rmi|stop|kill|exec)\b/,
    type: "system",
    label: "docker destructive operation",
  },
];

function sensitivityPreFilter(
  text: string,
): { hit: boolean; type: string; label: string; detail: string } | null {
  for (const { re, type, label } of SENSITIVE_PATTERNS) {
    const match = text.match(re);
    if (match) {
      // Extract the surrounding context for the matched operation
      const idx = text.indexOf(match[0]);
      const start = Math.max(0, idx - 20);
      const end = Math.min(text.length, idx + match[0].length + 80);
      const detail = text.slice(start, end).trim();
      return { hit: true, type, label, detail };
    }
  }
  return null;
}

// ============================================================================
// Daemon message handlers — route by message type
// ============================================================================

function handleIncomingTask(
  cfg: ChatroomConfig,
  msg: InboxMessage,
  runtime: any,
  config: any,
  logger: Logger,
): void {
  const taskId = msg.metadata?.task_id;
  if (!taskId) {
    logger.warn(`TASK_DISPATCH without task_id from ${msg.from}, ignoring`);
    return;
  }

  const task = readTaskRecord(cfg, taskId);
  if (!task) {
    logger.warn(`Task ${taskId} not found on NAS, creating local record`);
    const dir = tasksDir(cfg);
    ensureDir(dir);
    const metaTimeout =
      typeof msg.metadata?.task_timeout_ms === "number" ? msg.metadata.task_timeout_ms : undefined;
    const synthetic: TaskRecord = {
      task_id: taskId,
      from: msg.from,
      to: cfg.agentId,
      channel_id: msg.channel_id,
      status: "DISPATCHED",
      instruction: msg.content.text,
      dispatched_at: msg.timestamp,
      acked_at: null,
      started_at: null,
      completed_at: null,
      result_summary: null,
      asset_paths: [],
      retries: 0,
      max_retries: 3,
      ack_timeout_ms: 30_000,
      task_timeout_ms: metaTimeout ?? 3_600_000,
    };
    writeJson(path.join(dir, `${taskId}.json`), synthetic);
  }

  const currentTask = readTaskRecord(cfg, taskId)!;
  sendSystemAck(cfg, currentTask, logger);

  updateTaskRecord(cfg, taskId, {
    status: "PROCESSING",
    started_at: nowISO(),
    current_phase: "processing",
    error_type: null,
    error_detail: null,
  } as Partial<TaskRecord>);
  setAgentWorking(cfg, cfg.agentId, taskId, logger);
  logger.info(`Processing task ${taskId} from ${msg.from}: "${msg.content.text.slice(0, 80)}..."`);

  const isLongRunning = Boolean(msg.metadata?.long_running);
  const usePlanMode = shouldUsePlanMode(msg.content.text, isLongRunning);

  if (usePlanMode) {
    logger.info(`Task ${taskId}: using Plan Mode (long_running=${isLongRunning})`);
    handlePlanModeTask(cfg, msg, taskId, runtime, config, logger);
  } else {
    logger.info(`Task ${taskId}: using direct execution (simple task)`);
    autoDispatchForTask(cfg, msg, taskId, runtime, config, logger);
  }
}

/**
 * Plan Mode: planning phase -> approval -> step-by-step execution.
 */
async function handlePlanModeTask(
  cfg: ChatroomConfig,
  msg: InboxMessage,
  taskId: string,
  runtime: any,
  config: any,
  logger: Logger,
): Promise<void> {
  try {
    // Phase 1: Planning
    const plan = await planningPhase(cfg, msg, taskId, runtime, config, logger);
    if (!plan) {
      logger.warn(`Plan mode failed for task ${taskId} — falling back to direct execution`);
      autoDispatchForTask(cfg, msg, taskId, runtime, config, logger);
      return;
    }

    // Phase 1.5: Approval
    const approvedPlan = await waitForApproval(cfg, plan, taskId, logger);
    if (!approvedPlan) {
      logger.info(`Plan for task ${taskId} was not approved`);
      const existingTask = readTaskRecord(cfg, taskId);
      if (existingTask && existingTask.status !== "CANCELLED" && existingTask.status !== "FAILED") {
        sendTaskResult(cfg, taskId, "Plan was rejected or approval timed out", "FAILED", logger);
      }
      return;
    }

    // Phase 2: Step-by-step execution
    await stepExecutionLoop(cfg, approvedPlan, msg, taskId, runtime, config, logger);
  } catch (err) {
    logger.error(`Plan mode error for task ${taskId}: ${err}`);
    sendTaskResult(cfg, taskId, `Plan mode failed: ${err}`, "FAILED", logger);
  }
}

function handleTaskAck(cfg: ChatroomConfig, msg: InboxMessage, logger: Logger): void {
  const taskId = msg.metadata?.task_id;
  if (!taskId) return;

  const task = readTaskRecord(cfg, taskId);
  if (!task) return;

  if (task.status === "DISPATCHED" || task.status === "TIMEOUT" || task.status === "RETRYING") {
    updateTaskRecord(cfg, taskId, {
      status: "ACKED",
      acked_at: nowISO(),
      current_phase: "acked",
    } as Partial<TaskRecord>);
    logger.info(`Task ${taskId} ACK received from ${msg.from}`);
  }
}

function handleTaskResult(cfg: ChatroomConfig, msg: InboxMessage, logger: Logger): void {
  const taskId = msg.metadata?.task_id;
  if (!taskId) return;

  const task = readTaskRecord(cfg, taskId);
  if (!task) return;

  const resultStatus = (msg.metadata?.status as TaskStatus) || "DONE";
  const patch: Partial<TaskRecord> = {
    status: resultStatus,
    completed_at: nowISO(),
    result_summary: msg.content.text.slice(0, 500),
    asset_paths: msg.metadata?.asset_paths ?? [],
  };
  if (msg.metadata?.error_type) {
    patch.error_type = msg.metadata.error_type as TaskErrorType;
    patch.error_detail = msg.content.text.slice(0, 2000);
  }
  patch.current_phase = resultStatus === "DONE" ? "completed" : "failed";
  updateTaskRecord(cfg, taskId, patch);
  logger.info(
    `Task ${taskId} result received from ${msg.from} (${resultStatus}${patch.error_type ? ` [${patch.error_type}]` : ""})`,
  );
}

// ============================================================================
// ACK timeout monitoring
// ============================================================================

const RATE_LIMIT_RETRY_DELAY_MS = 60_000;

function monitorPendingTasks(cfg: ChatroomConfig, logger: Logger): void {
  const pending = listTasksByStatus(cfg, "DISPATCHED", "TIMEOUT", "RETRYING");
  const now = Date.now();

  for (const task of pending) {
    if (task.from !== cfg.agentId) continue;

    // RETRYING tasks wait for the backoff period, then re-dispatch
    if (task.status === "RETRYING") {
      const completedAt = new Date(task.completed_at ?? task.dispatched_at).getTime();
      if (now - completedAt < RATE_LIMIT_RETRY_DELAY_MS) continue;

      if (task.retries >= task.max_retries) {
        updateTaskRecord(cfg, task.task_id, { status: "ABANDONED", completed_at: nowISO() });
        sendMessageToNAS(
          cfg,
          task.channel_id,
          `[SYSTEM] Task ${task.task_id} abandoned — rate limit retries exhausted (${task.max_retries} attempts)`,
          "SYSTEM",
          [],
        );
        logger.warn(`Task ${task.task_id} ABANDONED after ${task.max_retries} rate-limit retries`);
        continue;
      }

      updateTaskRecord(cfg, task.task_id, {
        status: "DISPATCHED",
        retries: task.retries + 1,
        dispatched_at: nowISO(),
        error_type: null,
        error_detail: null,
        completed_at: null,
        current_phase: "retrying",
      } as Partial<TaskRecord>);

      const root = chatroomRoot(cfg);
      const inboxDir = path.join(root, "inbox", task.to);
      ensureDir(inboxDir);
      const notif = {
        notification_id: randomUUID(),
        timestamp: nowISO(),
        channel_id: task.channel_id,
        message_seq: 0,
        from: cfg.agentId,
        preview: `[RATE-LIMIT RETRY ${task.retries + 1}/${task.max_retries}] ${task.instruction.slice(0, 80)}`,
        priority: "urgent",
        retry_for_task: task.task_id,
      };
      writeJson(path.join(inboxDir, `retry_${task.task_id}_${notif.notification_id}.json`), notif);
      logger.info(
        `Task ${task.task_id} rate-limit retry ${task.retries + 1}/${task.max_retries} → ${task.to}`,
      );
      continue;
    }

    const dispatchedAt = new Date(task.dispatched_at).getTime();
    const elapsed = now - dispatchedAt;

    if (elapsed > task.ack_timeout_ms) {
      if (task.retries >= task.max_retries) {
        updateTaskRecord(cfg, task.task_id, { status: "ABANDONED" });
        sendMessageToNAS(
          cfg,
          task.channel_id,
          `[SYSTEM] Task ${task.task_id} abandoned — ${task.to} did not respond after ${task.max_retries} retries`,
          "SYSTEM",
          [],
        );
        logger.warn(`Task ${task.task_id} ABANDONED (${task.to} unreachable)`);
      } else {
        updateTaskRecord(cfg, task.task_id, {
          status: "TIMEOUT",
          retries: task.retries + 1,
          dispatched_at: nowISO(),
        });
        const root = chatroomRoot(cfg);
        const inboxDir = path.join(root, "inbox", task.to);
        ensureDir(inboxDir);
        const notif = {
          notification_id: randomUUID(),
          timestamp: nowISO(),
          channel_id: task.channel_id,
          message_seq: 0,
          from: cfg.agentId,
          preview: `[RETRY ${task.retries + 1}/${task.max_retries}] ${task.instruction.slice(0, 80)}`,
          priority: "urgent",
          retry_for_task: task.task_id,
        };
        writeJson(
          path.join(inboxDir, `retry_${task.task_id}_${notif.notification_id}.json`),
          notif,
        );
        logger.warn(
          `Task ${task.task_id} ACK timeout — retry ${task.retries + 1}/${task.max_retries} sent to ${task.to}`,
        );
      }
    }
  }

  // Check PROCESSING tasks for timeouts
  const processing = listTasksByStatus(cfg, "ACKED", "PROCESSING");
  for (const task of processing) {
    if (task.from !== cfg.agentId) continue;
    const startedAt = new Date(task.started_at ?? task.acked_at ?? task.dispatched_at).getTime();
    if (now - startedAt > task.task_timeout_ms) {
      updateTaskRecord(cfg, task.task_id, {
        status: "FAILED",
        completed_at: nowISO(),
        error_type: "LLM_ERROR",
        error_detail: `Task timed out after ${Math.round(task.task_timeout_ms / 60000)} minutes`,
        current_phase: "timed_out",
      } as Partial<TaskRecord>);
      sendMessageToNAS(
        cfg,
        task.channel_id,
        `[SYSTEM] Task ${task.task_id} timed out — ${task.to} did not deliver results within ${Math.round(task.task_timeout_ms / 60000)}min`,
        "SYSTEM",
        [],
      );
      logger.warn(`Task ${task.task_id} TIMED OUT (${task.to})`);
    }
  }

  // React to error-typed FAILED tasks
  const failed = listTasksByStatus(cfg, "FAILED");
  for (const task of failed) {
    if (task.from !== cfg.agentId) continue;
    if (!task.error_type) continue;

    if (task.error_type === "RATE_LIMITED") {
      // Auto-retry: transition to RETRYING, the next monitor cycle will re-dispatch after delay
      logger.info(`Task ${task.task_id} failed with RATE_LIMITED — scheduling auto-retry`);
      updateTaskRecord(cfg, task.task_id, {
        status: "RETRYING",
        current_phase: "waiting_rate_limit",
      } as Partial<TaskRecord>);
      continue;
    }

    if (task.error_type === "CONTEXT_OVERFLOW") {
      // Notify orchestrator via system message so it can decide (simplify & re-dispatch or abort)
      const sysMsg =
        `[SYSTEM] Task ${task.task_id} failed: CONTEXT_OVERFLOW.\n` +
        `Target: ${task.to} | Instruction: "${task.instruction.slice(0, 100)}"\n` +
        `The instruction may be too complex for the agent's context window.\n` +
        `Options: simplify the instruction and re-dispatch, or cancel the task.`;
      sendMessageToNAS(cfg, "general", sysMsg, "SYSTEM", [cfg.agentId]);
      // Clear error_type so we don't notify repeatedly
      updateTaskRecord(cfg, task.task_id, { error_type: null } as Partial<TaskRecord>);
      logger.info(`Task ${task.task_id} CONTEXT_OVERFLOW — notified orchestrator in #general`);
      continue;
    }

    // LLM_ERROR / TOOL_ERROR: notify orchestrator once
    const sysMsg =
      `[SYSTEM] Task ${task.task_id} failed: ${task.error_type}.\n` +
      `Target: ${task.to} | Error: ${(task.error_detail ?? "unknown").slice(0, 200)}\n` +
      `Review the error and decide whether to re-dispatch or cancel.`;
    sendMessageToNAS(cfg, "general", sysMsg, "SYSTEM", [cfg.agentId]);
    updateTaskRecord(cfg, task.task_id, { error_type: null } as Partial<TaskRecord>);
    logger.info(`Task ${task.task_id} ${task.error_type} — notified orchestrator in #general`);
  }
}

// ============================================================================
// Orchestration context
// ============================================================================

function buildOrchestratorContext(cfg: ChatroomConfig, sourceChannel?: string): string {
  const agents = readAgentRegistry(cfg);
  const channels = listAgentChannels(cfg);

  const otherAgents = agents.filter((a) => a.agent_id !== cfg.agentId);
  if (otherAgents.length === 0 && channels.length === 0) return "";

  const myAssets = assetsDir(cfg, cfg.agentId);
  const sharedAssets = assetsDir(cfg, "shared");

  const lines: string[] = [
    `[Chatroom Orchestration Context]`,
    `You are "${cfg.agentId}", the Orchestrator of the First Agent Family.`,
    ``,
    `═══ CHANNEL RULES (MUST follow) ═══`,
    `  #general   → Human ↔ Orchestrator communication ONLY.`,
    `               When a human sends a message here, respond HERE and nowhere else.`,
    `               Do NOT post task results, progress updates, or agent replies to #general.`,
    `  #pipeline  → Pipeline status updates and progress summaries.`,
    `               Post stage progress (e.g. "Stage 1 complete, moving to Stage 2") here.`,
    `               Post final delivery summaries here when a full pipeline completes.`,
    `  #permission → Sensitive operation approval channel (system-managed).`,
    `               When agents encounter sensitive operations, the system posts approval`,
    `               requests here automatically. Human admins approve/reject via Web UI.`,
    `               Do NOT manually send messages to #permission.`,
    `  dm_{agent} → Private task channels between you and a specific agent.`,
    `               Task dispatch and result delivery happen here automatically via the protocol.`,
    `               Do NOT manually send messages to DM channels — the system handles it.`,
    ``,
    `  CRITICAL: Your response goes to the SAME channel as the incoming message.`,
    sourceChannel ? `  Current channel: #${sourceChannel}` : ``,
    ``,
    `═══ File System (NAS) ═══`,
    `  Your output dir: ${myAssets}`,
    `  Shared dir: ${sharedAssets}`,
    `  All agent assets: ${assetsDir(cfg)}`,
    `  When dispatching a task, the system auto-creates an output dir for the target.`,
    ``,
  ];

  if (otherAgents.length > 0) {
    lines.push(`═══ Available Agents ═══`);
    for (const a of otherAgents) {
      const dmChannel = `dm_${a.agent_id}`;
      const hasDM = channels.some((ch) => ch.channel_id === dmChannel);
      lines.push(
        `  - ${a.agent_id} (${a.display_name}) [${a.status}]${hasDM ? ` — DM: ${dmChannel}` : ""}`,
      );
    }
    lines.push(``);
  }

  lines.push(`═══ Task Dispatch Protocol ═══`);
  lines.push(`  Use chatroom_dispatch_task to assign work to agents.`);
  lines.push(`  The system handles: DM delivery → ACK → result collection.`);
  lines.push(`  Output files are placed in: ${assetsDir(cfg)}/{agent_id}/{task_id}/`);
  lines.push(``);
  lines.push(
    `  Example: chatroom_dispatch_task(target="art", instruction="draw a steel dinosaur")`,
  );
  lines.push(``);
  lines.push(`═══ File Sharing Protocol ═══`);
  lines.push(`  Binary files (images, audio, PDFs, models):`);
  lines.push(`    chatroom_publish_file       — copy local file to NAS (verified)`);
  lines.push(`    chatroom_publish_and_send   — copy to NAS + send as chat message`);
  lines.push(`  Text/generated content:`);
  lines.push(`    chatroom_save_asset         — write text content to NAS`);
  lines.push(`    chatroom_send_file          — write content + send as message`);
  lines.push(`  Discovery:`);
  lines.push(`    chatroom_list_assets        — browse files on NAS`);
  lines.push(`  IMPORTANT: For binary files, ALWAYS use chatroom_publish_file/publish_and_send.`);
  lines.push(`  These perform direct binary copy with MD5 verification — no base64 needed.`);
  lines.push(``);

  lines.push(`═══ Plan Mode ═══`);
  lines.push(`  Agents create execution plans before starting complex tasks.`);
  lines.push(`  Use chatroom_approve_plan to approve, reject, or request revision of plans.`);
  lines.push(`  Use chatroom_list_plans to see all plans.`);
  lines.push(``);

  const activeTasks = listTasksByStatus(
    cfg,
    "DISPATCHED",
    "ACKED",
    "PROCESSING",
    "RETRYING",
    "PARKED",
  );
  if (activeTasks.length > 0) {
    lines.push(`═══ Active Tasks ═══`);
    for (const t of activeTasks) {
      const phase = t.current_phase ? ` (${t.current_phase})` : "";
      const errInfo = t.error_type ? ` [ERROR: ${t.error_type}]` : "";
      const permNote =
        t.current_phase === "awaiting_permission" ? " ⏳ AWAITING ADMIN APPROVAL" : "";
      const planNote = t.current_phase?.includes("awaiting_plan") ? " 📋 PLAN AWAITING REVIEW" : "";
      const stepInfo =
        t.current_step != null && t.total_steps != null
          ? ` [Step ${t.current_step}/${t.total_steps}]`
          : "";
      lines.push(
        `  - [${t.status}${phase}${stepInfo}${errInfo}${permNote}${planNote}] ${t.task_id.slice(0, 8)}... → ${t.to}: "${t.instruction.slice(0, 60)}"`,
      );
    }
    lines.push(``);
  }

  // Show pending plans that need orchestrator review
  try {
    const plDir = plansDir(cfg);
    if (fs.existsSync(plDir)) {
      const pendingPlans: TaskPlan[] = [];
      for (const f of fs.readdirSync(plDir)) {
        if (!f.endsWith(".json")) continue;
        const plan = readJson(path.join(plDir, f)) as TaskPlan | null;
        if (
          plan &&
          (plan.status === "PENDING_REVIEW" || plan.status === "DRAFT") &&
          plan.approval?.decision === "pending"
        ) {
          pendingPlans.push(plan);
        }
      }
      if (pendingPlans.length > 0) {
        lines.push(`═══ Plans Awaiting Review ═══`);
        for (const p of pendingPlans) {
          lines.push(`  - Task ${p.task_id.slice(0, 8)}... by ${p.agent_id}: "${p.summary}"`);
          lines.push(`    Steps: ${p.steps.length} (est. ${p.estimated_total_minutes}min)`);
          for (const s of p.steps) {
            lines.push(`      ${s.order}. ${s.title} (~${s.estimated_minutes}min)`);
          }
          lines.push(
            `    → Use chatroom_approve_plan(task_id="${p.task_id}", decision="approved") to approve`,
          );
        }
        lines.push(``);
      }
    }
  } catch {
    /* ignore errors reading plans dir */
  }

  return lines.join("\n");
}

function buildWorkerContext(cfg: ChatroomConfig, sourceChannel?: string): string {
  const myAssets = assetsDir(cfg, cfg.agentId);
  const myDM = `dm_${cfg.agentId}`;

  const lines: string[] = [
    `[Agent Worker Context]`,
    `You are "${cfg.agentId}", a specialist worker agent in the First Agent Family.`,
    ``,
    `═══ YOUR ROLE ═══`,
    `  You are NOT the orchestrator. You are a task executor.`,
    `  You receive tasks via your DM channel (#${myDM}) from the orchestrator.`,
    `  You complete tasks and report results — that's it.`,
    ``,
    `═══ STRICT RULES ═══`,
    `  1. NEVER respond to human messages. You are not the orchestrator.`,
    `  2. NEVER send messages to #general. That channel is orchestrator-only.`,
    `  3. NEVER dispatch tasks to other agents. Only the orchestrator does that.`,
    `  4. ONLY communicate in your DM channel: #${myDM}.`,
    `  5. Focus entirely on completing the assigned task.`,
    `  6. BEFORE executing sensitive operations, use chatroom_request_permission.`,
    ``,
    `═══ SENSITIVE OPERATIONS (require permission) ═══`,
    `  You MUST call chatroom_request_permission BEFORE any of these:`,
    `  - Shell commands that modify files outside the workspace or project directory`,
    `  - Commands using sudo, rm -rf on system paths, chmod, chown`,
    `  - Reading or writing .env, credentials, API keys, secrets`,
    `  - System service operations (systemctl, docker rm/stop, kill)`,
    `  - Network requests that modify external state (POST/PUT/DELETE to APIs)`,
    `  If the operation is allowlisted, it will auto-approve instantly.`,
    `  Otherwise your session will pause until an admin decides.`,
    ``,
    `═══ File System (NAS) ═══`,
    `  Your output dir: ${myAssets}`,
    sourceChannel ? `  Current channel: #${sourceChannel}` : ``,
    ``,
    `═══ File Sharing Protocol ═══`,
    `  Binary files (images, audio, PDFs, models):`,
    `    chatroom_publish_file(source_path="/local/path/file.png", task_id="...")`,
    `    chatroom_publish_and_send(source_path="/local/path/file.png", channel_id="...", task_id="...")`,
    `  Text/generated content:`,
    `    chatroom_save_asset(filename="report.md", content="...", task_id="...")`,
    `  IMPORTANT: For binary files, ALWAYS use chatroom_publish_file/publish_and_send.`,
    `  These perform direct binary copy with MD5 verification — never use base64 for local files.`,
    ``,
  ];

  return lines.join("\n");
}

function buildChatroomContext(cfg: ChatroomConfig, sourceChannel?: string): string {
  if (cfg.role === "orchestrator") {
    return buildOrchestratorContext(cfg, sourceChannel);
  }
  return buildWorkerContext(cfg, sourceChannel);
}

// ============================================================================
// Auto-dispatch: push messages through the LLM pipeline
// ============================================================================

async function autoDispatchMessage(
  chatroomCfg: ChatroomConfig,
  msg: InboxMessage,
  runtime: any,
  config: any,
  logger: Logger,
): Promise<void> {
  const channelId = msg.channel_id;
  const isDM = channelId.startsWith("dm_");

  // Hard gate: workers must not respond outside their DM channel
  if (chatroomCfg.role !== "orchestrator") {
    const myDM = `dm_${chatroomCfg.agentId}`;
    if (channelId !== myDM) {
      logger.info(
        `[worker] Blocked LLM dispatch for #${channelId} — workers only respond in their DM`,
      );
      return;
    }
  }

  const route = runtime.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "chatroom",
    peer: { kind: isDM ? "direct" : "group", id: channelId },
  });

  const senderLabel = msg.from.startsWith("human:")
    ? `[Human] ${msg.from.slice("human:".length)}`
    : msg.from;

  const chatroomContext = buildChatroomContext(chatroomCfg, channelId);
  const messageBody = `[Chatroom #${channelId}] ${senderLabel}: ${msg.content.text}`;
  const bodyForAgent = chatroomContext ? `${chatroomContext}\n${messageBody}` : messageBody;

  const ctxPayload = runtime.channel.reply.finalizeInboundContext({
    Body: bodyForAgent,
    BodyForAgent: bodyForAgent,
    RawBody: msg.content.text,
    CommandBody: msg.content.text,
    From: `chatroom:${msg.from}`,
    To: `chatroom:${chatroomCfg.agentId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isDM ? "direct" : "group",
    SenderName: senderLabel,
    SenderId: msg.from,
    Provider: "chatroom",
    Surface: "chatroom",
    MessageSid: msg.message_id,
    Timestamp: Date.now(),
    CommandAuthorized: true,
  });

  const prefixContext = createReplyPrefixContext({
    cfg: config,
    agentId: route.agentId,
  });

  const dispatcherOptions = {
    responsePrefix: prefixContext.responsePrefix,
    responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
    deliver: async (payload: ReplyPayload) => {
      const text = payload.text ?? "";
      if (!text.trim()) return;
      try {
        const inlineMentions = parseAtMentions(text);
        const result = sendMessageToNAS(chatroomCfg, channelId, text, "CHAT", inlineMentions);
        logger.info(`Auto-reply → #${channelId} (seq: ${result.seq})`);
      } catch (err) {
        logger.error(`Failed to send auto-reply to ${channelId}: ${err}`);
      }
    },
    onError: (err: any, info: any) => {
      logger.error(`Dispatch error (${info?.kind}): ${err}`);
    },
  };

  logger.info(`Dispatching chat from ${msg.from} in #${channelId} to LLM`);

  await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions,
    replyOptions: { onModelSelected: prefixContext.onModelSelected },
  });
}

// ============================================================================
// Plan Mode — two-phase execution: planning + step-by-step
// ============================================================================

function shouldUsePlanMode(instruction: string, isLongRunning: boolean): boolean {
  if (isLongRunning) return true;
  const wordCount = instruction.split(/\s+/).length;
  return wordCount > 30;
}

/**
 * Phase 1: Short LLM call to produce a structured plan.
 * Returns the created plan, or null if planning was skipped/failed.
 */
async function planningPhase(
  chatroomCfg: ChatroomConfig,
  msg: InboxMessage,
  taskId: string,
  runtime: any,
  config: any,
  logger: Logger,
): Promise<TaskPlan | null> {
  const channelId = msg.channel_id;
  const isDM = channelId.startsWith("dm_");

  const route = runtime.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "chatroom",
    peer: { kind: isDM ? "direct" : "group", id: channelId },
  });

  const planningPrompt = [
    `[CHATROOM TASK — PLANNING PHASE]`,
    `task_id: ${taskId}`,
    `assigned_by: ${msg.from}`,
    ``,
    `INSTRUCTION:`,
    msg.content.text,
    ``,
    `You are in PLANNING MODE. Do NOT execute the task yet.`,
    `Analyze the instruction and create a structured execution plan.`,
    ``,
    `Call chatroom_create_plan with:`,
    `  - task_id: "${taskId}"`,
    `  - summary: a one-line summary of the plan`,
    `  - steps: an ordered array of steps, each with:`,
    `    - title: short label`,
    `    - description: detailed instructions for this step`,
    `    - estimated_minutes: how long you think it will take`,
    `    - timeout_minutes: max allowed time (default 10, max 30)`,
    ``,
    `Guidelines:`,
    `  - Break the task into 2-8 logical, self-contained steps`,
    `  - Each step should produce a verifiable outcome`,
    `  - Steps for builds/uploads/deployments should have higher timeout_minutes`,
    `  - Keep descriptions specific and actionable`,
    `  - After calling chatroom_create_plan, respond with a brief confirmation`,
  ].join("\n");

  const ctxPayload = runtime.channel.reply.finalizeInboundContext({
    Body: planningPrompt,
    BodyForAgent: planningPrompt,
    RawBody: msg.content.text,
    CommandBody: msg.content.text,
    From: `chatroom:${msg.from}`,
    To: `chatroom:${chatroomCfg.agentId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isDM ? "direct" : "group",
    SenderName: msg.from,
    SenderId: msg.from,
    Provider: "chatroom",
    Surface: "chatroom",
    MessageSid: `${msg.message_id}-plan`,
    Timestamp: Date.now(),
    CommandAuthorized: true,
  });

  const prefixContext = createReplyPrefixContext({
    cfg: config,
    agentId: route.agentId,
  });

  let planCreated = false;

  appendTaskProgress(chatroomCfg, taskId, { phase: "planning", detail: "Creating execution plan" });

  const dispatcherOptions = {
    responsePrefix: prefixContext.responsePrefix,
    responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
    deliver: async (payload: ReplyPayload, info?: { kind: string }) => {
      const kind = info?.kind ?? "final";
      if (kind === "tool") {
        appendTaskProgress(chatroomCfg, taskId, {
          phase: "planning_tool",
          detail: (payload.text ?? "").slice(0, 200),
        });
      }
      if (kind === "final") {
        planCreated = true;
      }
    },
    onError: (err: any) => {
      logger.error(`Planning phase error for task ${taskId}: ${err}`);
    },
  };

  logger.info(
    `Starting planning phase for task ${taskId} (timeout: ${PLANNING_TIMEOUT_MS / 1000}s)`,
  );

  await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions,
    replyOptions: {
      onModelSelected: prefixContext.onModelSelected,
      toolsDeny: ["message", "feishu_*", "lark_*"],
      agentTimeoutMs: PLANNING_TIMEOUT_MS,
    },
  });

  const plan = readPlan(chatroomCfg, taskId);
  if (!plan) {
    logger.warn(`Planning phase completed but no plan was created for task ${taskId}`);
  }
  return plan;
}

/**
 * Wait for plan approval. In orchestrator mode, sends a review request
 * to the orchestrator. In human mode, waits for dashboard approval.
 * Returns the approved plan, or null if rejected/timed out.
 */
async function waitForApproval(
  cfg: ChatroomConfig,
  plan: TaskPlan,
  taskId: string,
  logger: Logger,
): Promise<TaskPlan | null> {
  if (plan.approval.mode === "orchestrator") {
    // Notify orchestrator about the plan
    sendMessageToNAS(
      cfg,
      "general",
      `[PLAN_REVIEW_REQUEST] Agent ${plan.agent_id} created a plan for task ${taskId}:\n` +
        `Summary: ${plan.summary}\n` +
        `Steps: ${plan.steps.length} (est. ${plan.estimated_total_minutes}min)\n` +
        plan.steps.map((s) => `  ${s.order}. ${s.title} (~${s.estimated_minutes}min)`).join("\n") +
        `\n\nUse chatroom_approve_plan to approve, reject, or request revision.`,
      "SYSTEM",
      ["firstclaw"],
      undefined,
      { task_id: taskId, plan_id: plan.plan_id },
    );

    updatePlan(cfg, taskId, { status: "PENDING_REVIEW" });
    updateTaskRecord(cfg, taskId, { current_phase: "awaiting_plan_review" } as Partial<TaskRecord>);
    logger.info(`Plan for task ${taskId} sent to orchestrator for review`);

    // Poll for approval with a timeout (5 min for orchestrator mode)
    const approvalTimeoutMs = 5 * 60_000;
    const pollMs = 3_000;
    const deadline = Date.now() + approvalTimeoutMs;

    while (Date.now() < deadline) {
      const current = readPlan(cfg, taskId);
      if (!current) return null;

      if (current.status === "APPROVED") {
        logger.info(`Plan for task ${taskId} approved by ${current.approval.approved_by}`);
        return current;
      }
      if (current.status === "CANCELLED") {
        logger.info(`Plan for task ${taskId} rejected`);
        return null;
      }
      if (current.status === "DRAFT" && current.revision > plan.revision) {
        logger.info(`Plan for task ${taskId} revision requested — would need re-planning`);
        return null;
      }

      // Check if the task was cancelled externally
      const task = readTaskRecord(cfg, taskId);
      if (task?.status === "CANCELLED") {
        updatePlan(cfg, taskId, { status: "CANCELLED", completed_at: nowISO() });
        return null;
      }

      await new Promise((r) => setTimeout(r, pollMs));
    }

    // Auto-approve on timeout in orchestrator mode
    logger.info(`Plan approval timed out for task ${taskId}, auto-approving`);
    const approved = updatePlan(cfg, taskId, {
      status: "APPROVED",
      approved_at: nowISO(),
      approval: {
        ...plan.approval,
        approved_by: "system:auto",
        decision: "approved",
        decision_reason: "Auto-approved after timeout",
        decided_at: nowISO(),
      },
    });
    return approved;
  }

  // Human mode: wait for dashboard approval (no auto-approve timeout)
  updatePlan(cfg, taskId, { status: "PENDING_REVIEW" });
  updateTaskRecord(cfg, taskId, {
    current_phase: "awaiting_human_approval",
  } as Partial<TaskRecord>);
  logger.info(`Plan for task ${taskId} awaiting human approval`);

  const humanPollMs = 5_000;
  const humanDeadlineMs = 60 * 60_000; // 1 hour max wait
  const humanDeadline = Date.now() + humanDeadlineMs;

  while (Date.now() < humanDeadline) {
    const current = readPlan(cfg, taskId);
    if (!current) return null;
    if (current.status === "APPROVED") return current;
    if (current.status === "CANCELLED") return null;

    const task = readTaskRecord(cfg, taskId);
    if (task?.status === "CANCELLED") {
      updatePlan(cfg, taskId, { status: "CANCELLED", completed_at: nowISO() });
      return null;
    }

    await new Promise((r) => setTimeout(r, humanPollMs));
  }

  logger.warn(`Human approval timed out for task ${taskId}`);
  return null;
}

/**
 * Phase 2: Execute each plan step as a separate LLM invocation.
 */
async function stepExecutionLoop(
  chatroomCfg: ChatroomConfig,
  plan: TaskPlan,
  msg: InboxMessage,
  taskId: string,
  runtime: any,
  config: any,
  logger: Logger,
): Promise<void> {
  updatePlan(chatroomCfg, taskId, { status: "EXECUTING" });
  updateTaskRecord(chatroomCfg, taskId, {
    current_phase: "executing_plan",
    current_step: 0,
  } as Partial<TaskRecord>);

  const outputDir =
    msg.metadata?.output_dir ?? taskAssetsDir(chatroomCfg, chatroomCfg.agentId, taskId);
  ensureDir(outputDir as string);

  const previousResults: { title: string; result: string }[] = [];

  for (const step of plan.steps) {
    // ── Abort checkpoint ──
    const task = readTaskRecord(chatroomCfg, taskId);
    if (task?.status === "CANCELLED") {
      logger.info(`Task ${taskId} cancelled — skipping remaining steps`);
      const currentPlan = readPlan(chatroomCfg, taskId);
      if (currentPlan) {
        for (const s of currentPlan.steps) {
          if (s.status === "PENDING") {
            updatePlanStep(chatroomCfg, taskId, s.step_id, { status: "SKIPPED" });
          }
        }
        updatePlan(chatroomCfg, taskId, { status: "CANCELLED", completed_at: nowISO() });
      }
      return;
    }

    // ── Execute step ──
    logger.info(`Executing step ${step.order}/${plan.steps.length}: ${step.title}`);
    updatePlanStep(chatroomCfg, taskId, step.step_id, {
      status: "IN_PROGRESS",
      started_at: nowISO(),
    });
    updateTaskRecord(chatroomCfg, taskId, {
      current_step: step.order,
      current_phase: `step_${step.order}/${plan.steps.length}: ${step.title}`,
    } as Partial<TaskRecord>);
    appendTaskProgress(chatroomCfg, taskId, {
      phase: `step_${step.order}_start`,
      detail: step.title,
    });

    const result = await executeStep(
      chatroomCfg,
      plan,
      step,
      taskId,
      outputDir as string,
      previousResults,
      msg,
      runtime,
      config,
      logger,
    );

    if (result.success) {
      previousResults.push({ title: step.title, result: result.result_summary });
    } else {
      // Step failed — mark remaining as skipped and fail the plan
      logger.warn(`Step ${step.order} failed: ${result.error_detail}`);
      updatePlanStep(chatroomCfg, taskId, step.step_id, {
        status: "FAILED",
        error_detail: result.error_detail ?? "Unknown error",
        completed_at: nowISO(),
      });

      const latestPlan = readPlan(chatroomCfg, taskId);
      if (latestPlan) {
        for (const s of latestPlan.steps) {
          if (s.status === "PENDING") {
            updatePlanStep(chatroomCfg, taskId, s.step_id, { status: "SKIPPED" });
          }
        }
      }
      updatePlan(chatroomCfg, taskId, { status: "FAILED", completed_at: nowISO() });

      const allFiles = scanOutputDir(outputDir as string);
      const errSummary = `Plan failed at step ${step.order}/${plan.steps.length} (${step.title}): ${result.error_detail}`;
      sendTaskResult(chatroomCfg, taskId, errSummary, "FAILED", logger, allFiles);
      return;
    }
  }

  // All steps completed
  updatePlan(chatroomCfg, taskId, { status: "COMPLETED", completed_at: nowISO() });
  const allFiles = scanOutputDir(outputDir as string);
  const resultSummary = [
    `Plan completed: ${plan.summary}`,
    ``,
    ...previousResults.map((r, i) => `Step ${i + 1} (${r.title}): ${r.result}`),
  ].join("\n");
  sendTaskResult(chatroomCfg, taskId, resultSummary, "DONE", logger, allFiles);
}

/**
 * Execute a single plan step as an LLM invocation.
 */
async function executeStep(
  chatroomCfg: ChatroomConfig,
  plan: TaskPlan,
  step: PlanStep,
  taskId: string,
  outputDir: string,
  previousResults: { title: string; result: string }[],
  originalMsg: InboxMessage,
  runtime: any,
  config: any,
  logger: Logger,
): Promise<StepResult> {
  const channelId = originalMsg.channel_id;
  const isDM = channelId.startsWith("dm_");

  const route = runtime.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "chatroom",
    peer: { kind: isDM ? "direct" : "group", id: channelId },
  });

  const commentsContext =
    step.comments.length > 0
      ? `\nReviewer comments for this step:\n` +
        step.comments.map((c) => `  [${c.type}] ${c.from}: ${c.text}`).join("\n")
      : "";

  const previousContext =
    previousResults.length > 0
      ? `\nPrevious step results:\n` +
        previousResults.map((r, i) => `  Step ${i + 1} (${r.title}): ${r.result}`).join("\n")
      : "";

  const stepPrompt = [
    `[CHATROOM TASK — STEP EXECUTION]`,
    `task_id: ${taskId}`,
    `step_id: ${step.step_id}`,
    `plan: ${plan.summary}`,
    `current_step: ${step.order}/${plan.steps.length}`,
    `output_dir: ${outputDir}`,
    ``,
    `ORIGINAL TASK INSTRUCTION:`,
    originalMsg.content.text,
    ``,
    `CURRENT STEP (${step.order}/${plan.steps.length}): ${step.title}`,
    `STEP DESCRIPTION:`,
    step.description,
    previousContext,
    commentsContext,
    ``,
    `RULES:`,
    `1. Focus ONLY on this step. Do not work ahead to future steps.`,
    `2. Use chatroom_publish_file for binary files, chatroom_save_asset for text content.`,
    `3. When done, call chatroom_complete_step(task_id="${taskId}", step_id="${step.step_id}",`,
    `   result_summary="...", output_files=[...]) to mark this step complete.`,
    `4. If you encounter an unrecoverable error, call chatroom_fail_step(task_id="${taskId}",`,
    `   step_id="${step.step_id}", error_detail="...").`,
    `5. For long-running operations, use chatroom_task_park.`,
    `6. SENSITIVE OPERATIONS require chatroom_request_permission.`,
    `7. DO NOT send messages to other channels or agents.`,
  ].join("\n");

  const ctxPayload = runtime.channel.reply.finalizeInboundContext({
    Body: stepPrompt,
    BodyForAgent: stepPrompt,
    RawBody: step.description,
    CommandBody: step.description,
    From: `chatroom:${originalMsg.from}`,
    To: `chatroom:${chatroomCfg.agentId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isDM ? "direct" : "group",
    SenderName: originalMsg.from,
    SenderId: originalMsg.from,
    Provider: "chatroom",
    Surface: "chatroom",
    MessageSid: `${originalMsg.message_id}-step-${step.order}`,
    Timestamp: Date.now(),
    CommandAuthorized: true,
  });

  const prefixContext = createReplyPrefixContext({
    cfg: config,
    agentId: route.agentId,
  });

  let stepResult: StepResult = {
    success: false,
    result_summary: "",
    output_files: [],
    error_detail: "Step did not complete",
  };

  const dispatcherOptions = {
    responsePrefix: prefixContext.responsePrefix,
    responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
    deliver: async (payload: ReplyPayload, info?: { kind: string }) => {
      const text = payload.text ?? "";
      const kind = info?.kind ?? "final";

      if (kind === "tool") {
        appendTaskProgress(chatroomCfg, taskId, {
          phase: `step_${step.order}_tool`,
          detail: text.slice(0, 200),
        });
        return;
      }

      if (kind === "block") {
        appendTaskProgress(chatroomCfg, taskId, {
          phase: `step_${step.order}_progress`,
          detail: text.slice(0, 200),
        });
        return;
      }

      if (kind === "final") {
        // Check if the step was completed via tool call
        const updatedPlan = readPlan(chatroomCfg, taskId);
        const updatedStep = updatedPlan?.steps.find((s) => s.step_id === step.step_id);
        if (updatedStep?.status === "COMPLETED") {
          stepResult = {
            success: true,
            result_summary: updatedStep.result_summary ?? text.slice(0, 500),
            output_files: updatedStep.output_files,
          };
        } else if (updatedStep?.status === "FAILED") {
          stepResult = {
            success: false,
            result_summary: "",
            output_files: [],
            error_detail: updatedStep.error_detail ?? "Step failed",
          };
        } else if (payload.isError) {
          stepResult = {
            success: false,
            result_summary: "",
            output_files: [],
            error_detail: text.slice(0, 500),
          };
        } else {
          // LLM finished but didn't call complete_step — treat as implicit success
          const producedFiles = scanOutputDir(outputDir);
          updatePlanStep(chatroomCfg, taskId, step.step_id, {
            status: "COMPLETED",
            result_summary: text.slice(0, 500),
            output_files: producedFiles,
            completed_at: nowISO(),
          });
          stepResult = {
            success: true,
            result_summary: text.slice(0, 500),
            output_files: producedFiles,
          };
        }
      }
    },
    onError: (err: any) => {
      const errType = classifyError(String(err));
      logger.error(`Step ${step.order} dispatch error [${errType}]: ${err}`);
      stepResult = {
        success: false,
        result_summary: "",
        output_files: [],
        error_detail: `LLM error: ${err}`,
      };
    },
  };

  const stepTimeoutMs = Math.min(step.timeout_minutes * 60_000, MAX_STEP_TIMEOUT_MS);

  logger.info(
    `Dispatching step ${step.order} to LLM (timeout: ${Math.round(stepTimeoutMs / 60000)}min)`,
  );

  await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions,
    replyOptions: {
      onModelSelected: prefixContext.onModelSelected,
      toolsDeny: ["message", "feishu_*", "lark_*"],
      agentTimeoutMs: stepTimeoutMs,
    },
  });

  return stepResult;
}

/**
 * Dispatch a TASK to the LLM. The deliver callback writes a RESULT_REPORT
 * (not a plain CHAT) so the orchestrator's task tracker picks it up.
 *
 * This is the LEGACY single-session path, used for simple tasks that skip plan mode.
 */
async function autoDispatchForTask(
  chatroomCfg: ChatroomConfig,
  msg: InboxMessage,
  taskId: string,
  runtime: any,
  config: any,
  logger: Logger,
): Promise<void> {
  const channelId = msg.channel_id;
  const isDM = channelId.startsWith("dm_");

  const route = runtime.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "chatroom",
    peer: { kind: isDM ? "direct" : "group", id: channelId },
  });

  const outputDir =
    msg.metadata?.output_dir ?? taskAssetsDir(chatroomCfg, chatroomCfg.agentId, taskId);
  ensureDir(outputDir as string);

  const taskContext = [
    `[CHATROOM TASK — STRICT PROTOCOL]`,
    `task_id: ${taskId}`,
    `assigned_by: ${msg.from}`,
    `output_dir: ${outputDir}`,
    ``,
    `INSTRUCTION:`,
    msg.content.text,
    ``,
    `RULES (MUST follow — violations break the pipeline):`,
    `1. FILE SHARING PROTOCOL — choose the right tool:`,
    `   ┌─────────────────────────────────────────────────────────────────────────┐`,
    `   │ chatroom_publish_file    — PREFERRED for ALL local files (binary-safe) │`,
    `   │   Copies the file directly from disk to NAS. No base64, no content.    │`,
    `   │   Example: chatroom_publish_file(source_path="/workspace/out/render.png", task_id="${taskId}")`,
    `   │                                                                         │`,
    `   │ chatroom_publish_and_send — publish + send as chat message (one step)  │`,
    `   │   Example: chatroom_publish_and_send(source_path="/workspace/out/render.png",`,
    `   │     channel_id="${msg.channel_id}", task_id="${taskId}")                │`,
    `   │                                                                         │`,
    `   │ chatroom_save_asset      — ONLY for dynamically generated text content │`,
    `   │   Example: chatroom_save_asset(filename="report.md", content="...", task_id="${taskId}")`,
    `   └─────────────────────────────────────────────────────────────────────────┘`,
    `   CRITICAL: For binary files (images, audio, PDFs, models, etc.),`,
    `   ALWAYS use chatroom_publish_file or chatroom_publish_and_send.`,
    `   NEVER read a binary file and pass its content as base64 — this is fragile and wastes tokens.`,
    `   Output directory: ${outputDir}`,
    `2. To share files visually (so others can see images/download files):`,
    `   chatroom_publish_and_send(source_path="/workspace/out/render.png", channel_id="${msg.channel_id}", task_id="${taskId}")`,
    `3. REPORT PROGRESS at significant milestones using chatroom_task_progress:`,
    `   chatroom_task_progress(task_id="${taskId}", phase="analyzing", detail="Reading the requirements")`,
    `   chatroom_task_progress(task_id="${taskId}", phase="generating", detail="Creating output")`,
    `   This keeps the orchestrator and dashboard informed of your progress.`,
    `4. Your final TEXT RESPONSE is your task result.`,
    `   The system AUTOMATICALLY delivers it as a RESULT_REPORT to the orchestrator.`,
    `5. For LONG-RUNNING OPERATIONS (builds, uploads, deployments >1min):`,
    `   Use chatroom_task_park to suspend your session while waiting.`,
    `   This saves tokens and prevents context overflow. A new session resumes when done.`,
    `   Example: chatroom_task_park(task_id="${taskId}", watch_type="file", file_path="/output/build.zip",`,
    `     resume_prompt="Build complete. Upload the zip and report results.", max_wait_minutes=30)`,
    `6. SENSITIVE OPERATIONS require permission. BEFORE executing any of these, call chatroom_request_permission:`,
    `   - Shell commands modifying system dirs (outside workspace), sudo, rm -rf on system paths`,
    `   - Reading/writing .env, credentials, API keys, secrets`,
    `   - System operations (systemctl, docker rm/stop, chmod, chown, kill)`,
    `   - Network mutations (POST/PUT/DELETE to external APIs)`,
    `   Example: chatroom_request_permission(task_id="${taskId}", operation_type="shell",`,
    `     operation_detail="rm -rf /usr/local/old-sdk", reason="Need to remove old SDK before installing new one",`,
    `     resume_prompt="Old SDK removed. Install the new SDK and continue.")`,
    `7. DO NOT send results via Lark, Feishu, or any other messaging channel.`,
    `   DO NOT call feishu tools, reply tools, or any messaging/notification tools.`,
    `   DO NOT attempt to notify anyone manually — the system handles ALL delivery.`,
    `8. Mention produced filenames in your text response so the orchestrator knows what was created.`,
  ].join("\n");

  const ctxPayload = runtime.channel.reply.finalizeInboundContext({
    Body: taskContext,
    BodyForAgent: taskContext,
    RawBody: msg.content.text,
    CommandBody: msg.content.text,
    From: `chatroom:${msg.from}`,
    To: `chatroom:${chatroomCfg.agentId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isDM ? "direct" : "group",
    SenderName: msg.from,
    SenderId: msg.from,
    Provider: "chatroom",
    Surface: "chatroom",
    MessageSid: msg.message_id,
    Timestamp: Date.now(),
    CommandAuthorized: true,
  });

  const prefixContext = createReplyPrefixContext({
    cfg: config,
    agentId: route.agentId,
  });

  let taskCompleted = false;

  appendTaskProgress(chatroomCfg, taskId, { phase: "llm_started", detail: "Dispatching to LLM" });

  const dispatcherOptions = {
    responsePrefix: prefixContext.responsePrefix,
    responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
    deliver: async (payload: ReplyPayload, info?: { kind: string }) => {
      const text = payload.text ?? "";
      if (!text.trim()) return;

      const kind = info?.kind ?? "final";

      if (kind === "tool") {
        appendTaskProgress(chatroomCfg, taskId, {
          phase: "tool_executed",
          detail: text.slice(0, 300),
        });
        return;
      }

      if (kind === "block") {
        appendTaskProgress(chatroomCfg, taskId, {
          phase: "generating",
          detail: text.slice(0, 200),
        });
        return;
      }

      // kind === "final" — complete the task
      if (taskCompleted) return;
      taskCompleted = true;

      try {
        if (payload.isError) {
          const errType = classifyError(text);
          logger.warn(`Task ${taskId} LLM error [${errType}]: ${text.slice(0, 150)}`);
          sendTaskResult(chatroomCfg, taskId, text, "FAILED", logger, [], errType);
          return;
        }

        const producedFiles = scanOutputDir(outputDir as string);
        sendTaskResult(chatroomCfg, taskId, text, "DONE", logger, producedFiles);
      } catch (err) {
        logger.error(`Failed to send task result for ${taskId}: ${err}`);
      }
    },
    onError: (err: any, info: any) => {
      if (taskCompleted) return;
      taskCompleted = true;
      const errText = `Task processing failed: ${err}`;
      const errType = classifyError(String(err));
      logger.error(`Task dispatch error for ${taskId} (${info?.kind}) [${errType}]: ${err}`);
      try {
        sendTaskResult(chatroomCfg, taskId, errText, "FAILED", logger, [], errType);
      } catch {
        /* ignore */
      }
    },
  };

  const task = readTaskRecord(chatroomCfg, taskId);
  const taskTimeoutMs = task?.task_timeout_ms;
  const agentTimeoutMs =
    taskTimeoutMs && taskTimeoutMs > 600_000 ? Math.min(taskTimeoutMs, 3_600_000) : undefined;

  logger.info(
    `Dispatching task ${taskId} to LLM` +
      (agentTimeoutMs ? ` (extended timeout: ${Math.round(agentTimeoutMs / 60000)}min)` : ""),
  );

  await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions,
    replyOptions: {
      onModelSelected: prefixContext.onModelSelected,
      toolsDeny: ["message", "feishu_*", "lark_*"],
      ...(agentTimeoutMs ? { agentTimeoutMs } : {}),
    },
  });
}

// ============================================================================
// Plugin definition
// ============================================================================

const agentChatroomPlugin = {
  id: "agent-chatroom",
  name: "Agent Chatroom",
  description: "Multi-agent collaboration chatroom over shared NAS with reliable task dispatch",

  register(api: FirstClawPluginApi) {
    const pluginCfg = (api.pluginConfig ?? {}) as Record<string, any>;
    const nasRoot = pluginCfg.nasRoot as string;
    const agentId = pluginCfg.agentId as string;

    if (!nasRoot || !agentId) {
      api.logger.warn(
        "agent-chatroom: nasRoot and agentId are required in plugin config. Tools disabled.",
      );
      return;
    }

    const rawRole = (pluginCfg.role as string) ?? "worker";
    const role: "orchestrator" | "worker" = rawRole === "orchestrator" ? "orchestrator" : "worker";

    const cfg: ChatroomConfig = {
      nasRoot,
      agentId,
      role,
      localDir: (pluginCfg.localDir as string) ?? "./chatroom_local",
      repoRoot: (pluginCfg.repoRoot as string) ?? null,
    };
    ensureDir(cfg.localDir);
    ensureDir(tasksDir(cfg));

    const runtime = api.runtime;
    const config = api.config;
    const logger: Logger = {
      info: (...args: any[]) => api.logger.info(`[chatroom] ${args.join(" ")}`),
      warn: (...args: any[]) => api.logger.warn(`[chatroom] ${args.join(" ")}`),
      error: (...args: any[]) => api.logger.error(`[chatroom] ${args.join(" ")}`),
    };

    logger.info(
      `Agent "${agentId}" initialized with role: ${role.toUpperCase()}` +
        (role === "worker"
          ? ` — will ONLY process messages from dm_${agentId}`
          : ` — full orchestration enabled`),
    );
    if (cfg.repoRoot) {
      logger.info(`Repo root: ${cfg.repoRoot}`);
    } else {
      logger.warn(
        `repoRoot is NOT configured — /system-update will not work. ` +
          `Run: firstclaw config set plugins.entries.agent-chatroom.config.repoRoot /path/to/repo`,
      );
    }

    // ── Orchestrator-only tools ─────────────────────────────────────────────
    // dispatch_task, cancel_task, task_status are only useful for the orchestrator.
    // Workers receive tasks; they don't create or manage them.

    if (role === "orchestrator") {
      api.registerTool(
        {
          name: "chatroom_dispatch_task",
          label: "Chatroom: Dispatch Task",
          description:
            "Dispatch a task to another agent with guaranteed delivery via the handshake protocol.\n" +
            "The target agent will:\n" +
            "  1. Instantly ACK (system-level, no delay)\n" +
            "  2. Process the instruction via its LLM\n" +
            "  3. Return a RESULT_REPORT\n" +
            "If no ACK is received within timeout, the system retries automatically.\n\n" +
            "Use this instead of chatroom_send_message when you need an agent to do work.",
          parameters: Type.Object({
            target: Type.String({
              description: "Target agent ID (e.g. 'art', 'audio', 'gamedev', 'uiux')",
            }),
            instruction: Type.String({
              description: "What you want the agent to do — be specific and actionable",
            }),
            timeout_minutes: Type.Optional(
              Type.Number({
                description:
                  "Task timeout in minutes. Default: 60. " +
                  "Set higher for long-running tasks (e.g. 120 for publishing/deployment).",
              }),
            ),
            long_running: Type.Optional(
              Type.Boolean({
                description:
                  "Mark as long-running task (builds, deploys, uploads). " +
                  "The agent will be advised to use chatroom_task_park for waiting periods.",
              }),
            ),
          }),
          async execute(_toolCallId, params) {
            try {
              const p = params as {
                target: string;
                instruction: string;
                timeout_minutes?: number;
                long_running?: boolean;
              };
              const timeoutMs = (p.timeout_minutes ?? 60) * 60_000;
              let instruction = p.instruction;
              if (p.long_running) {
                instruction +=
                  "\n\n[LONG-RUNNING TASK] This task may involve operations that take minutes " +
                  "(builds, uploads, deployments). Use chatroom_task_park to suspend your session " +
                  "while waiting for long operations instead of polling or sleeping. This prevents " +
                  "context overflow and saves tokens.";
              }
              const task = dispatchTask(cfg, p.target, instruction, logger, {
                taskTimeoutMs: timeoutMs,
              });
              return {
                content: [
                  {
                    type: "text" as const,
                    text:
                      `Task dispatched to ${p.target}.\n` +
                      `  task_id: ${task.task_id}\n` +
                      `  channel: #${task.channel_id}\n` +
                      `  timeout: ${p.timeout_minutes ?? 60} minutes\n` +
                      `  long_running: ${p.long_running ?? false}\n` +
                      `  status: DISPATCHED (awaiting ACK)\n` +
                      `The system will auto-retry if ${p.target} doesn't respond.`,
                  },
                ],
                details: task,
              };
            } catch (err) {
              return {
                content: [{ type: "text" as const, text: `Error dispatching task: ${err}` }],
                details: undefined,
              };
            }
          },
        },
        { names: ["chatroom_dispatch_task"] },
      );

      // ── Tool: check task status ─────────────────────────────────────────────

      api.registerTool(
        {
          name: "chatroom_task_status",
          label: "Chatroom: Task Status",
          description:
            "Check the status of dispatched tasks. Shows active, completed, and failed tasks.",
          parameters: Type.Object({
            task_id: Type.Optional(
              Type.String({
                description: "Specific task ID to check, or omit for all active tasks",
              }),
            ),
          }),
          async execute(_toolCallId, params) {
            try {
              const p = params as { task_id?: string };
              if (p.task_id) {
                const task = readTaskRecord(cfg, p.task_id);
                if (!task)
                  return {
                    content: [{ type: "text" as const, text: `Task ${p.task_id} not found` }],
                    details: undefined,
                  };
                return {
                  content: [{ type: "text" as const, text: JSON.stringify(task, null, 2) }],
                  details: task,
                };
              }
              const active = listTasksByStatus(cfg, "DISPATCHED", "ACKED", "PROCESSING", "TIMEOUT");
              if (active.length === 0)
                return {
                  content: [{ type: "text" as const, text: "No active tasks." }],
                  details: undefined,
                };
              const summary = active.map((t) => ({
                task_id: t.task_id,
                to: t.to,
                status: t.status,
                instruction: t.instruction.slice(0, 80),
                dispatched_at: t.dispatched_at,
                retries: t.retries,
              }));
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `${active.length} active task(s):\n${JSON.stringify(summary, null, 2)}`,
                  },
                ],
                details: summary,
              };
            } catch (err) {
              return {
                content: [{ type: "text" as const, text: `Error: ${err}` }],
                details: undefined,
              };
            }
          },
        },
        { names: ["chatroom_task_status"] },
      );

      // ── Tool: cancel / terminate a task ──────────────────────────────────

      api.registerTool(
        {
          name: "chatroom_cancel_task",
          label: "Chatroom: Cancel Task",
          description:
            "Cancel an active task. Use this when:\n" +
            "  - A task is stuck (agent cannot complete it)\n" +
            "  - You want to reassign the work to a different agent\n" +
            "  - The task is no longer needed\n" +
            "Sets the task status to CANCELLED, notifies the target agent, and resets their status to idle.",
          parameters: Type.Object({
            task_id: Type.String({ description: "The task ID to cancel" }),
            reason: Type.Optional(
              Type.String({ description: "Why the task is being cancelled (shown to the agent)" }),
            ),
          }),
          async execute(_toolCallId, params) {
            try {
              const p = params as { task_id: string; reason?: string };
              const reason = p.reason ?? "Cancelled by orchestrator";
              const result = cancelTask(cfg, p.task_id, reason, logger);
              if (!result) {
                return {
                  content: [{ type: "text" as const, text: `Task ${p.task_id} not found.` }],
                  details: undefined,
                };
              }
              if (result.status !== "CANCELLED") {
                return {
                  content: [
                    {
                      type: "text" as const,
                      text: `Task ${p.task_id} is already in terminal state: ${result.status}. No action taken.`,
                    },
                  ],
                  details: result,
                };
              }
              return {
                content: [
                  {
                    type: "text" as const,
                    text:
                      `Task ${p.task_id} cancelled.\n` +
                      `  Target: ${result.to}\n` +
                      `  Previous status: ${result.status}\n` +
                      `  Reason: ${reason}\n` +
                      `  Agent ${result.to} status reset to idle.`,
                  },
                ],
                details: result,
              };
            } catch (err) {
              return {
                content: [{ type: "text" as const, text: `Error: ${err}` }],
                details: undefined,
              };
            }
          },
        },
        { names: ["chatroom_cancel_task"] },
      );

      // ── Tool: approve a task plan ─────────────────────────────────────────

      api.registerTool(
        {
          name: "chatroom_approve_plan",
          label: "Chatroom: Approve Task Plan",
          description:
            "Approve (or reject) a worker agent's task plan.\n" +
            "Once approved, the agent will begin step-by-step execution.\n" +
            "You can also add comments to individual steps before approving.",
          parameters: Type.Object({
            task_id: Type.String({ description: "Task ID whose plan to review" }),
            decision: Type.Union(
              [
                Type.Literal("approved"),
                Type.Literal("rejected"),
                Type.Literal("revision_requested"),
              ],
              {
                description: "Your decision: approve, reject, or request revision",
              },
            ),
            reason: Type.Optional(Type.String({ description: "Reason for the decision" })),
            step_comments: Type.Optional(
              Type.Array(
                Type.Object({
                  step_order: Type.Number({ description: "Step order number (1-based)" }),
                  comment: Type.String({ description: "Your comment or suggestion for this step" }),
                  type: Type.Optional(
                    Type.Union(
                      [
                        Type.Literal("suggestion"),
                        Type.Literal("approval"),
                        Type.Literal("warning"),
                        Type.Literal("rejection"),
                      ],
                      { description: "Comment type (default: suggestion)" },
                    ),
                  ),
                }),
                { description: "Optional per-step comments" },
              ),
            ),
          }),
          async execute(_toolCallId, params) {
            try {
              const p = params as {
                task_id: string;
                decision: "approved" | "rejected" | "revision_requested";
                reason?: string;
                step_comments?: { step_order: number; comment: string; type?: string }[];
              };
              const plan = readPlan(cfg, p.task_id);
              if (!plan) {
                return {
                  content: [
                    { type: "text" as const, text: `Plan not found for task ${p.task_id}` },
                  ],
                  details: undefined,
                };
              }
              if (p.step_comments) {
                for (const sc of p.step_comments) {
                  const step = plan.steps.find((s) => s.order === sc.step_order);
                  if (step) {
                    step.comments.push({
                      comment_id: randomUUID(),
                      step_id: step.step_id,
                      from: cfg.agentId,
                      text: sc.comment,
                      timestamp: nowISO(),
                      type: (sc.type as StepComment["type"]) ?? "suggestion",
                    });
                  }
                }
              }
              plan.approval.approved_by = cfg.agentId;
              plan.approval.decision = p.decision;
              plan.approval.decision_reason = p.reason ?? null;
              plan.approval.decided_at = nowISO();
              if (p.decision === "approved") {
                plan.status = "APPROVED";
                plan.approved_at = nowISO();
              } else if (p.decision === "rejected") {
                plan.status = "CANCELLED";
                plan.completed_at = nowISO();
              } else {
                plan.status = "DRAFT";
                plan.revision += 1;
              }
              writePlan(cfg, plan);
              if (p.decision === "rejected") {
                updateTaskRecord(cfg, p.task_id, {
                  status: "FAILED",
                  completed_at: nowISO(),
                  current_phase: "plan_rejected",
                  error_detail: `Plan rejected: ${p.reason ?? "no reason"}`,
                } as Partial<TaskRecord>);
              }
              return {
                content: [
                  {
                    type: "text" as const,
                    text:
                      `Plan ${p.decision} for task ${p.task_id}.\n` +
                      (p.reason ? `  reason: ${p.reason}\n` : "") +
                      (p.step_comments?.length
                        ? `  step_comments: ${p.step_comments.length}\n`
                        : "") +
                      `  plan_status: ${plan.status}`,
                  },
                ],
                details: { plan_status: plan.status, decision: p.decision },
              };
            } catch (err) {
              return {
                content: [{ type: "text" as const, text: `Error: ${err}` }],
                details: undefined,
              };
            }
          },
        },
        { names: ["chatroom_approve_plan"] },
      );

      // ── Tool: list plans ──────────────────────────────────────────────────

      api.registerTool(
        {
          name: "chatroom_list_plans",
          label: "Chatroom: List Task Plans",
          description: "List all task plans, optionally filtered by status.",
          parameters: Type.Object({
            status: Type.Optional(
              Type.String({
                description: "Filter by plan status (e.g. 'DRAFT', 'EXECUTING', 'COMPLETED')",
              }),
            ),
          }),
          async execute(_toolCallId, params) {
            try {
              const p = params as { status?: string };
              const dir = plansDir(cfg);
              if (!fs.existsSync(dir)) {
                return {
                  content: [{ type: "text" as const, text: "No plans found." }],
                  details: [],
                };
              }
              let plans: TaskPlan[] = [];
              for (const f of fs.readdirSync(dir)) {
                if (!f.endsWith(".json")) continue;
                const plan = readJson(path.join(dir, f)) as TaskPlan | null;
                if (plan) plans.push(plan);
              }
              if (p.status) {
                plans = plans.filter((pl) => pl.status === p.status);
              }
              plans.sort((a, b) => a.created_at.localeCompare(b.created_at));
              const summary = plans.map((pl) => ({
                task_id: pl.task_id,
                agent: pl.agent_id,
                status: pl.status,
                steps: `${pl.steps.filter((s) => s.status === "COMPLETED").length}/${pl.steps.length}`,
                summary: pl.summary.slice(0, 80),
              }));
              return {
                content: [
                  {
                    type: "text" as const,
                    text: plans.length === 0 ? "No plans found." : JSON.stringify(summary, null, 2),
                  },
                ],
                details: summary,
              };
            } catch (err) {
              return {
                content: [{ type: "text" as const, text: `Error: ${err}` }],
                details: undefined,
              };
            }
          },
        },
        { names: ["chatroom_list_plans"] },
      );
    } // end orchestrator-only tools

    // ── Shared tools (available to ALL agents) ────────────────────────────

    // ── Tool: save asset to NAS ───────────────────────────────────────────

    api.registerTool(
      {
        name: "chatroom_save_asset",
        label: "Chatroom: Save Asset",
        description:
          "Save generated text content to NAS. For BINARY FILES that already exist on disk,\n" +
          "use chatroom_publish_file instead (it's faster, safer, and doesn't need base64).\n" +
          "This tool is best for: dynamically generated text, markdown reports, JSON, config files.\n" +
          "If you pass a file path as content by mistake, it will be auto-detected and copied correctly.",
        parameters: Type.Object({
          filename: Type.String({
            description: "File name (e.g. 'report.md', 'config.json')",
          }),
          content: Type.String({
            description:
              "File content — plain text for text files, base64-encoded string for binary files. " +
              "WARNING: for binary files on disk, use chatroom_publish_file(source_path=...) instead.",
          }),
          encoding: Type.Optional(
            Type.String({
              description:
                "'text' (default) or 'base64'. Prefer chatroom_publish_file for binary files.",
            }),
          ),
          task_id: Type.Optional(
            Type.String({
              description:
                "Task ID — saves to the task-specific output directory. If omitted, saves to your general agent directory.",
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          try {
            const p = params as {
              filename: string;
              content: string;
              encoding?: string;
              task_id?: string;
            };
            const dir = p.task_id
              ? taskAssetsDir(cfg, cfg.agentId, p.task_id)
              : assetsDir(cfg, cfg.agentId);

            // Guard: detect if content is actually a file path
            const detectedPath = detectMisusedFilePath(p.content);
            if (detectedPath) {
              const result = publishFileToNAS(detectedPath, dir, p.filename);
              return {
                content: [
                  {
                    type: "text" as const,
                    text:
                      `[AUTO-CORRECTED] Detected file path in content — copied file directly instead.\n` +
                      `File published to NAS (verified): ${result.nasPath} (${formatFileSize(result.sourceSize)}, MD5: ${result.md5})\n` +
                      `TIP: Next time, use chatroom_publish_file(source_path="${detectedPath}") for binary files.`,
                  },
                ],
                details: result,
              };
            }

            ensureDir(dir);
            const filePath = toForwardSlash(path.join(dir, p.filename));

            if (p.encoding === "base64") {
              const buf = Buffer.from(p.content, "base64");
              fs.writeFileSync(filePath, buf);
              const ext = path.extname(p.filename).toLowerCase();
              const sizeNote =
                buf.length > 512 * 1024
                  ? ` (large file — consider chatroom_publish_file for better reliability)`
                  : "";
              const binNote = BINARY_EXTENSIONS.has(ext)
                ? `\nTIP: For binary files on disk, chatroom_publish_file(source_path=...) is more reliable than base64.`
                : "";
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `File saved: ${filePath} (${formatFileSize(buf.length)})${sizeNote}${binNote}`,
                  },
                ],
                details: { path: filePath, size: buf.length },
              };
            }

            fs.writeFileSync(filePath, p.content, "utf-8");
            return {
              content: [
                {
                  type: "text" as const,
                  text: `File saved: ${filePath} (${fs.statSync(filePath).size} bytes)`,
                },
              ],
              details: { path: filePath, size: fs.statSync(filePath).size },
            };
          } catch (err) {
            return {
              content: [{ type: "text" as const, text: `Error saving file: ${err}` }],
              details: undefined,
            };
          }
        },
      },
      { names: ["chatroom_save_asset"] },
    );

    // ── Tool: send message (general chat, non-task) ─────────────────────────

    api.registerTool(
      {
        name: "chatroom_send_message",
        label: "Chatroom: Send Message",
        description:
          "Send a general chat message to a channel. For task assignments, use chatroom_dispatch_task instead.\n" +
          "Use this for: status updates, questions, broadcasting information, chatting.\n" +
          "Optionally attach files already saved on NAS via asset_paths.",
        parameters: Type.Object({
          channel_id: Type.String({
            description: "Target channel ID (e.g. 'general', 'pipeline', 'dm_art')",
          }),
          text: Type.String({ description: "Message content" }),
          mentions: Type.Optional(
            Type.Array(Type.String(), { description: "Agent IDs to @mention" }),
          ),
          asset_paths: Type.Optional(
            Type.Array(Type.String(), {
              description: "NAS file paths to attach (e.g. from chatroom_save_asset output)",
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          try {
            const p = params as {
              channel_id: string;
              text: string;
              mentions?: string[];
              asset_paths?: string[];
            };

            // Workers cannot post to #general — orchestrator-only channel
            if (cfg.role !== "orchestrator" && p.channel_id === "general") {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Blocked: #general is reserved for the orchestrator. Use your DM channel (dm_${cfg.agentId}) instead.`,
                  },
                ],
                details: undefined,
              };
            }

            const metadata: Record<string, any> = {};
            if (p.asset_paths?.length) metadata.asset_paths = p.asset_paths;
            const result = sendMessageToNAS(
              cfg,
              p.channel_id,
              p.text,
              "CHAT",
              p.mentions ?? [],
              undefined,
              metadata,
            );
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `Message sent to #${p.channel_id} (seq: ${result.seq})` +
                    (p.asset_paths?.length ? ` with ${p.asset_paths.length} attachment(s)` : ""),
                },
              ],
              details: result,
            };
          } catch (err) {
            return {
              content: [{ type: "text" as const, text: `Error: ${err}` }],
              details: undefined,
            };
          }
        },
      },
      { names: ["chatroom_send_message"] },
    );

    // ── Tool: upload file and send as message ────────────────────────────────

    api.registerTool(
      {
        name: "chatroom_send_file",
        label: "Chatroom: Upload & Send File",
        description:
          "Upload generated content to NAS and send as a chat message.\n" +
          "For BINARY FILES already on disk (images, audio, etc.), use chatroom_publish_and_send instead —\n" +
          "it copies the file directly without base64, with integrity verification.\n" +
          "This tool is best for: text content you want to both save and share in one step.\n" +
          "If you pass a file path as content by mistake, it will be auto-detected and copied correctly.",
        parameters: Type.Object({
          channel_id: Type.String({
            description: "Target channel ID (e.g. 'general', 'pipeline')",
          }),
          filename: Type.String({
            description: "File name with extension (e.g. 'concept_art.png', 'report.md')",
          }),
          content: Type.String({
            description:
              "File content — plain text for text files, base64-encoded string for binary files. " +
              "WARNING: for local binary files, use chatroom_publish_and_send(source_path=...) instead.",
          }),
          encoding: Type.Optional(
            Type.String({
              description:
                "'text' (default) or 'base64'. Prefer chatroom_publish_and_send for binary files.",
            }),
          ),
          text: Type.Optional(
            Type.String({
              description: "Optional message text to accompany the file. Defaults to the filename.",
            }),
          ),
          task_id: Type.Optional(
            Type.String({
              description: "If part of a task, saves to the task-specific directory.",
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          try {
            const p = params as {
              channel_id: string;
              filename: string;
              content: string;
              encoding?: string;
              text?: string;
              task_id?: string;
            };

            // Workers cannot post to #general
            if (cfg.role !== "orchestrator" && p.channel_id === "general") {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Blocked: #general is reserved for the orchestrator. Use your DM channel (dm_${cfg.agentId}) instead.`,
                  },
                ],
                details: undefined,
              };
            }

            const dir = p.task_id
              ? taskAssetsDir(cfg, cfg.agentId, p.task_id)
              : assetsDir(cfg, cfg.agentId);

            // Guard: detect if content is actually a file path
            const detectedPath = detectMisusedFilePath(p.content);
            if (detectedPath) {
              const pubResult = publishFileToNAS(detectedPath, dir, p.filename);
              const displayName = p.filename ?? path.basename(detectedPath);
              const msgText = p.text ?? `📎 ${displayName}`;
              const sendResult = sendMessageToNAS(
                cfg,
                p.channel_id,
                msgText,
                "CHAT",
                [],
                undefined,
                {
                  asset_paths: [pubResult.nasPath],
                },
              );
              return {
                content: [
                  {
                    type: "text" as const,
                    text:
                      `[AUTO-CORRECTED] Detected file path in content — copied file directly.\n` +
                      `File published and sent to #${p.channel_id} (seq: ${sendResult.seq}, verified):\n` +
                      `  NAS path: ${pubResult.nasPath} (${formatFileSize(pubResult.sourceSize)}, MD5: ${pubResult.md5})\n` +
                      `TIP: Next time, use chatroom_publish_and_send(source_path="${detectedPath}") for binary files.`,
                  },
                ],
                details: { ...pubResult, seq: sendResult.seq },
              };
            }

            ensureDir(dir);
            const filePath = toForwardSlash(path.join(dir, p.filename));

            if (p.encoding === "base64") {
              fs.writeFileSync(filePath, Buffer.from(p.content, "base64"));
            } else {
              fs.writeFileSync(filePath, p.content, "utf-8");
            }

            const fileSize = fs.statSync(filePath).size;
            const msgText = p.text ?? `📎 ${p.filename}`;
            const result = sendMessageToNAS(cfg, p.channel_id, msgText, "CHAT", [], undefined, {
              asset_paths: [filePath],
            });

            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `File uploaded and message sent to #${p.channel_id} (seq: ${result.seq})\n` +
                    `  Path: ${filePath} (${fileSize} bytes)`,
                },
              ],
              details: { path: filePath, size: fileSize, seq: result.seq },
            };
          } catch (err) {
            return {
              content: [{ type: "text" as const, text: `Error: ${err}` }],
              details: undefined,
            };
          }
        },
      },
      { names: ["chatroom_send_file"] },
    );

    // ── Tool: publish file (binary-safe copy to NAS) ────────────────────────

    api.registerTool(
      {
        name: "chatroom_publish_file",
        label: "Chatroom: Publish File to NAS",
        description:
          "Copy a file from your local filesystem to NAS shared storage with integrity verification.\n" +
          "This is the PREFERRED method for sharing binary files (images, audio, PDFs, models, etc.).\n" +
          "Unlike chatroom_save_asset (which requires base64 content), this tool takes a SOURCE PATH\n" +
          "and performs a direct binary copy — reliable for files of any size.\n" +
          "The file is verified after copy (size + MD5 checksum).\n\n" +
          "Returns the NAS path that can be referenced in messages via asset_paths.",
        parameters: Type.Object({
          source_path: Type.String({
            description:
              "Absolute path to the file on your local filesystem (e.g. '/workspace/output/render.png')",
          }),
          filename: Type.Optional(
            Type.String({
              description: "Target filename on NAS. Defaults to the source file's basename.",
            }),
          ),
          task_id: Type.Optional(
            Type.String({
              description:
                "Task ID — saves to the task-specific output directory. If omitted, saves to your general agent directory.",
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          try {
            const p = params as {
              source_path: string;
              filename?: string;
              task_id?: string;
            };
            const dir = p.task_id
              ? taskAssetsDir(cfg, cfg.agentId, p.task_id)
              : assetsDir(cfg, cfg.agentId);
            const result = publishFileToNAS(p.source_path, dir, p.filename);
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `File published to NAS (verified):\n` +
                    `  Source: ${p.source_path}\n` +
                    `  NAS path: ${result.nasPath}\n` +
                    `  Size: ${formatFileSize(result.sourceSize)}\n` +
                    `  MD5: ${result.md5}`,
                },
              ],
              details: result,
            };
          } catch (err) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Error publishing file: ${err}`,
                },
              ],
              details: undefined,
            };
          }
        },
      },
      { names: ["chatroom_publish_file"] },
    );

    // ── Tool: publish file and send as message ──────────────────────────────

    api.registerTool(
      {
        name: "chatroom_publish_and_send",
        label: "Chatroom: Publish File & Send Message",
        description:
          "Copy a local file to NAS AND send it as a chat message in one step.\n" +
          "This is the PREFERRED method for sharing binary files with the team.\n" +
          "The file is copied directly (binary-safe, not base64) and verified.\n" +
          "Images will be displayed inline in the chatroom UI.",
        parameters: Type.Object({
          source_path: Type.String({
            description:
              "Absolute path to the file on your local filesystem (e.g. '/workspace/output/render.png')",
          }),
          channel_id: Type.String({
            description: "Target channel ID (e.g. 'general', 'pipeline', 'dm_art')",
          }),
          filename: Type.Optional(
            Type.String({
              description: "Target filename on NAS. Defaults to the source file's basename.",
            }),
          ),
          text: Type.Optional(
            Type.String({
              description: "Message text to accompany the file. Defaults to the filename.",
            }),
          ),
          task_id: Type.Optional(
            Type.String({
              description: "If part of a task, saves to the task-specific directory.",
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          try {
            const p = params as {
              source_path: string;
              channel_id: string;
              filename?: string;
              text?: string;
              task_id?: string;
            };

            if (cfg.role !== "orchestrator" && p.channel_id === "general") {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Blocked: #general is reserved for the orchestrator. Use your DM channel (dm_${cfg.agentId}) instead.`,
                  },
                ],
                details: undefined,
              };
            }

            const dir = p.task_id
              ? taskAssetsDir(cfg, cfg.agentId, p.task_id)
              : assetsDir(cfg, cfg.agentId);
            const result = publishFileToNAS(p.source_path, dir, p.filename);

            const displayName = p.filename ?? path.basename(p.source_path);
            const msgText = p.text ?? `📎 ${displayName}`;
            const sendResult = sendMessageToNAS(cfg, p.channel_id, msgText, "CHAT", [], undefined, {
              asset_paths: [result.nasPath],
            });

            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `File published and message sent to #${p.channel_id} (seq: ${sendResult.seq}, verified):\n` +
                    `  NAS path: ${result.nasPath}\n` +
                    `  Size: ${formatFileSize(result.sourceSize)} | MD5: ${result.md5}`,
                },
              ],
              details: { ...result, seq: sendResult.seq },
            };
          } catch (err) {
            return {
              content: [{ type: "text" as const, text: `Error: ${err}` }],
              details: undefined,
            };
          }
        },
      },
      { names: ["chatroom_publish_and_send"] },
    );

    // ── Tool: list assets on NAS ────────────────────────────────────────────

    api.registerTool(
      {
        name: "chatroom_list_assets",
        label: "Chatroom: List Assets",
        description:
          "List files stored on NAS for a given agent or shared directory.\n" +
          "Use to discover what files are available for reference or download.",
        parameters: Type.Object({
          scope: Type.Optional(
            Type.String({
              description:
                "'mine' (default) — your own asset directory, 'shared' — shared assets, " +
                "or an agent ID to list that agent's assets.",
            }),
          ),
          task_id: Type.Optional(
            Type.String({
              description: "If provided, list only the task-specific subdirectory.",
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          try {
            const p = params as { scope?: string; task_id?: string };
            const scope = p.scope ?? "mine";
            let targetDir: string;

            if (scope === "mine") {
              targetDir = p.task_id
                ? taskAssetsDir(cfg, cfg.agentId, p.task_id)
                : assetsDir(cfg, cfg.agentId);
            } else if (scope === "shared") {
              targetDir = assetsDir(cfg, "shared");
            } else {
              targetDir = p.task_id ? taskAssetsDir(cfg, scope, p.task_id) : assetsDir(cfg, scope);
            }

            if (!fs.existsSync(targetDir)) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Directory does not exist: ${targetDir}`,
                  },
                ],
                details: { files: [], dir: targetDir },
              };
            }

            const entries = fs.readdirSync(targetDir, { withFileTypes: true });
            const files: { name: string; path: string; size: string; type: string }[] = [];
            const dirs: string[] = [];

            for (const entry of entries) {
              if (entry.isFile()) {
                const fullPath = toForwardSlash(path.join(targetDir, entry.name));
                const stat = fs.statSync(fullPath);
                files.push({
                  name: entry.name,
                  path: fullPath,
                  size: formatFileSize(stat.size),
                  type: path.extname(entry.name).toLowerCase() || "(no ext)",
                });
              } else if (entry.isDirectory()) {
                dirs.push(entry.name);
              }
            }

            const lines: string[] = [`Directory: ${targetDir}`];
            if (dirs.length > 0) {
              lines.push(`Subdirectories: ${dirs.join(", ")}`);
            }
            if (files.length === 0) {
              lines.push(`(empty — no files)`);
            } else {
              lines.push(`Files (${files.length}):`);
              for (const f of files) {
                lines.push(`  ${f.name}  ${f.size}  ${f.type}`);
              }
            }

            return {
              content: [{ type: "text" as const, text: lines.join("\n") }],
              details: { dir: targetDir, files, dirs },
            };
          } catch (err) {
            return {
              content: [{ type: "text" as const, text: `Error: ${err}` }],
              details: undefined,
            };
          }
        },
      },
      { names: ["chatroom_list_assets"] },
    );

    // ── Tool: list channels ─────────────────────────────────────────────────

    api.registerTool(
      {
        name: "chatroom_list_channels",
        label: "Chatroom: List Channels",
        description: "List all chatroom channels this agent belongs to.",
        parameters: Type.Object({}),
        async execute(_toolCallId, _params) {
          try {
            const channels = listAgentChannels(cfg);
            const text = JSON.stringify(
              channels.map((ch: any) => ({
                id: ch.channel_id,
                name: ch.display_name,
                type: ch.type,
                members: ch.members,
              })),
              null,
              2,
            );
            return { content: [{ type: "text" as const, text }], details: undefined };
          } catch (err) {
            return {
              content: [{ type: "text" as const, text: `Error: ${err}` }],
              details: undefined,
            };
          }
        },
      },
      { names: ["chatroom_list_channels"] },
    );

    // ── Tool: check inbox (manual, usually not needed) ──────────────────────

    api.registerTool(
      {
        name: "chatroom_check_inbox",
        label: "Chatroom: Check Inbox",
        description:
          "Manually check inbox. Usually not needed — the daemon auto-dispatches messages.",
        parameters: Type.Object({}),
        async execute(_toolCallId, _params) {
          try {
            const msgs = pollInbox(cfg);
            updateHeartbeat(cfg);
            if (msgs.length === 0)
              return {
                content: [{ type: "text" as const, text: "No new messages." }],
                details: undefined,
              };
            const all = msgs.map((m) => ({
              channel: m.channel_id,
              from: m.from,
              type: m.type,
              text: m.content?.text ?? "",
              message_id: m.message_id,
            }));
            return {
              content: [
                {
                  type: "text" as const,
                  text: `${all.length} message(s):\n${JSON.stringify(all, null, 2)}`,
                },
              ],
              details: all,
            };
          } catch (err) {
            return {
              content: [{ type: "text" as const, text: `Error: ${err}` }],
              details: undefined,
            };
          }
        },
      },
      { names: ["chatroom_check_inbox"] },
    );

    // ── Tool: report task progress (available to all agents) ────────────────

    api.registerTool(
      {
        name: "chatroom_task_progress",
        label: "Chatroom: Report Task Progress",
        description:
          "Report progress on an active task. Use this to keep the orchestrator informed of " +
          "what you are currently doing.\n\n" +
          "Examples:\n" +
          '  chatroom_task_progress(task_id="abc...", phase="generating_image", detail="Creating base composition")\n' +
          '  chatroom_task_progress(task_id="abc...", phase="uploading", detail="Pushing to NAS")\n\n' +
          "Call this at significant milestones so the orchestrator and dashboard can track your progress.",
        parameters: Type.Object({
          task_id: Type.String({ description: "The task ID you are working on" }),
          phase: Type.String({
            description:
              "Short phase label (e.g. 'analyzing', 'generating', 'uploading', 'finalizing')",
          }),
          detail: Type.Optional(
            Type.String({ description: "Optional details about what is happening" }),
          ),
        }),
        async execute(_toolCallId, params) {
          try {
            const p = params as { task_id: string; phase: string; detail?: string };
            appendTaskProgress(cfg, p.task_id, {
              phase: p.phase,
              detail: p.detail,
            });
            updateTaskRecord(cfg, p.task_id, { current_phase: p.phase } as Partial<TaskRecord>);
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Progress recorded: [${p.phase}]${p.detail ? ` ${p.detail}` : ""}`,
                },
              ],
              details: { task_id: p.task_id, phase: p.phase },
            };
          } catch (err) {
            return {
              content: [{ type: "text" as const, text: `Error: ${err}` }],
              details: undefined,
            };
          }
        },
      },
      { names: ["chatroom_task_progress"] },
    );

    // ── Tool: park a task for long-running operations ───────────────────────

    api.registerTool(
      {
        name: "chatroom_task_park",
        label: "Chatroom: Park Task (Long-Running)",
        description:
          "Park a task to wait for a long-running operation WITHOUT holding the LLM session.\n" +
          "Use this when you need to wait for something that takes minutes or longer:\n" +
          "  - A build/compile process to finish\n" +
          "  - A file to appear (e.g. build output, download)\n" +
          "  - An HTTP endpoint to become available\n\n" +
          "HOW IT WORKS:\n" +
          "  1. You call this tool with what to watch for and what to do when it's ready\n" +
          "  2. Your LLM session ENDS immediately (saving tokens and context)\n" +
          "  3. A lightweight system monitor checks the condition periodically\n" +
          "  4. When the condition is met, a NEW LLM session starts with your resume_prompt\n\n" +
          "IMPORTANT: After calling this tool, your response will be your FINAL output.\n" +
          "Put all continuation logic in resume_prompt.\n\n" +
          "Watch types:\n" +
          '  - "shell": Run a command; condition met when it exits 0\n' +
          '  - "file": Wait for a file to appear at a path\n' +
          '  - "poll_url": Poll a URL; condition met when it returns expected status code\n\n' +
          "Example:\n" +
          '  chatroom_task_park(task_id="abc", watch_type="shell",\n' +
          '    command="test -f /output/build.zip && echo done",\n' +
          '    resume_prompt="Build finished. Upload build.zip to NAS and report.",\n' +
          "    poll_interval_ms=30000, max_wait_minutes=30)",
        parameters: Type.Object({
          task_id: Type.String({ description: "The task ID being parked" }),
          watch_type: Type.String({
            description: 'What to watch: "shell", "file", or "poll_url"',
          }),
          command: Type.Optional(
            Type.String({
              description: 'For watch_type="shell": the command to run (success = exit 0)',
            }),
          ),
          file_path: Type.Optional(
            Type.String({
              description: 'For watch_type="file": absolute path to watch for',
            }),
          ),
          url: Type.Optional(
            Type.String({
              description: 'For watch_type="poll_url": the URL to poll',
            }),
          ),
          expected_status: Type.Optional(
            Type.Number({
              description: 'For watch_type="poll_url": expected HTTP status (default 200)',
            }),
          ),
          resume_prompt: Type.String({
            description:
              "Instructions for the NEW LLM session when the condition is met. " +
              "Include everything the agent needs to continue (what to do next, file paths, etc.)",
          }),
          poll_interval_ms: Type.Optional(
            Type.Number({
              description: "How often to check the condition in ms (default 30000 = 30s)",
            }),
          ),
          max_wait_minutes: Type.Optional(
            Type.Number({
              description: "Maximum time to wait in minutes (default 30, max 120)",
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          try {
            const p = params as {
              task_id: string;
              watch_type: string;
              command?: string;
              file_path?: string;
              url?: string;
              expected_status?: number;
              resume_prompt: string;
              poll_interval_ms?: number;
              max_wait_minutes?: number;
            };

            const task = readTaskRecord(cfg, p.task_id);
            if (!task) {
              return {
                content: [{ type: "text" as const, text: `Task ${p.task_id} not found.` }],
                details: undefined,
              };
            }

            const watchType = p.watch_type as ParkWatchType;
            if (!["shell", "file", "poll_url"].includes(watchType)) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Invalid watch_type "${p.watch_type}". Use "shell", "file", or "poll_url".`,
                  },
                ],
                details: undefined,
              };
            }

            const maxWaitMinutes = Math.min(p.max_wait_minutes ?? 30, 120);
            const pollInterval = Math.max(p.poll_interval_ms ?? 30_000, 5_000);

            const parkedInfo: ParkedTaskInfo = {
              task_id: p.task_id,
              agent_id: cfg.agentId,
              channel_id: task.channel_id,
              original_instruction: task.instruction,
              resume_prompt: p.resume_prompt,
              watch_type: watchType,
              watch_config: {
                command: p.command,
                file_path: p.file_path,
                url: p.url,
                expected_status: p.expected_status,
              },
              poll_interval_ms: pollInterval,
              max_wait_ms: maxWaitMinutes * 60_000,
              parked_at: nowISO(),
              last_poll_at: null,
              poll_count: 0,
            };

            writeParkedTask(cfg, parkedInfo);

            updateTaskRecord(cfg, p.task_id, {
              status: "PARKED",
              current_phase: `parked_${watchType}`,
            } as Partial<TaskRecord>);
            appendTaskProgress(cfg, p.task_id, {
              phase: "parked",
              detail: `Parked: watching ${watchType} (poll every ${pollInterval / 1000}s, max ${maxWaitMinutes}min)`,
            });

            logger.info(
              `Task ${p.task_id} PARKED: ${watchType}, poll ${pollInterval}ms, max ${maxWaitMinutes}min`,
            );

            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `Task ${p.task_id} is now PARKED.\n` +
                    `Watch: ${watchType} (poll every ${pollInterval / 1000}s, max wait ${maxWaitMinutes}min)\n` +
                    `Your LLM session will end now. When the condition is met, a new session ` +
                    `will start with your resume_prompt.\n\n` +
                    `You can now provide a brief status message as your final response.`,
                },
              ],
              details: parkedInfo,
            };
          } catch (err) {
            return {
              content: [{ type: "text" as const, text: `Error parking task: ${err}` }],
              details: undefined,
            };
          }
        },
      },
      { names: ["chatroom_task_park"] },
    );

    // ── Tool: request permission for sensitive operations ──────────────────

    api.registerTool(
      {
        name: "chatroom_request_permission",
        label: "Chatroom: Request Permission",
        description:
          "Request human admin approval before executing a sensitive operation.\n" +
          "Use this BEFORE performing any of these operations:\n" +
          "  - Shell commands that modify system directories (outside workspace)\n" +
          "  - Reading or writing sensitive files (.env, credentials, keys)\n" +
          "  - System-level operations (chmod, chown, systemctl, docker rm)\n" +
          "  - Network operations that mutate external state (POST/PUT/DELETE)\n\n" +
          "HOW IT WORKS:\n" +
          "  1. You call this tool describing the operation you want to perform\n" +
          "  2. If the operation is already allowlisted, it auto-approves instantly\n" +
          "  3. Otherwise, your LLM session ENDS and the request goes to the admin\n" +
          "  4. When approved, a NEW session starts with your resume_prompt\n" +
          "  5. If rejected, the task is marked as failed\n\n" +
          "IMPORTANT: After calling this tool (if not auto-approved), your next response is FINAL.",
        parameters: Type.Object({
          task_id: Type.String({ description: "The task ID you are working on" }),
          operation_type: Type.String({
            description: 'Type of operation: "shell", "write", "read", "network", or "system"',
          }),
          operation_detail: Type.String({
            description:
              "The actual command or file path (e.g. 'rm -rf /usr/local/old-sdk' or '/etc/nginx/nginx.conf')",
          }),
          reason: Type.String({
            description: "Brief explanation of why this operation is needed",
          }),
          resume_prompt: Type.String({
            description: "Instructions for the NEW LLM session if the operation is approved",
          }),
        }),
        async execute(_toolCallId, params) {
          try {
            const p = params as {
              task_id: string;
              operation_type: string;
              operation_detail: string;
              reason: string;
              resume_prompt: string;
            };

            const task = readTaskRecord(cfg, p.task_id);
            if (!task) {
              return {
                content: [{ type: "text" as const, text: `Task ${p.task_id} not found.` }],
                details: undefined,
              };
            }

            // Check allowlist first
            if (matchesAllowlist(cfg, p.operation_type, p.operation_detail)) {
              logger.info(
                `Permission auto-approved (allowlisted) for task ${p.task_id}: ${p.operation_type} ${p.operation_detail.slice(0, 60)}`,
              );
              return {
                content: [
                  {
                    type: "text" as const,
                    text:
                      `Operation auto-approved (allowlisted). You may proceed.\n` +
                      `  type: ${p.operation_type}\n` +
                      `  detail: ${p.operation_detail}`,
                  },
                ],
                details: { auto_approved: true },
              };
            }

            // Create permission request
            const permRecord = createPermissionRequest(
              cfg,
              p.task_id,
              cfg.agentId,
              task.channel_id,
              p.operation_type,
              p.operation_detail,
              p.reason,
              task.instruction,
              p.resume_prompt,
              logger,
            );

            // Park the task with watch_type="permission"
            const parkedInfo: ParkedTaskInfo = {
              task_id: p.task_id,
              agent_id: cfg.agentId,
              channel_id: task.channel_id,
              original_instruction: task.instruction,
              resume_prompt: p.resume_prompt,
              watch_type: "permission",
              watch_config: {
                permission_id: permRecord.permission_id,
              },
              poll_interval_ms: 5_000,
              max_wait_ms: 24 * 60 * 60_000,
              parked_at: nowISO(),
              last_poll_at: null,
              poll_count: 0,
            };
            writeParkedTask(cfg, parkedInfo);

            updateTaskRecord(cfg, p.task_id, {
              status: "PARKED",
              current_phase: "awaiting_permission",
            } as Partial<TaskRecord>);

            appendTaskProgress(cfg, p.task_id, {
              phase: "awaiting_permission",
              detail: `Permission requested: ${p.operation_type} — ${p.operation_detail.slice(0, 100)}`,
            });

            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `Permission request submitted (ID: ${permRecord.permission_id.slice(0, 8)}...).\n` +
                    `Task is now PARKED awaiting admin approval.\n` +
                    `  Operation: ${p.operation_type} — ${p.operation_detail}\n` +
                    `  Reason: ${p.reason}\n\n` +
                    `Your LLM session will end now. If approved, a new session starts with your resume_prompt.\n` +
                    `Provide a brief status message as your final response.`,
                },
              ],
              details: { permission_id: permRecord.permission_id, parked: true },
            };
          } catch (err) {
            return {
              content: [{ type: "text" as const, text: `Error requesting permission: ${err}` }],
              details: undefined,
            };
          }
        },
      },
      { names: ["chatroom_request_permission"] },
    );

    // ── Tool: create a structured plan for a task ─────────────────────────

    api.registerTool(
      {
        name: "chatroom_create_plan",
        label: "Chatroom: Create Task Plan",
        description:
          "Create a structured execution plan for a task. Call this during the planning phase " +
          "to break down a complex task into discrete steps.\n\n" +
          "Each step should be a self-contained unit of work with its own estimated duration.\n" +
          "The plan will be reviewed (by the orchestrator or a human) before execution begins.\n\n" +
          "Example:\n" +
          '  chatroom_create_plan(task_id="abc", summary="Build and publish iOS v2.1",\n' +
          "    steps=[{title: 'Run tests', description: '...', estimated_minutes: 2, timeout_minutes: 5}, ...])",
        parameters: Type.Object({
          task_id: Type.String({ description: "The task ID this plan is for" }),
          summary: Type.String({ description: "One-line summary of the plan" }),
          steps: Type.Array(
            Type.Object({
              title: Type.String({ description: "Short step title" }),
              description: Type.String({ description: "Detailed description of what to do" }),
              estimated_minutes: Type.Number({ description: "Estimated time in minutes" }),
              timeout_minutes: Type.Optional(
                Type.Number({
                  description: "Max timeout for this step (default: 10min, max: 30min)",
                }),
              ),
            }),
            { description: "Ordered list of steps", minItems: 1 },
          ),
        }),
        async execute(_toolCallId, params) {
          try {
            const p = params as {
              task_id: string;
              summary: string;
              steps: {
                title: string;
                description: string;
                estimated_minutes: number;
                timeout_minutes?: number;
              }[];
            };
            const approvalMode = getApprovalMode(cfg);
            const plan = createNewPlan(
              cfg,
              p.task_id,
              cfg.agentId,
              p.summary,
              p.steps.map((s, i) => ({
                order: i + 1,
                title: s.title,
                description: s.description,
                estimated_minutes: s.estimated_minutes,
                timeout_minutes: s.timeout_minutes ?? DEFAULT_STEP_TIMEOUT_MS / 60_000,
              })),
              approvalMode,
            );
            updateTaskRecord(cfg, p.task_id, {
              plan_id: plan.plan_id,
              total_steps: plan.steps.length,
              current_phase: "plan_created",
            } as Partial<TaskRecord>);
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `Plan created for task ${p.task_id}.\n` +
                    `  plan_id: ${plan.plan_id}\n` +
                    `  steps: ${plan.steps.length}\n` +
                    `  estimated_total: ${plan.estimated_total_minutes}min\n` +
                    `  approval_mode: ${approvalMode}\n` +
                    `  status: DRAFT (awaiting review)`,
                },
              ],
              details: plan,
            };
          } catch (err) {
            return {
              content: [{ type: "text" as const, text: `Error creating plan: ${err}` }],
              details: undefined,
            };
          }
        },
      },
      { names: ["chatroom_create_plan"] },
    );

    // ── Tool: mark a plan step as completed ───────────────────────────────

    api.registerTool(
      {
        name: "chatroom_complete_step",
        label: "Chatroom: Complete Plan Step",
        description:
          "Mark a plan step as completed and provide a result summary.\n" +
          "Call this after finishing each step during plan execution.\n\n" +
          "Example:\n" +
          '  chatroom_complete_step(task_id="abc", step_id="xyz",\n' +
          '    result_summary="All 42 tests passed", output_files=["/workspace/out/test-report.txt"])',
        parameters: Type.Object({
          task_id: Type.String({ description: "The task ID" }),
          step_id: Type.String({ description: "The step ID to mark as completed" }),
          result_summary: Type.String({ description: "Brief summary of what was accomplished" }),
          output_files: Type.Optional(
            Type.Array(Type.String(), { description: "Paths to files produced by this step" }),
          ),
        }),
        async execute(_toolCallId, params) {
          try {
            const p = params as {
              task_id: string;
              step_id: string;
              result_summary: string;
              output_files?: string[];
            };
            const plan = updatePlanStep(cfg, p.task_id, p.step_id, {
              status: "COMPLETED",
              result_summary: p.result_summary,
              output_files: p.output_files ?? [],
              completed_at: nowISO(),
            });
            if (!plan) {
              return {
                content: [{ type: "text" as const, text: `Plan not found for task ${p.task_id}` }],
                details: undefined,
              };
            }
            const completed = plan.steps.filter((s) => s.status === "COMPLETED").length;
            updateTaskRecord(cfg, p.task_id, {
              current_step: completed,
              current_phase: `step_${completed}/${plan.steps.length}`,
            } as Partial<TaskRecord>);
            appendTaskProgress(cfg, p.task_id, {
              phase: `step_completed`,
              detail: `Step ${completed}/${plan.steps.length}: ${p.result_summary.slice(0, 200)}`,
            });
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `Step completed: ${p.step_id}\n` +
                    `  progress: ${completed}/${plan.steps.length}\n` +
                    `  result: ${p.result_summary}`,
                },
              ],
              details: { completed, total: plan.steps.length },
            };
          } catch (err) {
            return {
              content: [{ type: "text" as const, text: `Error completing step: ${err}` }],
              details: undefined,
            };
          }
        },
      },
      { names: ["chatroom_complete_step"] },
    );

    // ── Tool: fail a plan step ────────────────────────────────────────────

    api.registerTool(
      {
        name: "chatroom_fail_step",
        label: "Chatroom: Fail Plan Step",
        description:
          "Mark a plan step as failed with an error detail.\n" +
          "The system will decide whether to retry or abort the remaining steps.",
        parameters: Type.Object({
          task_id: Type.String({ description: "The task ID" }),
          step_id: Type.String({ description: "The step ID that failed" }),
          error_detail: Type.String({ description: "What went wrong" }),
        }),
        async execute(_toolCallId, params) {
          try {
            const p = params as { task_id: string; step_id: string; error_detail: string };
            const plan = updatePlanStep(cfg, p.task_id, p.step_id, {
              status: "FAILED",
              error_detail: p.error_detail,
              completed_at: nowISO(),
            });
            if (!plan) {
              return {
                content: [{ type: "text" as const, text: `Plan not found for task ${p.task_id}` }],
                details: undefined,
              };
            }
            appendTaskProgress(cfg, p.task_id, {
              phase: "step_failed",
              detail: p.error_detail.slice(0, 200),
            });
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Step failed: ${p.step_id}\n  error: ${p.error_detail}`,
                },
              ],
              details: undefined,
            };
          } catch (err) {
            return {
              content: [{ type: "text" as const, text: `Error: ${err}` }],
              details: undefined,
            };
          }
        },
      },
      { names: ["chatroom_fail_step"] },
    );

    // ── Background service ──────────────────────────────────────────────────

    const pollIntervalMs = (pluginCfg.pollIntervalMs as number) ?? 3000;
    const taskMonitorIntervalMs = (pluginCfg.taskMonitorIntervalMs as number) ?? 10_000;
    const parkMonitorIntervalMs = (pluginCfg.parkMonitorIntervalMs as number) ?? 15_000;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let taskMonitorTimer: ReturnType<typeof setInterval> | null = null;
    let parkMonitorTimer: ReturnType<typeof setInterval> | null = null;

    api.registerService({
      id: "chatroom-daemon",
      start: async () => {
        logger.info(
          `Chatroom daemon starting for agent=${agentId}, role=${cfg.role.toUpperCase()} (task protocol enabled)`,
        );

        try {
          updateHeartbeat(cfg);
        } catch (err) {
          logger.error(`[daemon] Initial heartbeat failed (NAS write issue?): ${err}`);
        }

        // Post-update version report
        try {
          const repoRoot = cfg.repoRoot ?? resolveGitRoot() ?? process.cwd();
          const marker = readAndClearSelfUpdateMarker(repoRoot);
          if (marker) {
            const newVersion = readProjectVersion(repoRoot);
            const commit = readProjectCommit(repoRoot);
            ensureUpgradeChannel(cfg);
            const prev = marker.previous_version;
            sendMessageToNAS(
              cfg,
              UPGRADE_CHANNEL_ID,
              `[${cfg.agentId}] Update complete, restarted. Version: v${prev} -> v${newVersion} (${commit})`,
              "STATUS_UPDATE",
            );
            logger.info(
              `[self-update] Post-restart report: v${prev} -> v${newVersion} (${commit})`,
            );
          }
        } catch (err) {
          logger.warn(`[self-update] Failed to send post-restart report: ${err}`);
        }

        heartbeatTimer = setInterval(() => {
          try {
            updateHeartbeat(cfg);
          } catch {
            /* ignore */
          }
        }, 30_000);

        logger.info(
          `[daemon] Inbox poll timer started (interval=${pollIntervalMs}ms, inbox=${path.join(chatroomRoot(cfg), "inbox", cfg.agentId)})`,
        );

        // Main inbox poll — routes messages by type
        const myDM = `dm_${cfg.agentId}`;
        let pollCycleCount = 0;
        let totalMsgProcessed = 0;
        const inboxDirForLog = path.join(chatroomRoot(cfg), "inbox", cfg.agentId);

        pollTimer = setInterval(async () => {
          pollCycleCount++;

          // Periodic health log every ~60s (at default 3s interval → every 20 cycles)
          if (pollCycleCount % 20 === 1) {
            const inboxExists = fs.existsSync(inboxDirForLog);
            let pendingFiles = 0;
            if (inboxExists) {
              try {
                pendingFiles = fs
                  .readdirSync(inboxDirForLog)
                  .filter((f) => f.endsWith(".json")).length;
              } catch {
                /* ignore */
              }
            }
            logger.info(
              `[poll] Health: cycle=${pollCycleCount}, processed=${totalMsgProcessed}, ` +
                `inbox=${inboxExists ? "OK" : "MISSING"}, pending=${pendingFiles}, ` +
                `path=${inboxDirForLog}`,
            );
          }

          try {
            const messages = pollInbox(cfg, logger);
            for (const msg of messages) {
              totalMsgProcessed++;
              try {
                // ── System command gate: self-update bypasses DM restriction ──
                if (isSelfUpdateCommand(msg)) {
                  if (isSelfUpdateAuthorized(msg)) {
                    await handleSelfUpdate(cfg, msg, logger);
                  } else {
                    logger.warn(
                      `[self-update] Unauthorized update request from ${msg.from}, ignoring`,
                    );
                  }
                  continue;
                }

                // ── Survival check gate: respond immediately without LLM ──
                if (isSurvivalCheckCommand(msg)) {
                  handleSurvivalCheck(cfg, msg, logger);
                  continue;
                }

                // ── #upgrade is a system-only channel — never forward to LLM ──
                if (msg.channel_id === UPGRADE_CHANNEL_ID) {
                  continue;
                }

                // ── #survival is a system-only channel — never forward to LLM ──
                if (msg.channel_id === SURVIVAL_CHANNEL_ID) {
                  continue;
                }

                // ── Hard gate: workers ONLY process their own DM channel ──
                if (cfg.role !== "orchestrator") {
                  if (msg.channel_id !== myDM) {
                    logger.info(
                      `[worker] Dropping message from #${msg.channel_id} (only DM allowed)`,
                    );
                    continue;
                  }
                }

                switch (msg.type) {
                  case "TASK_DISPATCH":
                    handleIncomingTask(cfg, msg, runtime, config, logger);
                    break;
                  case "TASK_ACK":
                    handleTaskAck(cfg, msg, logger);
                    break;
                  case "RESULT_REPORT":
                    handleTaskResult(cfg, msg, logger);
                    // Orchestrator: screen for sensitive operations before forwarding
                    if (cfg.role === "orchestrator") {
                      const screening = sensitivityPreFilter(msg.content.text);
                      if (screening) {
                        const taskId = msg.metadata?.task_id as string | undefined;
                        if (taskId && !matchesAllowlist(cfg, screening.type, screening.detail)) {
                          logger.warn(
                            `Sensitivity screening triggered for task ${taskId}: ${screening.label}`,
                          );
                          createPermissionRequest(
                            cfg,
                            taskId,
                            msg.from,
                            msg.channel_id,
                            screening.type,
                            screening.detail,
                            `Orchestrator screening: ${screening.label} detected in result from ${msg.from}`,
                            "",
                            `Review the agent's result report and decide on next steps.`,
                            logger,
                          );
                          break;
                        }
                      }
                    }
                    await autoDispatchMessage(cfg, msg, runtime, config, logger);
                    break;
                  default:
                    await autoDispatchMessage(cfg, msg, runtime, config, logger);
                    break;
                }
              } catch (err) {
                logger.error(`Message handling failed for ${msg.message_id}: ${err}`);
              }
            }
          } catch (err) {
            logger.error(`[poll] Poll cycle failed: ${err}`);
          }
        }, pollIntervalMs);

        // Task timeout / retry monitor (orchestrator only — workers don't dispatch tasks)
        if (cfg.role === "orchestrator") {
          taskMonitorTimer = setInterval(() => {
            try {
              monitorPendingTasks(cfg, logger);
            } catch {
              /* ignore */
            }
          }, taskMonitorIntervalMs);
        }

        // Park monitor — checks parked task conditions (all agents)
        parkMonitorTimer = setInterval(() => {
          try {
            monitorParkedTasks(cfg, runtime, config, logger);
          } catch {
            /* ignore */
          }
        }, parkMonitorIntervalMs);
      },
      stop: async () => {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (pollTimer) clearInterval(pollTimer);
        if (taskMonitorTimer) clearInterval(taskMonitorTimer);
        if (parkMonitorTimer) clearInterval(parkMonitorTimer);
        logger.info("Chatroom daemon stopped");
      },
    });
  },
};

export default agentChatroomPlugin;
