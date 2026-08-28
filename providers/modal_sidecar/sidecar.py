"""
Modal sidecar for Sandbox Grand Prix.

Modal's SDK is Python-first, so the TypeScript orchestrator drives this
process over stdio instead of reimplementing Modal's protocol.

Wire format: one JSON object per line, both directions.
  ->  {"id": "1", "op": "create", "template": "python:3.12-slim", "timeout": 300}
  <-  {"id": "1", "ok": true, "result": {"sandbox_id": "sb-..."}}
  <-  {"id": "1", "ok": false, "error": {"type": "AuthError", "message": "..."}}

Requests are dispatched to a thread pool, so N concurrent createSandbox calls
provision in parallel (the RELAY task depends on this). Responses are
correlated by `id` and may arrive out of order.

API verified 2026-08-28 against modal 1.5.5:
  modal.App.lookup(name, create_if_missing=True)
  modal.Sandbox.create(*cmd, app=, image=, timeout=, cpu=, memory=, workdir=)
  sb.exec(*args, timeout=, workdir=, env=) -> ContainerProcess
      .stdout.read() / .stderr.read() / .wait() -> returncode
  sb.filesystem.write_text(data, path) / read_text(path) / make_directory(path)
      (the legacy sb.open()/sb.mkdir() API was removed — ConflictError if used)
  sb.terminate(wait=)
  sb.object_id
"""

from __future__ import annotations

import json
import os
import sys
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor

APP_NAME = os.environ.get("SGP_MODAL_APP", "sandbox-grand-prix")
DEFAULT_IMAGE = os.environ.get("SGP_MODAL_IMAGE", "python:3.12-slim")
MAX_WORKERS = int(os.environ.get("SGP_MODAL_WORKERS", "32"))

_write_lock = threading.Lock()
_state_lock = threading.Lock()
_sandboxes: dict[str, object] = {}
_app = None
_images: dict[str, object] = {}


def respond(msg: dict) -> None:
    line = json.dumps(msg, default=str)
    with _write_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def log(msg: str) -> None:
    """Diagnostics go to stderr so they never corrupt the protocol stream."""
    sys.stderr.write(f"[modal-sidecar] {msg}\n")
    sys.stderr.flush()


def get_app():
    global _app
    with _state_lock:
        if _app is None:
            import modal

            _app = modal.App.lookup(APP_NAME, create_if_missing=True)
        return _app


def get_image(template: str | None):
    """Registry tag -> Modal Image, memoised so repeat creates don't re-resolve."""
    import modal

    tag = template or DEFAULT_IMAGE
    with _state_lock:
        if tag not in _images:
            _images[tag] = modal.Image.from_registry(tag, add_python=None)
        return _images[tag]


def get_sandbox(handle_id: str):
    with _state_lock:
        sb = _sandboxes.get(handle_id)
    if sb is None:
        raise KeyError(f"unknown sandbox handle: {handle_id}")
    return sb


# --------------------------------------------------------------------------
# operations
# --------------------------------------------------------------------------


def op_ping(_req: dict) -> dict:
    import modal

    return {"pong": True, "modal_version": modal.__version__}


def op_warmup(_req: dict) -> dict:
    """Resolve the app + client up front so it is not billed to cold start."""
    import modal

    app = get_app()
    return {"app": APP_NAME, "app_id": getattr(app, "app_id", None), "modal_version": modal.__version__}


def op_create(req: dict) -> dict:
    import modal

    app = get_app()
    image = get_image(req.get("template"))
    kwargs = {
        "app": app,
        "image": image,
        "timeout": int(req.get("timeout", 300)),
    }
    if req.get("cpu") is not None:
        kwargs["cpu"] = float(req["cpu"])
    if req.get("memory") is not None:
        kwargs["memory"] = int(req["memory"])
    if req.get("workdir"):
        kwargs["workdir"] = req["workdir"]

    sb = modal.Sandbox.create(**kwargs)
    sandbox_id = sb.object_id
    with _state_lock:
        _sandboxes[sandbox_id] = sb
    return {"sandbox_id": sandbox_id}


