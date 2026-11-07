"""ゲームAPIボディの復号。

生のボディは次の形式で送られてくる。

    ciphertext || key(32 bytes)

* 暗号方式: AES-256-CBC
* 鍵: 暗号文の末尾32バイト（リクエストごとにランダム）
* IV: UDID からハイフンを除いた文字列の先頭16バイト
* 復号後: 先頭にサイズ情報などのヘッダが数バイト付き、その後に MessagePack

ヘッダ長は固定ではないため、復号結果の先頭を数バイトずつずらして
MessagePack として読める位置を探す。
"""

from __future__ import annotations

import gzip
import io
import zlib
from typing import Any

import msgpack
from Crypto.Cipher import AES
from Crypto.Util.Padding import unpad

try:  # 任意依存。入っていれば Brotli も解凍する。
    import brotli
except ImportError:  # pragma: no cover
    brotli = None


class DecodeError(ValueError):
    """パケットを復号・解析できなかったときに送出する。"""


# ヘッダ長の候補。4バイトの長さフィールドが最も多い。
# 170 は CarrotJuicer 形式のリクエスト（先頭4バイトの offset + 4）を想定。
_PREFERRED_OFFSETS = (4, 0, 8, 12, 16, 20, 24, 28, 32, 2, 1, 3, 5, 6, 7, 170, 174)


def iv_from_udid(udid: str) -> bytes:
    """UDID から AES の IV を作る（ハイフン除去後の先頭16文字）。"""
    normalized = str(udid or "").replace("-", "")
    if len(normalized) < 16:
        raise DecodeError("UDID はハイフンを除いて16文字以上必要です。")
    return normalized[:16].encode("ascii")


def _decompress(data: bytes) -> bytes:
    """HTTP層で解凍されずに残った gzip / zlib を解凍する。"""
    if len(data) >= 2 and data[:2] == b"\x1f\x8b":
        try:
            return gzip.decompress(data)
        except OSError:
            return data
    if len(data) >= 2 and data[0] == 0x78:
        try:
            return zlib.decompress(data)
        except zlib.error:
            return data
    return data


def _decompress_brotli(data: bytes) -> bytes | None:
    """Brotli はマジックバイトがないため、MsgPack と誤認しない範囲で試す。"""
    if brotli is None or not data or data[0] >= 0x80:
        return None
    try:
        return brotli.decompress(data)
    except Exception:
        return None


def _payload_score(obj: Any) -> int:
    """APIレスポンスらしさのスコア。誤ったオフセットの偶然の一致を避ける。"""
    if not isinstance(obj, dict):
        return 0
    score = 0
    if "data" in obj:
        score += 10
    if "response" in obj:
        score += 6
    if "header" in obj:
        score += 3
    if "chara_info" in obj:
        score += 20
    if "card_id" in obj:
        score += 5
    return score


def parse_msgpack(data: bytes, *, min_score: int = 0) -> tuple[int, Any] | None:
    """先頭のヘッダを読み飛ばして MessagePack を1オブジェクト読む。

    min_score を指定すると、APIレスポンスらしさがその値未満の候補を捨てる。
    戻り値は (開始オフセット, オブジェクト)。見つからなければ None。
    """
    if not data:
        return None
    limit = min(512, len(data) - 1)
    offsets = list(_PREFERRED_OFFSETS)
    if len(data) >= 4:
        header = int.from_bytes(data[:4], "little")
        if header == 0xA6:
            # CarrotJuicer 形式のリクエスト: 先頭4バイトが offset、MsgPack は offset+4
            offsets.insert(0, 170)
        elif 0 <= header <= 4096:
            offsets.append(header + 4)
    offsets.extend(range(0, limit + 1))

    best: tuple[int, int, Any] | None = None  # (score, offset, obj)
    seen: set[int] = set()
    for offset in offsets:
        if offset in seen or offset > limit:
            continue
        seen.add(offset)
        chunk = data[offset:]
        if not chunk:
            continue
        try:
            unpacker = msgpack.Unpacker(
                io.BytesIO(chunk), raw=False, strict_map_key=False
            )
            obj = next(unpacker)
        except Exception:
            continue
        if not isinstance(obj, (dict, list)):
            continue
        score = _payload_score(obj)
        if best is None or score > best[0]:
            best = (score, offset, obj)
            # 確実にAPIレスポンスらしいものが見つかったら打ち切る
            if score >= 10:
                break
    if best is None or best[0] < min_score:
        return None
    return best[1], best[2]


