import { writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { execSync } from "node:child_process";

const SYSTEMD_DIR = join(homedir(), ".config", "systemd", "user");
const SYSTEMD_SERVICE = "acp-discord.service";
const LAUNCHD_DIR = join(homedir(), "Library", "LaunchAgents");
const LAUNCHD_PLIST = "com.acp-discord.plist";

function getNpxPath(): string {
  return execSync("which npx", { encoding: "utf-8" }).trim();
}

export function enableAutostart(): void {
  const os = platform();

  if (os === "linux") {
    mkdirSync(SYSTEMD_DIR, { recursive: true });
    const npx = getNpxPath();
    const service = `[Unit]
Description=acp-discord daemon
After=network.target

[Service]
ExecStart=${npx} acp-discord daemon start
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
    const servicePath = join(SYSTEMD_DIR, SYSTEMD_SERVICE);
    writeFileSync(servicePath, service);
    execSync("systemctl --user daemon-reload");
    execSync(`systemctl --user enable ${SYSTEMD_SERVICE}`);
    console.log(`Enabled systemd service: ${servicePath}`);
    console.log("Run: systemctl --user start acp-discord");
  } else if (os === "darwin") {
    mkdirSync(LAUNCHD_DIR, { recursive: true });
    const npx = getNpxPath();
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.acp-discord</string>
  <key>ProgramArguments</key>
  <array>
    <string>${npx}</string>
    <string>acp-discord</string>
    <string>daemon</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${join(homedir(), ".acp-discord", "daemon.log")}</string>
  <key>StandardErrorPath</key>
  <string>${join(homedir(), ".acp-discord", "daemon.error.log")}</string>
</dict>
</plist>`;
    const plistPath = join(LAUNCHD_DIR, LAUNCHD_PLIST);
    writeFileSync(plistPath, plist);
    console.log(`Enabled launchd service: ${plistPath}`);
    console.log("Run: launchctl load " + plistPath);
  } else {
    console.error(`Auto-start not supported on ${os}. Use your OS service manager manually.`);
  }
}

export function disableAutostart(): void {
  const os = platform();

  if (os === "linux") {
    const servicePath = join(SYSTEMD_DIR, SYSTEMD_SERVICE);
    try {
      execSync(`systemctl --user disable ${SYSTEMD_SERVICE}`);
    } catch {
      // may not be enabled
    }
    if (existsSync(servicePath)) unlinkSync(servicePath);
    execSync("systemctl --user daemon-reload");
    console.log("Disabled systemd auto-start");
  } else if (os === "darwin") {
    const plistPath = join(LAUNCHD_DIR, LAUNCHD_PLIST);
    try {
      execSync(`launchctl unload ${plistPath}`);
    } catch {
      // may not be loaded
    }
    if (existsSync(plistPath)) unlinkSync(plistPath);
    console.log("Disabled launchd auto-start");
  } else {
    console.error(`Auto-start not supported on ${os}.`);
  }
}
