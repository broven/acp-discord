import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function writePid(pidPath: string, pid: number): void {
  mkdirSync(dirname(pidPath), { recursive: true });
  writeFileSync(pidPath, String(pid), "utf-8");
}

export function readPid(pidPath: string): number | null {
  if (!existsSync(pidPath)) return null;
  const content = readFileSync(pidPath, "utf-8").trim();
  const pid = parseInt(content, 10);
  return isNaN(pid) ? null : pid;
}

export function removePid(pidPath: string): void {
  if (existsSync(pidPath)) unlinkSync(pidPath);
}

export function isDaemonRunning(pidPath: string): boolean {
  const pid = readPid(pidPath);
  if (pid === null) return false;
  try {
    process.kill(pid, 0); // signal 0 = check if process exists
    return true;
  } catch {
    return false;
  }
}
