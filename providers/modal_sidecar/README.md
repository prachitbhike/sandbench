# Modal sidecar

Modal's SDK is Python-first, so the TypeScript orchestrator drives Modal
through this process over stdio (newline-delimited JSON) rather than
reimplementing Modal's wire protocol.

## Setup

```bash
python3 -m venv providers/modal_sidecar/.venv
providers/modal_sidecar/.venv/bin/pip install -r providers/modal_sidecar/requirements.txt
```

The TS adapter auto-discovers the interpreter in this order:

1. `$SGP_MODAL_PYTHON`
2. `providers/modal_sidecar/.venv/bin/python`
3. `python3` on `PATH`

## Environment

| Var | Purpose |
| --- | --- |
| `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` | Auth (or a `~/.modal.toml` from `modal token new`) |
| `SGP_MODAL_APP` | Modal app name (default `sandbox-grand-prix`) |
| `SGP_MODAL_IMAGE` | Default registry image (default `python:3.12-slim`) |
| `SGP_MODAL_WORKERS` | Sidecar thread-pool size (default 32) |

## Protocol

One JSON object per line, both directions; responses correlate by `id` and may
arrive out of order because requests run on a thread pool.

| op | params | result |
| --- | --- | --- |
| `ping` | — | `{pong, modal_version}` |
| `warmup` | — | `{app, app_id, modal_version}` |
| `create` | `template?, timeout?, cpu?, memory?, workdir?` | `{sandbox_id}` |
| `exec` | `sandbox_id, cmd, timeout_ms?, cwd?, env?` | `{stdout, stderr, exit_code}` |
| `write` | `sandbox_id, path, contents` | `{bytes}` |
| `read` | `sandbox_id, path` | `{contents}` |
| `destroy` | `sandbox_id` | `{terminated}` |
| `shutdown` | — | `{terminated_orphans}` |

Errors come back as `{"ok": false, "error": {type, message, traceback}}` with
the raw Modal message preserved — capturing real failures is the point.

Closing stdin terminates every tracked sandbox before the process exits, so a
crashed orchestrator cannot leave billed orphans.
