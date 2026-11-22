#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
다중 영상 컷 편집기 — 로컬 서버 (video-cutter)
---------------------------------------------
영상 최대 5개를 올려 각각 시작~끝 구간으로 자르고, 순서대로 1개 MP4로 합칩니다.
이 PC 안(127.0.0.1)에서만 열리고, 파일은 외부로 나가지 않습니다.

    웹 화면      http://127.0.0.1:8768/
    GET  /health                     연결 확인 (웹페이지가 서버 유무를 판단)
    POST /api/upload?name=파일명      본문(octet-stream) = 영상 바이트 -> {id, duration, width, height, ...}
    POST /api/cut    {id, start, end, name?}          -> 잘린 MP4
    POST /api/concat {parts:[{id,start,end}], name?}  -> 이어 붙인 MP4
    GET  /api/download/<fid>         결과/원본 파일 내려받기 (attachment)
    POST /api/forget?id=<id>         업로드 파일 정리

실행:  python server.py              (브라우저 자동 열림)
       python server.py --no-open
       python server.py --port 9000
"""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
import traceback
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SERVER_VERSION = "1.0.0"
DEFAULT_PORT = 8768

MAX_CLIPS = 5
MAX_UPLOAD_BYTES = 1024 * 1024 * 1024      # 1GB 한 파일
MAX_FILE_SECONDS = 3600.0                  # 60분
OUT_LONG_SIDE = 1920                       # 합칠 때 긴 쪽 최대(빠른 인코딩)
OUT_FPS = 30
JOB_MAX_AGE = 6 * 3600                     # 6시간 지난 작업 폴더 정리
JOB_KEEP = 40

JOBS_DIR = os.path.join(BASE_DIR, "jobs")
STATIC_OK = {"index.html", "app.js", "style.css", "favicon.svg", "manifest.json"}
VIDEO_EXTS = {".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi", ".3gp", ".mpg", ".mpeg", ".ts"}

FILES = {}                 # fid -> {path, name, size, duration, width, height, fps, hasAudio, job}
FILES_LOCK = threading.Lock()
RUN_LOCK = threading.Lock()   # ffmpeg 한 번에 하나
FFMPEG = {"path": None, "version": None, "error": ""}


def log(msg: str) -> None:
    print("[video-cutter] " + str(msg), flush=True)


def warn(msg: str) -> None:
    print("[video-cutter] ! " + str(msg), flush=True)


# ───────────────────────────── ffmpeg ─────────────────────────────

def ffmpeg_exe() -> str:
    if FFMPEG["path"]:
        return FFMPEG["path"]
    try:
        import imageio_ffmpeg  # type: ignore
        path = imageio_ffmpeg.get_ffmpeg_exe()
        if path and os.path.isfile(path):
            FFMPEG["path"] = path
            return path
    except Exception:  # noqa: BLE001
        pass
    found = shutil.which("ffmpeg")
    if found:
        FFMPEG["path"] = found
        return found
    raise RuntimeError("ffmpeg 를 찾을 수 없습니다. 실행하기.bat 을 다시 실행하면 자동으로 설치됩니다.")


def ffmpeg_version() -> str | None:
    if FFMPEG["version"]:
        return FFMPEG["version"]
    try:
        out = subprocess.run([ffmpeg_exe(), "-version"], capture_output=True, timeout=25)
        first = (out.stdout or b"").decode("utf-8", "replace").splitlines()
        m = re.search(r"ffmpeg version (\S+)", first[0] if first else "")
        FFMPEG["version"] = (m.group(1) if m else "설치됨")
        return FFMPEG["version"]
    except Exception as exc:  # noqa: BLE001
        FFMPEG["error"] = str(exc)
        return None


def probe(path: str) -> dict:
    """ffprobe 없이 ffmpeg -i 출력에서 길이·해상도·fps·오디오 유무를 읽습니다."""
    info = {"duration": 0.0, "width": 0, "height": 0, "fps": 0.0, "hasAudio": False}
    try:
        res = subprocess.run([ffmpeg_exe(), "-hide_banner", "-nostdin", "-i", path],
                             capture_output=True, timeout=90)
        err = (res.stderr or b"").decode("utf-8", "replace")
    except Exception as exc:  # noqa: BLE001
        warn("probe 실패: %s" % exc)
        return info

    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", err)
    if m:
        info["duration"] = round(int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3)), 3)

    got_video = False
    for line in err.splitlines():
        if "Stream #" not in line:
            continue
        if "Video:" in line and not got_video:
            got_video = True
            m2 = re.search(r"(\d{2,5})x(\d{2,5})", line)
            if m2:
                info["width"], info["height"] = int(m2.group(1)), int(m2.group(2))
            m3 = re.search(r"([\d.]+)\s*fps", line)
            if m3:
                info["fps"] = round(float(m3.group(1)), 2)
        if "Audio:" in line:
            info["hasAudio"] = True

    rot = re.search(r"rotation of (-?[\d.]+)", err)
    if rot and info["width"] and info["height"]:
        try:
            if abs(float(rot.group(1))) % 180 > 45:   # 90 / 270도 -> 세로/가로 뒤집힘
                info["width"], info["height"] = info["height"], info["width"]
        except ValueError:
            pass
    return info


def run_ffmpeg(cmd: list[str], timeout: float) -> tuple[bool, str]:
    log("ffmpeg " + " ".join(cmd[1:]))
    try:
        res = subprocess.run(cmd, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return False, "영상 처리가 너무 오래 걸려 멈췄습니다. 구간을 줄여 보세요."
    except Exception as exc:  # noqa: BLE001
        return False, "ffmpeg 실행 실패: %s" % exc
    if res.returncode != 0:
        err = (res.stderr or b"").decode("utf-8", "replace").strip().splitlines()
        tail = " / ".join(err[-3:]) if err else ""
        return False, "ffmpeg 오류: " + tail[:400]
    return True, ""


# ───────────────────────────── 작업 폴더 ─────────────────────────────

def new_job_dir() -> str:
    os.makedirs(JOBS_DIR, exist_ok=True)
    path = os.path.join(JOBS_DIR, time.strftime("%Y%m%d-%H%M%S-") + secrets.token_hex(3))
    os.makedirs(path, exist_ok=True)
    return path


def cleanup_old_jobs() -> None:
    try:
        entries = [e for e in os.listdir(JOBS_DIR) if os.path.isdir(os.path.join(JOBS_DIR, e))]
    except OSError:
        return
    entries.sort()
    now = time.time()
    alive = []
    for name in entries:
        full = os.path.join(JOBS_DIR, name)
        try:
            age = now - os.path.getmtime(full)
        except OSError:
            continue
        if age > JOB_MAX_AGE:
            shutil.rmtree(full, ignore_errors=True)
        else:
            alive.append(full)
    for full in alive[:-JOB_KEEP] if len(alive) > JOB_KEEP else []:
        shutil.rmtree(full, ignore_errors=True)


def sanitize_name(name: str) -> str:
    name = os.path.basename((name or "").replace("\\", "/"))
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "_", name).strip(" .")
    return name[:80] or "video.mp4"


def register(path: str, name: str, job: str, info: dict) -> str:
    fid = secrets.token_hex(8)
    with FILES_LOCK:
        FILES[fid] = {
            "path": path, "name": name, "job": job,
            "size": os.path.getsize(path) if os.path.isfile(path) else 0,
            "duration": info.get("duration", 0.0),
            "width": info.get("width", 0), "height": info.get("height", 0),
            "fps": info.get("fps", 0.0), "hasAudio": bool(info.get("hasAudio")),
        }
    return fid


def file_info(fid: str) -> dict:
    with FILES_LOCK:
        item = FILES.get(fid)
    if not item:
        raise KeyError("파일을 찾을 수 없습니다. 다시 올려 주세요.")
    out = {k: v for k, v in item.items() if k != "path"}
    out["id"] = fid
    out["url"] = "/api/download/" + fid
    return out


# ───────────────────────────── 컷 / 합치기 ─────────────────────────────

def cut_video(src: str, start: float, end: float, out_path: str, has_audio: bool,
              mode: str = "accurate") -> None:
    dur = max(0.05, end - start)
    if mode == "fast":
        cmd = [ffmpeg_exe(), "-hide_banner", "-y", "-nostdin",
               "-ss", "%.3f" % start, "-i", src, "-t", "%.3f" % dur,
               "-c", "copy", "-avoid_negative_ts", "make_zero", "-movflags", "+faststart", out_path]
    else:
        cmd = [ffmpeg_exe(), "-hide_banner", "-y", "-nostdin",
               "-ss", "%.3f" % start, "-i", src, "-t", "%.3f" % dur,
               "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
               "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"]
        if has_audio:
            cmd += ["-c:a", "aac", "-b:a", "160k", "-ac", "2", "-ar", "48000"]
        else:
            cmd += ["-an"]
        cmd += ["-movflags", "+faststart", out_path]

    with RUN_LOCK:
        ok, err = run_ffmpeg(cmd, timeout=60 + dur * 12)
    if not ok:
        raise RuntimeError(err)
    if not os.path.isfile(out_path) or os.path.getsize(out_path) == 0:
        raise RuntimeError("결과 파일이 만들어지지 않았습니다.")


def even(n: float) -> int:
    n = int(round(n / 2.0) * 2)
    return max(2, n)


def output_size(parts: list[dict]) -> tuple[int, int]:
    first = parts[0]
    w = first.get("width") or 1280
    h = first.get("height") or 720
    long_side = max(w, h)
    if long_side > OUT_LONG_SIDE:
        k = OUT_LONG_SIDE / float(long_side)
        w, h = w * k, h * k
    return even(w), even(h)


def concat_video(parts: list[dict], out_path: str) -> None:
    w, h = output_size(parts)
    cmd = [ffmpeg_exe(), "-hide_banner", "-y", "-nostdin"]
    total = 0.0
    for p in parts:
        dur = max(0.05, float(p["end"]) - float(p["start"]))
        total += dur
        cmd += ["-ss", "%.3f" % float(p["start"]), "-t", "%.3f" % dur, "-i", p["path"]]

    filters = []
    for i, p in enumerate(parts):
        dur = max(0.05, float(p["end"]) - float(p["start"]))
        filters.append(
            "[%d:v]scale=%d:%d:force_original_aspect_ratio=decrease,"
            "pad=%d:%d:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=%d,format=yuv420p,"
            "setpts=PTS-STARTPTS[v%d]" % (i, w, h, w, h, OUT_FPS, i)
        )
        if p.get("hasAudio"):
            filters.append(
                "[%d:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,"
                "asetpts=PTS-STARTPTS[a%d]" % (i, i)
            )
        else:
            filters.append(
                "anullsrc=r=48000:cl=stereo,atrim=duration=%.3f,asetpts=PTS-STARTPTS[a%d]" % (dur, i)
            )
    joined = "".join("[v%d][a%d]" % (i, i) for i in range(len(parts)))
    filters.append("%sconcat=n=%d:v=1:a=1[vout][aout]" % (joined, len(parts)))

    cmd += ["-filter_complex", ";".join(filters),
            "-map", "[vout]", "-map", "[aout]",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
            "-movflags", "+faststart", out_path]

    with RUN_LOCK:
        ok, err = run_ffmpeg(cmd, timeout=180 + total * 14)
    if not ok:
        raise RuntimeError(err)
    if not os.path.isfile(out_path) or os.path.getsize(out_path) == 0:
        raise RuntimeError("합친 파일이 만들어지지 않았습니다.")


# ───────────────────────────── HTTP ─────────────────────────────

class Handler(SimpleHTTPRequestHandler):
    server_version = "VideoCutter/%s" % SERVER_VERSION
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def log_message(self, fmt, *args):  # 콘솔 조용히
        pass

    # ── 헤더 ──
    def cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Range, X-Filename")
        self.send_header("Access-Control-Expose-Headers", "Content-Disposition, Content-Length")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Max-Age", "86400")

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        self.cors()
        super().end_headers()

    def json_out(self, obj: dict, status: int = 200) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            data = json.loads(raw.decode("utf-8", "replace") or "{}")
            return data if isinstance(data, dict) else {}
        except Exception:  # noqa: BLE001
            return {}

    def do_OPTIONS(self):  # noqa: N802
        self.send_response(204)
        self.send_header("Content-Length", "0")
        # 브라우저(Private Network Access) 사전 요청
        req = self.headers.get("Access-Control-Request-Headers")
        if req:
            self.send_header("Access-Control-Allow-Headers", req)
        self.end_headers()

    # ── GET ──
    def do_GET(self):  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path

        if path in ("/health", "/api/health"):
            return self.json_out(health_payload())

        if path.startswith("/api/download/"):
            return self.serve_download(path.rsplit("/", 1)[-1])

        if path.startswith("/api/"):
            return self.json_out({"ok": False, "error": "알 수 없는 요청입니다."}, 404)

        if path == "/":
            path = "/index.html"
        rel = path.lstrip("/")
        if rel not in STATIC_OK:
            return self.json_out({"ok": False, "error": "not found"}, 404)
        self.path = "/" + rel
        return super().do_GET()

    # ── POST ──
    def do_POST(self):  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if path == "/api/upload":
                return self.handle_upload(parse_qs(parsed.query))
            if path == "/api/cut":
                return self.handle_cut(self.read_json())
            if path == "/api/concat":
                return self.handle_concat(self.read_json())
            if path == "/api/forget":
                return self.handle_forget(parse_qs(parsed.query))
            self.close_connection = True
            return self.json_out({"ok": False, "error": "알 수 없는 요청입니다."}, 404)
        except KeyError as exc:
            return self.json_out({"ok": False, "error": str(exc).strip("'\"")}, 404)
        except RuntimeError as exc:
            return self.json_out({"ok": False, "error": str(exc)}, 400)
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            return self.json_out({"ok": False, "error": "서버 오류: %s" % exc}, 500)

    # ── 업로드 ──
    def handle_upload(self, qs: dict) -> None:
        name = sanitize_name((qs.get("name") or ["video.mp4"])[0])
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            self.close_connection = True
            return self.json_out({"ok": False, "error": "빈 파일입니다."}, 400)
        if length > MAX_UPLOAD_BYTES:
            self.close_connection = True
            return self.json_out(
                {"ok": False, "error": "파일이 너무 큽니다(최대 1GB). 다른 구간만 잘라 올려 주세요."}, 413)

        ext = os.path.splitext(name)[1].lower()
        if ext not in VIDEO_EXTS:
            ext = ".mp4"
        job = new_job_dir()
        target = os.path.join(job, "src" + ext)

        remaining = length
        with open(target, "wb") as fh:
            while remaining > 0:
                chunk = self.rfile.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                fh.write(chunk)
                remaining -= len(chunk)
        if remaining > 0:
            self.close_connection = True
            try:
                os.remove(target)
            except OSError:
                pass
            return self.json_out({"ok": False, "error": "업로드가 중간에 끊겼습니다. 다시 시도해 주세요."}, 400)

        info = probe(target)
        if info["duration"] > MAX_FILE_SECONDS:
            try:
                os.remove(target)
            except OSError:
                pass
            return self.json_out({"ok": False, "error": "60분이 넘는 영상은 다룰 수 없어요. 구간을 나눠 주세요."}, 413)
        if not info["duration"] and not info["width"]:
            try:
                os.remove(target)
            except OSError:
                pass
            return self.json_out({"ok": False, "error": "영상으로 읽지 못했어요. MP4/MOV/WebM 파일인지 확인해 주세요."}, 415)

        fid = register(target, name, job, info)
        log("업로드 %s (%s, %.1f초) -> %s" % (name, info["width"] or "?", info["duration"], fid[:6]))
        return self.json_out({
            "ok": True, "id": fid, "name": name, "size": length,
            "duration": info["duration"], "width": info["width"], "height": info["height"],
            "fps": info["fps"], "hasAudio": info["hasAudio"],
        })

    # ── 자르기 ──
    def handle_cut(self, payload: dict) -> None:
        fid = str(payload.get("id") or "")
        with FILES_LOCK:
            item = FILES.get(fid)
        if not item:
            raise KeyError("올린 영상을 찾을 수 없습니다. 다시 올려 주세요.")

        duration = float(item.get("duration") or 0)
        start = float(payload.get("start") or 0)
        end = float(payload.get("end") or 0)
        if duration:
            start = min(max(0.0, start), duration)
            end = min(end, duration)
        if end - start < 0.05:
            raise RuntimeError("시작과 끝 시간을 확인해 주세요.")

        mode = "fast" if str(payload.get("mode") or "") == "fast" else "accurate"
        name = sanitize_name(payload.get("name") or "cut.mp4")
        if not name.lower().endswith(".mp4"):
            name += ".mp4"

        out_path = os.path.join(item["job"], secrets.token_hex(4) + "_cut.mp4")
        cut_video(item["path"], start, end, out_path, bool(item.get("hasAudio")), mode)

        info = probe(out_path)
        out_fid = register(out_path, name, item["job"], info)
        return self.json_out({"ok": True, "file": file_info(out_fid)})

    # ── 합치기 ──
    def handle_concat(self, payload: dict) -> None:
        raw_parts = payload.get("parts") or []
        if not isinstance(raw_parts, list) or not raw_parts:
            raise RuntimeError("합칠 구간이 없습니다.")
        if len(raw_parts) > MAX_CLIPS:
            raise RuntimeError("한 번에 최대 %d개까지 합칠 수 있어요." % MAX_CLIPS)

        parts = []
        with FILES_LOCK:
            for raw in raw_parts:
                item = FILES.get(str(raw.get("id") or ""))
                if not item:
                    raise KeyError("올린 영상을 찾을 수 없습니다. 다시 올려 주세요.")
                duration = float(item.get("duration") or 0)
                start = float(raw.get("start") or 0)
                end = float(raw.get("end") or 0)
                if duration:
                    start = min(max(0.0, start), duration)
                    end = min(end, duration)
                if end - start < 0.05:
                    raise RuntimeError("구간이 너무 짧아요. 시작·끝을 다시 확인해 주세요.")
                parts.append({"path": item["path"], "start": start, "end": end,
                              "hasAudio": bool(item.get("hasAudio")),
                              "width": item.get("width"), "height": item.get("height")})

        name = sanitize_name(payload.get("name") or "merged.mp4")
        if not name.lower().endswith(".mp4"):
            name += ".mp4"

        job = new_job_dir()
        out_path = os.path.join(job, secrets.token_hex(4) + "_merged.mp4")
        concat_video(parts, out_path)

        info = probe(out_path)
        out_fid = register(out_path, name, job, info)
        return self.json_out({"ok": True, "file": file_info(out_fid)})

    # ── 정리 ──
    def handle_forget(self, qs: dict) -> None:
        fid = (qs.get("id") or [""])[0]
        with FILES_LOCK:
            item = FILES.pop(fid, None)
        if item:
            try:
                os.remove(item["path"])
            except OSError:
                pass
        return self.json_out({"ok": True})

    # ── 내려받기 ──
    def serve_download(self, fid: str) -> None:
        with FILES_LOCK:
            item = FILES.get(fid)
        if not item or not os.path.isfile(item["path"]):
            return self.json_out({"ok": False, "error": "파일이 없습니다."}, 404)
        size = os.path.getsize(item["path"])
        name = item["name"]
        ascii_name = re.sub(r"[^A-Za-z0-9._-]+", "_", name) or "video.mp4"
        self.send_response(200)
        self.send_header("Content-Type", "video/mp4" if name.lower().endswith(".mp4") else "application/octet-stream")
        self.send_header("Content-Length", str(size))
        self.send_header("Content-Disposition",
                         "attachment; filename=\"%s\"; filename*=UTF-8''%s" % (ascii_name, quote(name)))
        self.end_headers()
        try:
            with open(item["path"], "rb") as fh:
                shutil.copyfileobj(fh, self.wfile, 1024 * 512)
        except (BrokenPipeError, ConnectionResetError):
            pass


def quote(text: str) -> str:
    from urllib.parse import quote as _q
    return _q(text, safe="")


def health_payload() -> dict:
    ver = ffmpeg_version()
    return {
        "ok": True,
        "app": "video-cutter",
        "version": SERVER_VERSION,
        "ffmpeg": ver,
        "ffmpegReady": bool(ver),
        "error": FFMPEG["error"] if not ver else "",
        "maxClips": MAX_CLIPS,
        "maxUploadMB": MAX_UPLOAD_BYTES // (1024 * 1024),
        "cors": True,
        "host": "127.0.0.1",
    }


# ───────────────────────────── 실행 ─────────────────────────────

def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="다중 영상 컷 편집기 로컬 서버")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--no-open", dest="open_browser", action="store_false", help="브라우저를 열지 않습니다")
    parser.set_defaults(open_browser=True)
    args = parser.parse_args(argv)

    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            pass

    cleanup_old_jobs()
    os.makedirs(JOBS_DIR, exist_ok=True)

    try:
        ver = ffmpeg_version()
        if ver:
            log("ffmpeg %s 준비 완료" % ver)
        else:
            warn("ffmpeg 를 찾지 못했습니다 — 실행하기.bat 을 다시 실행해 주세요.")
    except Exception as exc:  # noqa: BLE001
        warn(str(exc))

    url = "http://127.0.0.1:%d/" % args.port
    try:
        httpd = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError as exc:
        warn("포트 %d 를 열지 못했습니다: %s" % (args.port, exc))
        return 1
    httpd.daemon_threads = True

    log("영상 컷 편집기 → %s  (Ctrl+C 로 종료)" % url)
    if args.open_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        log("종료합니다.")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
