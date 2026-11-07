"""パケット転送サーバー。

次の2系統の入力を受け付ける。

1. Hachimi-Edge（URA）の転送契約
   POST /notify/request
   POST /notify/response
   ヘッダ: X-Hachimi-Game-Url, X-Hachimi-Request-Id, ...
   本文: 復号・解凍済みの MessagePack

2. 生パケットの取り込み
   POST /api/ingest
   {"udid": "...", "body": "<base64>", "format": "raw" | "msgpack"}

ビューアは GET /api/state で最後に取得した育成データを読む。
"""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import sys
import threading
import time
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

if __package__ in (None, ""):
    # `python capture/server.py` で直接実行された場合
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from capture.decoder import DecodeError, decode_any
    from capture.extractor import extract
    from capture.store import StateStore
else:
    from .decoder import DecodeError, decode_any
    from .extractor import extract
    from .store import StateStore

MAX_BODY_BYTES = 64 * 1024 * 1024


def _jsonable(node: Any) -> Any:
    """MessagePack の値を JSON にできる形へ変換する（デバッグ用）。"""
    if isinstance(node, dict):
        return {str(key): _jsonable(value) for key, value in node.items()}
    if isinstance(node, (list, tuple)):
        return [_jsonable(value) for value in node]
    if isinstance(node, (bytes, bytearray)):
        return bytes(node).hex()
    if isinstance(node, float) and (node != node or node in (float("inf"), float("-inf"))):
        return str(node)
    return node


class CaptureServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(
        self,
        address,
        handler,
        *,
        repo_root: Path,
        default_udid: str = "",
        dist_path: str = "dist/index.html",
        dump_dir: Path | None = None,
        state_file: Path | None = None,
    ):
        super().__init__(address, handler)
        self.repo_root = repo_root
        self.default_udid = default_udid
        self.dist_path = dist_path
        self.store = StateStore()
        self.verbose = False
        self.dump_dir = dump_dir
        self.state_file = state_file
        self._dump_index = 0
        if state_file and state_file.is_file():
            try:
                self.store.restore(json.loads(state_file.read_text(encoding="utf-8-sig")))
            except (OSError, json.JSONDecodeError) as error:
                print(f"[state] 復元できません: {error}", flush=True)


