#!/usr/bin/env node
import { execSync } from "child_process";
import { resolve } from "path";

const rawArgs = process.argv.slice(2);
const args = rawArgs.filter((a) => a !== "--");

const METHODS = {
  cloudflare: { host: "ssh.dockercaddytailscaletinyauth.dpdns.org", user: "nodesync" },
  tailscale: { host: null, user: "nodesync" },
};

function usage() {
  console.log("Usage: node scripts/runners/ssh-connect/ssh-connect.mjs -m <method> [-p port] [path-to-key]");
  console.log("Methods: cloudflare, tailscale");
  console.log("Default key: .secret/nodesync_id_ed25519");
  process.exit(0);
}

if (args.includes("--help") || args.includes("-h") || !args.includes("-m")) usage();

const methodIdx = args.indexOf("-m");
const method = args[methodIdx + 1];

if (!method || !METHODS[method]) {
  console.error(`Invalid method: ${method}`);
  usage();
}

const portIdx = args.indexOf("-p");
const PORT = portIdx !== -1 ? args[portIdx + 1] : null;

const KEY_PATH = resolve(args.find((a) => a !== "-m" && a !== method && a !== "-p" && a !== PORT && !a.startsWith("-")) || ".secret/nodesync_id_ed25519");
const REMOTE_CMD = 'cd /workspace 2>/dev/null || cd /home/runner/work/docker-caddy-tailscale-tinyauth/docker-caddy-tailscale-tinyauth; exec sh -l';

function getHost() {
  if (method === "tailscale") {
    const status = JSON.parse(execSync("tailscale status --json", { encoding: "utf8" }));
    const self = status.Self.TailscaleIPs[0];
    const peers = Object.values(status.Peer || {}).filter(
      (p) => p.Online === true && p.TailscaleIPs?.[0] !== self
    );
    if (!peers.length) {
      console.error("No online Tailscale peers");
      process.exit(1);
    }
    const ip = peers[0].TailscaleIPs[0];
    console.log(`Connecting to ${ip} (${peers[0].HostName})`);
    return ip;
  }
  const { host, user } = METHODS[method];
  console.log(`Connecting to ${user}@${host} via Cloudflare Access`);
  return host;
}

const host = getHost();
const { user } = METHODS[method];
const sshArgs = [
  "-t",
  "-i", KEY_PATH,
  "-o", "IdentitiesOnly=yes",
  "-o", "PubkeyAuthentication=yes",
  "-o", "PasswordAuthentication=yes",
  "-o", "StrictHostKeyChecking=no",
  "-o", "UserKnownHostsFile=NUL",
  "-o", "GlobalKnownHostsFile=NUL",
  "-o", "LogLevel=ERROR",
];

if (PORT) {
  sshArgs.push("-p", PORT);
}

if (method === "cloudflare") {
  sshArgs.push("-o", `ProxyCommand=cloudflared access ssh --hostname ${host}`);
}

sshArgs.push(`${user}@${host}`, REMOTE_CMD);

try {
  execSync(`ssh ${sshArgs.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`, {
    stdio: "inherit",
  });
} catch (e) {
  process.exit(e.status || 1);
}