def _decrypt_candidates(body: bytes, key: bytes, iv: bytes):
    """先頭の数バイトを落としながら復号候補を返す。"""
    max_drop = min(64, max(0, len(body) - 16))
    for drop in range(max_drop + 1):
        ciphertext = body[drop:]
        if not ciphertext or len(ciphertext) % 16:
            continue
        try:
            plain = unpad(AES.new(key, AES.MODE_CBC, iv).decrypt(ciphertext), 16)
        except ValueError:
            continue
        yield drop, plain


def decrypt_blob(
    blob: bytes,
    udid: str,
    *,
    key: bytes | None = None,
    iv: bytes | None = None,
) -> tuple[bytes, int]:
    """暗号化ボディを復号し、(平文, 切り捨てた先頭バイト数) を返す。

    key を指定しない場合は、ボディ末尾32バイトを鍵として扱う。
    レスポンスがリクエストの鍵を再利用する場合は key を明示する。
    """
    if key is None:
        if len(blob) <= 32:
            raise DecodeError("暗号化ボディが短すぎます（末尾32バイトの鍵が必要です）。")
        key = blob[-32:]
        body = blob[:-32]
    else:
        if len(key) != 32:
            raise DecodeError("鍵は32バイトである必要があります。")
        body = blob
    if iv is None:
        iv = iv_from_udid(udid)
    if len(iv) != 16:
        raise DecodeError("IV は16バイトである必要があります。")

    fallback: tuple[bytes, int] | None = None
    for drop, plain in _decrypt_candidates(body, key, iv):
        plain = _decompress(plain)
        if fallback is None:
            fallback = (plain, drop)
        # APIレスポンスらしい形（data / chara_info など）を優先する
        if parse_msgpack(plain, min_score=1) is not None:
            return plain, drop
        brotli_plain = _decompress_brotli(plain)
        if brotli_plain is not None and parse_msgpack(brotli_plain, min_score=1) is not None:
            return brotli_plain, drop
        if parse_msgpack(plain) is not None:
            return plain, drop
    if fallback is not None:
        return fallback
    raise DecodeError(
        "復号に失敗しました。UDID・鍵の位置・ボディ長を確認してください。"
    )


def decode_raw(
    blob: bytes,
    udid: str,
    *,
    key: bytes | None = None,
    iv: bytes | None = None,
) -> tuple[bytes, int, Any]:
    """暗号化ボディを復号して MessagePack オブジェクトまで返す。"""
    plain, drop = decrypt_blob(blob, udid, key=key, iv=iv)
    found = parse_msgpack(plain)
    if found is None:
        raise DecodeError("復号はできましたが MessagePack を読み取れませんでした。")
    offset, obj = found
    return plain, drop + offset, obj


def decode_any(
    blob: bytes,
    udid: str | None = None,
    *,
    key: bytes | None = None,
    iv: bytes | None = None,
) -> tuple[bytes, int, Any]:
    """平文 MessagePack と暗号化ボディのどちらでも受け付ける。"""
    if udid:
        try:
            return decode_raw(blob, udid, key=key, iv=iv)
        except DecodeError:
            # すでに平文の可能性を試す
            pass
    plain = _decompress(blob)
    found = parse_msgpack(plain, min_score=1)
    if found is not None:
        offset, obj = found
        return plain, offset, obj
    brotli_plain = _decompress_brotli(plain)
    if brotli_plain is not None:
        found = parse_msgpack(brotli_plain, min_score=1)
        if found is not None:
            offset, obj = found
            return brotli_plain, offset, obj
    found = parse_msgpack(plain)
    if found is not None:
        offset, obj = found
        return plain, offset, obj
    raise DecodeError("MessagePack を読み取れませんでした。")