class Handler(BaseHTTPRequestHandler):
    server: CaptureServer
    protocol_version = "HTTP/1.1"
    server_version = "UmaSkillEvalCapture/1.0"

    # ---------- helpers ----------

    def log_message(self, fmt: str, *args) -> None:
        if getattr(self.server, "verbose", False):
            super().log_message(fmt, *args)

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header(
            "Access-Control-Allow-Headers",
            "Content-Type, X-UDID, X-Hachimi-Request-Id, X-Hachimi-Game-Url",
        )

    def _send(self, status: int, body: bytes, content_type: str, *, cache: bool = False) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        if not cache:
            self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self._cors()
        self.end_headers()
        if body:
            self.wfile.write(body)
        self.close_connection = True

    def _json(self, status: int, payload: Any) -> None:
        body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8")

    def _text(self, status: int, text: str) -> None:
        self._send(status, text.encode("utf-8"), "text/plain; charset=utf-8")

    def _dump_payload(self, payload: Any, endpoint: str) -> None:
        dump_dir = self.server.dump_dir
        if not dump_dir:
            return
        try:
            dump_dir.mkdir(parents=True, exist_ok=True)
            self.server._dump_index += 1
            slug = "".join(c if c.isalnum() else "_" for c in endpoint)[-80:] or "payload"
            stamp = time.strftime("%Y%m%d-%H%M%S")
            path = dump_dir / f"{stamp}_{self.server._dump_index:04d}_{slug}.json"
            path.write_text(
                json.dumps(_jsonable(payload), ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except OSError as error:
            print(f"[dump] {error}", flush=True)

    def _store_update(self, state: dict) -> int:
        version = self.server.store.update(state)
        state_file = self.server.state_file
        if state_file:
            try:
                state_file.write_text(
                    json.dumps(self.server.store.snapshot(), ensure_ascii=False),
                    encoding="utf-8",
                )
            except OSError as error:
                print(f"[state] 保存できません: {error}", flush=True)
        return version

    def _read_body(self) -> bytes:
        length_header = self.headers.get("Content-Length")
        if length_header is None:
            raise ValueError("Content-Length がありません。")
        length = int(length_header)
        if length < 0 or length > MAX_BODY_BYTES:
            raise ValueError(f"本文が大きすぎます（{length} bytes）。")
        body = self.rfile.read(length)
        if len(body) != length:
            raise ValueError(
                f"本文長が一致しません（宣言 {length} / 実際 {len(body)}）。"
            )
        return body

    # ---------- HTTP ----------

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Content-Length", "0")
        self.send_header("Connection", "close")
        self._cors()
        self.end_headers()
        self.close_connection = True

    def do_GET(self) -> None:
        path = unquote(urlsplit(self.path).path)
        if path in ("/api/state", "/api/state.json"):
            self._json(HTTPStatus.OK, self.server.store.snapshot())
            return
        if path == "/api/health":
            self._json(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "version": self.server.store.version,
                    "has_data": self.server.store.has_data,
                    "port": self.server.server_address[1],
                },
            )
            return
        if path == "/api/ping":
            self._text(HTTPStatus.OK, "pong")
            return
        if path in ("/", "/index.html"):
            self._serve_repo_file(Path(self.server.dist_path), fallback_index=True)
            return
        if path.startswith("/assets/"):
            self._serve_repo_file(Path(path.lstrip("/")))
            return
        if path == "/favicon.ico":
            self._send(HTTPStatus.NO_CONTENT, b"", "image/x-icon")
            return
        self._text(HTTPStatus.NOT_FOUND, "not found")

    def do_POST(self) -> None:
        path = urlsplit(self.path).path
        try:
            body = self._read_body()
        except (ValueError, OSError) as error:
            self._json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(error)})
            return

        if path in ("/notify/request", "/notify/response"):
            self._handle_notify(path, body)
            return
        if path == "/api/ingest":
            self._handle_ingest(body)
            return
        self._text(HTTPStatus.NOT_FOUND, "not found")

    # ---------- handlers ----------

    def _handle_notify(self, path: str, body: bytes) -> None:
        kind = "response" if path.endswith("response") else "request"
        endpoint = self.headers.get("X-Hachimi-Game-Url", "")
        request_id = self.headers.get("X-Hachimi-Request-Id", "")
        self.server.store.note_notification(
            endpoint=endpoint, request_id=request_id, kind=kind, body_size=len(body)
        )
        if kind == "request":
            # リクエストは育成データを含まないため、受信だけ記録する。
            self._json(HTTPStatus.OK, {"ok": True, "kind": kind, "stored": False})
            return

        try:
            _, _, payload = decode_any(body, self.server.default_udid or None)
        except DecodeError as error:
            self.server.store.note_error(str(error), endpoint=endpoint)
            self._json(
                HTTPStatus.OK,
                {"ok": False, "kind": kind, "error": str(error)},
            )
            return

        self._dump_payload(payload, endpoint)
        state = extract(
            payload,
            endpoint=endpoint,
            request_id=request_id,
            kind=kind,
            body_size=len(body),
        )
        if state.get("ok"):
            version = self._store_update(state)
            self._log_state(endpoint, state, version)
            self._json(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "kind": kind,
                    "stored": True,
                    "version": version,
                    "card_id": state["chara"]["card_id"],
                },
            )
        else:
            self.server.store.note_error(state.get("error", ""), endpoint=endpoint)
            self._json(
                HTTPStatus.OK,
                {"ok": False, "kind": kind, "error": state.get("error")},
            )

    def _handle_ingest(self, body: bytes) -> None:
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            self._json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": f"JSON: {error}"})
            return
        if not isinstance(payload, dict):
            self._json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "JSON object が必要です。"})
            return

        encoded = payload.get("body")
        if not isinstance(encoded, str) or not encoded:
            self._json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "body がありません。"})
            return
        encoding = str(payload.get("encoding") or "base64").lower()
        try:
            if encoding == "hex":
                raw = bytes.fromhex(encoded)
            else:
                raw = base64.b64decode(encoded, validate=False)
        except ValueError as error:
            self._json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": f"body: {error}"})
            return

        udid = payload.get("udid") or self.server.default_udid or None
        key = None
        key_text = payload.get("key")
        if isinstance(key_text, str) and key_text:
            key_encoding = str(payload.get("key_encoding") or "hex").lower()
            try:
                if key_encoding == "base64":
                    key = base64.b64decode(key_text, validate=False)
                else:
                    key = bytes.fromhex(key_text)
            except ValueError as error:
                self._json(
                    HTTPStatus.BAD_REQUEST,
                    {"ok": False, "error": f"key: {error}"},
                )
                return
            if len(key) != 32:
                self._json(
                    HTTPStatus.BAD_REQUEST,
                    {"ok": False, "error": "key は32バイトで指定してください。"},
                )
                return
        fmt = str(payload.get("format") or "auto").lower()
        try:
            if fmt == "msgpack":
                _, _, msgpack_obj = decode_any(raw, None)
            else:
                _, _, msgpack_obj = decode_any(raw, udid, key=key)
        except DecodeError as error:
            self._json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(error)})
            return

        state = extract(
            msgpack_obj,
            endpoint=str(payload.get("endpoint") or ""),
            request_id=str(payload.get("request_id") or ""),
            kind=str(payload.get("kind") or "response"),
            body_size=len(raw),
        )
        if not state.get("ok"):
            self._json(HTTPStatus.UNPROCESSABLE_ENTITY, state)
            return
        version = self._store_update(state)
        self._log_state(state["source"].get("endpoint", ""), state, version)
        response = dict(state)
        response["version"] = version
        self._json(HTTPStatus.OK, response)

    # ---------- static ----------

    def _serve_repo_file(self, relative: Path, *, fallback_index: bool = False) -> None:
        root = self.server.repo_root.resolve()
        target = (root / relative).resolve()
        if root not in target.parents and target != root:
            self._text(HTTPStatus.FORBIDDEN, "forbidden")
            return
        if not target.is_file():
            if fallback_index:
                self._text(
                    HTTPStatus.NOT_FOUND,
                    "dist/index.html がありません。先に `npm run build` を実行してください。",
                )
            else:
                self._text(HTTPStatus.NOT_FOUND, "not found")
            return
        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type in (
            "application/javascript",
            "application/json",
        ):
            content_type += "; charset=utf-8"
        self._send(HTTPStatus.OK, target.read_bytes(), content_type)

    # ---------- logging ----------

    def _log_state(self, endpoint: str, state: dict, version: int) -> None:
        chara = state.get("chara") or {}
        hints = chara.get("hints") or []
        print(
            f"[{self.log_date_time_string()}] #{version} "
            f"card={chara.get('card_id')} turn={chara.get('turn')} "
            f"sp={chara.get('skill_point')} hints={len(hints)} "
            f"{endpoint or state.get('source', {}).get('path', '')}",
            flush=True,
        )


