// scripts/runners/_docker.mjs
// Docker detection utility — supports Docker Desktop and Docker in WSL.
import { execSync } from "node:child_process";

let _docker = null;

export function detectDocker() {
  if (_docker) return _docker;

  // 1. Docker Desktop / docker in PATH
  try {
    execSync("docker info", { stdio: "ignore", timeout: 5000 });
    _docker = { available: true, cmd: "docker", via: "desktop" };
    return _docker;
  } catch {}

  // 2. Docker in WSL
  try {
    execSync("wsl docker info", { stdio: "ignore", timeout: 10000 });
    _docker = { available: true, cmd: "wsl docker", via: "wsl" };
    return _docker;
  } catch {}

  _docker = { available: false, cmd: "", via: "" };
  return _docker;
}

export function dockerCmd(parts) {
  const d = detectDocker();
  if (!d.available) return null;
  return `${d.cmd} ${parts}`;
}

export function requireDocker() {
  const d = detectDocker();
  if (!d.available) {
    console.error("ERROR: Docker not found. Install Docker Desktop or Docker in WSL.");
    process.exit(1);
  }
  return d;
}
