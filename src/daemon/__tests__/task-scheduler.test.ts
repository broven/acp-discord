import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TaskScheduler, type ScheduledTask } from "../task-scheduler.js";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("TaskScheduler", () => {
  let testDir: string;
  let scheduler: TaskScheduler;
  let firedTasks: ScheduledTask[];

  beforeEach(() => {
    testDir = join(tmpdir(), `task-scheduler-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    firedTasks = [];
    scheduler = new TaskScheduler(async (task) => {
      firedTasks.push(task);
    }, testDir);
  });

  afterEach(() => {
    scheduler.stop();
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe("CRUD", () => {
    it("creates a task with defaults", () => {
      scheduler.start();
      const task = scheduler.createTask({
        channel_id: "ch1",
        agent_name: "default",
        prompt: "do something",
        schedule_type: "interval",
        schedule_value: "3600",
        created_by: "user1",
      });

      expect(task.id).toBeTruthy();
      expect(task.channel_id).toBe("ch1");
      expect(task.agent_name).toBe("default");
      expect(task.prompt).toBe("do something");
      expect(task.status).toBe("active");
      expect(task.notify).toBe("on_error");
      expect(task.next_run).toBeTruthy();
    });

    it("lists tasks, optionally by channel", () => {
      scheduler.start();
      scheduler.createTask({
        channel_id: "ch1",
        agent_name: "default",
        prompt: "task1",
        schedule_type: "interval",
        schedule_value: "60",
        created_by: "user1",
      });
      scheduler.createTask({
        channel_id: "ch2",
        agent_name: "default",
        prompt: "task2",
        schedule_type: "interval",
        schedule_value: "60",
        created_by: "user1",
      });

      expect(scheduler.listTasks()).toHaveLength(2);
      expect(scheduler.listTasks("ch1")).toHaveLength(1);
      expect(scheduler.listTasks("ch1")[0].prompt).toBe("task1");
    });

    it("updates a task", () => {
      scheduler.start();
      const task = scheduler.createTask({
        channel_id: "ch1",
        agent_name: "default",
        prompt: "old prompt",
        schedule_type: "interval",
        schedule_value: "60",
        created_by: "user1",
      });

      const updated = scheduler.updateTask(task.id, { prompt: "new prompt", notify: "always" });
      expect(updated?.prompt).toBe("new prompt");
      expect(updated?.notify).toBe("always");
    });

    it("returns null when updating nonexistent task", () => {
      scheduler.start();
      expect(scheduler.updateTask("nonexistent", { prompt: "x" })).toBeNull();
    });

    it("rejects invalid schedule updates", () => {
      scheduler.start();
      const task = scheduler.createTask({
        channel_id: "ch1",
        agent_name: "default",
        prompt: "valid",
        schedule_type: "interval",
        schedule_value: "60",
        created_by: "user1",
      });

      expect(() =>
        scheduler.updateTask(task.id, { schedule_value: "not-a-number" }),
      ).toThrow("Invalid schedule");

      // Task should be unchanged after failed update
      const tasks = scheduler.listTasks();
      expect(tasks[0].schedule_value).toBe("60");
    });

    it("enforces channel isolation on update", () => {
      scheduler.start();
      const task = scheduler.createTask({
        channel_id: "ch1",
        agent_name: "default",
        prompt: "owned by ch1",
        schedule_type: "interval",
        schedule_value: "60",
        created_by: "user1",
      });

      // Cannot update from a different channel
      expect(scheduler.updateTask(task.id, { prompt: "hacked" }, "ch2")).toBeNull();
      expect(scheduler.listTasks()[0].prompt).toBe("owned by ch1");

      // Can update from the owning channel
      expect(scheduler.updateTask(task.id, { prompt: "updated" }, "ch1")?.prompt).toBe("updated");
    });

    it("enforces channel isolation on delete", () => {
      scheduler.start();
      const task = scheduler.createTask({
        channel_id: "ch1",
        agent_name: "default",
        prompt: "owned by ch1",
        schedule_type: "interval",
        schedule_value: "60",
        created_by: "user1",
      });

      // Cannot delete from a different channel
      expect(scheduler.deleteTask(task.id, "ch2")).toBe(false);
      expect(scheduler.listTasks()).toHaveLength(1);

      // Can delete from the owning channel
      expect(scheduler.deleteTask(task.id, "ch1")).toBe(true);
    });

    it("enforces channel isolation on getTaskLogs", () => {
      scheduler.start();
      const task1 = scheduler.createTask({
        channel_id: "ch1",
        agent_name: "default",
        prompt: "t1",
        schedule_type: "interval",
        schedule_value: "60",
        created_by: "user1",
      });
      const task2 = scheduler.createTask({
        channel_id: "ch2",
        agent_name: "default",
        prompt: "t2",
        schedule_type: "interval",
        schedule_value: "60",
        created_by: "user1",
      });

      const now = new Date();
      scheduler.logRun(task1.id, {
        startedAt: now, completedAt: now, durationMs: 0,
        status: "success", output: "out1", error: null,
      });
      scheduler.logRun(task2.id, {
        startedAt: now, completedAt: now, durationMs: 0,
        status: "success", output: "out2", error: null,
      });

      // Channel-scoped: only see own logs
      expect(scheduler.getTaskLogs(undefined, "ch1")).toHaveLength(1);
      expect(scheduler.getTaskLogs(undefined, "ch2")).toHaveLength(1);

      // Cannot see other channel's task logs by task_id
      expect(scheduler.getTaskLogs(task2.id, "ch1")).toHaveLength(0);
    });

    it("deletes a task", () => {
      scheduler.start();
      const task = scheduler.createTask({
        channel_id: "ch1",
        agent_name: "default",
        prompt: "to delete",
        schedule_type: "interval",
        schedule_value: "60",
        created_by: "user1",
      });

      expect(scheduler.deleteTask(task.id)).toBe(true);
      expect(scheduler.listTasks()).toHaveLength(0);
    });

    it("returns false when deleting nonexistent task", () => {
      scheduler.start();
      expect(scheduler.deleteTask("nonexistent")).toBe(false);
    });
  });

  describe("computeNextRun", () => {
    it("computes next run for once schedule (future)", () => {
      scheduler.start();
      const future = new Date(Date.now() + 60_000).toISOString();
      const task = scheduler.createTask({
        channel_id: "ch1",
        agent_name: "default",
        prompt: "once",
        schedule_type: "once",
        schedule_value: future,
        created_by: "user1",
      });

      expect(task.next_run).toBe(new Date(future).toISOString());
    });

    it("computes next run for cron schedule", () => {
      scheduler.start();
      const task = scheduler.createTask({
        channel_id: "ch1",
        agent_name: "default",
        prompt: "cron",
        schedule_type: "cron",
        schedule_value: "*/5 * * * *",
        created_by: "user1",
      });

      expect(task.next_run).toBeTruthy();
      const nextRun = new Date(task.next_run!);
      expect(nextRun.getTime()).toBeGreaterThan(Date.now());
    });

    it("computes next run for interval schedule", () => {
      scheduler.start();
      const task = scheduler.createTask({
        channel_id: "ch1",
        agent_name: "default",
        prompt: "interval",
        schedule_type: "interval",
        schedule_value: "300",
        created_by: "user1",
      });

      expect(task.next_run).toBeTruthy();
      const nextRun = new Date(task.next_run!);
      const diff = nextRun.getTime() - Date.now();
      expect(diff).toBeGreaterThan(290_000);
      expect(diff).toBeLessThan(310_000);
    });

    it("rejects invalid cron expression", () => {
      scheduler.start();
      expect(() =>
        scheduler.createTask({
          channel_id: "ch1",
          agent_name: "default",
          prompt: "bad cron",
          schedule_type: "cron",
          schedule_value: "not a cron",
          created_by: "user1",
        }),
      ).toThrow("Invalid schedule");
    });

    it("rejects invalid interval", () => {
      scheduler.start();
      expect(() =>
        scheduler.createTask({
          channel_id: "ch1",
          agent_name: "default",
          prompt: "bad interval",
          schedule_type: "interval",
          schedule_value: "not-a-number",
          created_by: "user1",
        }),
      ).toThrow("Invalid schedule");
    });

    it("anchors interval to last_run to prevent drift", () => {
      scheduler.start();
      const task = scheduler.createTask({
        channel_id: "ch1",
        agent_name: "default",
        prompt: "interval",
        schedule_type: "interval",
        schedule_value: "300",
        created_by: "user1",
      });

      // Simulate a past run
      const lastRun = new Date(Date.now() - 100_000);
      task.last_run = lastRun.toISOString();
      const nextRun = scheduler.computeNextRun(task);

      expect(nextRun).toBeTruthy();
      const nextDate = new Date(nextRun!);
      const expected = new Date(lastRun.getTime() + 300_000);
      expect(nextDate.getTime()).toBe(expected.getTime());
    });
  });

  describe("persistence", () => {
    it("saves and loads tasks across scheduler instances", () => {
      scheduler.start();
      scheduler.createTask({
        channel_id: "ch1",
        agent_name: "default",
        prompt: "persistent",
        schedule_type: "interval",
        schedule_value: "60",
        created_by: "user1",
      });
      scheduler.stop();

      const scheduler2 = new TaskScheduler(async () => {}, testDir);
      scheduler2.start();
      expect(scheduler2.listTasks()).toHaveLength(1);
      expect(scheduler2.listTasks()[0].prompt).toBe("persistent");
      scheduler2.stop();
    });
  });

  describe("run logging", () => {
    it("logs a run and retrieves it", () => {
      scheduler.start();
      const task = scheduler.createTask({
        channel_id: "ch1",
        agent_name: "default",
        prompt: "logged",
        schedule_type: "interval",
        schedule_value: "60",
        created_by: "user1",
      });

      const now = new Date();
      scheduler.logRun(task.id, {
        startedAt: now,
        completedAt: new Date(now.getTime() + 5000),
        durationMs: 5000,
        status: "success",
        output: "task output",
        error: null,
      });

      const logs = scheduler.getTaskLogs(task.id);
      expect(logs).toHaveLength(1);
      expect(logs[0].status).toBe("success");
      expect(logs[0].output).toBe("task output");
      expect(logs[0].task_description).toBe("logged");
    });

    it("filters logs by task id", () => {
      scheduler.start();
      const task1 = scheduler.createTask({
        channel_id: "ch1",
        agent_name: "default",
        prompt: "t1",
        schedule_type: "interval",
        schedule_value: "60",
        created_by: "user1",
      });
      const task2 = scheduler.createTask({
        channel_id: "ch1",
        agent_name: "default",
        prompt: "t2",
        schedule_type: "interval",
        schedule_value: "60",
        created_by: "user1",
      });

      const now = new Date();
      scheduler.logRun(task1.id, {
        startedAt: now, completedAt: now, durationMs: 0,
        status: "success", output: "out1", error: null,
      });
      scheduler.logRun(task2.id, {
        startedAt: now, completedAt: now, durationMs: 0,
        status: "error", output: "", error: "fail",
      });

      expect(scheduler.getTaskLogs(task1.id)).toHaveLength(1);
      expect(scheduler.getTaskLogs(task2.id)).toHaveLength(1);
      expect(scheduler.getTaskLogs()).toHaveLength(2);
    });
  });

  describe("poll", () => {
    it("fires due tasks", async () => {
      scheduler.start();
      const past = new Date(Date.now() - 1000).toISOString();
      scheduler.createTask({
        channel_id: "ch1",
        agent_name: "default",
        prompt: "fire me",
        schedule_type: "once",
        schedule_value: past,
        created_by: "user1",
      });

      // Wait for poll cycle (15s interval)
      await new Promise((r) => setTimeout(r, 16_000));

      expect(firedTasks).toHaveLength(1);
      expect(firedTasks[0].prompt).toBe("fire me");

      // Once task should be completed
      const tasks = scheduler.listTasks();
      expect(tasks[0].status).toBe("completed");
    }, 20_000);
  });
});
