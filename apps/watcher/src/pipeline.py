#!/usr/bin/env python3
"""
Bodycam Studio pipeline driver.

Invoked by the Node orchestrator (src/pipeline.ts) as a child process:

    python3 pipeline.py \
        --episode-name ep_YYYYMMDD_HHMMSS \
        --brief "full case brief text" \
        --image-path /tmp/ref.png \
        --gradio-url https://bodycam-studio.tail88fe71.ts.net

It drives the three Gradio endpoints in sequence and prints a single JSON
object to stdout describing the result:

    {"success": true,  "zip_path": "...", "episode_name": "..."}
    {"success": false, "error": "..."}

All diagnostic / progress logging goes to stderr so stdout stays a clean,
single-line JSON contract for the parent process.
"""
import argparse
import json
import sys
import traceback

# Fallback wall-clock budget for the orchestrated step (seconds). The real cap
# is passed in via --timeout-min from the Node parent (which also runs a stall
# watchdog); this default only applies if the arg is missing.
DEFAULT_TIMEOUT = 60 * 60  # 60 minutes


def log(msg: str) -> None:
    """Progress logging — stderr only, never stdout."""
    print(f"[pipeline.py] {msg}", file=sys.stderr, flush=True)


def progress(phase: str, steps=None) -> None:
    """
    Emit a machine-readable progress line (stderr) the Node parent parses to
    update the episode's live status. Format: 'PROGRESS <json>' where json is
    {"phase": str, "steps": [{"label": str, "text": str}, ...]}. `steps` lists
    the concurrent sub-tasks of the current phase (Script / Images / Voiceover).
    """
    payload = {"phase": phase, "steps": steps or []}
    print(f"[pipeline.py] PROGRESS {json.dumps(payload)}", file=sys.stderr, flush=True)


def emit(payload: dict) -> None:
    """Print the one and only stdout line: the JSON result."""
    sys.stdout.write(json.dumps(payload))
    sys.stdout.flush()


