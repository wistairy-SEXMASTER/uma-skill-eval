"""復号・抽出・サーバーの最小テスト。"""

from __future__ import annotations

import base64
import json
import os
import sys
import threading
import unittest
import urllib.request
from pathlib import Path

import msgpack
from Crypto.Cipher import AES
from Crypto.Util.Padding import pad

# `python capture/tests/test_capture.py` でも動くようにする。
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from capture.decoder import decode_any, decode_raw, parse_msgpack
from capture.extractor import extract
from capture.server import CaptureServer, Handler

REPO_ROOT = Path(__file__).resolve().parents[2]
UDID = "12345678-1234-1234-1234-123456789abc"


def sample_payload() -> dict:
    return {
        "data": {
            "single_mode_load_common": {
                "chara_info": {
                    "card_id": 100101,
                    "scenario_id": 7,
                    "turn": 24,
                    "skill_point": 350,
                    "chara_grade": 5,
                    "talent_level": 3,
                    "fans": 123456,
                    "speed": 800,
                    "stamina": 600,
                    "power": 700,
                    "guts": 400,
                    "wiz": 500,
                    "proper_distance_short": 2,
                    "proper_distance_mile": 4,
                    "proper_distance_middle": 6,
                    "proper_distance_long": 8,
                    "proper_running_style_nige": 1,
                    "proper_running_style_senko": 7,
                    "proper_running_style_sashi": 7,
                    "proper_running_style_oikomi": 5,
                    "proper_ground_turf": 8,
                    "proper_ground_dirt": 1,
                    "skill_tips_array": [
                        {"group_id": 20001, "rarity": 1, "level": 2},
                        {"group_id": 20002, "rarity": 2, "level": 3},
                        {"group_id": 20001, "rarity": 1, "level": 1},
                    ],
                    "skill_array": [{"skill_id": 201341, "level": 1}],
                    "chara_effect_id_array": [7, 40],
                }
            }
        }
    }


def encrypt_payload(payload: dict, udid: str = UDID) -> bytes:
    key = os.urandom(32)
    iv = udid.replace("-", "")[:16].encode("ascii")
    plain = b"\x00\x00\x00\x00" + msgpack.packb(payload, use_bin_type=True)
    ciphertext = AES.new(key, AES.MODE_CBC, iv).encrypt(pad(plain, 16))
    return ciphertext + key


class DecoderTests(unittest.TestCase):
    def test_decrypts_raw_blob_and_extracts(self) -> None:
        blob = encrypt_payload(sample_payload())
        plain, offset, payload = decode_raw(blob, UDID)
        self.assertGreater(len(plain), 0)
        self.assertGreaterEqual(offset, 0)
        state = extract(payload, endpoint="single_mode/load")
        self.assertTrue(state["ok"])
        chara = state["chara"]
        self.assertEqual(chara["card_id"], 100101)
        self.assertEqual(chara["turn"], 24)
        self.assertEqual(chara["skill_point"], 350)
        self.assertEqual(
            chara["aptitude"]["distance"],
            {"1": "F", "2": "D", "3": "B", "4": "S"},
        )
        self.assertEqual(
            chara["aptitude"]["style"],
            {"1": "G", "2": "A", "3": "A", "4": "C"},
        )
        self.assertEqual(
            chara["aptitude"]["ground"],
            {"1": "S", "2": "G"},
        )
        self.assertEqual(
            chara["hints"],
            [
                {"group_id": 20001, "rarity": 1, "level": 2},
                {"group_id": 20002, "rarity": 2, "level": 3},
            ],
        )
        self.assertEqual(chara["effects"], [7, 40])
        self.assertEqual(chara["learned_skills"], [{"skill_id": 201341, "level": 1}])
        self.assertTrue(chara["has_hints"])

    def test_explicit_key_without_appended_key(self) -> None:
        blob = encrypt_payload(sample_payload())
        key = blob[-32:]
        ciphertext = blob[:-32]
        _, _, payload = decode_raw(ciphertext, UDID, key=key)
        state = extract(payload)
        self.assertTrue(state["ok"])
        self.assertEqual(state["chara"]["card_id"], 100101)

    def test_carrotjuicer_request_header(self) -> None:
        body = {"foo": "bar", "n": 1}
        packed = msgpack.packb(body, use_bin_type=True)
        data = b"\xa6\x00\x00\x00" + b"\x00" * 166 + packed
        found = parse_msgpack(data)
        self.assertIsNotNone(found)
        offset, parsed = found
        self.assertEqual(offset, 170)
        self.assertEqual(parsed, body)

    def test_plain_msgpack(self) -> None:
        packed = msgpack.packb(sample_payload(), use_bin_type=True)
        _, _, payload = decode_any(packed, None)
        state = extract(payload)
        self.assertTrue(state["ok"])
        self.assertEqual(state["chara"]["card_id"], 100101)


class ServerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.server = CaptureServer(
            ("127.0.0.1", 0), Handler, repo_root=REPO_ROOT, default_udid=UDID
        )
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def _post(self, path: str, body: bytes, headers: dict) -> dict:
        request = urllib.request.Request(
            self.base + path, data=body, method="POST", headers=headers
        )
        with urllib.request.urlopen(request, timeout=5) as response:
            return json.loads(response.read().decode("utf-8"))

    def _state(self) -> dict:
        with urllib.request.urlopen(self.base + "/api/state", timeout=5) as response:
            return json.loads(response.read().decode("utf-8"))

    def test_notify_response_updates_state(self) -> None:
        packed = msgpack.packb(sample_payload(), use_bin_type=True)
        result = self._post(
            "/notify/response",
            packed,
            {
                "Content-Type": "application/msgpack",
                "X-Hachimi-Game-Url": "https://api.umamusume.jp/umamusume/single_mode/load",
                "X-Hachimi-Request-Id": "0123456789abcdef0123456789abcdef",
            },
        )
        self.assertTrue(result["stored"])
        state = self._state()
        self.assertTrue(state["ok"])
        self.assertEqual(state["version"], 1)
        self.assertEqual(state["chara"]["card_id"], 100101)
        self.assertEqual(state["source"]["endpoint"], "https://api.umamusume.jp/umamusume/single_mode/load")

    def test_ingest_raw_blob_updates_state(self) -> None:
        blob = encrypt_payload(sample_payload())
        body = json.dumps(
            {"udid": UDID, "body": base64.b64encode(blob).decode("ascii")}
        ).encode("utf-8")
        result = self._post("/api/ingest", body, {"Content-Type": "application/json"})
        self.assertTrue(result["ok"])
        state = self._state()
        self.assertTrue(state["ok"])
        self.assertEqual(state["version"], 1)
        self.assertEqual(state["chara"]["card_id"], 100101)

    def test_ingest_with_explicit_key(self) -> None:
        blob = encrypt_payload(sample_payload())
        key = blob[-32:]
        body = json.dumps(
            {
                "udid": UDID,
                "body": base64.b64encode(blob[:-32]).decode("ascii"),
                "key": key.hex(),
            }
        ).encode("utf-8")
        result = self._post("/api/ingest", body, {"Content-Type": "application/json"})
        self.assertTrue(result["ok"])
        self.assertEqual(result["chara"]["card_id"], 100101)


if __name__ == "__main__":
    unittest.main()
