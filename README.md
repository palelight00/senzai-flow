# 洗剤記録 — 浴槽自動洗浄

浴槽の自動洗浄機で使うバスマジックリンの**洗剤量を手早く記録する**ためのWEBアプリです。
最終的な目的は、記録をためて「**冬季の寒い時期に1回あたりの洗剤使用量が公称値（25ml）より増えるのか**」を、後日 気象条件・外気温と突き合わせて分析することです。

このフェーズの最優先は「記録のしやすさ」。アプリを開いて**最少タップ**で記録できることを重視しています。

## 特徴

- **ビルド不要の静的サイト**（素の HTML/CSS/JS）。GitHub Pages で公開し、Safari など各種ブラウザから直接アクセスできます。
- **データはブラウザ内（localStorage）にのみ保存**。サーバには送りません。
- **JSON / CSV で書き出し・JSON で読み込み**ができ、バックアップ・端末間移行が可能。
- **PWA 対応**。iPhone の「ホーム画面に追加」でアプリのように使え、オフラインでも記録できます。

## 記録できるイベント

| ボタン | 意味 |
|---|---|
| 洗剤追加（×1 / ×2） | 詰め替え 300ml ×1（+300ml）または ×2（+600ml）を追加 |
| low シグナル | 残量が 350ml 未満になった |
| min シグナル | 残量が 150ml 未満になった |
| 洗浄休み | その日は洗浄しなかった（消費なし） |

- 通常は「1日1回洗浄」と仮定し、例外（洗浄休み）とシグナル・追加だけを記録します。
- ヘッダーに**推定残量**と**シグナル状態**を表示します（記録時のフィードバック用の概算）。
- 日付を選べば**過去日の記録（事後入力）**ができ、履歴から**編集・削除**もできます。
- 各記録には任意で**備考**を付けられます（外気温メモ・2回洗浄など）。

## 使い方

1. 公開URL（`https://palelight00.github.io/senzai-flow/`）を Safari で開く。
2. 共有メニュー →「**ホーム画面に追加**」でアプリ化（任意）。
3. 該当ボタンをタップして記録。過去分は上部の日付を変えてから記録。
4. 「データ」タブから定期的に**JSON で書き出し**て保管。

### 過去データの読み込み

過去の記録は**プライバシーのためリポジトリには含めていません**。
別途お渡しする `senzai-flow-records.json` を端末に保存し、アプリの
「データ」→「JSON ファイルを選ぶ」→「追加（マージ）」で取り込んでください。

## GitHub Pages での公開手順

1. このリポジトリの **Settings → Pages** を開く。
2. **Source** を「**GitHub Actions**」に設定（1回だけ）。
3. `main`（または `claude/lucid-wozniak-5yDXf`）に push するとワークフロー
   （`.github/workflows/pages.yml`）が走り、自動でデプロイされます。
4. 数十秒後に公開URLへアクセスできます。

## ローカルでの確認

```sh
python3 -m http.server 8000
# ブラウザで http://localhost:8000/ を開く
```

> service worker（オフライン機能）は `http(s)` でのみ動作します（`file://` では無効）。

## アイコンの再生成

```sh
python3 tools/make_icons.py
```

## ファイル構成

```
index.html              画面（記録 / 履歴 / データ の3タブ）
app.js                  ロジック（保存・推定・import/export・UI）
styles.css              スタイル（モバイル優先）
manifest.webmanifest    PWA 設定
sw.js                   service worker（オフライン）
icons/                  アプリアイコン
tools/make_icons.py     アイコン生成スクリプト
.github/workflows/      GitHub Pages デプロイ
```

## データ形式（JSON）

```jsonc
{
  "schemaVersion": 1,
  "config": { "tankCapacity": 850, "refillUnit": 300,
              "lowThreshold": 350, "minThreshold": 150, "nominalPerWash": 25 },
  "events": [
    { "id": "...", "type": "add", "date": "2025-01-06", "amount": 600,
      "note": "", "createdAt": "2025-01-06T12:00:00.000Z" }
  ]
}
```

`type` は `add` / `low` / `min` / `rest`。`amount`（300 または 600）は `add` のときのみ。
日付は端末ローカルの暦日（`YYYY-MM-DD`）で保持します。
