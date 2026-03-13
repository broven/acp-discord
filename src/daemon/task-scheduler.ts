import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";

const DEFAULT_DATA_DIR = join(homedir(), ".acp-discord");
const MAX_LOGS_PER_TASK = 50;

export interface ScheduledTask {
  id: string;
  channel_id: string;
  agent_name: string;
  prompt: string;
  description: string;
  schedule_type: "once" | "cron" | "interval";
  schedule_value: string;
  status: "active" | "paused" | "completed";
  notify: "always" | "on_error" | "never";
  next_run: string | null;
  last_run: string | null;
  created_by: string;
  created_at: string;
}

export interface TaskRunLog {
  id: string;
  task_id: string;
  task_description: string;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  status: "success" | "error";
  output: string;
  error: string | null;
}

export interface TaskRunInput {
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
  status: "success" | "error";
  output: string;
  error: string | null;
}

export interface CreateTaskParams {
  channel_id: string;
  agent_name: string;
  prompt: string;
  description?: string;
  schedule_type: "once" | "cron" | "interval";
  schedule_value: string;
  notify?: "always" | "on_error" | "never";
  created_by: string;
}

export type OnTaskFire = (task: ScheduledTask) => Promise<void>;

export class TaskScheduler {
  private tasks: ScheduledTask[] = [];
  private logs: TaskRunLog[] = [];
  private interval: NodeJS.Timeout | null = null;
  private onTaskFire: OnTaskFire;
  private tasksPath: string;
  private logsPath: string;
  private dataDir: string;
  private inFlight = new Set<string>(); // task IDs currently running

  constructor(onTaskFire: OnTaskFire, dataDir?: string) {
    this.onTaskFire = onTaskFire;
    this.dataDir = dataDir ?? DEFAULT_DATA_DIR;
    this.tasksPath = join(this.dataDir, "scheduled-tasks.json");
    this.logsPath = join(this.dataDir, "task-run-logs.json");
  }

  start(): void {
    this.load();
    this.interval = setInterval(() => {
      this.poll().catch((err) => {
        console.error("TaskScheduler poll error:", err);
      });
    }, 15_000);
    console.log(`TaskScheduler started with ${this.tasks.length} task(s)`);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.save();
  }

  createTask(params: CreateTaskParams): ScheduledTask {
    const now = new Date().toISOString();
    const task: ScheduledTask = {
      id: randomUUID(),
      channel_id: params.channel_id,
      agent_name: params.agent_name,
      prompt: params.prompt,
      description: params.description ?? params.prompt.slice(0, 80),
      schedule_type: params.schedule_type,
      schedule_value: params.schedule_value,
      status: "active",
      notify: params.notify ?? "on_error",
      next_run: null,
      last_run: null,
      created_by: params.created_by,
      created_at: now,
    };

    task.next_run = this.computeNextRun(task);
    if (!task.next_run) {
      throw new Error(`Invalid schedule: cannot compute next run for ${params.schedule_type} "${params.schedule_value}"`);
    }

    this.tasks.push(task);
    this.save();
    return task;
  }

  listTasks(channelId?: string): ScheduledTask[] {
    if (channelId) {
      return this.tasks.filter((t) => t.channel_id === channelId);
    }
    return [...this.tasks];
  }

  updateTask(
    id: string,
    updates: Partial<Pick<ScheduledTask, "status" | "prompt" | "schedule_type" | "schedule_value" | "notify" | "description">>,
    channelId?: string,
  ): ScheduledTask | null {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return null;
    if (channelId && task.channel_id !== channelId) return null;

    if (updates.status !== undefined) task.status = updates.status;
    if (updates.prompt !== undefined) task.prompt = updates.prompt;
    if (updates.description !== undefined) task.description = updates.description;
    if (updates.notify !== undefined) task.notify = updates.notify;

    if (updates.schedule_type !== undefined || updates.schedule_value !== undefined) {
      // Save originals for rollback on validation failure
      const origType = task.schedule_type;
      const origValue = task.schedule_value;
      const origNextRun = task.next_run;

      if (updates.schedule_type !== undefined) task.schedule_type = updates.schedule_type;
      if (updates.schedule_value !== undefined) task.schedule_value = updates.schedule_value;
      const nextRun = this.computeNextRun(task);
      if (!nextRun) {
        // Rollback
        task.schedule_type = origType;
        task.schedule_value = origValue;
        task.next_run = origNextRun;
        throw new Error(`Invalid schedule: cannot compute next run for ${task.schedule_type} "${task.schedule_value}"`);
      }
      task.next_run = nextRun;
    }

    this.save();
    return task;
  }

