// SPDX-License-Identifier: Apache-2.0
/**
 * OS supervisor unit rendering for `iicp-node service` (#551).
 *
 * The node stays a foreground process (`iicp-node serve --node <name>`).
 * launchd/systemd own restart-on-failure, logs and background resilience.
 */
import * as os from "node:os";
import * as path from "node:path";
import { cloudflaredPath } from "./tunnel.js";

export interface ServiceUnit {
  platform: "launchd" | "systemd";
  name: string;
  path: string;
  content: string;
  statusHint: string;
  restartHint: string;
  uninstallHint: string;
  logHint: string;
}

export interface ManagerAction {
  command: string;
  args: string[];
  tolerateFailure?: boolean;
}

/** Pure service-manager action plan; execution stays in the CLI. */
export function managerActions(
  unit: ServiceUnit,
  operation: "install" | "status" | "restart" | "uninstall",
  noStart = false,
): ManagerAction[] {
  if (unit.platform === "systemd") {
    const service = `${unit.name}.service`;
    if (operation === "install") {
      return [
        { command: "systemctl", args: ["--user", "daemon-reload"] },
        { command: "systemctl", args: ["--user", "enable", service] },
        ...(!noStart ? [{ command: "systemctl", args: ["--user", "start", service] }] : []),
        {
          command: "systemctl",
          args: [
            "--user", "show", service,
            "--property=LoadState,ActiveState,SubState,UnitFileState,Restart,RestartUSec,Type,WatchdogUSec,NotifyAccess",
          ],
        },
        { command: "loginctl", args: ["show-user", process.env.USER ?? "", "--property=Linger"], tolerateFailure: true },
      ];
    }
    if (operation === "status") {
      return [{ command: "systemctl", args: ["--user", "show", service, "--property=LoadState,ActiveState,SubState,UnitFileState,Restart,RestartUSec,Type,WatchdogUSec,NotifyAccess"] }];
    }
    if (operation === "restart") return [{ command: "systemctl", args: ["--user", "restart", service] }];
    return [{ command: "systemctl", args: ["--user", "disable", "--now", service], tolerateFailure: true }];
  }

  const target = `gui/${process.getuid?.() ?? 0}`;
  const domain = `${target}/${unit.name}`;
  if (operation === "install") {
    return [
      { command: "launchctl", args: ["enable", domain] },
      { command: "launchctl", args: ["bootout", target, unit.path], tolerateFailure: true },
      { command: "launchctl", args: ["bootstrap", target, unit.path] },
      ...(!noStart ? [{ command: "launchctl", args: ["kickstart", "-k", domain] }] : []),
      { command: "launchctl", args: ["print", domain] },
    ];
  }
  if (operation === "status") return [{ command: "launchctl", args: ["print", domain] }];
  if (operation === "restart") return [{ command: "launchctl", args: ["kickstart", "-k", domain] }];
  return [{ command: "launchctl", args: ["bootout", target, unit.path], tolerateFailure: true }];
}

const SAFE_RE = /[^A-Za-z0-9_.-]+/g;

export function sanitizeServiceName(value: string): string {
  const cleaned = value.trim().replace(SAFE_RE, "-").replace(/^[-.]+|[-.]+$/g, "");
  if (!cleaned) throw new Error("service/node name must contain at least one safe character");
  return cleaned.slice(0, 80);
}

export function serviceLabel(node: string, name?: string): string {
  return sanitizeServiceName(name ?? `network.iicp.node.${sanitizeServiceName(node)}`);
}

