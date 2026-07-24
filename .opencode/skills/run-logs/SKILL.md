---
name: run-logs
description: Use when the user wants to find, view, or debug CI/CD logs from GitHub Actions or Azure Pipelines. Triggers on keywords like "action logs", "workflow logs", "CI logs", "build logs", "failed workflow", "gh run logs", "azure pipeline logs", "azdo logs", "get logs from CI", "debug CI failure", or any request to inspect CI/CD output.
---

# CI/CD Logs (GitHub Actions + Azure Pipelines)

Use the `workflow-log-inspector` MCP tools to find and retrieve logs from CI/CD runs.

## Aliases

| Alias | Provider | Target |
|-------|----------|--------|
| `github` (shortcut: `gh`) | GitHub Actions | `hoahien7281/docker-caddy-tailscale-tinyauth` |
| `pipeline` (shortcut: `az`) | Azure Pipelines | `addakimanjose/me` |

**Resolution rule:** when the user says "gh", "github", "CI" → use `alias: "github"`. When the user says "az", "azure", "pipeline", "azdo" → use `alias: "pipeline"`. If ambiguous (no provider specified), default to `alias: "github"`.

## Available tools

| Tool | Purpose |
|------|---------|
| `workflow-log-inspector_list_configured_repos` | List all configured repos (alias, provider, org, target) |
| `workflow-log-inspector_list_runs` | List recent runs for an alias, with status and runId |
| `workflow-log-inspector_get_run_log` | Get log content for a run/job, or list child logs if no jobOrLogId |
| `workflow-log-inspector_watch_active_log` | Auto-detect running job/step and stream latest log output |

## Workflow

1. **Resolve alias** — determine `github` or `pipeline` from user context.
2. **List runs** — `workflow-log-inspector_list_runs(alias, status?, limit?)` to find the relevant run. Returns each run's `runId`, status, and metadata.
3. **Drill into a run** — `workflow-log-inspector_get_run_log(alias, runId)` **without** `jobOrLogId` to list child logs (per-job breakdown with id, name, lineCount).
4. **Get job log content** — `workflow-log-inspector_get_run_log(alias, runId, jobOrLogId)` with `tailLines` to retrieve actual log text.
5. **Monitor active runs** — `workflow-log-inspector_watch_active_log(alias, runId)` to auto-detect which job/step is currently running and get live log output.

## Key parameters

| Parameter | Tool | Description |
|-----------|------|-------------|
| `alias` | all | `"github"` or `"pipeline"` |
| `status` | `list_runs` | Filter: `"in_progress"`, `"completed"`, `"queued"` (optional) |
| `limit` | `list_runs` | Max runs to return (default 10, max 50) |
| `runId` | `get_run_log`, `watch_active_log` | The run/build ID from `list_runs` |
| `jobOrLogId` | `get_run_log` | Job/log ID — omit to list child logs, provide to get content |
| `tailLines` | `get_run_log` | Number of final lines to return (0-5000, default 300) |
| `pollSeconds` | `watch_active_log` | Interval between polls (1-60, default 5) |

## Tips

- Start with `list_runs` with `status: "completed"` to find failed runs, then drill down.
- Omit `jobOrLogId` first to see the per-job breakdown before fetching a specific job's log.
- Use `tailLines` to limit output — increase for more context, decrease for quick triage.
- `watch_active_log` is for runs **currently in progress** — it auto-detects the active job and streams new lines.
- For quick triage: `list_runs` → pick latest failed → `get_run_log(runId)` to list jobs → `get_run_log(runId, jobOrLogId, tailLines: 200)` → read tail.

## Example flow — GitHub Actions

```
User: "show me why the CI failed on main"

1. workflow-log-inspector_list_runs(alias: "github", status: "completed", limit: 5)
   → returns recent completed runs with runId, status, commit info
2. Pick the latest failed run → workflow-log-inspector_get_run_log(alias: "github", runId: "<runId>")
   → returns list of child jobs with id, name, lineCount
3. Pick the failed job → workflow-log-inspector_get_run_log(alias: "github", runId: "<runId>", jobOrLogId: "<jobId>", tailLines: 300)
   → returns actual log content
4. Summarize the failure from the log output
```

## Example flow — Azure Pipelines

```
User: "az pipeline failed last build"

1. workflow-log-inspector_list_runs(alias: "pipeline", status: "completed", limit: 5)
   → returns recent completed builds with runId, status
2. Pick the latest failed build → workflow-log-inspector_get_run_log(alias: "pipeline", runId: "<runId>")
   → returns list of child jobs/logs with id, name, lineCount
3. Pick the failed job → workflow-log-inspector_get_run_log(alias: "pipeline", runId: "<runId>", jobOrLogId: "<jobId>", tailLines: 300)
   → returns actual log content
4. Summarize the failure from the log output
```

## Example flow — Both providers

```
User: "check CI status for this repo"

1. workflow-log-inspector_list_runs(alias: "github", status: "in_progress", limit: 3)
2. workflow-log-inspector_list_runs(alias: "pipeline", status: "in_progress", limit: 3)
3. Summarize both providers' status
```

## Monitoring an active run

```
User: "watch the CI while it runs"

# GitHub Actions
1. workflow-log-inspector_list_runs(alias: "github", status: "in_progress")
   → find the active run
2. workflow-log-inspector_watch_active_log(alias: "github", runId: "<runId>")
   → auto-detects the active job/step, returns latest log lines
3. Call again later to get updated output (polls detect which job is executing)

# Azure Pipelines
1. workflow-log-inspector_list_runs(alias: "pipeline", status: "in_progress")
   → find the active build
2. workflow-log-inspector_watch_active_log(alias: "pipeline", runId: "<runId>")
   → auto-detects the active job/step, returns latest log lines
```