  deleteTask(id: string, channelId?: string): boolean {
    const idx = this.tasks.findIndex((t) => t.id === id);
    if (idx === -1) return false;
    if (channelId && this.tasks[idx].channel_id !== channelId) return false;
    this.tasks.splice(idx, 1);
    this.save();
    return true;
  }

  getTaskLogs(taskId?: string, channelId?: string): TaskRunLog[] {
    let logs = this.logs;
    if (taskId) {
      // Verify the task belongs to the channel if channelId specified
      if (channelId) {
        const task = this.tasks.find((t) => t.id === taskId);
        if (task && task.channel_id !== channelId) return [];
      }
      logs = logs.filter((l) => l.task_id === taskId);
    } else if (channelId) {
      // Only return logs for tasks belonging to this channel
      const channelTaskIds = new Set(
        this.tasks.filter((t) => t.channel_id === channelId).map((t) => t.id),
      );
      logs = logs.filter((l) => channelTaskIds.has(l.task_id));
    }
    return [...logs];
  }

  logRun(taskId: string, result: TaskRunInput): void {
    const task = this.tasks.find((t) => t.id === taskId);
    const log: TaskRunLog = {
      id: randomUUID(),
      task_id: taskId,
      task_description: task?.description ?? "unknown",
      started_at: result.startedAt.toISOString(),
      completed_at: result.completedAt.toISOString(),
      duration_ms: result.durationMs,
      status: result.status,
      output: result.output.slice(0, 4000),
      error: result.error,
    };
    this.logs.push(log);

    // Trim logs per task
    const taskLogs = this.logs.filter((l) => l.task_id === taskId);
    if (taskLogs.length > MAX_LOGS_PER_TASK) {
      const idsToRemove = new Set(
        taskLogs
          .slice(0, taskLogs.length - MAX_LOGS_PER_TASK)
          .map((l) => l.id),
      );
      this.logs = this.logs.filter((l) => !idsToRemove.has(l.id));
    }

    this.saveLogs();
  }

  computeNextRun(task: ScheduledTask): string | null {
    const now = new Date();

    switch (task.schedule_type) {
      case "once": {
        const date = new Date(task.schedule_value);
        if (isNaN(date.getTime())) return null;
        return date > now ? date.toISOString() : date.toISOString();
      }

      case "cron": {
        try {
          const expr = CronExpressionParser.parse(task.schedule_value, { currentDate: now });
          const next = expr.next();
          return next.toDate().toISOString();
        } catch {
          return null;
        }
      }

      case "interval": {
        const seconds = parseInt(task.schedule_value, 10);
        if (isNaN(seconds) || seconds <= 0) return null;
        // Anchor to last_run to prevent drift
        const anchor = task.last_run ? new Date(task.last_run) : now;
        const next = new Date(anchor.getTime() + seconds * 1000);
        // If next is in the past, advance forward
        if (next <= now) {
          const elapsed = now.getTime() - anchor.getTime();
          const intervals = Math.ceil(elapsed / (seconds * 1000));
          return new Date(anchor.getTime() + intervals * seconds * 1000).toISOString();
        }
        return next.toISOString();
      }

      default:
        return null;
    }
  }

  private async poll(): Promise<void> {
    const now = new Date();

    for (const task of this.tasks) {
      if (task.status !== "active") continue;
      if (!task.next_run) continue;
      if (this.inFlight.has(task.id)) continue; // skip if already running

      const nextRun = new Date(task.next_run);
      if (nextRun > now) continue;

      // Mark as firing
      task.last_run = now.toISOString();

      if (task.schedule_type === "once") {
        task.status = "completed";
      } else {
        task.next_run = this.computeNextRun(task);
      }
      this.save();

      // Fire asynchronously with in-flight guard
      this.inFlight.add(task.id);
      this.onTaskFire(task)
        .catch((err) => {
          console.error(`Task fire error for ${task.id}:`, err);
        })
        .finally(() => {
          this.inFlight.delete(task.id);
        });
    }
  }

  private load(): void {
    mkdirSync(this.dataDir, { recursive: true });
    try {
      const data = readFileSync(this.tasksPath, "utf-8");
      this.tasks = JSON.parse(data);
    } catch {
      this.tasks = [];
    }
    try {
      const data = readFileSync(this.logsPath, "utf-8");
      this.logs = JSON.parse(data);
    } catch {
      this.logs = [];
    }
  }

  private save(): void {
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(this.tasksPath, JSON.stringify(this.tasks, null, 2));
  }

  private saveLogs(): void {
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(this.logsPath, JSON.stringify(this.logs, null, 2));
  }
}