function envValue(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function supervisorTunnelEnvironment(): Record<string, string> {
  const configuredPath = process.env.IICP_CLOUDFLARED_PATH;
  const binary = cloudflaredPath();
  if (configuredPath !== undefined && binary === null) {
    throw new Error("IICP_CLOUDFLARED_PATH must be an absolute path to an executable file");
  }

  const explicit = process.env.IICP_TUNNEL;
  let normalized: string | undefined;
  if (explicit !== undefined) {
    const value = explicit.trim().toLowerCase();
    if (["1", "true", "yes"].includes(value)) normalized = "1";
    else if (["0", "false", "no"].includes(value)) normalized = "0";
    else throw new Error("IICP_TUNNEL must be one of 1/true/yes or 0/false/no");
  }
  if (normalized === "1" && binary === null) {
    throw new Error(
      "IICP_TUNNEL=1 requires cloudflared; set IICP_CLOUDFLARED_PATH to its absolute executable path",
    );
  }

  const native = process.env.IICP_ENABLE_EXPERIMENTAL_NATIVE_TCP;
  let normalizedNative: string | undefined;
  if (native !== undefined) {
    const value = native.trim().toLowerCase();
    if (["1", "true", "yes"].includes(value)) normalizedNative = "1";
    else if (["0", "false", "no"].includes(value)) normalizedNative = "0";
    else throw new Error("IICP_ENABLE_EXPERIMENTAL_NATIVE_TCP must be one of 1/true/yes or 0/false/no");
  }

  return {
    ...(binary ? { IICP_CLOUDFLARED_PATH: binary } : {}),
    ...(normalized !== undefined ? { IICP_TUNNEL: normalized } : {}),
    ...(normalizedNative !== undefined ? { IICP_ENABLE_EXPERIMENTAL_NATIVE_TCP: normalizedNative } : {}),
  };
}

export function detectPlatform(requested = "auto"): "launchd" | "systemd" {
  if (requested === "launchd" || requested === "systemd") return requested;
  if (requested !== "auto") throw new Error("platform must be auto, launchd or systemd");
  return process.platform === "darwin" ? "launchd" : "systemd";
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function renderLaunchd(node: string, name?: string, executable = "iicp-node"): ServiceUnit {
  const label = serviceLabel(node, name);
  const home = os.homedir();
  const logDir = envValue("IICP_LOG_DIR", path.join(home, ".iicp", "logs"));
  const plist = path.join(home, "Library", "LaunchAgents", `${label}.plist`);
  const env: Record<string, string> = {
    IICP_NODE_NAME: node,
    IICP_AUTO_UPDATE: envValue("IICP_AUTO_UPDATE", "1"),
    IICP_AUTO_UPDATE_INTERVAL_S: envValue("IICP_AUTO_UPDATE_INTERVAL_S", "3600"),
    IICP_SUPERVISED: envValue("IICP_SUPERVISED", "1"),
    IICP_TUNNEL_DEAD_POLICY: envValue("IICP_TUNNEL_DEAD_POLICY", "auto"),
    IICP_LOG_DIR: logDir,
    ...supervisorTunnelEnvironment(),
  };
  const envXml = Object.entries(env)
    .map(([k, v]) => `    <key>${xmlEscape(k)}</key><string>${xmlEscape(v)}</string>`)
    .join("\n");
  const outLog = path.join(logDir, `${label}.out.log`);
  const errLog = path.join(logDir, `${label}.err.log`);
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(executable)}</string>
    <string>serve</string>
    <string>--node</string>
    <string>${xmlEscape(node)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${xmlEscape(outLog)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(errLog)}</string>
</dict>
</plist>
`;
  return {
    platform: "launchd",
    name: label,
    path: plist,
    content,
    statusHint: `launchctl print gui/$(id -u)/${label}`,
    restartHint: `launchctl kickstart -k gui/$(id -u)/${label}`,
    uninstallHint: `launchctl bootout gui/$(id -u) ${shellQuote(plist)}; rm -f ${shellQuote(plist)}`,
    logHint: `tail -f ${shellQuote(outLog)} ${shellQuote(errLog)}`,
  };
}

export function renderSystemd(node: string, name?: string, executable = "iicp-node"): ServiceUnit {
  const label = serviceLabel(node, name);
  const home = os.homedir();
  const unitPath = path.join(home, ".config", "systemd", "user", `${label}.service`);
  const logDir = envValue("IICP_LOG_DIR", path.join(home, ".iicp", "logs"));
  const env: Record<string, string> = {
    IICP_NODE_NAME: node,
    IICP_AUTO_UPDATE: envValue("IICP_AUTO_UPDATE", "1"),
    IICP_AUTO_UPDATE_INTERVAL_S: envValue("IICP_AUTO_UPDATE_INTERVAL_S", "3600"),
    IICP_SUPERVISED: envValue("IICP_SUPERVISED", "1"),
    IICP_TUNNEL_DEAD_POLICY: envValue("IICP_TUNNEL_DEAD_POLICY", "auto"),
    IICP_LOG_DIR: logDir,
    ...supervisorTunnelEnvironment(),
  };
  const envLines = Object.entries(env).map(([k, v]) => `Environment=${k}=${shellQuote(v)}`).join("\n");
  const content = `[Unit]
Description=IICP node ${node}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${executable} serve --node ${shellQuote(node)}
${envLines}
Restart=on-failure
RestartSec=30
WorkingDirectory=${shellQuote(home)}

[Install]
WantedBy=default.target
`;
  return {
    platform: "systemd",
    name: label,
    path: unitPath,
    content,
    statusHint: `systemctl --user status ${label}.service`,
    restartHint: `systemctl --user restart ${label}.service`,
    uninstallHint: `systemctl --user disable --now ${label}.service; rm -f ${shellQuote(unitPath)}; systemctl --user daemon-reload`,
    logHint: `journalctl --user -u ${label}.service -f`,
  };
}

export function renderServiceUnit(node: string, name?: string, platform = "auto", executable = "iicp-node"): ServiceUnit {
  return detectPlatform(platform) === "launchd"
    ? renderLaunchd(node, name, executable)
    : renderSystemd(node, name, executable);
}