def run(
    episode_name: str,
    brief: str,
    image_path: str,
    gradio_url: str,
    enable_build_video: bool,
    timeout_seconds: int,
    download_only: bool = False,
) -> dict:
    # Imported lazily so that an import error becomes a structured result
    # rather than a raw traceback the parent can't parse.
    from gradio_client import Client, handle_file

    # Total steps depends on whether the final video build is enabled.
    total = 4 if enable_build_video else 3

    log(f"Connecting to Gradio at {gradio_url}")
    client = Client(
        gradio_url,
        headers={"x-gradio-user": "app"},
        verbose=False,
    )

    # Reuse probe: only fetch the bundle for an already-generated episode. If
    # nothing exists, /cb_download_all errors/returns nothing → we report failure
    # and the Node parent falls back to a full run.
    if download_only:
        log("Reuse probe: /cb_download_all")
        progress("Checking for existing output")
        probe_result = client.predict(
            episode_name=episode_name,
            api_name="/cb_download_all",
        )
        probe_zip = _first(probe_result)
        if not probe_zip:
            raise RuntimeError("No existing bundle for this episode")
        log(f"Existing bundle -> {probe_zip}")
        return {"success": True, "zip_path": probe_zip, "episode_name": episode_name}

    # ── Step 1: enhance the reference image ──────────────────────────────
    log(f"Step 1/{total}: /cb_pipeline_enhance")
    progress("Enhancing reference")
    enhance_result = client.predict(
        episode_name=episode_name,
        ref_input=handle_file(image_path),
        ref_enhanced=None,
        api_name="/cb_pipeline_enhance",
    )
    # Returns (enhanced_filepath, status_string)
    enhanced_path = _first(enhance_result)
    if not enhanced_path:
        raise RuntimeError(f"Enhance step returned no enhanced path: {enhance_result!r}")
    log(f"Enhanced reference -> {enhanced_path}")

    # ── Step 2: orchestrated pipeline (streaming generator) ──────────────
    log(f"Step 2/{total}: /cb_orchestrated_pipeline (streaming)")
    progress("Generating script & assets")
    job = client.submit(
        episode_name=episode_name,
        brief=brief,
        enhanced_path=handle_file(enhanced_path),
        aspect_ratio="16:9",
        api_name="/cb_orchestrated_pipeline",
    )

    final = None
    last_payload = None
    # Iterate every yielded value; keep the last one. The gradio_client Job is
    # iterable and yields each streamed update. Emit ALL concurrent sub-tasks
    # present (Script / Images / Voiceover), each with its own status text, so
    # the dashboard can show parallel progress. Only emit when something changed.
    for update in job:
        final = update
        steps = []
        for idx, label in ((11, "Script"), (12, "Images"), (13, "Voiceover")):
            status = _index(update, idx)
            if isinstance(status, str) and status.strip():
                steps.append({"label": label, "text": _clean(status)})
        payload = json.dumps(steps)
        if steps and payload != last_payload:
            last_payload = payload
            progress("Generating script & assets", steps)
    # Block for completion / surface any server-side exception, honoring the
    # overall timeout budget.
    job.result(timeout=timeout_seconds)
    if final is None:
        # Fall back to the job's final result if no intermediate yields were seen.
        final = job.outputs()[-1] if job.outputs() else None
    if final is None:
        raise RuntimeError("Orchestrated pipeline produced no output")

    run_all_status = _index(final, 14)
    log(f"Orchestrated pipeline complete. run_all_status={run_all_status!r}")

    # ── Step 3 (optional): build the final video ─────────────────────────
    # Disabled by default — current scope is just the asset bundle. Enable with
    # ENABLE_BUILD_VIDEO=true on the watcher to render the stitched MP4.
    if enable_build_video:
        log(f"Step 3/{total}: /cb_build_video")
        progress("Building video")
        build_result = client.predict(
            ep_choice=episode_name,
            api_name="/cb_build_video",
        )
        # Returns: (video_filepath, status_string)
        video_path = _first(build_result)
        video_status = _index(build_result, 1)
        if not video_path:
            raise RuntimeError(f"Build video step returned no video path: {build_result!r}")
        log(f"Final video -> {video_path} | status={video_status!r}")
    else:
        log("Skipping video build (ENABLE_BUILD_VIDEO is off)")

    # ── Final step: bundle everything into a zip ─────────────────────────
    download_step = total  # 3 when video disabled, 4 when enabled
    log(f"Step {download_step}/{total}: /cb_download_all")
    progress("Packaging files")
    download_result = client.predict(
        episode_name=episode_name,
        api_name="/cb_download_all",
    )
    # Returns (zip_filepath, status_string)
    zip_path = _first(download_result)
    if not zip_path:
        raise RuntimeError(f"Download step returned no zip path: {download_result!r}")
    log(f"Bundle ready -> {zip_path}")

    return {"success": True, "zip_path": zip_path, "episode_name": episode_name}


def _first(result):
    """Return the first element of a tuple/list result, else the result itself."""
    if isinstance(result, (list, tuple)):
        return result[0] if result else None
    return result


def _index(result, i):
    if isinstance(result, (list, tuple)) and len(result) > i:
        return result[i]
    return None


def _clean(s: str) -> str:
    """Collapse whitespace/newlines and cap length for a tidy one-line stage."""
    return " ".join(s.split())[:160]


def main() -> int:
    parser = argparse.ArgumentParser(description="Bodycam Studio pipeline driver")
    parser.add_argument("--episode-name", required=True)
    parser.add_argument("--brief", required=True)
    parser.add_argument("--image-path", required=True)
    parser.add_argument("--gradio-url", required=True)
    parser.add_argument("--enable-build-video", action="store_true")
    parser.add_argument("--download-only", action="store_true")
    parser.add_argument("--timeout-min", type=int, default=0)
    args = parser.parse_args()

    timeout_seconds = args.timeout_min * 60 if args.timeout_min > 0 else DEFAULT_TIMEOUT

    try:
        result = run(
            args.episode_name,
            args.brief,
            args.image_path,
            args.gradio_url,
            args.enable_build_video,
            timeout_seconds,
            args.download_only,
        )
        emit(result)
        return 0
    except Exception as exc:  # noqa: BLE001 — top-level guard, report everything
        log("FATAL:\n" + traceback.format_exc())
        emit({"success": False, "error": f"{type(exc).__name__}: {exc}"})
        # Return 0 so the parent reads our JSON rather than treating a non-zero
        # exit as an opaque spawn failure. Success is determined by the JSON.
        return 0


if __name__ == "__main__":
    sys.exit(main())