def op_exec(req: dict) -> dict:
    sb = get_sandbox(req["sandbox_id"])
    cmd = req["cmd"]
    kwargs = {}
    if req.get("timeout_ms"):
        # Modal takes whole seconds; round up so we never undercut the caller.
        kwargs["timeout"] = max(1, int(req["timeout_ms"] / 1000 + 0.999))
    if req.get("cwd"):
        kwargs["workdir"] = req["cwd"]
    if req.get("env"):
        kwargs["env"] = req["env"]

    p = sb.exec("sh", "-c", cmd, **kwargs)
    # Drain the pipes before wait() — a full pipe buffer would deadlock.
    stdout = p.stdout.read()
    stderr = p.stderr.read()
    exit_code = p.wait()
    return {
        "stdout": stdout or "",
        "stderr": stderr or "",
        "exit_code": exit_code if exit_code is not None else -1,
    }


def op_write(req: dict) -> dict:
    sb = get_sandbox(req["sandbox_id"])
    path = req["path"]
    parent = os.path.dirname(path)
    if parent and parent != "/":
        try:
            sb.filesystem.make_directory(parent, create_parents=True)
        except Exception:
            pass  # already exists, or the image forbids it — write_text will say
    sb.filesystem.write_text(req["contents"], path)
    return {"bytes": len(req["contents"])}


def op_read(req: dict) -> dict:
    sb = get_sandbox(req["sandbox_id"])
    return {"contents": sb.filesystem.read_text(req["path"])}


def op_destroy(req: dict) -> dict:
    sandbox_id = req["sandbox_id"]
    with _state_lock:
        sb = _sandboxes.pop(sandbox_id, None)
    if sb is None:
        return {"already_gone": True}
    sb.terminate()
    return {"terminated": True}


def op_shutdown(_req: dict) -> dict:
    """Best-effort sweep so a crashed race never leaves billed orphans."""
    with _state_lock:
        leftovers = list(_sandboxes.items())
        _sandboxes.clear()
    killed = []
    for sandbox_id, sb in leftovers:
        try:
            sb.terminate()
            killed.append(sandbox_id)
        except Exception as exc:  # noqa: BLE001
            log(f"failed to terminate orphan {sandbox_id}: {exc}")
    return {"terminated_orphans": killed}


OPS = {
    "ping": op_ping,
    "warmup": op_warmup,
    "create": op_create,
    "exec": op_exec,
    "write": op_write,
    "read": op_read,
    "destroy": op_destroy,
    "shutdown": op_shutdown,
}


def handle(req: dict) -> None:
    req_id = req.get("id")
    op_name = req.get("op")
    fn = OPS.get(op_name or "")
    if fn is None:
        respond({"id": req_id, "ok": False,
                 "error": {"type": "UnknownOp", "message": f"unknown op: {op_name}"}})
        return
    try:
        respond({"id": req_id, "ok": True, "result": fn(req)})
    except Exception as exc:  # noqa: BLE001
        # Raw error text is the point of the benchmark — pass it through intact.
        respond({
            "id": req_id,
            "ok": False,
            "error": {
                "type": type(exc).__name__,
                "message": str(exc),
                "traceback": "".join(traceback.format_exception(exc))[-2000:],
            },
        })


def main() -> None:
    pool = ThreadPoolExecutor(max_workers=MAX_WORKERS, thread_name_prefix="sgp")
    respond({"id": "__ready__", "ok": True, "result": {"pid": os.getpid()}})
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
            except json.JSONDecodeError as exc:
                respond({"id": None, "ok": False,
                         "error": {"type": "BadJSON", "message": str(exc)}})
                continue
            pool.submit(handle, req)
    finally:
        # stdin closed: the orchestrator is gone. Never leave sandboxes billing.
        try:
            op_shutdown({})
        except Exception:  # noqa: BLE001
            pass
        pool.shutdown(wait=False)


if __name__ == "__main__":
    main()
