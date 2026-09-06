import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { managerActions, renderLaunchd, renderSystemd } from "../src/service.js";

describe("service supervisor unit rendering", () => {
  it("launchd unit runs foreground serve with hourly auto-update defaults", () => {
    delete process.env.IICP_AUTO_UPDATE;
    delete process.env.IICP_AUTO_UPDATE_INTERVAL_S;
    delete process.env.IICP_ENABLE_EXPERIMENTAL_NATIVE_TCP;
    const unit = renderLaunchd("mynode");

    assert.equal(unit.platform, "launchd");
    assert.ok(unit.path.endsWith("network.iicp.node.mynode.plist"));
    assert.ok(unit.content.includes("<string>serve</string>"));
    assert.ok(unit.content.includes("<string>--node</string>"));
    assert.ok(unit.content.includes("<string>mynode</string>"));
    assert.ok(unit.content.includes("<key>IICP_AUTO_UPDATE</key><string>1</string>"));
    assert.ok(unit.content.includes("<key>IICP_AUTO_UPDATE_INTERVAL_S</key><string>3600</string>"));
    assert.ok(unit.content.includes("<key>IICP_SUPERVISED</key><string>1</string>"));
    assert.ok(unit.content.includes("<key>IICP_TUNNEL_DEAD_POLICY</key><string>auto</string>"));
    assert.ok(unit.content.includes("<key>KeepAlive</key><true/>"));
    assert.ok(!unit.content.includes("<key>IICP_ENABLE_EXPERIMENTAL_NATIVE_TCP</key>"));
    assert.ok(!unit.content.includes("--daemon"));
  });

  it("systemd unit runs foreground serve with hourly auto-update defaults", () => {
    delete process.env.IICP_AUTO_UPDATE;
    delete process.env.IICP_AUTO_UPDATE_INTERVAL_S;
    delete process.env.IICP_ENABLE_EXPERIMENTAL_NATIVE_TCP;
    const unit = renderSystemd("mynode");

    assert.equal(unit.platform, "systemd");
    assert.ok(unit.path.endsWith("network.iicp.node.mynode.service"));
    assert.ok(unit.content.includes("ExecStart=iicp-node serve --node mynode"));
    assert.ok(unit.content.includes("Environment=IICP_AUTO_UPDATE=1"));
    assert.ok(unit.content.includes("Environment=IICP_AUTO_UPDATE_INTERVAL_S=3600"));
    assert.ok(unit.content.includes("Environment=IICP_SUPERVISED=1"));
    assert.ok(unit.content.includes("Environment=IICP_TUNNEL_DEAD_POLICY=auto"));
    assert.ok(unit.content.includes("Restart=on-failure"));
    assert.ok(!unit.content.includes("Environment=IICP_ENABLE_EXPERIMENTAL_NATIVE_TCP="));
    assert.ok(!unit.content.includes("--daemon"));
  });

  it("preserves only explicit tunnel policy and a resolved cloudflared binary", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "iicp-cloudflared-"));
    const binary = path.join(tmp, "cloudflared");
    fs.writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const oldOverride = process.env.IICP_CLOUDFLARED_PATH;
    const oldTunnel = process.env.IICP_TUNNEL;
    const oldNative = process.env.IICP_ENABLE_EXPERIMENTAL_NATIVE_TCP;
    try {
      process.env.IICP_CLOUDFLARED_PATH = binary;
      process.env.IICP_TUNNEL = "yes";
      process.env.IICP_ENABLE_EXPERIMENTAL_NATIVE_TCP = "yes";
      const launchd = renderLaunchd("mynode");
      const systemd = renderSystemd("mynode");
      const resolved = fs.realpathSync(binary);
      assert.ok(launchd.content.includes(`<key>IICP_CLOUDFLARED_PATH</key><string>${resolved}</string>`));
      assert.ok(launchd.content.includes("<key>IICP_TUNNEL</key><string>1</string>"));
      const quoted = /^[A-Za-z0-9_/:=.,@%+-]+$/.test(resolved) ? resolved : `'${resolved.replace(/'/g, `'\\''`)}'`;
      assert.ok(systemd.content.includes(`Environment=IICP_CLOUDFLARED_PATH=${quoted}`));
      assert.ok(systemd.content.includes("Environment=IICP_TUNNEL=1"));
      assert.ok(launchd.content.includes("<key>IICP_ENABLE_EXPERIMENTAL_NATIVE_TCP</key><string>1</string>"));
      assert.ok(systemd.content.includes("Environment=IICP_ENABLE_EXPERIMENTAL_NATIVE_TCP=1"));

      delete process.env.IICP_TUNNEL;
      assert.equal(renderLaunchd("mynode").content.includes("<key>IICP_TUNNEL</key>"), false);
    } finally {
      if (oldOverride === undefined) delete process.env.IICP_CLOUDFLARED_PATH;
      else process.env.IICP_CLOUDFLARED_PATH = oldOverride;
      if (oldTunnel === undefined) delete process.env.IICP_TUNNEL;
      else process.env.IICP_TUNNEL = oldTunnel;
      if (oldNative === undefined) delete process.env.IICP_ENABLE_EXPERIMENTAL_NATIVE_TCP;
      else process.env.IICP_ENABLE_EXPERIMENTAL_NATIVE_TCP = oldNative;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses an invalid override or unavailable forced tunnel", () => {
    const oldOverride = process.env.IICP_CLOUDFLARED_PATH;
    const oldTunnel = process.env.IICP_TUNNEL;
    const oldPath = process.env.PATH;
    try {
      process.env.IICP_CLOUDFLARED_PATH = "relative/cloudflared";
      delete process.env.IICP_TUNNEL;
      assert.throws(() => renderLaunchd("mynode"), /absolute path/);

      delete process.env.IICP_CLOUDFLARED_PATH;
      process.env.PATH = "";
      process.env.IICP_TUNNEL = "1";
      assert.throws(() => renderSystemd("mynode"), /requires cloudflared/);
    } finally {
      if (oldOverride === undefined) delete process.env.IICP_CLOUDFLARED_PATH;
      else process.env.IICP_CLOUDFLARED_PATH = oldOverride;
      if (oldTunnel === undefined) delete process.env.IICP_TUNNEL;
      else process.env.IICP_TUNNEL = oldTunnel;
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  });

  it("refuses an invalid experimental native setting", () => {
    const oldNative = process.env.IICP_ENABLE_EXPERIMENTAL_NATIVE_TCP;
    try {
      process.env.IICP_ENABLE_EXPERIMENTAL_NATIVE_TCP = "sometimes";
      assert.throws(() => renderLaunchd("mynode"), /must be one of/);
    } finally {
      if (oldNative === undefined) delete process.env.IICP_ENABLE_EXPERIMENTAL_NATIVE_TCP;
      else process.env.IICP_ENABLE_EXPERIMENTAL_NATIVE_TCP = oldNative;
    }
  });
});

describe("service manager lifecycle planning", () => {
  it("installs, enables, starts and verifies a systemd user service by default", () => {
    const unit = renderSystemd("mynode");
    const actions = managerActions(unit, "install");
    assert.deepEqual(actions.slice(0, 3).map(({ command, args }) => [command, ...args]), [
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "network.iicp.node.mynode.service"],
      ["systemctl", "--user", "start", "network.iicp.node.mynode.service"],
    ]);
    assert.ok(actions.some(({ command, args }) => command === "systemctl" && args.includes("--property=LoadState,ActiveState,SubState,UnitFileState,Restart,RestartUSec,Type,WatchdogUSec,NotifyAccess")));
    assert.ok(actions.some(({ command }) => command === "loginctl"));
  });

  it("supports install without activation and preserves a launchd verification step", () => {
    const actions = managerActions(renderLaunchd("mynode"), "install", true);
    assert.equal(actions.some(({ args }) => args.includes("kickstart")), false);
    assert.equal(actions.at(-1)?.args[0], "print");
  });
});

describe("iicp-node service CLI", () => {
  it("install --dry-run prints unit, hints and no daemon note without writing", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "iicp-service-"));
    const oldHome = process.env.HOME;
    process.env.HOME = tmp;
    const lines: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array, ...rest: unknown[]) => {
      if (typeof chunk === "string") lines.push(chunk);
      return orig(chunk, ...(rest as [BufferEncoding?, (() => void)?]));
    };
    try {
      const { main } = await import("../src/cli.js");
      const rc = await main(["service", "install", "--node", "mynode", "--platform", "systemd", "--dry-run"]);
      const out = lines.join("");
      assert.equal(rc, 0);
      assert.ok(out.includes("ExecStart=iicp-node serve --node mynode"));
      assert.ok(out.includes("IICP_AUTO_UPDATE_INTERVAL_S=3600"));
      assert.ok(out.includes("status:"));
      assert.ok(out.includes("restart:"));
      assert.ok(out.includes("logs:"));
      assert.ok(out.includes("no classic --daemon fork"));
      assert.ok(out.includes('"systemctl" "--user" "daemon-reload"'));
      assert.ok(out.includes('"systemctl" "--user" "start"'));
      assert.equal(fs.existsSync(path.join(tmp, ".config", "systemd", "user", "network.iicp.node.mynode.service")), false);
    } finally {
      process.stdout.write = orig;
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