def _watch_directory(server: CaptureServer, directory: Path, udid: str) -> None:
    """Fiddler などが保存した生パケットを定期的に取り込む。"""
    seen: dict[Path, tuple[int, int]] = {}
    suffixes = {".bin", ".body", ".msgpack", ".dat"}
    print(f"パケット保存フォルダを監視します: {directory}")
    while True:
        try:
            for path in sorted(directory.iterdir()):
                if not path.is_file() or path.suffix.lower() not in suffixes:
                    continue
                stat = path.stat()
                key = (stat.st_mtime_ns, stat.st_size)
                if seen.get(path) == key:
                    continue
                seen[path] = key
                try:
                    data = path.read_bytes()
                    plain = path.suffix.lower() == ".msgpack"
                    _, _, payload = decode_any(data, None if plain else udid)
                    state = extract(
                        payload,
                        endpoint=f"file:{path.name}",
                        kind="response",
                        body_size=len(data),
                    )
                    if state.get("ok"):
                        version = server.store.update(state)
                        chara = state["chara"]
                        print(
                            f"[watch] #{version} card={chara.get('card_id')} "
                            f"turn={chara.get('turn')} hints={len(chara.get('hints') or [])} "
                            f"{path.name}",
                            flush=True,
                        )
                    else:
                        server.store.note_error(
                            state.get("error", ""), endpoint=f"file:{path.name}"
                        )
                        print(f"[watch] {path.name}: {state.get('error')}", flush=True)
                except Exception as error:  # 監視は止めない
                    server.store.note_error(str(error), endpoint=f"file:{path.name}")
                    print(f"[watch] {path.name}: {error}", flush=True)
        except OSError as error:
            print(f"[watch] {error}", flush=True)
        time.sleep(1.0)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="ウマ娘のパケット転送を受けて育成データを抽出するローカルサーバー"
    )
    parser.add_argument("--host", default="127.0.0.1", help="待ち受けアドレス")
    parser.add_argument(
        "--port", type=int, default=4693, help="待ち受けポート（既定: 4693）"
    )
    parser.add_argument(
        "--udid",
        default="",
        help="生パケットを復号するときの UDID（/api/ingest で個別指定も可能）",
    )
    parser.add_argument(
        "--dist",
        default="dist/index.html",
        help="配信するビューアHTML（リポジトリルートからの相対パス）",
    )
    parser.add_argument(
        "--watch",
        default="",
        help="生パケットの保存フォルダを監視して自動取り込みする（.bin/.body/.msgpack/.dat）",
    )
    parser.add_argument(
        "--dump-dir",
        default="",
        help="受信した復号済みMessagePackをJSONで保存するフォルダ（デバッグ用）",
    )
    parser.add_argument(
        "--state-file",
        default="",
        help="最後の状態を保存し、再起動時に復元するJSONファイル",
    )
    parser.add_argument("--open", action="store_true", help="起動後にブラウザを開く")
    parser.add_argument("--verbose", action="store_true", help="HTTPアクセスログを表示")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    repo_root = Path(__file__).resolve().parent.parent
    server = CaptureServer(
        (args.host, args.port),
        Handler,
        repo_root=repo_root,
        default_udid=args.udid,
        dist_path=args.dist,
        dump_dir=Path(args.dump_dir) if args.dump_dir else None,
        state_file=Path(args.state_file) if args.state_file else None,
    )
    server.verbose = args.verbose
    url = f"http://{args.host}:{args.port}/"
    print(f"パケット転送サーバーを起動しました: {url}")
    print(f"  状態API: {url}api/state")
    print(f"  生パケット: POST {url}api/ingest")
    print("  Hachimi-Edge の転送先をこのアドレスにしてください。")
    if args.watch:
        watch_dir = Path(args.watch)
        if not watch_dir.is_dir():
            print(f"監視フォルダがありません: {watch_dir}")
        else:
            threading.Thread(
                target=_watch_directory,
                args=(server, watch_dir, args.udid),
                daemon=True,
            ).start()
    if args.open:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n停止します。")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
