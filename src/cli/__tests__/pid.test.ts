import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writePid, readPid, removePid, isDaemonRunning } from "../pid.js";

const TEST_DIR = join(import.meta.dirname, ".tmp-pid-test");
const PID_PATH = join(TEST_DIR, "daemon.pid");

beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe("PID management", () => {
  it("writes and reads PID", () => {
    writePid(PID_PATH, 12345);
    expect(readPid(PID_PATH)).toBe(12345);
  });

  it("returns null when no PID file", () => {
    expect(readPid(PID_PATH)).toBeNull();
  });

  it("removes PID file", () => {
    writePid(PID_PATH, 12345);
    removePid(PID_PATH);
    expect(existsSync(PID_PATH)).toBe(false);
  });

  it("detects current process as running", () => {
    writePid(PID_PATH, process.pid);
    expect(isDaemonRunning(PID_PATH)).toBe(true);
  });

  it("detects stale PID as not running", () => {
    writePid(PID_PATH, 999999);
    expect(isDaemonRunning(PID_PATH)).toBe(false);
  });
});
