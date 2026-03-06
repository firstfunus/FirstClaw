/**
 * Agent Chatroom Plugin for the Firstclaw framework (OpenClaw)
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
import {
  createReplyPrefixContext,
  DEFAULT_TOOLS_FILENAME,
  type ReplyPayload,
  resolveDefaultAgentWorkspaceDir,
} from "firstclaw/plugin-sdk";
import { AsyncLocalStorage } from "node:async_hooks";
import { execSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import * as path from "node:path";

/** Current inbox message being processed; used so dispatch_task can read rag_free from the triggering message (programmatic, no LLM). */
const chatroomCurrentMessageStorage = new AsyncLocalStorage<{
  currentInboxMessage: InboxMessage;
}>();

// ============================================================================
// Types
// ============================================================================

interface ChatroomConfig {
  nasRoot: string;
  agentId: string;
  localDir: string;
  role: "orchestrator" | "worker";
  repoRoot: string | null;
  chatroomServerUrl?: string;
  ragServiceUrl?: string;
  /** Max worker task queue size (default 100). When full, new TASK_DISPATCH are dropped. */
  workerTaskQueueMaxSize?: number;
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
  | "DELIVERED"
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

type ResumeStrategy = "continue" | "restart" | "wait_and_check";

interface ExpectedDeliverables {
  required_extensions?: string[];
  exclude_extensions?: string[];
  description?: string;
}

/** Worker-confirmed deliverables (agreed in handshake). Orchestrator does not set this. */
interface AgreedDeliverables {
  work_summary?: string;
  description?: string;
  /** Each item = one expected file by extension. e.g. [{ extension: ".zip" }, { extension: ".zip" }] = 2 zips. */
  items: { extension: string }[];
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
  resume_strategy?: ResumeStrategy;
  expected_deliverables?: ExpectedDeliverables;
  /** Set by Worker via chatroom_confirm_deliverables; used for acceptance validation. Orchestrator does not set. */
  agreed_deliverables?: AgreedDeliverables | null;
  /** Set when status is PARKED; used to show how long the task has been waiting. */
  parked_at?: string | null;
  /** Last run context snapshot (for debugging context overflow / step end). Written by worker after each step. */
  run_context_snapshot?: RunContextSnapshot | null;
}

interface RunContextSnapshot {
  last_updated: string;
  step_order?: number;
  step_id?: string;
  success?: boolean;
  error_detail?: string | null;
  note?: string;
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
  is_final_deliverable: boolean;
  started_at: string | null;
  completed_at: string | null;
  error_detail: string | null;
  comments: StepComment[];
}

interface PlanApproval {
  mode: "orchestrator" | "human" | "autonomous";
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

/** Async read to avoid Node/libuv assertion in timer callbacks (e.g. uv_fs_close in readFileSync). */
async function readJsonAsync(filePath: string): Promise<any> {
  try {
    return JSON.parse(await readFile(filePath, "utf-8"));
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
    | "is_final_deliverable"
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
      is_final_deliverable: false,
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

/**
 * Convert an absolute NAS path to a path relative to the NAS root.
 * E.g. "/Volumes/Projects/chatroom/assets/art/task/file.png"
 *   → "chatroom/assets/art/task/file.png"
 * If the path is already relative or doesn't start with nasRoot, return as-is.
 */
function toNasRelativePath(cfg: ChatroomConfig, absPath: string): string {
  const nasRoot = toForwardSlash(cfg.nasRoot);
  const normalized = toForwardSlash(absPath);
  if (normalized.startsWith(nasRoot + "/")) {
    return normalized.slice(nasRoot.length + 1);
  }
  if (normalized.startsWith(nasRoot)) {
    return normalized.slice(nasRoot.length);
  }
  return normalized;
}

/**
 * Resolve a NAS-relative path back to an absolute path using this agent's NAS root.
 * E.g. "chatroom/assets/art/task/file.png"
 *   → "/Volumes/Projects/chatroom/assets/art/task/file.png"
 */
function fromNasRelativePath(cfg: ChatroomConfig, relPath: string): string {
  if (path.isAbsolute(relPath)) return relPath;
  return path.join(cfg.nasRoot, relPath);
}

// ============================================================================
// Chatroom URI Protocol — cross-machine asset path resolution
//
//   chatroom://assets/{agentId}/{taskId}/{filename}
//
// Every agent resolves this URI against its own NAS mount point.
// ============================================================================

const CHATROOM_URI_PREFIX = "chatroom://";

function isChatroomUri(s: string): boolean {
  return s.startsWith(CHATROOM_URI_PREFIX);
}

/**
 * Convert an absolute NAS path to a chatroom:// URI.
 * E.g. "/Volumes/Projects/chatroom/assets/art/task/file.png"
 *   → "chatroom://assets/art/task/file.png"
 */
function toChatroomUri(absPath: string, cfg: ChatroomConfig): string {
  const rel = toNasRelativePath(cfg, absPath);
  // Strip leading "chatroom/" if present since the URI scheme already implies it
  const stripped = rel.startsWith("chatroom/") ? rel.slice("chatroom/".length) : rel;
  return `${CHATROOM_URI_PREFIX}${stripped}`;
}

/**
 * Resolve a chatroom:// URI (or legacy path) to an absolute local path.
 * Accepts:
 *   - "chatroom://assets/art/task/file.png"  → "{nasRoot}/chatroom/assets/art/task/file.png"
 *   - "chatroom/assets/art/task/file.png"    → "{nasRoot}/chatroom/assets/art/task/file.png"  (legacy relative)
 *   - "/Volumes/Projects/chatroom/..."       → as-is  (legacy absolute)
 */
function fromChatroomUri(uri: string, cfg: ChatroomConfig): string {
  if (uri.startsWith(CHATROOM_URI_PREFIX)) {
    const relPart = uri.slice(CHATROOM_URI_PREFIX.length);
    return path.join(cfg.nasRoot, "chatroom", relPart);
  }
  return fromNasRelativePath(cfg, uri);
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
// NAS Health Monitor — state machine: ONLINE → DEGRADED → OFFLINE
// ============================================================================

type NasHealthState = "ONLINE" | "DEGRADED" | "OFFLINE";

interface NasHealthMonitor {
  state: NasHealthState;
  consecutiveFailures: number;
  lastCheckTime: string;
  offlineSince: string | null;
  timer: ReturnType<typeof setInterval> | null;
  listeners: Array<(state: NasHealthState, prev: NasHealthState) => void>;
}

const DEGRADED_THRESHOLD = 1;
const OFFLINE_THRESHOLD = 3;
const NAS_CHECK_INTERVAL_MS = 5_000;
const MAX_OFFLINE_BUFFER_MINUTES = 30;

let _nasHealth: NasHealthMonitor = {
  state: "ONLINE",
  consecutiveFailures: 0,
  lastCheckTime: "",
  offlineSince: null,
  timer: null,
  listeners: [],
};

function isNasOnline(): boolean {
  return _nasHealth.state === "ONLINE";
}

function getNasHealthState(): NasHealthState {
  return _nasHealth.state;
}

function nasOfflineDurationMs(): number {
  if (!_nasHealth.offlineSince) return 0;
  return Date.now() - new Date(_nasHealth.offlineSince).getTime();
}

function isNasBufferExpired(): boolean {
  return nasOfflineDurationMs() > MAX_OFFLINE_BUFFER_MINUTES * 60_000;
}

function onNasStateChange(cb: (state: NasHealthState, prev: NasHealthState) => void): void {
  _nasHealth.listeners.push(cb);
}

function checkNasAccess(nasRoot: string): boolean {
  try {
    fs.accessSync(nasRoot, fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function startNasHealthMonitor(cfg: ChatroomConfig, logger: Logger): void {
  if (_nasHealth.timer) return;

  const doCheck = () => {
    const ok = checkNasAccess(cfg.nasRoot);
    const prev = _nasHealth.state;
    _nasHealth.lastCheckTime = nowISO();

    if (ok) {
      _nasHealth.consecutiveFailures = 0;
      if (prev !== "ONLINE") {
        _nasHealth.state = "ONLINE";
        _nasHealth.offlineSince = null;
        logger.info(`[nas-health] NAS recovered → ONLINE`);
        for (const cb of _nasHealth.listeners) {
          try {
            cb("ONLINE", prev);
          } catch {
            /* ignore */
          }
        }
      }
    } else {
      _nasHealth.consecutiveFailures++;
      let newState: NasHealthState;
      if (_nasHealth.consecutiveFailures >= OFFLINE_THRESHOLD) {
        newState = "OFFLINE";
      } else if (_nasHealth.consecutiveFailures >= DEGRADED_THRESHOLD) {
        newState = "DEGRADED";
      } else {
        newState = prev;
      }
      if (newState !== prev) {
        _nasHealth.state = newState;
        if (newState === "OFFLINE" && !_nasHealth.offlineSince) {
          _nasHealth.offlineSince = nowISO();
        }
        logger.warn(
          `[nas-health] NAS state: ${prev} → ${newState} (failures: ${_nasHealth.consecutiveFailures})`,
        );
        for (const cb of _nasHealth.listeners) {
          try {
            cb(newState, prev);
          } catch {
            /* ignore */
          }
        }
      }
    }
  };

  doCheck();
  _nasHealth.timer = setInterval(doCheck, NAS_CHECK_INTERVAL_MS);
  logger.info(`[nas-health] Monitor started (check every ${NAS_CHECK_INTERVAL_MS / 1000}s)`);
}

function stopNasHealthMonitor(): void {
  if (_nasHealth.timer) {
    clearInterval(_nasHealth.timer);
    _nasHealth.timer = null;
  }
}

// ============================================================================
// Write-Ahead Log (WAL) + Local Staging
// ============================================================================

interface WalEntry {
  id: string;
  timestamp: string;
  op: "FILE_COPY" | "FILE_WRITE" | "JSON_WRITE" | "MESSAGE_SEND" | "TASK_UPDATE" | "INBOX_NOTIFY";
  localPath: string;
  nasPath: string;
  metadata?: Record<string, unknown>;
  status: "pending" | "synced" | "failed";
  retries: number;
}

function walPath(cfg: ChatroomConfig): string {
  return path.join(cfg.localDir, "wal.jsonl");
}

function stagedDir(cfg: ChatroomConfig): string {
  return path.join(cfg.localDir, "staged");
}

function appendWal(
  cfg: ChatroomConfig,
  entry: Omit<WalEntry, "id" | "timestamp" | "status" | "retries">,
): WalEntry {
  const full: WalEntry = {
    id: randomUUID(),
    timestamp: nowISO(),
    status: "pending",
    retries: 0,
    ...entry,
  };
  const walFile = walPath(cfg);
  ensureDir(path.dirname(walFile));
  fs.appendFileSync(walFile, JSON.stringify(full) + "\n", "utf-8");
  return full;
}

function readWal(cfg: ChatroomConfig): WalEntry[] {
  const walFile = walPath(cfg);
  if (!fs.existsSync(walFile)) return [];
  const lines = fs.readFileSync(walFile, "utf-8").split("\n").filter(Boolean);
  return lines.map((l) => JSON.parse(l) as WalEntry);
}

function rewriteWal(cfg: ChatroomConfig, entries: WalEntry[]): void {
  const walFile = walPath(cfg);
  ensureDir(path.dirname(walFile));
  fs.writeFileSync(walFile, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
}

function stagedPathFor(cfg: ChatroomConfig, chatroomUri: string): string {
  const rel = chatroomUri.startsWith(CHATROOM_URI_PREFIX)
    ? chatroomUri.slice(CHATROOM_URI_PREFIX.length)
    : chatroomUri;
  return path.join(stagedDir(cfg), rel);
}

// ── NAS-aware write primitives ──────────────────────────────────────────────

function nasWriteFile(cfg: ChatroomConfig, absNasPath: string, data: Buffer | string): void {
  if (isNasOnline()) {
    ensureDir(path.dirname(absNasPath));
    fs.writeFileSync(absNasPath, data);
  } else {
    const uri = toChatroomUri(absNasPath, cfg);
    const staged = stagedPathFor(cfg, uri);
    ensureDir(path.dirname(staged));
    fs.writeFileSync(staged, data);
    appendWal(cfg, { op: "FILE_WRITE", localPath: staged, nasPath: uri });
  }
}

function nasCopyFile(cfg: ChatroomConfig, sourcePath: string, absNasDest: string): void {
  if (isNasOnline()) {
    ensureDir(path.dirname(absNasDest));
    fs.copyFileSync(sourcePath, absNasDest);
  } else {
    const uri = toChatroomUri(absNasDest, cfg);
    const staged = stagedPathFor(cfg, uri);
    ensureDir(path.dirname(staged));
    fs.copyFileSync(sourcePath, staged);
    appendWal(cfg, { op: "FILE_COPY", localPath: staged, nasPath: uri });
  }
}

function nasWriteJson(cfg: ChatroomConfig, absNasPath: string, data: any): void {
  const content = JSON.stringify(data, null, 2);
  if (isNasOnline()) {
    ensureDir(path.dirname(absNasPath));
    fs.writeFileSync(absNasPath, content, "utf-8");
  } else {
    const uri = toChatroomUri(absNasPath, cfg);
    const staged = stagedPathFor(cfg, uri);
    ensureDir(path.dirname(staged));
    fs.writeFileSync(staged, content, "utf-8");
    appendWal(cfg, { op: "JSON_WRITE", localPath: staged, nasPath: uri });
  }
}

// ============================================================================
// Sync Manager — replays WAL entries when NAS recovers
// ============================================================================

const WAL_MAX_RETRIES = 3;

function syncWalEntries(cfg: ChatroomConfig, logger: Logger): void {
  const entries = readWal(cfg);
  const pending = entries.filter((e) => e.status === "pending");
  if (pending.length === 0) return;

  logger.info(`[sync] Replaying ${pending.length} WAL entries...`);

  // Sort by timestamp to maintain causal order
  pending.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  let synced = 0;
  let failed = 0;

  for (const entry of pending) {
    try {
      switch (entry.op) {
        case "FILE_COPY":
        case "FILE_WRITE":
        case "JSON_WRITE": {
          const dest = fromChatroomUri(entry.nasPath, cfg);
          // Conflict detection: if NAS file exists and is newer, skip
          if (fs.existsSync(dest)) {
            try {
              const nasMtime = fs.statSync(dest).mtimeMs;
              const entryTime = new Date(entry.timestamp).getTime();
              if (nasMtime > entryTime) {
                logger.info(`[sync] Skipped ${entry.id} — NAS file is newer`);
                entry.status = "synced";
                synced++;
                continue;
              }
            } catch {
              /* proceed with copy */
            }
          }
          ensureDir(path.dirname(dest));
          fs.copyFileSync(entry.localPath, dest);
          entry.status = "synced";
          synced++;
          break;
        }

        case "MESSAGE_SEND": {
          // Re-send the buffered message through the normal NAS path.
          // The message was serialised to staged; read and write to NAS.
          const msgData = readJson(entry.localPath);
          if (!msgData) {
            entry.status = "failed";
            failed++;
            break;
          }
          const channelId = msgData.channel_id as string;
          const root = chatroomRoot(cfg);
          const chDir = path.join(root, "channels", channelId);
          const msgDir = path.join(chDir, "messages");
          const metaPath = path.join(chDir, "meta.json");
          const lockPath = path.join(chDir, ".lock");

          ensureDir(msgDir);
          if (acquireLock(lockPath, cfg.agentId)) {
            try {
              const meta = readJson(metaPath) ?? { last_message_seq: 0, message_count: 0 };
              const seq = (meta.last_message_seq ?? 0) + 1;
              msgData.seq = seq;
              const ts = (msgData.timestamp as string) ?? "";
              const tsCompact = ts.replace(/[-:]/g, "").replace(/\.\d+/, "").replace("T", "T");
              const filename = `${String(seq).padStart(6, "0")}_${tsCompact}_${msgData.message_id}.json`;
              writeJson(path.join(msgDir, filename), msgData);
              meta.last_message_seq = seq;
              meta.message_count = (meta.message_count ?? 0) + 1;
              writeJson(metaPath, meta);

              // Send inbox notifications for buffered messages
              const members: string[] = meta.members ?? [];
              const mentions: string[] = (entry.metadata?.mentions as string[]) ?? [];
              const notifySet = new Set(members);
              for (const m of mentions) notifySet.add(m);
              notifySet.delete(cfg.agentId);
              for (const target of notifySet) {
                const isMentioned = mentions.includes(target);
                const inboxDir = path.join(root, "inbox", target);
                ensureDir(inboxDir);
                const notif = {
                  notification_id: randomUUID(),
                  timestamp: msgData.timestamp,
                  channel_id: channelId,
                  message_seq: seq,
                  from: cfg.agentId,
                  preview: ((msgData.content as any)?.text ?? "").slice(0, 120),
                  priority: isMentioned ? "high" : "normal",
                  mentioned: isMentioned,
                };
                writeJson(
                  path.join(
                    inboxDir,
                    `${String(seq).padStart(6, "0")}_${notif.notification_id}.json`,
                  ),
                  notif,
                );
              }

              entry.status = "synced";
              synced++;
            } finally {
              releaseLock(lockPath);
            }
          } else {
            entry.retries++;
            failed++;
          }
          break;
        }

        case "TASK_UPDATE": {
          const dest = fromChatroomUri(entry.nasPath, cfg);
          const patch = readJson(entry.localPath);
          if (!patch) {
            entry.status = "failed";
            failed++;
            break;
          }
          const existing = readJson(dest);
          if (existing) {
            writeJson(dest, { ...existing, ...patch });
          } else {
            ensureDir(path.dirname(dest));
            writeJson(dest, patch);
          }
          entry.status = "synced";
          synced++;
          break;
        }

        case "INBOX_NOTIFY": {
          const dest = fromChatroomUri(entry.nasPath, cfg);
          ensureDir(path.dirname(dest));
          fs.copyFileSync(entry.localPath, dest);
          entry.status = "synced";
          synced++;
          break;
        }
      }
    } catch (err) {
      entry.retries++;
      if (entry.retries >= WAL_MAX_RETRIES) {
        entry.status = "failed";
        logger.error(
          `[sync] WAL entry ${entry.id} failed permanently after ${WAL_MAX_RETRIES} retries: ${err}`,
        );
      } else {
        logger.warn(
          `[sync] WAL entry ${entry.id} failed (retry ${entry.retries}/${WAL_MAX_RETRIES}): ${err}`,
        );
      }
      failed++;
    }
  }

  // Rewrite WAL, removing synced entries. Keep failed for inspection.
  const remaining = entries.filter((e) => e.status !== "synced");
  if (remaining.length === 0) {
    try {
      fs.unlinkSync(walPath(cfg));
    } catch {
      /* ignore */
    }
  } else {
    rewriteWal(cfg, remaining);
  }

  // Clean up staged files for synced entries
  for (const entry of pending) {
    if (entry.status === "synced") {
      try {
        fs.unlinkSync(entry.localPath);
      } catch {
        /* ignore */
      }
    }
  }

  logger.info(
    `[sync] WAL replay complete: ${synced} synced, ${failed} failed, ${remaining.length} remaining`,
  );
}

// ============================================================================
// Resume strategy — applied when NAS comes back online
// ============================================================================

function applyResumeStrategies(cfg: ChatroomConfig, logger: Logger): void {
  const dir = tasksDir(cfg);
  if (!fs.existsSync(dir)) return;

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    const task = readJson(path.join(dir, file)) as TaskRecord | null;
    if (!task) continue;
    if (task.current_phase !== "nas_offline_buffering") continue;

    const strategy = task.resume_strategy ?? "restart";
    logger.info(`[resume] Task ${task.task_id} (${task.to}): applying strategy "${strategy}"`);

    switch (strategy) {
      case "continue":
        // Simply update the phase — the agent's LLM session can continue from
        // where it left off since files were buffered locally and now synced.
        updateTaskRecord(cfg, task.task_id, { current_phase: "resumed_after_offline" });
        appendTaskProgress(cfg, task.task_id, {
          phase: "resumed_after_offline",
          detail: "NAS recovered; continuing from buffered state",
        });
        break;

      case "wait_and_check":
        // The external process (e.g. CI build) may still be running.
        // Mark as waiting and let the park monitor or next poll handle it.
        updateTaskRecord(cfg, task.task_id, { current_phase: "checking_external" });
        appendTaskProgress(cfg, task.task_id, {
          phase: "checking_external",
          detail: "NAS recovered; checking if external process completed during offline period",
        });
        break;

      case "restart":
      default:
        // Task needs a full restart — mark failed so the retry system handles it
        updateTaskRecord(cfg, task.task_id, {
          status: "FAILED",
          current_phase: "restart_after_offline",
          error_type: "TOOL_ERROR",
          error_detail: "NAS was offline during task execution; restarting per resume_strategy",
          completed_at: nowISO(),
        });
        appendTaskProgress(cfg, task.task_id, {
          phase: "restart_after_offline",
          detail: "NAS recovered; task will be retried from the beginning",
        });
        break;
    }
  }
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
 *
 * When *nasCfg* is provided and NAS is offline, the file is staged locally
 * and a WAL entry is created for later sync.
 */
function publishFileToNAS(
  sourcePath: string,
  destDir: string,
  filename?: string,
  nasCfg?: ChatroomConfig,
): PublishResult {
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
  const destPath = toForwardSlash(path.join(destDir, targetName));
  const sourceMd5 = md5File(sourcePath);

  if (nasCfg && !isNasOnline()) {
    const uri = toChatroomUri(destPath, nasCfg);
    const staged = stagedPathFor(nasCfg, uri);
    ensureDir(path.dirname(staged));
    fs.copyFileSync(sourcePath, staged);
    appendWal(nasCfg, { op: "FILE_COPY", localPath: staged, nasPath: uri });
    return {
      nasPath: destPath,
      sourceSize: stat.size,
      destSize: stat.size,
      md5: sourceMd5,
      verified: true,
    };
  }

  ensureDir(destDir);
  fs.copyFileSync(sourcePath, destPath);

  const destStat = fs.statSync(destPath);
  const destMd5 = md5File(destPath);

  if (destStat.size !== stat.size || destMd5 !== sourceMd5) {
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

/** Async version for use in timer callback path (avoids readFileSync/libuv assertion). */
async function readAgentRegistryAsync(cfg: ChatroomConfig): Promise<AgentRegistryEntry[]> {
  const regDir = path.join(chatroomRoot(cfg), "registry");
  if (!fs.existsSync(regDir)) return [];
  const agents: AgentRegistryEntry[] = [];
  const files = await readdir(regDir);
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const data = await readJsonAsync(path.join(regDir, file));
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
  const messageId = randomUUID();
  const timestamp = nowISO();
  const tsCompact = timestamp.replace(/[-:]/g, "").replace(/\.\d+/, "").replace("T", "T");

  // When NAS is offline, buffer the entire message to WAL for later replay
  if (!isNasOnline()) {
    const seq = 0;
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
    const staged = path.join(stagedDir(cfg), "messages", `${messageId}.json`);
    ensureDir(path.dirname(staged));
    fs.writeFileSync(staged, JSON.stringify(msg, null, 2), "utf-8");
    appendWal(cfg, {
      op: "MESSAGE_SEND",
      localPath: staged,
      nasPath: `chatroom://channels/${channelId}/messages/${messageId}.json`,
      metadata: { channel_id: channelId, mentions },
    });
    return { message_id: messageId, seq };
  }

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

/** Async version for use in timer callback path (avoids readFileSync/libuv assertion). */
async function listAgentChannelsAsync(cfg: ChatroomConfig): Promise<any[]> {
  const indexPath = path.join(chatroomRoot(cfg), "channels", "_index.json");
  const idx = await readJsonAsync(indexPath);
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
      // be routed (e.g. as a TASK_DISPATCH retry). Task file must live in shared tasksDir (same NAS root as orchestrator).
      if (!resolved && notif.retry_for_task) {
        const taskPath = path.join(tasksDir(cfg), `${notif.retry_for_task}.json`);
        const taskData = readJson(taskPath);
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
                ? toChatroomUri(
                    path.dirname(
                      isChatroomUri(taskData.asset_paths[0])
                        ? fromChatroomUri(taskData.asset_paths[0], cfg)
                        : fromNasRelativePath(cfg, taskData.asset_paths[0]),
                    ),
                    cfg,
                  )
                : toChatroomUri(taskAssetsDir(cfg, cfg.agentId, notif.retry_for_task), cfg),
              is_retry: true,
            },
          });
          resolved = true;
        } else {
          const tasksDirAbs = path.resolve(tasksDir(cfg));
          logger?.warn(
            `[pollInbox] Retry notification for task ${notif.retry_for_task} could not resolve: task file not found. ` +
              `Attempted path: ${path.resolve(taskPath)}. Worker tasksDir: ${tasksDirAbs}. ` +
              "Ensure orchestrator and worker share the same NAS root (tasks dir). Leaving notification file for retry.",
          );
          // Do not delete the file so it can be retried or inspected
          continue;
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
// Worker task queue — serialize TASK_DISPATCH so only one task runs at a time
// ============================================================================

const WORKER_TASK_QUEUE_MAX_SIZE = 100;

type WorkerTaskQueueEntry = {
  msg: InboxMessage;
  cfg: ChatroomConfig;
  runtime: any;
  config: any;
  logger: Logger;
};

const workerTaskQueue: WorkerTaskQueueEntry[] = [];
let currentTaskPromise: Promise<void> | null = null;
/** Set by daemon start; used to log "queue drained" when the last task completes. */
let workerQueueLogger: Logger | null = null;

function tryDrainWorkerTaskQueue(): void {
  if (currentTaskPromise != null || workerTaskQueue.length === 0) return;
  const entry = workerTaskQueue.shift()!;
  entry.logger.info(
    `[chatroom] worker task started from queue (depth was ${workerTaskQueue.length + 1})`,
  );
  currentTaskPromise = handleIncomingTaskAsync(
    entry.cfg,
    entry.msg,
    entry.runtime,
    entry.config,
    entry.logger,
  );
  currentTaskPromise.finally(() => {
    currentTaskPromise = null;
    if (workerTaskQueue.length === 0 && workerQueueLogger) {
      workerQueueLogger.info("[chatroom] worker task queue drained");
    }
    tryDrainWorkerTaskQueue();
  });
}

// ============================================================================
// Task Registry — persistent task state on NAS
// ============================================================================

function createTaskRecord(
  cfg: ChatroomConfig,
  to: string,
  channelId: string,
  instruction: string,
  opts?: {
    ackTimeoutMs?: number;
    taskTimeoutMs?: number;
    maxRetries?: number;
    resumeStrategy?: ResumeStrategy;
  },
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
    resume_strategy: getResumeStrategy(to, opts?.resumeStrategy),
    // Orchestrator does not set expected_deliverables; Worker confirms via agreed_deliverables.
  };

  writeJson(path.join(dir, `${task.task_id}.json`), task);
  return task;
}

function readTaskRecord(cfg: ChatroomConfig, taskId: string): TaskRecord | null {
  return readJson(path.join(tasksDir(cfg), `${taskId}.json`));
}

function updateTaskRecord(cfg: ChatroomConfig, taskId: string, patch: Partial<TaskRecord>): void {
  const filePath = path.join(tasksDir(cfg), `${taskId}.json`);

  if (!isNasOnline()) {
    const staged = stagedPathFor(cfg, toChatroomUri(filePath, cfg));
    ensureDir(path.dirname(staged));
    // Write patch so Sync Manager can apply it later
    fs.writeFileSync(staged, JSON.stringify(patch, null, 2), "utf-8");
    appendWal(cfg, {
      op: "TASK_UPDATE",
      localPath: staged,
      nasPath: toChatroomUri(filePath, cfg),
      metadata: { task_id: taskId },
    });
    return;
  }

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

/** Async version to avoid readFileSync in timer callbacks (Node/libuv assertion). */
async function listTasksByStatusAsync(
  cfg: ChatroomConfig,
  ...statuses: TaskStatus[]
): Promise<TaskRecord[]> {
  const dir = tasksDir(cfg);
  if (!fs.existsSync(dir)) return [];

  const statusSet = new Set(statuses);
  const tasks: TaskRecord[] = [];
  const files = await readdir(dir);
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const task = (await readJsonAsync(path.join(dir, file))) as TaskRecord | null;
    if (task && statusSet.has(task.status)) tasks.push(task);
  }
  return tasks;
}

// ============================================================================
// Task Protocol: dispatch, ACK, result (TCP-style reliable handshake)
// ============================================================================

/**
 * Validates that a message's identity fields match the expected recipient.
 * Returns true if valid, false if the message should be rejected.
 */
function validateMessageIdentity(cfg: ChatroomConfig, msg: InboxMessage, logger: Logger): boolean {
  const meta = msg.metadata ?? {};
  const toAgent = meta.to_agent_id;
  if (toAgent && toAgent !== cfg.agentId) {
    logger.warn(
      `[identity] Rejecting message ${msg.message_id}: to_agent_id="${toAgent}" does not match self="${cfg.agentId}"`,
    );
    return false;
  }
  return true;
}

// ── Per-agent expected deliverable defaults ─────────────────────────────────

const AGENT_DEFAULT_DELIVERABLES: Record<string, ExpectedDeliverables> = {
  art: {
    required_extensions: [".png", ".jpg", ".jpeg", ".webp", ".psd", ".tiff", ".svg"],
    exclude_extensions: [".md", ".txt"],
    description: "image/visual asset files",
  },
  audio: {
    required_extensions: [".wav", ".mp3", ".ogg", ".flac", ".aac", ".m4a"],
    exclude_extensions: [".md", ".txt"],
    description: "audio files",
  },
  git: {
    required_extensions: [".zip", ".tar", ".gz"],
    description: "build artifacts / packages",
  },
};

function inferExpectedDeliverables(
  agentId: string,
  instruction: string,
  explicit?: ExpectedDeliverables,
): ExpectedDeliverables | undefined {
  if (explicit) return explicit;
  const defaults = AGENT_DEFAULT_DELIVERABLES[agentId];
  if (defaults) return defaults;
  // Infer from instruction keywords
  const lower = instruction.toLowerCase();
  const wantsVisual =
    ["generate", "render", "create", "draw", "produce", "design"].some((k) => lower.includes(k)) &&
    ["image", "picture", "sprite", "icon", "texture", "render", "photo", "illustration"].some((k) =>
      lower.includes(k),
    );
  if (wantsVisual) {
    return {
      required_extensions: [".png", ".jpg", ".jpeg", ".webp", ".psd", ".svg"],
      exclude_extensions: [".md", ".txt"],
      description: "image/visual asset files",
    };
  }
  return undefined;
}

const AGENT_DEFAULT_RESUME_STRATEGY: Record<string, ResumeStrategy> = {
  art: "continue",
  audio: "continue",
  git: "wait_and_check",
  ux: "continue",
};

function getResumeStrategy(agentId: string, explicit?: ResumeStrategy): ResumeStrategy {
  if (explicit) return explicit;
  return AGENT_DEFAULT_RESUME_STRATEGY[agentId] ?? "restart";
}

function dispatchTask(
  cfg: ChatroomConfig,
  to: string,
  instruction: string,
  logger: Logger,
  opts?: {
    ackTimeoutMs?: number;
    taskTimeoutMs?: number;
    maxRetries?: number;
    longRunning?: boolean;
    humanApprovalRequired?: boolean;
    ragFree?: boolean;
    resumeStrategy?: ResumeStrategy;
  },
): TaskRecord {
  const channelId = `dm_${to}`;
  const task = createTaskRecord(cfg, to, channelId, instruction, opts);

  const outputDir = taskAssetsDir(cfg, to, task.task_id);
  ensureDir(outputDir);
  const outputDirUri = toChatroomUri(outputDir, cfg);

  const identityToken = randomUUID();
  const sessionNonce = randomUUID();

  sendMessageToNAS(cfg, channelId, instruction, "TASK_DISPATCH", [to], undefined, {
    task_id: task.task_id,
    priority: "urgent",
    output_dir: outputDirUri,
    task_timeout_ms: task.task_timeout_ms,
    long_running: opts?.longRunning ?? false,
    from_agent_id: cfg.agentId,
    to_agent_id: to,
    agent_identity_token: identityToken,
    session_nonce: sessionNonce,
    human_approval_required: opts?.humanApprovalRequired ?? false,
    rag_free: opts?.ragFree ?? false,
    resume_strategy: task.resume_strategy,
    // Orchestrator does not send expected_deliverables; Worker confirms deliverables in handshake.
  });

  updateTaskRecord(cfg, task.task_id, {
    identity_token: identityToken,
    session_nonce: sessionNonce,
  } as any);

  logger.info(
    `Task ${task.task_id} dispatched to ${to} via #${channelId} (token: ${identityToken.slice(0, 8)}...)`,
  );
  return task;
}

function sendSystemAck(
  cfg: ChatroomConfig,
  task: TaskRecord,
  logger: Logger,
  identityToken?: string,
  sessionNonce?: string,
): void {
  const ackText = `[SYSTEM] Task ${task.task_id} acknowledged by ${cfg.agentId}`;
  sendMessageToNAS(cfg, task.channel_id, ackText, "TASK_ACK", [task.from], undefined, {
    task_id: task.task_id,
    from_agent_id: cfg.agentId,
    to_agent_id: task.from,
    agent_identity_token: identityToken,
    session_nonce: sessionNonce,
  });
  updateTaskRecord(cfg, task.task_id, { status: "ACKED", acked_at: nowISO() });
  logger.info(
    `ACK sent for task ${task.task_id} → ${task.from} (token echo: ${identityToken?.slice(0, 8) ?? "none"})`,
  );
}

/**
 * Filter asset paths: when agreed_deliverables exists use it (extension + count);
 * when legacy expected_deliverables exists use it; otherwise all paths are deliverables.
 */
function filterDeliverables(
  allPaths: string[],
  task: TaskRecord,
  logger: Logger,
  taskId: string,
): { deliverables: string[]; intermediates: string[] } {
  const agreed = task.agreed_deliverables;
  if (agreed?.items?.length) {
    const byExt = new Map<string, string[]>();
    for (const p of allPaths) {
      const ext = path.extname(p).toLowerCase();
      if (!byExt.has(ext)) byExt.set(ext, []);
      byExt.get(ext)!.push(p);
    }
    const deliverables: string[] = [];
    for (const item of agreed.items) {
      const ext = item.extension.startsWith(".")
        ? item.extension.toLowerCase()
        : `.${item.extension}`.toLowerCase();
      const list = byExt.get(ext);
      if (list?.length) {
        deliverables.push(list.shift()!);
      }
    }
    const used = new Set(deliverables);
    const intermediates = allPaths.filter((p) => !used.has(p));
    if (intermediates.length > 0) {
      logger.info(
        `[delivery] Task ${taskId}: filtered ${intermediates.length} intermediate file(s) from deliverables`,
      );
    }
    return { deliverables, intermediates };
  }

  const expected = task.expected_deliverables;
  if (!expected) return { deliverables: allPaths, intermediates: [] };

  const deliverables: string[] = [];
  const intermediates: string[] = [];
  for (const p of allPaths) {
    const ext = path.extname(p).toLowerCase();
    if (expected.exclude_extensions?.includes(ext)) {
      intermediates.push(p);
      continue;
    }
    deliverables.push(p);
  }
  if (expected.required_extensions?.length) {
    const hasRequired = deliverables.some((p) =>
      expected.required_extensions!.includes(path.extname(p).toLowerCase()),
    );
    if (!hasRequired && deliverables.length > 0) {
      logger.warn(
        `[delivery] Task ${taskId}: no files matching required extensions ${expected.required_extensions.join(",")}`,
      );
    }
  }
  if (intermediates.length > 0) {
    logger.info(
      `[delivery] Task ${taskId}: filtered ${intermediates.length} intermediate file(s) from deliverables: ` +
        intermediates.map((p) => path.basename(p)).join(", "),
    );
  }
  return { deliverables, intermediates };
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

  // Programmatic filter: use agreed_deliverables when set, else legacy expected_deliverables, else all
  const { deliverables } = filterDeliverables(assetPaths, task, logger, taskId);
  const uriAssetPaths = deliverables.map((p) => toChatroomUri(p, cfg));

  // Workers send DELIVERED (not DONE). Only the orchestrator can close a task after review.
  const reportStatus = status === "DONE" ? "DELIVERED" : status;

  // Append file listing to result text so it's always visible
  let enrichedText = resultText;
  if (uriAssetPaths.length > 0) {
    enrichedText +=
      `\n\n📂 Output files (${uriAssetPaths.length}):\n` +
      uriAssetPaths.map((p) => `  • ${p}`).join("\n");
  }

  sendMessageToNAS(cfg, task.channel_id, enrichedText, "RESULT_REPORT", [task.from], undefined, {
    task_id: taskId,
    status: reportStatus,
    asset_paths: uriAssetPaths,
    error_type: errorType ?? undefined,
  });
  const patch: Partial<TaskRecord> = {
    status: reportStatus as TaskStatus,
    completed_at: status === "FAILED" ? nowISO() : null,
    result_summary: enrichedText.slice(0, 500),
    asset_paths: uriAssetPaths,
  };
  if (errorType) {
    patch.error_type = errorType;
  }
  // Always persist failure detail for debugging (frontend shows this in Failed task modal)
  if (status === "FAILED") {
    patch.error_detail = resultText.slice(0, 2000);
  }
  patch.current_phase = status === "FAILED" ? "failed" : "delivered";
  updateTaskRecord(cfg, taskId, patch);
  resetAgentStatus(cfg, task.to, logger);
  logger.info(
    `Result DELIVERED for task ${taskId} (${reportStatus}${errorType ? ` [${errorType}]` : ""}) → ${task.from}`,
  );
}

/**
 * Validate that delivered asset_paths match agreed_deliverables and files exist with content.
 * Used by chatroom_close_task(verdict="accepted").
 */
function validateDeliveryForAcceptance(
  cfg: ChatroomConfig,
  task: TaskRecord,
  logger: Logger,
): { ok: true } | { ok: false; reason: string } {
  // Never accept tasks that ended with context overflow or rate limit — they are failed, not delivered.
  const errType = task.error_type;
  if (errType === "CONTEXT_OVERFLOW" || errType === "RATE_LIMITED") {
    return {
      ok: false,
      reason: `Task ended with error (${errType}). Cannot accept; treat as failed. Worker should have reported FAILED, not DELIVERED.`,
    };
  }
  const agreed = task.agreed_deliverables;
  if (!agreed?.items?.length) {
    return {
      ok: false,
      reason:
        "No agreed deliverables on this task. The worker must call chatroom_confirm_deliverables before planning; acceptance cannot proceed without an agreement.",
    };
  }
  const paths = task.asset_paths ?? [];
  if (paths.length === 0) {
    return {
      ok: false,
      reason: "No files delivered. The worker must attach the agreed deliverables.",
    };
  }
  const expectedByExt = new Map<string, number>();
  for (const item of agreed.items) {
    const ext = item.extension.startsWith(".")
      ? item.extension.toLowerCase()
      : `.${item.extension}`.toLowerCase();
    expectedByExt.set(ext, (expectedByExt.get(ext) ?? 0) + 1);
  }
  const deliveredByExt = new Map<string, string[]>();
  for (const uri of paths) {
    const ext = path.extname(uri).toLowerCase();
    if (!deliveredByExt.has(ext)) deliveredByExt.set(ext, []);
    deliveredByExt.get(ext)!.push(uri);
  }
  for (const [ext, count] of expectedByExt) {
    const list = deliveredByExt.get(ext) ?? [];
    if (list.length !== count) {
      return {
        ok: false,
        reason: `Agreed deliverables require exactly ${count} file(s) with extension ${ext}, but ${list.length} delivered.`,
      };
    }
  }
  for (const ext of deliveredByExt.keys()) {
    if (!expectedByExt.has(ext)) {
      return {
        ok: false,
        reason: `Delivered file(s) with extension ${ext} were not in the agreed deliverables.`,
      };
    }
  }
  for (const uri of paths) {
    try {
      const localPath = fromChatroomUri(uri, cfg);
      if (!fs.existsSync(localPath)) {
        return { ok: false, reason: `File not found: ${uri} (resolved to ${localPath}).` };
      }
      const stat = fs.statSync(localPath);
      if (!stat.isFile() || stat.size <= 0) {
        return { ok: false, reason: `File empty or not a file: ${uri}.` };
      }
    } catch (err) {
      return { ok: false, reason: `Cannot validate file ${uri}: ${err}.` };
    }
  }
  return { ok: true };
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

/** True for transient LLM output errors (e.g. truncated JSON) where one retry may succeed. */
function isRetryableStepError(errMsg: string): boolean {
  const lower = errMsg.toLowerCase();
  return (
    /unterminated string in json/i.test(errMsg) ||
    /(?:unexpected end of|invalid) json/i.test(errMsg) ||
    /json\.parse/i.test(errMsg) ||
    (lower.includes("json") && (lower.includes("position") || lower.includes("syntax")))
  );
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

// --- Logging helpers: tool name extraction & secret redaction ----------------

const _SECRET_PATTERNS: RegExp[] = [
  /(?:api[_-]?key|apikey)\s*[:=]\s*\S+/gi,
  /(?:secret|token|password|passwd|pwd)\s*[:=]\s*\S+/gi,
  /Bearer\s+\S+/g,
  /sk-[a-zA-Z0-9]{20,}/g,
];

function _redactDetail(text: string): string {
  let result = text;
  for (const pat of _SECRET_PATTERNS) {
    result = result.replace(pat, "[REDACTED]");
  }
  return result;
}

function _extractToolName(payload: ReplyPayload): string {
  const explicit = (payload as Record<string, unknown>).toolName;
  if (explicit && typeof explicit === "string") return explicit;
  const text = payload.text ?? "";
  // formatToolAggregate output starts with "<emoji> <ToolLabel>: ..."
  const m = text.match(/^\S+\s+(\S+)/);
  return m?.[1]?.replace(/:$/, "") ?? "tool";
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

/** Async version for timer callback path (avoids readFileSync/libuv assertion). */
async function listParkedTasksAsync(cfg: ChatroomConfig): Promise<ParkedTaskInfo[]> {
  const dir = parkedTasksDir(cfg);
  if (!fs.existsSync(dir)) return [];
  const results: ParkedTaskInfo[] = [];
  const files = await readdir(dir);
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const info = (await readJsonAsync(path.join(dir, file))) as ParkedTaskInfo | null;
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

/** Async version for permission case (avoids readFileSync in timer callback). */
async function checkParkConditionAsync(
  cfg: ChatroomConfig,
  info: ParkedTaskInfo,
  logger: Logger,
): Promise<{ met: boolean; result: string }> {
  if (info.watch_type === "permission") {
    const permId = info.watch_config.permission_id;
    if (!permId) return { met: false, result: "No permission_id configured" };
    const permFile = path.join(permissionsDir(cfg), `${permId}.json`);
    const perm = (await readJsonAsync(permFile)) as PermissionRecord | null;
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
  return checkParkCondition(cfg, info, logger);
}

async function monitorParkedTasks(
  cfg: ChatroomConfig,
  runtime: any,
  config: any,
  logger: Logger,
): Promise<void> {
  const parked = await listParkedTasksAsync(cfg);
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

    const { met, result } = await checkParkConditionAsync(cfg, info, logger);
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
          output_dir: toChatroomUri(taskAssetsDir(cfg, info.agent_id, info.task_id), cfg),
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

async function handleIncomingTaskAsync(
  cfg: ChatroomConfig,
  msg: InboxMessage,
  runtime: any,
  config: any,
  logger: Logger,
): Promise<void> {
  const taskId = msg.metadata?.task_id;
  if (!taskId) {
    logger.warn(`TASK_DISPATCH without task_id from ${msg.from}, ignoring`);
    return;
  }

  // TCP-style identity validation: verify this task is meant for us
  if (!validateMessageIdentity(cfg, msg, logger)) {
    logger.warn(`[handshake] Rejecting TASK_DISPATCH ${taskId}: identity mismatch`);
    return;
  }

  const identityToken = msg.metadata?.agent_identity_token as string | undefined;
  const sessionNonce = msg.metadata?.session_nonce as string | undefined;

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
  // Echo identity token in ACK for orchestrator verification
  sendSystemAck(cfg, currentTask, logger, identityToken, sessionNonce);

  // Clean up the task output directory to avoid stale files from previous runs
  const taskOutputDir = taskAssetsDir(cfg, cfg.agentId, taskId);
  if (fs.existsSync(taskOutputDir)) {
    const oldFiles = fs.readdirSync(taskOutputDir);
    if (oldFiles.length > 0) {
      logger.info(
        `Cleaning ${oldFiles.length} stale file(s) from ${toChatroomUri(taskOutputDir, cfg)}`,
      );
      for (const f of oldFiles) {
        try {
          fs.unlinkSync(path.join(taskOutputDir, f));
        } catch {
          /* skip */
        }
      }
    }
  }

  updateTaskRecord(cfg, taskId, {
    status: "PROCESSING",
    started_at: nowISO(),
    current_phase: "processing",
    error_type: null,
    error_detail: null,
    human_approval_required: Boolean(msg.metadata?.human_approval_required),
  } as Partial<TaskRecord>);
  setAgentWorking(cfg, cfg.agentId, taskId, logger);
  logger.info(`Processing task ${taskId} from ${msg.from}: "${msg.content.text.slice(0, 80)}..."`);

  const isLongRunning = Boolean(msg.metadata?.long_running);
  const usePlanMode = shouldUsePlanMode(msg.content.text, isLongRunning);

  try {
    if (usePlanMode) {
      logger.info(`Task ${taskId}: using Plan Mode (long_running=${isLongRunning})`);
      await handlePlanModeTask(cfg, msg, taskId, runtime, config, logger);
    } else {
      logger.info(`Task ${taskId}: using direct execution (simple task)`);
      await autoDispatchForTask(cfg, msg, taskId, runtime, config, logger);
    }
  } catch (err) {
    logger.error(`Unhandled error for task ${taskId}: ${err}`);
    sendTaskResult(cfg, taskId, `Task crashed: ${err}`, "FAILED", logger);
  }
}

/**
 * Plan Mode: planning phase -> then execution.
 * Human approval is required ONLY when the task was dispatched with /human (human_approval_required on TASK_DISPATCH).
 * Otherwise the plan is auto-approved. Sensitive operations use #permission (chatroom_request_permission) separately.
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

    // Human approval ONLY when task was explicitly dispatched with /human (human_approval_required on TASK_DISPATCH).
    // Do not use msg.metadata here — only the task record (set at dispatch time) counts. Sensitive ops use #permission.
    const task = readTaskRecord(cfg, taskId);
    const needsHumanApproval = (task as any)?.human_approval_required === true;

    let approvedPlan: TaskPlan | null;

    if (needsHumanApproval) {
      // /human mode: wait for human approval via dashboard
      logger.info(`Task ${taskId}: /human mode — waiting for human approval`);
      plan.approval.mode = "human";
      approvedPlan = await waitForApproval(cfg, plan, taskId, logger);
      if (!approvedPlan) {
        logger.warn(`Plan for task ${taskId} was not approved by human`);
        const existingTask = readTaskRecord(cfg, taskId);
        if (
          existingTask &&
          existingTask.status !== "CANCELLED" &&
          existingTask.status !== "FAILED"
        ) {
          sendTaskResult(
            cfg,
            taskId,
            "Plan was rejected or human approval timed out",
            "FAILED",
            logger,
          );
        }
        return;
      }
    } else {
      // Autonomous mode: auto-approve and execute immediately
      logger.info(`Task ${taskId}: autonomous plan mode — auto-approving`);
      approvedPlan = updatePlan(cfg, taskId, {
        status: "APPROVED",
        approved_at: nowISO(),
        approval: {
          ...plan.approval,
          mode: "autonomous",
          approved_by: cfg.agentId,
          decision: "approved",
          decision_reason: "Agent autonomous execution (no orchestrator approval needed)",
          decided_at: nowISO(),
        },
      });
      if (!approvedPlan) approvedPlan = plan;
    }

    // Phase 2: Step-by-step execution
    logger.info(`Task ${taskId}: starting step execution (${approvedPlan.steps.length} steps)`);
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
    // TCP-style: verify echoed identity token from the worker
    const echoedToken = msg.metadata?.agent_identity_token as string | undefined;
    const storedToken = (task as any).identity_token as string | undefined;
    if (storedToken && echoedToken && storedToken !== echoedToken) {
      logger.warn(
        `[handshake] Task ${taskId}: ACK token mismatch (expected=${storedToken.slice(0, 8)}, got=${echoedToken.slice(0, 8)}). Possible identity confusion.`,
      );
      return;
    }

    updateTaskRecord(cfg, taskId, {
      status: "ACKED",
      acked_at: nowISO(),
      current_phase: "acked",
    } as Partial<TaskRecord>);
    logger.info(`Task ${taskId} ACK received from ${msg.from} (token verified)`);

    // Send DISPATCH_CONFIRMED to complete the three-way handshake
    sendMessageToNAS(
      cfg,
      task.channel_id,
      `[SYSTEM] Task ${taskId} confirmed — handshake complete. Proceed with execution.`,
      "DISPATCH_CONFIRMED",
      [task.to],
      undefined,
      {
        task_id: taskId,
        from_agent_id: cfg.agentId,
        to_agent_id: task.to,
        session_nonce: (task as any).session_nonce,
      },
    );
    logger.info(`DISPATCH_CONFIRMED sent for task ${taskId} → ${task.to}`);
  }
}

function handleTaskResult(cfg: ChatroomConfig, msg: InboxMessage, logger: Logger): void {
  const taskId = msg.metadata?.task_id;
  if (!taskId) return;

  if (!validateMessageIdentity(cfg, msg, logger)) {
    logger.warn(`[handshake] Rejecting RESULT_REPORT for task ${taskId}: identity mismatch`);
    return;
  }

  const task = readTaskRecord(cfg, taskId);
  if (!task) return;

  const reportStatus = (msg.metadata?.status as TaskStatus) || "DELIVERED";
  const assetPaths = (msg.metadata?.asset_paths as string[]) ?? [];

  // Task stays DELIVERED until orchestrator explicitly closes it
  const patch: Partial<TaskRecord> = {
    status: reportStatus === "FAILED" ? "FAILED" : "DELIVERED",
    result_summary: msg.content.text.slice(0, 500),
    asset_paths: assetPaths,
  };
  if (reportStatus === "FAILED") {
    patch.completed_at = nowISO();
  }
  if (msg.metadata?.error_type) {
    patch.error_type = msg.metadata.error_type as TaskErrorType;
    patch.error_detail = msg.content.text.slice(0, 2000);
  }
  patch.current_phase = reportStatus === "FAILED" ? "failed" : "delivered";
  updateTaskRecord(cfg, taskId, patch);
  logger.info(
    `Task ${taskId} result DELIVERED from ${msg.from} (${reportStatus}${patch.error_type ? ` [${patch.error_type}]` : ""}) — awaiting orchestrator review`,
  );

  // Send RESULT_ACK to confirm receipt (completes the result handshake)
  sendMessageToNAS(
    cfg,
    task.channel_id,
    `[SYSTEM] Result for task ${taskId} received. Awaiting orchestrator review.`,
    "RESULT_ACK",
    [msg.from],
    undefined,
    {
      task_id: taskId,
      from_agent_id: cfg.agentId,
      to_agent_id: msg.from,
      verified: true,
    },
  );
  logger.info(`RESULT_ACK sent for task ${taskId} → ${msg.from}`);

  // Orchestrator: notify #general that result was delivered (not yet closed)
  if (cfg.role === "orchestrator") {
    const assetNote =
      assetPaths.length > 0
        ? `\n\n📂 Output files (${assetPaths.length}):\n${assetPaths.map((p) => `- \`${p}\``).join("\n")}`
        : "";
    const statusEmoji = reportStatus === "FAILED" ? "❌" : "📋";
    const statusLabel =
      reportStatus === "FAILED" ? "Task failed" : "Task result delivered — reviewing";
    const summary =
      `${statusEmoji} **${statusLabel}** from **${msg.from}** (task \`${taskId.slice(0, 8)}\`)\n\n` +
      `${msg.content.text.slice(0, 800)}${msg.content.text.length > 800 ? "..." : ""}` +
      assetNote;
    sendMessageToNAS(cfg, "general", summary, "CHAT", [], undefined, {
      task_id: taskId,
      asset_paths: assetPaths,
    });
    logger.info(`Task delivery notification posted to #general for task ${taskId}`);
  }
}

// ============================================================================
// Plan Question/Answer routing (point-to-point via Orchestrator)
// ============================================================================

async function handlePlanQuestion(
  cfg: ChatroomConfig,
  msg: InboxMessage,
  runtime: any,
  config: any,
  logger: Logger,
): Promise<void> {
  const sourceTaskId = msg.metadata?.task_id as string | undefined;
  const question = (msg.metadata?.question as string) || msg.content.text;
  const sourceAgent = msg.from;

  logger.info(
    `[question] Received PLAN_QUESTION from ${sourceAgent} (task ${sourceTaskId}): "${question.slice(0, 80)}"`,
  );

  const agents = readAgentRegistry(cfg);
  const otherAgents = agents.filter(
    (a) => a.agent_id !== cfg.agentId && a.agent_id !== sourceAgent,
  );
  if (otherAgents.length === 0) {
    sendMessageToNAS(
      cfg,
      `dm_${sourceAgent}`,
      `No other agents available to answer this question. Please proceed with your best judgment.`,
      "ANSWER_FORWARD",
      [sourceAgent],
      undefined,
      { task_id: sourceTaskId, source_agent_id: sourceAgent, source_task_id: sourceTaskId },
    );
    return;
  }

  // Use LLM to decide which agent should answer
  const agentList = otherAgents.map((a) => `- ${a.agent_id} (${a.display_name})`).join("\n");
  const routingPrompt = [
    `An agent "${sourceAgent}" has a question about their task:`,
    `Question: ${question}`,
    ``,
    `Available agents to route this question to:`,
    agentList,
    ``,
    `Which agent is best suited to answer? Reply with just the agent_id.`,
    `If no agent can answer, reply with "none".`,
  ].join("\n");

  // Forward to the first available agent as a simple heuristic,
  // or use LLM routing via auto-dispatch
  const targetAgent = otherAgents[0].agent_id;
  const targetDM = `dm_${targetAgent}`;

  sendMessageToNAS(
    cfg,
    targetDM,
    `[QUESTION from ${sourceAgent}] ${question}`,
    "QUESTION_FORWARD",
    [targetAgent],
    undefined,
    {
      task_id: sourceTaskId,
      source_agent_id: sourceAgent,
      source_task_id: sourceTaskId,
      from_agent_id: cfg.agentId,
      to_agent_id: targetAgent,
      question,
    },
  );
  logger.info(`[question] Forwarded question to ${targetAgent}`);
}

async function handleQuestionForward(
  cfg: ChatroomConfig,
  msg: InboxMessage,
  runtime: any,
  config: any,
  logger: Logger,
): Promise<void> {
  const question = (msg.metadata?.question as string) || msg.content.text;
  const sourceAgent = msg.metadata?.source_agent_id as string;
  const sourceTaskId = msg.metadata?.source_task_id as string;

  logger.info(
    `[question] Received QUESTION_FORWARD from orchestrator (originally from ${sourceAgent}): "${question.slice(0, 80)}"`,
  );

  // Auto-dispatch to LLM for answering
  await autoDispatchMessage(cfg, msg, runtime, config, logger);
}

function handleQuestionAnswer(cfg: ChatroomConfig, msg: InboxMessage, logger: Logger): void {
  const sourceAgent = msg.metadata?.source_agent_id as string;
  const sourceTaskId = msg.metadata?.source_task_id as string;

  if (!sourceAgent) {
    logger.warn(`[question] QUESTION_ANSWER without source_agent_id, ignoring`);
    return;
  }

  const targetDM = `dm_${sourceAgent}`;
  sendMessageToNAS(cfg, targetDM, msg.content.text, "ANSWER_FORWARD", [sourceAgent], undefined, {
    task_id: sourceTaskId,
    source_agent_id: msg.from,
    source_task_id: sourceTaskId,
    from_agent_id: cfg.agentId,
    to_agent_id: sourceAgent,
  });
  logger.info(`[question] Answer from ${msg.from} forwarded to ${sourceAgent}`);
}

// ============================================================================
// ACK timeout monitoring
// ============================================================================

const RATE_LIMIT_RETRY_DELAY_MS = 60_000;

async function monitorPendingTasks(cfg: ChatroomConfig, logger: Logger): Promise<void> {
  const pending = await listTasksByStatusAsync(cfg, "DISPATCHED", "TIMEOUT", "RETRYING");
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
  const processing = await listTasksByStatusAsync(cfg, "ACKED", "PROCESSING");
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
  const failed = await listTasksByStatusAsync(cfg, "FAILED");
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

async function buildOrchestratorContext(
  cfg: ChatroomConfig,
  sourceChannel?: string,
  currentMessageHumanApproval?: boolean,
): Promise<string> {
  const agents = await readAgentRegistryAsync(cfg);
  const channels = await listAgentChannelsAsync(cfg);

  const otherAgents = agents.filter((a) => a.agent_id !== cfg.agentId);
  if (otherAgents.length === 0 && channels.length === 0) return "";

  const myAssets = assetsDir(cfg, cfg.agentId);
  const sharedAssets = assetsDir(cfg, "shared");

  const lines: string[] = [
    `[Chatroom Orchestration Context — Firstclaw Framework]`,
    `You are "${cfg.agentId}" (FirstClaw), the Orchestrator of the First Agent Family.`,
    `You run on the Firstclaw framework. Your role is to understand human tasks and dispatch them to specialist agents.`,
    `All inter-agent communication is strictly point-to-point (you ↔ each agent). Agents do NOT communicate with each other.`,
    ``,
    `═══ CHANNEL RULES (MUST follow) ═══`,
    `  #general   → Human ↔ Orchestrator communication ONLY.`,
    `               When a human sends a message here, respond HERE and nowhere else.`,
    `               Do NOT post task results, progress updates, or agent replies to #general.`,
    `  #permission → Sensitive operation approval channel (system-managed).`,
    `               When agents encounter sensitive operations, the system posts approval`,
    `               requests here automatically. Human admins approve/reject via Web UI.`,
    `               Do NOT manually send messages to #permission.`,
    `  dm_{agent} → Private point-to-point channels between you and a specific agent.`,
    `               ALL task dispatch, questions, answers, and result delivery happen here.`,
    `               This is the primary communication mechanism. Each DM is a dedicated link to one agent.`,
    ``,
    `  CRITICAL: Your response goes to the SAME channel as the incoming message.`,
    sourceChannel ? `  Current channel: #${sourceChannel}` : ``,
    ``,
    `═══ File System (NAS) ═══`,
    `  All asset paths use the chatroom:// URI protocol for cross-machine compatibility.`,
    `  Your output dir: ${toChatroomUri(myAssets, cfg)}`,
    `  Shared dir: ${toChatroomUri(sharedAssets, cfg)}`,
    `  All agent assets: ${toChatroomUri(assetsDir(cfg), cfg)}`,
    `  When dispatching a task, the system auto-creates an output dir for the target.`,
    `  URI format: chatroom://assets/{agentId}/{taskId}/{file} — resolved against each machine's NAS mount.`,
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

  lines.push(`═══ Task Dispatch Protocol (TCP-style reliable handshake) ═══`);
  lines.push(`  Use chatroom_dispatch_task to assign work to agents.`);
  lines.push(`  The system handles a three-way handshake for reliable delivery:`);
  lines.push(`    1. You → Agent: TASK_DISPATCH (with identity token)`);
  lines.push(`    2. Agent → You: TASK_ACK (echoes identity token for verification)`);
  lines.push(`    3. You → Agent: DISPATCH_CONFIRMED (handshake complete)`);
  lines.push(`  Result delivery also uses confirmation:`);
  lines.push(`    4. Agent → You: RESULT_REPORT (status=DELIVERED — task NOT yet closed)`);
  lines.push(`    5. You → Agent: RESULT_ACK (receipt confirmed)`);
  lines.push(`  All messages carry from_agent_id and to_agent_id for strict identity validation.`);
  lines.push(`  Output files are placed in: ${assetsDir(cfg)}/{agent_id}/{task_id}/`);
  lines.push(``);
  lines.push(`═══ CRITICAL: Task Review & Close Protocol ═══`);
  lines.push(`  When you receive a RESULT_REPORT, the task status becomes DELIVERED (NOT DONE).`);
  lines.push(`  You MUST review the deliverables before closing:`);
  lines.push(`    1. Read the RESULT_REPORT and check the file list`);
  lines.push(`    2. Verify output files exist using chatroom_list_assets`);
  lines.push(`    3. Use chatroom_close_task(task_id, verdict="accepted") to mark DONE`);
  lines.push(
    `       OR chatroom_close_task(task_id, verdict="rejected", comment="reason") for rework`,
  );
  lines.push(`  NEVER leave a task in DELIVERED state — always close or reject promptly.`);
  lines.push(`  The agent worker CANNOT close its own task. Only you (orchestrator) can.`);
  lines.push(``);
  lines.push(
    `  Example: chatroom_dispatch_task(target="art", instruction="draw a steel dinosaur")`,
  );
  lines.push(
    `  Human approval: pass human_approval_required: true ONLY when the user explicitly used /human; otherwise plans are auto-approved. Sensitive ops use #permission.`,
  );
  // Explicit per-message signal so the orchestrator does not claim "/human mode" when the user did not use /human
  if (currentMessageHumanApproval === true) {
    lines.push(``);
    lines.push(
      `  [CURRENT MESSAGE] This user message was sent WITH /human. You may pass human_approval_required: true when dispatching and may mention that plans will be submitted for human review.`,
    );
  } else {
    lines.push(``);
    lines.push(
      `  [CURRENT MESSAGE] This user message was NOT sent with /human. You MUST NOT say "当前处于 /human 模式" or "提交计划供审核" or that the Agent will submit the plan for review. Plans are auto-approved. Do not pass human_approval_required: true when dispatching for this request.`,
    );
  }
  lines.push(``);
  lines.push(`═══ RAG (Project Knowledge) — MANDATORY ═══`);
  lines.push(`  Use rag_query(query="...") to retrieve project context from the RAG system.`);
  lines.push(`  CRITICAL RULES:`);
  lines.push(
    `    1. You MUST call rag_query for ANY question about the project, game, design, specs, or team decisions.`,
  );
  lines.push(
    `    2. ALWAYS query RAG even if you think you already know the answer from prior conversation.`,
  );
  lines.push(`       Prior conversation context may contain OUTDATED or FABRICATED information.`);
  lines.push(
    `    3. If RAG is unavailable, you MUST explicitly tell the user that the knowledge base is`,
  );
  lines.push(`       currently unreachable and you CANNOT provide verified project information.`);
  lines.push(
    `    4. NEVER answer project-specific questions from memory alone — RAG is the single source of truth.`,
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

  lines.push(`═══ Plan Mode (Autonomous) ═══`);
  lines.push(
    `  Agents create and execute their own plans autonomously — you do NOT approve or reject plans.`,
  );
  lines.push(`  If an agent has questions about its task, it will send a PLAN_QUESTION to you.`);
  lines.push(`  You then route the question to the appropriate agent for an answer.`);
  lines.push(`  Use chatroom_list_plans to monitor plan progress.`);
  lines.push(
    `  Human approval for plans happens ONLY when you passed human_approval_required: true in chatroom_dispatch_task (i.e. when the user used /human). Otherwise plans are auto-approved.`,
  );
  lines.push(``);

  const activeTasks = await listTasksByStatusAsync(
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

  // Show plans awaiting human approval (only when /human command is active)
  try {
    const plDir = plansDir(cfg);
    if (fs.existsSync(plDir)) {
      const pendingPlans: TaskPlan[] = [];
      const planFiles = await readdir(plDir);
      for (const f of planFiles) {
        if (!f.endsWith(".json")) continue;
        const plan = (await readJsonAsync(path.join(plDir, f))) as TaskPlan | null;
        if (plan && plan.status === "PENDING_REVIEW" && plan.approval?.mode === "human") {
          pendingPlans.push(plan);
        }
      }
      if (pendingPlans.length > 0) {
        lines.push(`═══ Plans Awaiting Human Approval (/human mode) ═══`);
        for (const p of pendingPlans) {
          lines.push(`  - Task ${p.task_id.slice(0, 8)}... by ${p.agent_id}: "${p.summary}"`);
          lines.push(`    Steps: ${p.steps.length} (est. ${p.estimated_total_minutes}min)`);
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
    `[Agent Worker Context — Firstclaw Framework]`,
    `You are "${cfg.agentId}", a specialist worker agent in the First Agent Family, running on the Firstclaw framework.`,
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
    `  6. BEFORE executing sensitive operations that are NOT the task objective, use chatroom_request_permission.`,
    ``,
    `═══ SENSITIVE OPERATIONS (permission only when OUTSIDE task objective) ═══`,
    `  Call chatroom_request_permission ONLY for sensitive operations that are NOT the direct goal of the task.`,
    `  If the task instruction explicitly asks you to do something (e.g. "trigger the release pipeline", "run the build", "call Jenkins"),`,
    `  that operation is the TASK OBJECTIVE — do NOT request permission; proceed.`,
    `  Only request permission for operations that are clearly outside the task (e.g. ad-hoc rm -rf, modifying system files, unrelated APIs).`,
    `  Sensitive types: shell (system dirs, sudo, rm -rf), .env/credentials, systemctl/docker, network mutations to unrelated services.`,
    `  If the operation is allowlisted, it will auto-approve instantly.`,
    ``,
    `═══ File System (NAS) ═══`,
    `  All asset paths use the chatroom:// URI protocol for cross-machine compatibility.`,
    `  Your output dir: ${toChatroomUri(myAssets, cfg)}`,
    `  To access files from other agents, resolve their chatroom:// URI with your own NAS root.`,
    sourceChannel ? `  Current channel: #${sourceChannel}` : ``,
    ``,
    `═══ RAG vs TOOLS.md — DO NOT CONFUSE ═══`,
    `  RAG = project-specific knowledge (design docs, specs, prior decisions, game features). Use rag_query for that.`,
    `  TOOLS.md + your registered tools = what you CAN do and HOW (e.g. release branch, release notes, shell, read/write).`,
    `  RAG does NOT contain everything. Many procedures and capabilities are in TOOLS.md.`,
    `  Do NOT conclude "I cannot do this task" just because RAG did not return repo URL, template, or version.`,
    `  Use your tools (shell, read workspace, etc.) and TOOLS.md first; only say you cannot when both RAG and TOOLS don't cover it.`,
    ``,
    `═══ RAG (Project Knowledge) — USE FOR FACTS ═══`,
    `  BEFORE starting any task, query RAG for relevant project context:`,
    `    rag_query(query="relevant question about the project")`,
    `  Use RAG for project facts. If RAG is unavailable, state that and proceed using TOOLS.md and your tools.`,
    `  Do NOT refuse to execute a task solely because RAG lacked some detail — your capabilities are in TOOLS.md.`,
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
    `═══ Task Result & Delivery ═══`,
    `  When you finish a task, your result status will be DELIVERED (not DONE).`,
    `  The orchestrator will review your output and then accept or reject it.`,
    `  If rejected, you will receive a rework request with feedback.`,
    `  Your result message MUST clearly state:`,
    `    1. What you produced (summary)`,
    `    2. The output file paths will be automatically appended`,
    `  Do NOT mark your own tasks as DONE — only the orchestrator can do that.`,
    ``,
  ];

  return lines.join("\n");
}

async function buildChatroomContext(
  cfg: ChatroomConfig,
  sourceChannel?: string,
  currentMessageHumanApproval?: boolean,
): Promise<string> {
  if (cfg.role === "orchestrator") {
    return buildOrchestratorContext(cfg, sourceChannel, currentMessageHumanApproval);
  }
  return buildWorkerContext(cfg, sourceChannel);
}

// ============================================================================
// Auto-dispatch: push messages through the LLM processing chain
// ============================================================================

async function autoDispatchMessage(
  chatroomCfg: ChatroomConfig,
  msg: InboxMessage,
  runtime: any,
  config: any,
  logger: Logger,
): Promise<void> {
  await chatroomCurrentMessageStorage.run({ currentInboxMessage: msg }, async () => {
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

    const currentMessageHumanApproval = msg.metadata?.human_approval_required === true;
    const chatroomContext = await buildChatroomContext(
      chatroomCfg,
      channelId,
      currentMessageHumanApproval,
    );

    // If this is a RESULT_REPORT to the orchestrator, add a review prompt
    let messageBody: string;
    if (msg.type === "RESULT_REPORT" && chatroomCfg.role === "orchestrator") {
      const taskId = msg.metadata?.task_id as string | undefined;
      const assetPaths = (msg.metadata?.asset_paths as string[] | undefined) ?? [];
      const assetSection =
        assetPaths.length > 0
          ? `\nDelivered files:\n${assetPaths.map((p) => `  • ${p}`).join("\n")}`
          : "\n(No files delivered)";

      const taskRecord = taskId ? readTaskRecord(chatroomCfg, taskId) : null;
      const agreed = taskRecord?.agreed_deliverables;
      const reviewHint = agreed
        ? `Review ONLY against the agreed deliverables (${agreed.items.map((i) => i.extension).join(", ")}). ` +
          `If the worker delivered what they agreed (e.g. two .zip files), accept it. Do not reject based on your own assumptions (e.g. expecting .ipa/.apk). `
        : `No agreed_deliverables on record; accept only if you are satisfied. `;

      messageBody =
        `[RESULT_REPORT from ${senderLabel}] Task ${taskId ?? "unknown"}${assetSection}\n\n` +
        `${msg.content.text}\n\n` +
        `⚠️ ACTION REQUIRED: ${reviewHint}` +
        `Use chatroom_list_assets to verify files exist, then call chatroom_close_task(task_id="${taskId}", verdict="accepted") ` +
        `to close, or verdict="rejected" with a comment to request rework.`;
    } else {
      messageBody = `[Chatroom #${channelId}] ${senderLabel}: ${msg.content.text}`;
    }
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

    // Write thinking state so the frontend can show a live "Thinking..." indicator
    const thinkingFile = path.join(
      chatroomCfg.nasRoot,
      "chatroom",
      "thinking",
      `${chatroomCfg.agentId}.json`,
    );
    const updateThinking = (state: "thinking" | "tool" | "done", snippet?: string) => {
      try {
        ensureDir(path.dirname(thinkingFile));
        writeJson(thinkingFile, {
          agent_id: chatroomCfg.agentId,
          channel_id: channelId,
          message_id: msg.message_id,
          state,
          snippet: snippet?.slice(0, 500) ?? "",
          updated_at: nowISO(),
        });
      } catch {
        /* best effort */
      }
    };
    updateThinking("thinking");

    const dispatcherOptions = {
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      deliver: async (payload: ReplyPayload, info?: { kind: string }) => {
        const text = payload.text ?? "";
        const kind = info?.kind ?? "final";

        if (kind === "block") {
          updateThinking("thinking", text);
          return;
        }
        if (kind === "tool") {
          const toolName = (payload as any).toolName ?? "tool";
          updateThinking("tool", `Using ${toolName}...`);
          return;
        }

        // kind === "final"
        updateThinking("done");
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
        updateThinking("done");
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
  });
}

// ============================================================================
// Plan Mode — two-phase execution: planning + step-by-step
// ============================================================================

function shouldUsePlanMode(instruction: string, isLongRunning: boolean): boolean {
  // Plan Mode is ON by default for all tasks.
  // Only skip for extremely trivial instructions (< 5 words, no newlines).
  if (isLongRunning) return true;
  const trimmed = instruction.trim();
  const wordCount = trimmed.split(/\s+/).length;
  if (wordCount < 5 && !trimmed.includes("\n")) return false;
  return true;
}

const DELIVERABLES_FILENAME = "DELIVERABLES.md";

/**
 * Fetch RAG context and (for workers only) TOOLS.md + DELIVERABLES.md for the planning phase (before Plan).
 * Worker must use DELIVERABLES.md to decide what to declare in chatroom_confirm_deliverables.
 * Skips RAG when the frontend sends metadata.rag_free === true (e.g. user set system instruction /rag-free).
 * Do NOT infer from task text — only the frontend decides.
 */
async function fetchPlanningContext(
  cfg: ChatroomConfig,
  msg: InboxMessage,
  taskId: string,
  _config: any,
  logger: Logger,
): Promise<{ ragText: string; toolsMdText: string; deliverablesMdText: string }> {
  const reportChannel = cfg.role === "orchestrator" ? "general" : `dm_${cfg.agentId}`;
  const skipRag = msg.metadata?.rag_free === true;

  let ragText: string;
  if (skipRag) {
    ragText =
      "[RAG skipped for this task — frontend sent rag_free (e.g. system instruction /rag-free). Use TOOLS.md and DELIVERABLES.md below.]";
    logger.info(`Planning context: skipping RAG for task ${taskId} (metadata.rag_free=true)`);
  } else {
    const ragServiceUrl =
      process.env.RAG_SERVICE_URL || cfg.ragServiceUrl || "http://localhost:8000";
    const query = msg.content.text.trim().slice(0, 500) || "Project context and conventions";

    // ── 1. Query RAG ───────────────────────────────────────────────────────
    try {
      sendMessageToNAS(cfg, reportChannel, `[RAG][QUERY] ${query}`, "STATUS_UPDATE");
    } catch (e) {
      logger.warn(`RAG report (QUERY) failed: ${e}`);
    }
    try {
      const response = await fetch(`${ragServiceUrl}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, top_k: 5 }),
      });
      if (!response.ok) {
        ragText = `RAG query failed (${response.status}). Proceed with your best judgment; do not fabricate project details.`;
        try {
          sendMessageToNAS(cfg, reportChannel, `[RAG][ERROR] ${ragText}`, "STATUS_UPDATE");
        } catch {
          /* ignore */
        }
      } else {
        const data = (await response.json()) as {
          answer: string;
          sources?: { text: string; source: string; score: number }[];
          strategy?: string;
        };
        ragText =
          `Answer:\n${data.answer}\n` +
          (data.sources?.length
            ? `\nSources:\n${data.sources.map((s, i) => `[${i + 1}] ${s.source}\n${s.text}`).join("\n\n")}`
            : "");
        try {
          sendMessageToNAS(
            cfg,
            reportChannel,
            `[RAG][RESPONSE] strategy: ${data.strategy ?? "unknown"}\n${data.answer}`,
            "STATUS_UPDATE",
          );
        } catch {
          /* ignore */
        }
      }
    } catch (err) {
      ragText = `RAG unavailable: ${err}. Proceed with your best judgment; do not fabricate project details.`;
      try {
        sendMessageToNAS(cfg, reportChannel, `[RAG][ERROR] ${ragText}`, "STATUS_UPDATE");
      } catch {
        /* ignore */
      }
    }
  }

  // ── 2. Read TOOLS.md only for workers; from default/base workspace ───────
  let toolsMdText = "";
  let deliverablesMdText = "";
  if (cfg.role === "worker") {
    const workspaceDir = resolveDefaultAgentWorkspaceDir();
    try {
      const toolsPath = path.join(workspaceDir, DEFAULT_TOOLS_FILENAME);
      if (fs.existsSync(toolsPath)) {
        toolsMdText = await readFile(toolsPath, "utf-8");
      } else {
        toolsMdText = `(No ${DEFAULT_TOOLS_FILENAME} found in default workspace ${workspaceDir}. Use the tools available to this agent as documented in your system prompt.)`;
      }
    } catch (err) {
      toolsMdText = `(Could not load TOOLS.md: ${err}. Rely on your registered tools and system prompt for capabilities.)`;
      logger.warn(`Planning context: TOOLS.md read failed: ${err}`);
    }
    // ── 3. Read DELIVERABLES.md (mandatory before deliverables confirmation) ─
    try {
      const deliverablesPath = path.join(workspaceDir, DELIVERABLES_FILENAME);
      if (fs.existsSync(deliverablesPath)) {
        deliverablesMdText = await readFile(deliverablesPath, "utf-8");
      } else {
        deliverablesMdText = `(No ${DELIVERABLES_FILENAME} in default workspace ${workspaceDir}. Declare what you will deliver based on the task instruction and your role.)`;
        logger.warn(
          `Planning context: ${DELIVERABLES_FILENAME} not found; agent will confirm from instruction.`,
        );
      }
    } catch (err) {
      deliverablesMdText = `(Could not load ${DELIVERABLES_FILENAME}: ${err}. Declare deliverables from the task instruction.)`;
      logger.warn(`Planning context: DELIVERABLES.md read failed: ${err}`);
    }
  }

  return { ragText, toolsMdText, deliverablesMdText, ragSkipped: skipRag };
}

/**
 * Phase 1: Short LLM call to produce a structured plan.
 * Returns the created plan, or null if planning was skipped/failed.
 * Before planning, we inject RAG context and TOOLS.md so the agent knows project facts and its own tools.
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

  // Pre-step: query RAG and (for workers only) load TOOLS.md + DELIVERABLES.md from default workspace (before Plan)
  appendTaskProgress(chatroomCfg, taskId, {
    phase: "planning",
    detail:
      chatroomCfg.role === "worker"
        ? "Querying RAG, loading TOOLS.md and DELIVERABLES.md"
        : "Querying RAG",
  });
  const { ragText, toolsMdText, deliverablesMdText, ragSkipped } = await fetchPlanningContext(
    chatroomCfg,
    msg,
    taskId,
    config,
    logger,
  );

  const taskRecord = readTaskRecord(chatroomCfg, taskId);
  const agreedDel = taskRecord?.agreed_deliverables;
  const deliverableContext = agreedDel
    ? `\nAGREED DELIVERABLES (you already confirmed): ${agreedDel.items.map((i) => i.extension).join(", ")}` +
      (agreedDel.work_summary ? ` — ${agreedDel.work_summary}` : "")
    : "";

  const planningPromptParts: string[] = [
    ``,
    `═══ RAG CONTEXT (retrieved before planning — use for project knowledge) ═══`,
    ...(ragSkipped
      ? []
      : [
          "This task REQUIRES RAG for project knowledge. Use the context below and call rag_query during execution when needed.",
          "",
        ]),
    ragText,
    ``,
  ];
  if (toolsMdText) {
    planningPromptParts.push(
      `═══ YOUR TOOLS (TOOLS.md from default workspace — your capabilities and how to use them) ═══`,
      `CRITICAL: Your capabilities (e.g. release branch, release notes) are defined here. Do NOT refuse to plan or execute because RAG did not return repo URL or template — use your tools and this TOOLS.md.`,
      toolsMdText,
      ``,
    );
  }
  if (deliverablesMdText) {
    planningPromptParts.push(
      `═══ DELIVERABLES.md (MANDATORY — read and use for chatroom_confirm_deliverables) ═══`,
      `You MUST use the content below to decide what to declare. Do not confirm deliverables without it.`,
      ``,
      deliverablesMdText,
      ``,
    );
  }
  planningPromptParts.push(
    `═══ TASK & PLANNING INSTRUCTIONS ═══`,
    ``,
    `[CHATROOM TASK — PLANNING PHASE]`,
    `task_id: ${taskId}`,
    `assigned_by: ${msg.from}`,
    ``,
    `INSTRUCTION:`,
    msg.content.text,
    deliverableContext,
    ``,
    `MANDATORY — Deliverables confirmation (use DELIVERABLES.md above):`,
    `  If you have NOT yet called chatroom_confirm_deliverables for this task, you MUST call it FIRST.`,
    `  Use the DELIVERABLES.md content above to set items (e.g. items: [{ extension: ".zip" }, { extension: ".zip" }]).`,
    `  The orchestrator will only accept files that match this agreement. Then call chatroom_create_plan.`,
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
    `  - Do NOT refuse to plan because RAG lacked repo URL, template, or version — TOOLS.md defines your capabilities; use workspace and shell as needed`,
    `  - After calling chatroom_create_plan, respond with a brief confirmation`,
    ``,
    `CRITICAL — Deliverable-first planning:`,
    `  - Before creating your plan, identify the FINAL DELIVERABLE the downstream consumer needs.`,
    `  - Your last step MUST produce the actual deliverable files (not documentation about them).`,
    `  - Intermediate notes, briefs, or plans are useful for YOUR process but are NOT deliverables.`,
    `  - Text-only documentation (*.md, *.txt) is automatically excluded from delivery when the task`,
    `    expects visual/binary output. Only actual asset files will be delivered to the requester.`,
    `  - Example: if asked to "generate an image", your plan must include a step that actually`,
    `    generates the image file — writing a description of the image is NOT a valid deliverable.`,
  );
  const planningPrompt = planningPromptParts.join("\n");

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

  let planCreatedResolve: (() => void) | null = null;
  const planCreatedPromise = new Promise<void>((resolve) => {
    planCreatedResolve = resolve;
  });

  appendTaskProgress(chatroomCfg, taskId, { phase: "planning", detail: "Creating execution plan" });

  const dispatcherOptions = {
    responsePrefix: prefixContext.responsePrefix,
    responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
    deliver: async (payload: ReplyPayload, info?: { kind: string }) => {
      const kind = info?.kind ?? "final";
      if (kind === "tool") {
        const toolName = _extractToolName(payload);
        if (toolName === "chatroom_create_plan") {
          planCreatedResolve?.();
        }
        const rawDetail = (payload.text ?? "").slice(0, 200);
        appendTaskProgress(chatroomCfg, taskId, {
          phase: "planning_tool",
          detail: `[${toolName}] ${_redactDetail(rawDetail)}`,
        });
      }
      if (kind === "final") {
        planCreatedResolve?.();
      }
    },
    onError: (err: any) => {
      logger.error(`Planning phase error for task ${taskId}: ${err}`);
    },
  };

  logger.info(
    `Starting planning phase for task ${taskId} (timeout: ${PLANNING_TIMEOUT_MS / 1000}s)`,
  );

  const dispatchPromise = runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions,
    replyOptions: {
      onModelSelected: prefixContext.onModelSelected,
      toolsDeny: [
        "message",
        "feishu_*",
        "lark_*",
        "chatroom_complete_step",
        "chatroom_fail_step",
        "chatroom_task_progress",
        "chatroom_publish_file",
        "chatroom_publish_and_send",
        "chatroom_save_asset",
        "chatroom_task_park",
        "chatroom_request_permission",
      ],
      agentTimeoutMs: PLANNING_TIMEOUT_MS,
    },
  });

  // Wait for either: (a) plan created via tool call, or (b) dispatch finishes naturally.
  // When plan is created, give a short grace period then return immediately — don't let
  // the LLM continue executing tasks inside the planning dispatch.
  const PLAN_CREATED_GRACE_MS = 3_000;
  await Promise.race([
    dispatchPromise,
    planCreatedPromise.then(
      () => new Promise<void>((resolve) => setTimeout(resolve, PLAN_CREATED_GRACE_MS)),
    ),
  ]);

  const plan = readPlan(chatroomCfg, taskId);
  if (!plan) {
    logger.warn(`Planning phase completed but no plan was created for task ${taskId}`);
  } else {
    logger.info(`Plan created for task ${taskId}, returning to handlePlanModeTask for approval`);
  }
  return plan;
}

/**
 * Wait for human approval via the Web dashboard.
 * Only used when /human command is active. No auto-approve timeout.
 * Returns the approved plan, or null if rejected/timed out.
 */
async function waitForApproval(
  cfg: ChatroomConfig,
  plan: TaskPlan,
  taskId: string,
  logger: Logger,
): Promise<TaskPlan | null> {
  // Notify via DM that this plan requires human approval
  const dmChannel = `dm_${cfg.agentId}`;
  sendMessageToNAS(
    cfg,
    dmChannel,
    `[HUMAN_APPROVAL_REQUIRED] Plan for task ${taskId} requires human approval:\n` +
      `Summary: ${plan.summary}\n` +
      `Steps: ${plan.steps.length} (est. ${plan.estimated_total_minutes}min)\n` +
      plan.steps.map((s) => `  ${s.order}. ${s.title} (~${s.estimated_minutes}min)`).join("\n") +
      `\n\nPlease approve, reject, or request revision from the Web dashboard.`,
    "SYSTEM",
    [],
    undefined,
    { task_id: taskId, plan_id: plan.plan_id, human_approval_required: true },
  );

  updatePlan(cfg, taskId, { status: "PENDING_REVIEW" });
  updateTaskRecord(cfg, taskId, {
    current_phase: "awaiting_human_approval",
  } as Partial<TaskRecord>);
  logger.info(`Plan for task ${taskId} awaiting human approval`);

  const humanPollMs = 5_000;
  const humanDeadlineMs = 60 * 60_000; // 1 hour max wait
  const humanDeadline = Date.now() + humanDeadlineMs;
  let humanReadFailures = 0;

  while (Date.now() < humanDeadline) {
    const current = readPlan(cfg, taskId);
    if (!current) {
      humanReadFailures++;
      if (humanReadFailures > 10) {
        logger.warn(`Plan file for task ${taskId} unreadable after ${humanReadFailures} attempts`);
        return null;
      }
      await new Promise((r) => setTimeout(r, humanPollMs));
      continue;
    }
    humanReadFailures = 0;

    if (current.status === "APPROVED") {
      logger.info(`Plan for task ${taskId} approved by ${current.approval.approved_by}`);
      return current;
    }
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

  const rawOutputDir = msg.metadata?.output_dir as string | undefined;
  const outputDir = rawOutputDir
    ? fromChatroomUri(rawOutputDir, chatroomCfg)
    : taskAssetsDir(chatroomCfg, chatroomCfg.agentId, taskId);
  ensureDir(outputDir);

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

    let result: StepResult;
    try {
      result = await executeStep(
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
    } catch (err: any) {
      const errMsg = err?.message ?? String(err);
      result = {
        success: false,
        result_summary: "",
        output_files: [],
        error_detail: `Unhandled error during step execution: ${errMsg}`,
      };
    }

    // Retry once on retryable LLM/output errors (e.g. Unterminated string in JSON)
    if (!result.success && result.error_detail && isRetryableStepError(result.error_detail)) {
      logger.info(
        `Step ${step.order} retrying once after retryable error: ${result.error_detail.slice(0, 100)}`,
      );
      appendTaskProgress(chatroomCfg, taskId, {
        phase: `step_${step.order}_retry`,
        detail: `Retrying after: ${result.error_detail.slice(0, 80)}`,
      });
      try {
        result = await executeStep(
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
      } catch (retryErr: any) {
        const retryMsg = retryErr?.message ?? String(retryErr);
        result = {
          success: false,
          result_summary: "",
          output_files: [],
          error_detail: `Retry failed: ${retryMsg}. Original: ${result.error_detail}`,
        };
      }
    }

    updateTaskRecord(chatroomCfg, taskId, {
      run_context_snapshot: {
        last_updated: nowISO(),
        step_order: step.order,
        step_id: step.step_id,
        success: result.success,
        error_detail: result.error_detail ?? undefined,
        note: "Updated after each step run for context/debugging.",
      },
    } as Partial<TaskRecord>);

    if (result.success) {
      previousResults.push({ title: step.title, result: result.result_summary });
    } else {
      // Step failed — record in progress log for frontend, then mark plan failed and send result
      const errDetail = result.error_detail ?? "Unknown error";
      logger.warn(`Step ${step.order} failed: ${errDetail}`);
      appendTaskProgress(chatroomCfg, taskId, {
        phase: `step_${step.order}_failed`,
        detail: errDetail,
      });
      updatePlanStep(chatroomCfg, taskId, step.step_id, {
        status: "FAILED",
        error_detail: errDetail,
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
      const errSummary = `Plan failed at step ${step.order}/${plan.steps.length} (${step.title}): ${errDetail}`;
      sendTaskResult(chatroomCfg, taskId, errSummary, "FAILED", logger, allFiles);
      return;
    }
  }

  // All steps completed
  updatePlan(chatroomCfg, taskId, { status: "COMPLETED", completed_at: nowISO() });

  // Prefer files explicitly tagged as deliverables by the agent.
  // Fall back to scanOutputDir if no files were tagged (backward compat).
  const updatedPlan = readPlan(chatroomCfg, taskId);
  const taggedDeliverables: string[] = [];
  if (updatedPlan) {
    for (const s of updatedPlan.steps) {
      if ((s as any).is_final_deliverable && s.output_files?.length) {
        taggedDeliverables.push(...s.output_files);
      }
    }
  }
  const rawFiles =
    taggedDeliverables.length > 0 ? taggedDeliverables : scanOutputDir(outputDir as string);
  // Deduplicate by basename — multiple steps may declare the same output file
  const seenNames = new Set<string>();
  const allFiles = rawFiles.filter((f) => {
    const base = path.basename(f).toLowerCase();
    if (seenNames.has(base)) return false;
    seenNames.add(base);
    return true;
  });

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

  const isLastStep = step.order === plan.steps.length;
  const taskInstruction = originalMsg.content.text.toLowerCase();
  const looksVisual =
    ["generate", "render", "create", "draw", "produce"].some((k) => taskInstruction.includes(k)) &&
    ["image", "picture", "sprite", "icon", "texture", "render", "asset"].some((k) =>
      taskInstruction.includes(k),
    );
  const finalStepReminder =
    isLastStep && looksVisual
      ? `\n\nCRITICAL: This is the FINAL step. The original task asks for visual/rendered output. ` +
        `You MUST produce actual image files (not just documentation/plans). ` +
        `Use your image generation capabilities and call chatroom_publish_file to deliver the rendered asset. ` +
        `Text-only deliverables will be REJECTED.`
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
    `4. Set is_final_deliverable=true in chatroom_complete_step ONLY when this step produces the`,
    `   actual files that the task requester needs. Intermediate notes/documentation are NOT deliverables.`,
    `5. If you encounter an unrecoverable error, call chatroom_fail_step(task_id="${taskId}",`,
    `   step_id="${step.step_id}", error_detail="...").`,
    `6. For long-running operations, use chatroom_task_park.`,
    `7. SENSITIVE OPERATIONS: request permission ONLY when the operation is NOT the task objective. If the step/task is "trigger release pipeline" or "call Jenkins", do NOT request permission — proceed.`,
    `8. DO NOT send messages to other channels or agents.`,
    `9. When the original instruction asks for visual output (images, renders), you MUST actually`,
    `   generate/render the visual asset — NOT just a text description of how to do it.`,
    finalStepReminder,
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
  /** Last tool/block activity — used to explain "Step did not complete" when agent never called complete_step/fail_step */
  let lastActivityDetail: string | null = null;
  /** Final payload text from runner — when run ends without complete_step/fail_step, may contain the actual error (e.g. context overflow, timeout). */
  let lastFinalPayloadText: string | null = null;

  const dispatcherOptions = {
    responsePrefix: prefixContext.responsePrefix,
    responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
    deliver: async (payload: ReplyPayload, info?: { kind: string }) => {
      const text = payload.text ?? "";
      const kind = info?.kind ?? "final";

      if (kind === "tool") {
        const toolName = _extractToolName(payload);
        const rawDetail = text.slice(0, 200);
        const detail = `[${toolName}] ${_redactDetail(rawDetail)}`;
        lastActivityDetail = detail;
        appendTaskProgress(chatroomCfg, taskId, {
          phase: `step_${step.order}_tool`,
          detail,
        });
        return;
      }

      if (kind === "block") {
        const detail = text.slice(0, 200);
        lastActivityDetail = detail;
        appendTaskProgress(chatroomCfg, taskId, {
          phase: `step_${step.order}_progress`,
          detail,
        });
        return;
      }

      if (kind === "final") {
        lastFinalPayloadText = text;
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
        } else if (stepResult.success === false && stepResult.error_detail) {
          // onError already fired or run ended without complete_step/fail_step — mark step FAILED
          updatePlanStep(chatroomCfg, taskId, step.step_id, {
            status: "FAILED",
            error_detail: stepResult.error_detail,
            completed_at: nowISO(),
          });
        } else {
          // Run ended without explicit complete_step/fail_step — do NOT treat as success.
          // Mark as failed so the step is never shown as green; post-try block will set a clear error_detail.
          updatePlanStep(chatroomCfg, taskId, step.step_id, {
            status: "FAILED",
            error_detail: "Step did not complete",
            completed_at: nowISO(),
          });
          stepResult = { ...stepResult, success: false, error_detail: "Step did not complete" };
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

  try {
    const dispatchResult = await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg: config,
      dispatcherOptions,
      replyOptions: {
        onModelSelected: prefixContext.onModelSelected,
        toolsDeny: ["message", "feishu_*", "lark_*"],
        agentTimeoutMs: stepTimeoutMs,
      },
    });

    // When LLM returns empty/NO_REPLY, deliver("final") is never called (normalizeReplyPayload
    // filters it out), so stepResult stays at the initial "Step did not complete". Detect this
    // via the dispatch result: no final, no block, no tool queued → LLM produced no output.
    if (
      stepResult.error_detail === "Step did not complete" &&
      !stepResult.success &&
      dispatchResult
    ) {
      const c = dispatchResult.counts;
      const totalQueued = (c?.final ?? 0) + (c?.block ?? 0) + (c?.tool ?? 0);
      if (totalQueued === 0) {
        stepResult = {
          ...stepResult,
          error_detail:
            "LLM returned empty or NO_REPLY — no output was produced for this step. " +
            "This usually means the model's context was too large, the prompt was filtered, " +
            "or the model declined to respond. Check the agent's session/context size.",
        };
      }
    }
  } catch (err: any) {
    // Timeout, LLM throw, or dispatcher rejection — capture real reason for frontend
    const errMsg = err?.message ?? String(err);
    stepResult = {
      success: false,
      result_summary: "",
      output_files: [],
      error_detail:
        errMsg.includes("timeout") || errMsg.includes("timed out")
          ? `Step timed out after ${step.timeout_minutes}min. ${errMsg}`
          : `Step execution error: ${errMsg}`,
    };
  }

  // When run ended without complete_step/fail_step, use runner's final payload as the reason when it looks like an error.
  if (!stepResult.success && stepResult.error_detail === "Step did not complete") {
    const looksLikeError =
      lastFinalPayloadText &&
      /overflow|timeout|failed|error|⚠️|Agent failed|Context limit|rate limit|cut-off/i.test(
        lastFinalPayloadText,
      );
    if (looksLikeError && lastFinalPayloadText) {
      stepResult = {
        ...stepResult,
        error_detail: `Run ended without complete_step or fail_step. ${lastFinalPayloadText.trim().slice(0, 1500)}`,
      };
    } else {
      const activity = lastActivityDetail
        ? ` Last activity before run ended: ${lastActivityDetail}.`
        : " No tool or block output was recorded.";
      stepResult = {
        ...stepResult,
        error_detail: "Run ended without the agent calling complete_step or fail_step." + activity,
      };
    }
  }

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

  const rawOutputDir2 = msg.metadata?.output_dir as string | undefined;
  const outputDir = rawOutputDir2
    ? fromChatroomUri(rawOutputDir2, chatroomCfg)
    : taskAssetsDir(chatroomCfg, chatroomCfg.agentId, taskId);
  ensureDir(outputDir);

  // Surface agreed deliverables (Worker confirmed at handshake); no orchestrator assumption
  const taskRecord = readTaskRecord(chatroomCfg, taskId);
  const agreedDel = taskRecord?.agreed_deliverables;
  const deliverableHint = agreedDel
    ? [
        ``,
        `AGREED DELIVERABLES (you confirmed): ${agreedDel.items.map((i) => i.extension).join(", ")}`,
        agreedDel.description ? `  ${agreedDel.description}` : "",
        `  Only these file types will be accepted. Documentation/notes are NOT deliverables.`,
      ]
        .filter(Boolean)
        .join("\n")
    : `\nYou must have called chatroom_confirm_deliverables before planning. Deliver only what you agreed.`;

  const taskContext = [
    `[CHATROOM TASK — STRICT PROTOCOL]`,
    `task_id: ${taskId}`,
    `assigned_by: ${msg.from}`,
    `output_dir: ${outputDir}`,
    ``,
    `INSTRUCTION:`,
    msg.content.text,
    deliverableHint,
    ``,
    `RULES (MUST follow — violations break the task protocol):`,
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
    `6. SENSITIVE OPERATIONS: call chatroom_request_permission ONLY when the operation is NOT the task objective.`,
    `   If the task is to "trigger the release pipeline" or "call Jenkins", do NOT request permission — proceed.`,
    `   Only request for: shell (system dirs, sudo, rm -rf), .env/credentials, systemctl/docker, or network to unrelated services.`,
    `   Example (only when not the task goal): chatroom_request_permission(task_id="${taskId}", operation_type="shell",`,
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
        const toolName = _extractToolName(payload);
        const rawDetail = text.slice(0, 300);
        appendTaskProgress(chatroomCfg, taskId, {
          phase: "tool_executed",
          detail: `[${toolName}] ${_redactDetail(rawDetail)}`,
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
          updateTaskRecord(chatroomCfg, taskId, {
            run_context_snapshot: {
              last_updated: nowISO(),
              success: false,
              error_detail: text.slice(0, 2000),
              note: "Legacy task run (no plan).",
            },
          } as Partial<TaskRecord>);
          sendTaskResult(chatroomCfg, taskId, text, "FAILED", logger, [], errType);
          return;
        }

        updateTaskRecord(chatroomCfg, taskId, {
          run_context_snapshot: {
            last_updated: nowISO(),
            success: true,
            note: "Legacy task run (no plan).",
          },
        } as Partial<TaskRecord>);
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
        updateTaskRecord(chatroomCfg, taskId, {
          run_context_snapshot: {
            last_updated: nowISO(),
            success: false,
            error_detail: errText.slice(0, 2000),
            note: `Legacy task run error [${errType}].`,
          },
        } as Partial<TaskRecord>);
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
      ragServiceUrl: (pluginCfg.ragServiceUrl as string) ?? undefined,
      workerTaskQueueMaxSize:
        typeof pluginCfg.workerTaskQueueMaxSize === "number"
          ? pluginCfg.workerTaskQueueMaxSize
          : undefined,
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
            resume_strategy: Type.Optional(
              Type.String({
                description:
                  "How to handle this task if NAS goes offline mid-execution. " +
                  "'continue' = keep going, sync later; 'restart' = redo from scratch; " +
                  "'wait_and_check' = check external process status first. " +
                  "Defaults based on target agent (art/audio=continue, git=wait_and_check, else=restart).",
              }),
            ),
            human_approval_required: Type.Optional(
              Type.Boolean({
                description:
                  "Set to true ONLY when the user explicitly used /human in their request. " +
                  "Otherwise omit or pass false so the worker's plan is auto-approved. " +
                  "Sensitive operations use #permission (chatroom_request_permission) separately.",
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
                resume_strategy?: ResumeStrategy;
                human_approval_required?: boolean;
              };
              // rag_free is set programmatically from the message that triggered this dispatch (no LLM parameter)
              const currentMsg = chatroomCurrentMessageStorage.getStore()?.currentInboxMessage;
              const ragFree = currentMsg?.metadata?.rag_free === true;
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
                longRunning: p.long_running,
                resumeStrategy: p.resume_strategy,
                humanApprovalRequired: p.human_approval_required === true,
                ragFree,
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
                      `  resume_strategy: ${task.resume_strategy}\n` +
                      `  status: DISPATCHED (awaiting ACK)\n` +
                      `The worker will confirm what they will deliver; you accept only against that agreement.`,
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

      // ── Tool: close/accept task (orchestrator only) ─────────────────────────

      if (cfg.role === "orchestrator") {
        api.registerTool(
          {
            name: "chatroom_close_task",
            label: "Chatroom: Close Task",
            description:
              "Close a DELIVERED task after reviewing the agent's output.\n" +
              "Only the orchestrator can close tasks. Call this after verifying the output files are correct.\n" +
              "Use verdict='accepted' if the deliverables are satisfactory, or 'rejected' to send back for rework.",
            parameters: Type.Object({
              task_id: Type.String({ description: "Task ID to close" }),
              verdict: Type.Union([Type.Literal("accepted"), Type.Literal("rejected")], {
                description: "'accepted' to mark DONE, 'rejected' to request rework",
              }),
              comment: Type.Optional(
                Type.String({ description: "Review comment (required if rejected)" }),
              ),
            }),
            async execute(_toolCallId, params) {
              try {
                const p = params as {
                  task_id: string;
                  verdict: "accepted" | "rejected";
                  comment?: string;
                };
                const task = readTaskRecord(cfg, p.task_id);
                if (!task) {
                  return {
                    content: [{ type: "text" as const, text: `Task ${p.task_id} not found.` }],
                    details: undefined,
                  };
                }
                if (task.status !== "DELIVERED") {
                  return {
                    content: [
                      {
                        type: "text" as const,
                        text: `Task ${p.task_id} is not in DELIVERED state (current: ${task.status}). Only DELIVERED tasks can be closed.`,
                      },
                    ],
                    details: undefined,
                  };
                }

                if (p.verdict === "accepted") {
                  const validation = validateDeliveryForAcceptance(cfg, task, logger);
                  if (!validation.ok) {
                    return {
                      content: [
                        {
                          type: "text" as const,
                          text: `Cannot accept task ${p.task_id}: ${validation.reason} Use verdict="rejected" with a comment to request rework.`,
                        },
                      ],
                      details: undefined,
                    };
                  }
                  updateTaskRecord(cfg, p.task_id, {
                    status: "DONE",
                    completed_at: nowISO(),
                    current_phase: "completed",
                  });
                  const note = p.comment ? `\n\nReview: ${p.comment}` : "";
                  sendMessageToNAS(
                    cfg,
                    "general",
                    `✅ **Task closed** — \`${p.task_id.slice(0, 8)}\` by **${task.to}** accepted.${note}`,
                    "CHAT",
                    [],
                    undefined,
                    { task_id: p.task_id },
                  );
                  sendMessageToNAS(
                    cfg,
                    task.channel_id,
                    `[SYSTEM] Task ${p.task_id} has been reviewed and accepted by the orchestrator.${note}`,
                    "STATUS_UPDATE",
                    [task.to],
                    undefined,
                    { task_id: p.task_id, status: "DONE" },
                  );
                  logger.info(`Task ${p.task_id} ACCEPTED and closed`);
                  return {
                    content: [
                      {
                        type: "text" as const,
                        text: `Task ${p.task_id} accepted and closed. Agent ${task.to} notified.`,
                      },
                    ],
                    details: { task_id: p.task_id, status: "DONE" },
                  };
                } else {
                  updateTaskRecord(cfg, p.task_id, {
                    status: "PROCESSING",
                    current_phase: "rework",
                  });
                  const reason = p.comment || "Output did not meet requirements.";
                  sendMessageToNAS(
                    cfg,
                    task.channel_id,
                    `[REVIEW] Task ${p.task_id} result rejected — rework needed.\n\nReason: ${reason}`,
                    "TASK_DISPATCH",
                    [task.to],
                    undefined,
                    {
                      task_id: p.task_id,
                      status: "PROCESSING",
                      rework: true,
                      rework_reason: reason,
                    },
                  );
                  logger.info(`Task ${p.task_id} REJECTED — sent back to ${task.to} for rework`);
                  return {
                    content: [
                      {
                        type: "text" as const,
                        text: `Task ${p.task_id} rejected and sent back to ${task.to} for rework. Reason: ${reason}`,
                      },
                    ],
                    details: { task_id: p.task_id, status: "PROCESSING" },
                  };
                }
              } catch (err) {
                return {
                  content: [{ type: "text" as const, text: `Error closing task: ${err}` }],
                  details: undefined,
                };
              }
            },
          },
          { names: ["chatroom_close_task"] },
        );
      }

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

      // ── Tool: ask question (worker → orchestrator for routing) ────────────

      api.registerTool(
        {
          name: "chatroom_ask_question",
          label: "Chatroom: Ask Question",
          description:
            "Ask a question about your task. The question will be sent to the Orchestrator (FirstClaw),\n" +
            "who will route it to the most appropriate agent for an answer.\n" +
            "Use this when you need clarification about the task requirements or need information\n" +
            "from another agent's domain.",
          parameters: Type.Object({
            task_id: Type.String({ description: "The task ID this question relates to" }),
            question: Type.String({ description: "Your question" }),
            context: Type.Optional(
              Type.String({ description: "Additional context to help route the question" }),
            ),
          }),
          async execute(_toolCallId, params) {
            try {
              const p = params as { task_id: string; question: string; context?: string };
              const orchestratorDM = `dm_${cfg.agentId}`;
              sendMessageToNAS(
                cfg,
                orchestratorDM,
                `[PLAN_QUESTION] ${p.question}${p.context ? `\n\nContext: ${p.context}` : ""}`,
                "PLAN_QUESTION",
                ["firstclaw"],
                undefined,
                {
                  task_id: p.task_id,
                  from_agent_id: cfg.agentId,
                  to_agent_id: "firstclaw",
                  question: p.question,
                  question_context: p.context,
                },
              );
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Question sent to Orchestrator for routing. You will receive an answer via ANSWER_FORWARD message.`,
                  },
                ],
                details: { task_id: p.task_id, question: p.question },
              };
            } catch (err) {
              return {
                content: [{ type: "text" as const, text: `Error: ${err}` }],
                details: undefined,
              };
            }
          },
        },
        { names: ["chatroom_ask_question"] },
      );

      // ── Tool: answer a forwarded question ───────────────────────────────────

      api.registerTool(
        {
          name: "chatroom_answer_question",
          label: "Chatroom: Answer Question",
          description:
            "Answer a question that was forwarded to you by the Orchestrator.\n" +
            "Your answer will be routed back to the agent who asked.",
          parameters: Type.Object({
            source_task_id: Type.String({ description: "The task ID the question relates to" }),
            source_agent_id: Type.String({ description: "The agent who asked the question" }),
            answer: Type.String({ description: "Your answer" }),
          }),
          async execute(_toolCallId, params) {
            try {
              const p = params as {
                source_task_id: string;
                source_agent_id: string;
                answer: string;
              };
              const orchestratorDM = `dm_${cfg.agentId}`;
              sendMessageToNAS(
                cfg,
                orchestratorDM,
                p.answer,
                "QUESTION_ANSWER",
                ["firstclaw"],
                undefined,
                {
                  source_task_id: p.source_task_id,
                  source_agent_id: p.source_agent_id,
                  from_agent_id: cfg.agentId,
                  to_agent_id: "firstclaw",
                },
              );
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Answer sent to Orchestrator for forwarding to ${p.source_agent_id}.`,
                  },
                ],
                details: { source_agent_id: p.source_agent_id },
              };
            } catch (err) {
              return {
                content: [{ type: "text" as const, text: `Error: ${err}` }],
                details: undefined,
              };
            }
          },
        },
        { names: ["chatroom_answer_question"] },
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

    // ── Tool: RAG query (retrieval augmented generation) ──────────────────

    /**
     * Resolve the best Chatroom channel for RAG usage reports.
     * Priority: current task's channel → dm_<agentId> (worker) → general (orchestrator).
     */
    function resolveReportChannel(): string {
      try {
        const regPath = path.join(chatroomRoot(cfg), "registry", `${cfg.agentId}.json`);
        const info = readJson(regPath);
        if (info?.current_task) {
          const task = readTaskRecord(cfg, info.current_task);
          if (task?.channel_id) return task.channel_id;
        }
      } catch {
        // fall through to defaults
      }
      return cfg.role === "orchestrator" ? "general" : `dm_${cfg.agentId}`;
    }

    api.registerTool(
      {
        name: "rag_query",
        label: "RAG: Query Project Knowledge",
        description:
          "Query the project RAG (Retrieval Augmented Generation) system to retrieve relevant project context.\n" +
          "IMPORTANT: You SHOULD call this tool before starting any task to understand the project context.\n" +
          "The RAG contains project documentation, design specs, codebase knowledge, and prior decisions.",
        parameters: Type.Object({
          query: Type.String({
            description:
              "Natural language query about the project (e.g. 'What is the art style guide?')",
          }),
          max_results: Type.Optional(
            Type.Number({ description: "Maximum number of results to return (default 5)" }),
          ),
        }),
        async execute(_toolCallId, params) {
          const p = params as { query: string; max_results?: number };
          const ragServiceUrl =
            process.env.RAG_SERVICE_URL || cfg.ragServiceUrl || "http://localhost:8000";
          const url = `${ragServiceUrl}/query`;
          const reportChannel = resolveReportChannel();

          // ── [RAG][QUERY] report ──
          try {
            sendMessageToNAS(cfg, reportChannel, `[RAG][QUERY] ${p.query}`, "STATUS_UPDATE");
          } catch (e) {
            logger.warn(`RAG report (QUERY) failed: ${e}`);
          }

          try {
            const response = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                query: p.query,
                top_k: p.max_results ?? 5,
              }),
            });

            if (!response.ok) {
              const errText = await response.text();
              const errMsg = `RAG query failed (${response.status}): ${errText}`;

              // ── [RAG][ERROR] report ──
              try {
                sendMessageToNAS(
                  cfg,
                  reportChannel,
                  `[RAG][ERROR] strategy: unavailable | ${errMsg}`,
                  "STATUS_UPDATE",
                );
              } catch (e) {
                logger.warn(`RAG report (ERROR) failed: ${e}`);
              }

              return {
                content: [
                  {
                    type: "text" as const,
                    text:
                      errMsg +
                      "\n\n⚠️ IMPORTANT: Because the RAG query failed, you have NO verified project knowledge. " +
                      "Do NOT fabricate or guess project details. If the user's question requires project-specific information, " +
                      "honestly state that the RAG knowledge base is currently unavailable and you cannot provide an accurate answer.",
                  },
                ],
                details: undefined,
              };
            }

            const data = (await response.json()) as {
              answer: string;
              sources: { text: string; source: string; score: number }[];
              strategy: string;
              latency_ms: number;
            };

            const sources = data.sources ?? [];

            // Build readable output
            let text = `RAG query: "${p.query}"\nStrategy: ${data.strategy || "unknown"} | Latency: ${Math.round(data.latency_ms)}ms\n\n`;
            text += `Answer:\n${data.answer}\n`;

            if (sources.length > 0) {
              text += `\nSources (${sources.length}):\n`;
              text += sources
                .map(
                  (s, i) =>
                    `[${i + 1}] ${s.source || "unknown"} (score: ${s.score.toFixed(3)})\n${s.text}`,
                )
                .join("\n\n---\n\n");
            }

            // ── [RAG][RESPONSE] report (includes strategy) ──
            const sourceSummary =
              sources.length > 0
                ? sources.map((s, i) => `[${i + 1}] ${s.source || "unknown"}`).join(", ")
                : "none";
            try {
              sendMessageToNAS(
                cfg,
                reportChannel,
                `[RAG][RESPONSE] strategy: ${data.strategy || "unknown"} | sources: ${sourceSummary}\n${data.answer}`,
                "STATUS_UPDATE",
              );
            } catch (e) {
              logger.warn(`RAG report (RESPONSE) failed: ${e}`);
            }

            return {
              content: [{ type: "text" as const, text }],
              details: data,
            };
          } catch (err) {
            const errMsg = `RAG query error: ${err}. The RAG service may not be running.`;

            // ── [RAG][ERROR] report ──
            try {
              sendMessageToNAS(
                cfg,
                reportChannel,
                `[RAG][ERROR] strategy: unavailable | ${errMsg}`,
                "STATUS_UPDATE",
              );
            } catch (e) {
              logger.warn(`RAG report (ERROR) failed: ${e}`);
            }

            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    errMsg +
                    "\n\n⚠️ IMPORTANT: Because the RAG service is unreachable, you have NO verified project knowledge. " +
                    "Do NOT fabricate or guess project details. If the user's question requires project-specific information, " +
                    "honestly state that the RAG knowledge base is currently unavailable and you cannot provide an accurate answer.",
                },
              ],
              details: undefined,
            };
          }
        },
      },
      { names: ["rag_query"] },
    );

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
              const result = publishFileToNAS(detectedPath, dir, p.filename, cfg);
              const uri = toChatroomUri(result.nasPath, cfg);
              return {
                content: [
                  {
                    type: "text" as const,
                    text:
                      `[AUTO-CORRECTED] Detected file path in content — copied file directly instead.\n` +
                      `File published to NAS (verified): ${uri} (${formatFileSize(result.sourceSize)}, MD5: ${result.md5})\n` +
                      `TIP: Next time, use chatroom_publish_file(source_path="${detectedPath}") for binary files.`,
                  },
                ],
                details: { ...result, nasPath: uri },
              };
            }

