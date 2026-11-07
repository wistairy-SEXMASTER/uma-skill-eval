# 自前パケット取得 DLL（cri_mana_vpx.dll）

Hachimi の `httpforward` プラグインを使わずに、ゲーム内の `Cute.Http` をフックして
復号・解凍済みの MessagePack を `capture/server.py` へ転送するための DLL です。

## 最終構成

- `UmamusumePrettyDerby_Jpn.exe`: FunnyHoney ローダー
- `cri_mana_vpx.dll`: **このリポジトリでビルドした自前 DLL**
- `hachimi` フォルダ: 不要
- `winhttp.dll` / `winhttp_orig.dll`: 不要
- Hachimi 本体・httpforward プラグイン: 不要

FunnyHoney は DLL をゲームに読み込ませるためだけに使用します。
取得処理（フック・転送）はすべて自前 DLL で行います。

## 仕組み

ゲーム内の次のメソッドを MinHook でフックします。

- `Cute.Http.HttpHelper.CompressRequest(byte[])`
- `Cute.Http.HttpHelper.DecompressResponse(byte[])`
- `Cute.Http.WWWRequest.Post(string, byte[], Dictionary)`
- `Cute.Http.WWWRequest.get_bytes()`
- `Cute.Http.WWWRequest.Dispose()`

送信前の平文リクエストと、受信後の復号・解凍済みレスポンスを取得し、
`http://127.0.0.1:4693/notify/request` と `/notify/response` に転送します。

IL2CPP の API 名は `UnityPlayer.dll` 内の難読化エクスポートテーブルから解決します。

## ビルド

Zig（`zig cc`）と同梱の MinHook を使用します。

```powershell
# Zig が PATH にある場合
powershell -ExecutionPolicy Bypass -File capture\native\build.ps1

# Zig の場所を指定する場合
powershell -ExecutionPolicy Bypass -File capture\native\build.ps1 `
  -Zig "C:\path\to\zig.exe"
```

出力:

```text
capture/native/proxy/cri_mana_vpx.dll
```

ゲームフォルダへ直接インストールする場合:

```powershell
powershell -ExecutionPolicy Bypass -File capture\native\build.ps1 -Install
```

## 導入手順

1. ゲームを終了する
2. 元の `UmamusumePrettyDerby_Jpn.exe` をバックアップする
3. FunnyHoney を `UmamusumePrettyDerby_Jpn.exe` としてゲームフォルダに置く
4. ビルドした `cri_mana_vpx.dll` をゲームフォルダに置く
5. `py -3 -X utf8 capture/server.py --port 4693` を起動する
6. ゲームを起動する

## 元に戻す

1. ゲームを終了する
2. バックアップした元の `UmamusumePrettyDerby_Jpn.exe` を戻す
3. `cri_mana_vpx.dll` を削除する

## 調査メモ: 純正 EXE のまま使えない理由

純正 EXE のまま自前 DLL を読み込ませる方法も検証しましたが、以下で失敗しました。

- `winhttp.dll` / `UnityPlayer.dll` / `baselib.dll` プロキシ
  - DRM / 起動チェックで Unity 起動前に終了
- 純正 EXE を一時停止しての DLL 注入
  - ランチャーへの注入は成功
  - 実際のゲームは保護された子プロセスで動作し、`VirtualAllocEx` がエラー5
- 自前ローダーで `UnityPlayer.dll!UnityMain` を直接呼ぶ
  - `Failed to load il2cpp`
  - `global-metadata.dat` がディスク上に存在しない
- メモリ上のメタデータ抽出
  - メタデータは `GameAssembly.dll` の `.data` に復号展開される
  - ただし `GameAssembly.dll` のロード中に書き込まれるため、ユーザーモードの
    ページガードでは間に合わない
  - 純正 EXE の保護子プロセスは `ReadProcessMemory` も拒否する

そのため、完全自己完結には DRM / ローダー / メタデータ復号の解析が必要で、
最終製品としてはリスクが高いと判断しました。

## ライセンス

`third_party/minhook` は MinHook（BSD 2-Clause）です。
`third_party/minhook/LICENSE.txt` を参照してください。
