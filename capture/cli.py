"""生パケットを復号して育成データの JSON を出力する CLI。

使用例:
    py -3 -X utf8 capture/cli.py decode captured.bin --udid <UDID> --out state.json
    py -3 -X utf8 capture/cli.py decode response.msgpack --format msgpack
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from capture.decoder import DecodeError, decode_any
    from capture.extractor import extract
else:
    from .decoder import DecodeError, decode_any
    from .extractor import extract


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="ウマ娘のパケットを復号して育成データを抽出する")
    sub = parser.add_subparsers(dest="command", required=True)

    decode = sub.add_parser("decode", help="暗号化ボディまたは MessagePack を読む")
    decode.add_argument("input", help="入力ファイル（- で標準入力）")
    decode.add_argument("--udid", default="", help="復号に使う UDID")
    decode.add_argument(
        "--key",
        default="",
        help="ボディ末尾に鍵がない場合の32バイト鍵（hex / base64）",
    )
    decode.add_argument(
        "--key-encoding",
        choices=("hex", "base64"),
        default="hex",
        help="--key のエンコード",
    )
    decode.add_argument(
        "--format",
        choices=("auto", "raw", "msgpack"),
        default="auto",
        help="raw=暗号化ボディ / msgpack=平文 / auto=自動判定",
    )
    decode.add_argument("--endpoint", default="", help="APIのURL（記録用）")
    decode.add_argument("--request-id", default="", help="X-Hachimi-Request-Id（記録用）")
    decode.add_argument("--out", default="", help="出力JSON（省略時は標準出力）")

    return parser


def _read_input(path: str) -> bytes:
    if path == "-":
        return sys.stdin.buffer.read()
    return Path(path).read_bytes()


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command != "decode":
        return 2

    blob = _read_input(args.input)
    key = None
    if args.key:
        try:
            key = (
                base64.b64decode(args.key, validate=False)
                if args.key_encoding == "base64"
                else bytes.fromhex(args.key)
            )
        except ValueError as error:
            print(f"error: --key: {error}", file=sys.stderr)
            return 1
        if len(key) != 32:
            print("error: --key は32バイトで指定してください。", file=sys.stderr)
            return 1
    try:
        if args.format == "msgpack":
            _, _, payload = decode_any(blob, None)
        elif args.format == "raw":
            if not args.udid:
                raise DecodeError("--format raw には --udid が必要です。")
            _, _, payload = decode_any(blob, args.udid, key=key)
        else:
            _, _, payload = decode_any(blob, args.udid or None, key=key)
    except DecodeError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    state = extract(
        payload,
        endpoint=args.endpoint,
        request_id=args.request_id,
        kind="response",
        body_size=len(blob),
    )
    text = json.dumps(state, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(text + "\n", encoding="utf-8")
        print(f"wrote {args.out}")
    else:
        print(text)
    return 0 if state.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