            const filePath = toForwardSlash(path.join(dir, p.filename));

            if (p.encoding === "base64") {
              const buf = Buffer.from(p.content, "base64");
              nasWriteFile(cfg, filePath, buf);
              const uri = toChatroomUri(filePath, cfg);
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
                    text: `File saved: ${uri} (${formatFileSize(buf.length)})${sizeNote}${binNote}`,
                  },
                ],
                details: { path: uri, size: buf.length },
              };
            }

            nasWriteFile(cfg, filePath, p.content);
            const uri = toChatroomUri(filePath, cfg);
            return {
              content: [
                {
                  type: "text" as const,
                  text: `File saved: ${uri} (${fs.statSync(filePath).size} bytes)`,
                },
              ],
              details: { path: uri, size: fs.statSync(filePath).size },
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
            description: "Target channel ID (e.g. 'general', 'dm_art')",
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
            description: "Target channel ID (e.g. 'general', 'dm_art')",
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
              const pubResult = publishFileToNAS(detectedPath, dir, p.filename, cfg);
              const pubUri = toChatroomUri(pubResult.nasPath, cfg);
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
                  asset_paths: [pubUri],
                },
              );
              return {
                content: [
                  {
                    type: "text" as const,
                    text:
                      `[AUTO-CORRECTED] Detected file path in content — copied file directly.\n` +
                      `File published and sent to #${p.channel_id} (seq: ${sendResult.seq}, verified):\n` +
                      `  URI: ${pubUri} (${formatFileSize(pubResult.sourceSize)}, MD5: ${pubResult.md5})\n` +
                      `TIP: Next time, use chatroom_publish_and_send(source_path="${detectedPath}") for binary files.`,
                  },
                ],
                details: { ...pubResult, seq: sendResult.seq },
              };
            }

            const filePath = toForwardSlash(path.join(dir, p.filename));

            if (p.encoding === "base64") {
              nasWriteFile(cfg, filePath, Buffer.from(p.content, "base64"));
            } else {
              nasWriteFile(cfg, filePath, p.content);
            }

            const fileSize = Buffer.byteLength(
              p.content,
              p.encoding === "base64" ? "base64" : "utf-8",
            );
            const fileUri = toChatroomUri(filePath, cfg);
            const msgText = p.text ?? `📎 ${p.filename}`;
            const result = sendMessageToNAS(cfg, p.channel_id, msgText, "CHAT", [], undefined, {
              asset_paths: [fileUri],
            });

            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `File uploaded and message sent to #${p.channel_id} (seq: ${result.seq})\n` +
                    `  URI: ${fileUri} (${fileSize} bytes)`,
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
            const result = publishFileToNAS(p.source_path, dir, p.filename, cfg);
            const uri = toChatroomUri(result.nasPath, cfg);
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `File published to NAS (verified):\n` +
                    `  Source: ${p.source_path}\n` +
                    `  URI: ${uri}\n` +
                    `  Size: ${formatFileSize(result.sourceSize)}\n` +
                    `  MD5: ${result.md5}`,
                },
              ],
              details: { ...result, nasPath: uri },
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
            description: "Target channel ID (e.g. 'general', 'dm_art')",
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
            const result = publishFileToNAS(p.source_path, dir, p.filename, cfg);
            const uri = toChatroomUri(result.nasPath, cfg);

            const displayName = p.filename ?? path.basename(p.source_path);
            const msgText = p.text ?? `📎 ${displayName}`;
            const sendResult = sendMessageToNAS(cfg, p.channel_id, msgText, "CHAT", [], undefined, {
              asset_paths: [uri],
            });

            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `File published and message sent to #${p.channel_id} (seq: ${sendResult.seq}, verified):\n` +
                    `  URI: ${uri}\n` +
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

            const dirUri = toChatroomUri(targetDir, cfg);
            if (!fs.existsSync(targetDir)) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Directory does not exist: ${dirUri}`,
                  },
                ],
                details: { files: [], dir: dirUri },
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
                  path: toChatroomUri(fullPath, cfg),
                  size: formatFileSize(stat.size),
                  type: path.extname(entry.name).toLowerCase() || "(no ext)",
                });
              } else if (entry.isDirectory()) {
                dirs.push(entry.name);
              }
            }

            const lines: string[] = [`Directory: ${dirUri}`];
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
              details: { dir: dirUri, files, dirs },
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

    // ── Tool: confirm deliverables (Worker only; handshake before planning) ─

    api.registerTool(
      {
        name: "chatroom_confirm_deliverables",
        label: "Chatroom: Confirm Deliverables",
        description:
          "Declare what you will deliver for this task. You MUST call this before creating your plan.\n" +
          "The orchestrator will only accept deliverables that match this agreement (e.g. two .zip files).\n" +
          "Do not assume the orchestrator expects specific formats — you declare what you will produce.",
        parameters: Type.Object({
          task_id: Type.String({ description: "The task ID" }),
          work_summary: Type.Optional(
            Type.String({ description: "One-sentence summary of what you will do" }),
          ),
          description: Type.Optional(
            Type.String({ description: "Short description of the deliverables" }),
          ),
          items: Type.Array(
            Type.Object({
              extension: Type.String({
                description: 'File extension including dot, e.g. ".zip", ".ipa", ".apk"',
              }),
            }),
            {
              description:
                'List of expected files by extension. One item per file. e.g. [{ extension: ".zip" }, { extension: ".zip" }] for two zips.',
            },
          ),
        }),
        async execute(_toolCallId, params) {
          try {
            const p = params as {
              task_id: string;
              work_summary?: string;
              description?: string;
              items: { extension: string }[];
            };
            if (cfg.role !== "worker") {
              return {
                content: [
                  { type: "text" as const, text: "Only workers can confirm deliverables." },
                ],
                details: undefined,
              };
            }
            const task = readTaskRecord(cfg, p.task_id);
            if (!task) {
              return {
                content: [{ type: "text" as const, text: `Task ${p.task_id} not found.` }],
                details: undefined,
              };
            }
            if (task.to !== cfg.agentId) {
              return {
                content: [{ type: "text" as const, text: "This task is not assigned to you." }],
                details: undefined,
              };
            }
            if (task.agreed_deliverables) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Deliverables already confirmed for task ${p.task_id}. No change.`,
                  },
                ],
                details: task.agreed_deliverables,
              };
            }
            if (!p.items?.length) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: 'items must be a non-empty array of { extension: ".ext" }.',
                  },
                ],
                details: undefined,
              };
            }
            const agreed: AgreedDeliverables = {
              work_summary: p.work_summary,
              description: p.description,
              items: p.items.map((i) => ({
                extension: i.extension.startsWith(".") ? i.extension : `.${i.extension}`,
              })),
            };
            updateTaskRecord(cfg, p.task_id, {
              agreed_deliverables: agreed,
            } as Partial<TaskRecord>);
            const summary =
              `Task ${p.task_id} **deliverables confirmed** by ${cfg.agentId}. ` +
              `Will deliver: ${agreed.items.map((i) => i.extension).join(", ")}` +
              (agreed.work_summary ? ` — ${agreed.work_summary}` : ".");
            sendMessageToNAS(
              cfg,
              task.channel_id,
              summary,
              "TASK_DELIVERABLES_CONFIRMED",
              [task.from],
              undefined,
              {
                task_id: p.task_id,
                agreed_deliverables: agreed,
              },
            );
            logger.info(
              `Task ${p.task_id}: agreed_deliverables set (${agreed.items.length} item(s))`,
            );
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Deliverables confirmed. You can now call chatroom_create_plan.`,
                },
              ],
              details: agreed,
            };
          } catch (err) {
            return {
              content: [{ type: "text" as const, text: `Error: ${err}` }],
              details: undefined,
            };
          }
        },
      },
      { names: ["chatroom_confirm_deliverables"] },
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

            const parkedAt = nowISO();
            updateTaskRecord(cfg, p.task_id, {
              status: "PARKED",
              current_phase: `parked_${watchType}`,
              parked_at: parkedAt,
            } as Partial<TaskRecord>);
            appendTaskProgress(cfg, p.task_id, {
              phase: "parked",
              detail: `Parked: watching ${watchType} (poll every ${pollInterval / 1000}s, max ${maxWaitMinutes}min)`,
            });

            // Notify orchestrator so it knows the task is waiting, not failed
            const parkSummary =
              `Task ${p.task_id} is **PARKED** (waiting for ${watchType}). ` +
              `Max wait: ${maxWaitMinutes} min. Parked at ${parkedAt}. ` +
              `The agent will resume automatically when the condition is met.`;
            sendMessageToNAS(
              cfg,
              task.channel_id,
              parkSummary,
              "TASK_PARKED",
              [task.from],
              undefined,
              {
                task_id: p.task_id,
                status: "PARKED",
                parked_at: parkedAt,
                max_wait_minutes: maxWaitMinutes,
                watch_type: watchType,
              },
            );

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
          "Request human admin approval before executing a sensitive operation that is NOT the task objective.\n" +
          "Do NOT call this for operations that are the direct goal of the task (e.g. task says 'trigger release pipeline' and you are triggering it).\n" +
          "Only use for operations outside the task: shell (system dirs, sudo, rm -rf), .env/credentials, systemctl/docker, network to unrelated APIs.\n\n" +
          "Use this BEFORE performing such out-of-scope operations:\n" +
          "  - Shell commands that modify system directories (outside workspace)\n" +
          "  - Reading or writing sensitive files (.env, credentials, keys)\n" +
          "  - System-level operations (chmod, chown, systemctl, docker rm)\n" +
          "  - Network mutations to services not related to the task goal\n\n" +
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
            // Plan approval mode must match actual behavior: only /human (task.human_approval_required) triggers human approval
            const taskForPlan = readTaskRecord(cfg, p.task_id);
            const approvalMode =
              (taskForPlan as any)?.human_approval_required === true ? "human" : "orchestrator";
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

            // Send plan to DM channel so it's visible in chat
            const taskRecord = readTaskRecord(cfg, p.task_id);
            if (taskRecord) {
              const stepsText = plan.steps
                .map(
                  (s: any) =>
                    `${s.order}. **${s.title}** (~${s.estimated_minutes}min)\n   ${s.description}`,
                )
                .join("\n");
              const planMsgText =
                `📋 **Execution Plan** — ${plan.summary}\n\n` +
                `${stepsText}\n\n` +
                `Estimated total: ~${plan.estimated_total_minutes} min · ` +
                `${plan.steps.length} steps · ` +
                `Approval: ${approvalMode === "human" ? "Human required" : "Orchestrator can decide"}`;
              sendMessageToNAS(
                cfg,
                taskRecord.channel_id,
                planMsgText,
                "PLAN_CREATED",
                [taskRecord.from],
                undefined,
                {
                  task_id: p.task_id,
                  plan_id: plan.plan_id,
                  plan_status: plan.status,
                  plan_summary: plan.summary,
                  plan_steps: plan.steps,
                  estimated_total_minutes: plan.estimated_total_minutes,
                  approval_mode: approvalMode,
                },
              );
            }

            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `Plan created for task ${p.task_id}.\n` +
                    `  plan_id: ${plan.plan_id}\n` +
                    `  steps: ${plan.steps.length}\n` +
                    `  estimated_total: ${plan.estimated_total_minutes}min\n` +
                    `  approval_mode: ${approvalMode}\n\n` +
                    `STOP — planning phase is complete. Do NOT execute any steps now.\n` +
                    `The system will approve the plan and invoke you for each step separately.`,
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
          "IMPORTANT: Set is_final_deliverable=true ONLY for files that are the actual task output\n" +
          "that downstream consumers need. Intermediate notes, plans, and documentation are NOT deliverables.\n\n" +
          "Example:\n" +
          '  chatroom_complete_step(task_id="abc", step_id="xyz",\n' +
          '    result_summary="Rendered hero image", output_files=["render.png"], is_final_deliverable=true)',
        parameters: Type.Object({
          task_id: Type.String({ description: "The task ID" }),
          step_id: Type.String({ description: "The step ID to mark as completed" }),
          result_summary: Type.String({ description: "Brief summary of what was accomplished" }),
          output_files: Type.Optional(
            Type.Array(Type.String(), { description: "Paths to files produced by this step" }),
          ),
          is_final_deliverable: Type.Optional(
            Type.Boolean({
              description:
                "Set to true if this step's output_files are FINAL DELIVERABLES for the task " +
                "(actual assets the requester needs). Leave false/omit for intermediate artifacts " +
                "like notes, briefs, specs, or plans. Only deliverable files are included in the " +
                "task result sent to the requester.",
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          try {
            const p = params as {
              task_id: string;
              step_id: string;
              result_summary: string;
              output_files?: string[];
              is_final_deliverable?: boolean;
            };
            const plan = updatePlanStep(cfg, p.task_id, p.step_id, {
              status: "COMPLETED",
              result_summary: p.result_summary,
              output_files: p.output_files ?? [],
              completed_at: nowISO(),
              is_final_deliverable: p.is_final_deliverable ?? false,
            } as any);
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
        if (cfg.role === "worker") workerQueueLogger = logger;

        // Start NAS health monitor and register sync + task-resume callbacks
        startNasHealthMonitor(cfg, logger);
        onNasStateChange((state, prev) => {
          if (state === "OFFLINE" && prev !== "OFFLINE") {
            // Mark active tasks as NAS-offline buffering
            try {
              const activeTasks = listTasksByStatus(cfg, "PROCESSING", "ACKED");
              for (const t of activeTasks) {
                if (t.to === cfg.agentId || t.from === cfg.agentId) {
                  updateTaskRecord(cfg, t.task_id, { current_phase: "nas_offline_buffering" });
                  appendTaskProgress(cfg, t.task_id, {
                    phase: "nas_offline_buffering",
                    detail: `NAS went offline. Strategy: ${t.resume_strategy ?? "restart"}`,
                  });
                }
              }
            } catch {
              /* updateTaskRecord already buffers locally */
            }
          }

          if (state === "ONLINE" && prev !== "ONLINE") {
            logger.info(`[sync] NAS back online — triggering WAL sync`);
            try {
              syncWalEntries(cfg, logger);
            } catch (err) {
              logger.error(`[sync] WAL sync failed: ${err}`);
            }

            // Apply resume strategies for tasks that were buffering
            try {
              applyResumeStrategies(cfg, logger);
            } catch (err) {
              logger.error(`[resume] Failed to apply resume strategies: ${err}`);
            }
          }
        });

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
                    if (cfg.role === "worker") {
                      const maxQueueSize = cfg.workerTaskQueueMaxSize ?? WORKER_TASK_QUEUE_MAX_SIZE;
                      if (workerTaskQueue.length >= maxQueueSize) {
                        logger.warn(
                          `[chatroom] worker task queue full (${maxQueueSize}), dropping TASK_DISPATCH ${msg.metadata?.task_id}`,
                        );
                      } else {
                        workerTaskQueue.push({ msg, cfg, runtime, config, logger });
                        logger.info(
                          `[chatroom] worker task enqueued, queue depth=${workerTaskQueue.length}`,
                        );
                      }
                    } else {
                      void handleIncomingTaskAsync(cfg, msg, runtime, config, logger);
                    }
                    break;
                  case "TASK_ACK":
                    handleTaskAck(cfg, msg, logger);
                    break;
                  case "DISPATCH_CONFIRMED":
                    logger.info(
                      `[handshake] DISPATCH_CONFIRMED received for task ${msg.metadata?.task_id} from ${msg.from}`,
                    );
                    break;
                  case "RESULT_REPORT":
                    handleTaskResult(cfg, msg, logger);
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
                  case "RESULT_ACK":
                    logger.info(
                      `[handshake] RESULT_ACK received for task ${msg.metadata?.task_id} — result delivery confirmed`,
                    );
                    break;
                  case "PLAN_QUESTION":
                    if (cfg.role === "orchestrator") {
                      await handlePlanQuestion(cfg, msg, runtime, config, logger);
                    }
                    break;
                  case "QUESTION_FORWARD":
                    if (cfg.role !== "orchestrator") {
                      await handleQuestionForward(cfg, msg, runtime, config, logger);
                    }
                    break;
                  case "QUESTION_ANSWER":
                    if (cfg.role === "orchestrator") {
                      handleQuestionAnswer(cfg, msg, logger);
                    }
                    break;
                  case "ANSWER_FORWARD":
                    logger.info(
                      `[question] Answer received for task ${msg.metadata?.source_task_id}: ${msg.content.text.slice(0, 100)}`,
                    );
                    break;
                  default:
                    await autoDispatchMessage(cfg, msg, runtime, config, logger);
                    break;
                }
              } catch (err) {
                logger.error(`Message handling failed for ${msg.message_id}: ${err}`);
              }
            }
            // After processing batch: drain worker task queue (one task at a time)
            if (cfg.role === "worker") tryDrainWorkerTaskQueue();
          } catch (err) {
            logger.error(`[poll] Poll cycle failed: ${err}`);
          }
        }, pollIntervalMs);

        // Task timeout / retry monitor (orchestrator only — workers don't dispatch tasks)
        if (cfg.role === "orchestrator") {
          taskMonitorTimer = setInterval(() => {
            void monitorPendingTasks(cfg, logger).catch(() => {
              /* ignore */
            });
          }, taskMonitorIntervalMs);
        }

        // Park monitor — checks parked task conditions (all agents)
        parkMonitorTimer = setInterval(() => {
          void monitorParkedTasks(cfg, runtime, config, logger).catch(() => {
            /* ignore */
          });
        }, parkMonitorIntervalMs);
      },
      stop: async () => {
        stopNasHealthMonitor();
        workerQueueLogger = null;
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
