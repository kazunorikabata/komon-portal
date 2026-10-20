# 顧問先専用ページ

顧問先が現金出納帳・売上精算書・仕入一覧・給与（合計）を入力して毎月提出し、事務所がそれを仕訳にしてJDL・MJS用のCSVを出すためのしくみです。

- 顧問先のページ：`https://c-xxxx.kabaoffice.com`（顧問先ごとに別のアドレス）
- 事務所のページ：`https://office.kabaoffice.com`

## しくみ

```
顧問先・事務所のブラウザ
   │
 [Cloudflare Access]  メールアドレスにワンタイムコードを送って本人確認
   │
 [Worker（このリポジトリ）]
   │  ・ログインの証明（JWT）を確かめる
   │  ・アドレス（c-xxxx / office）とメールアドレスから、見てよいページかを判定する
   │  ・顧問先は自社のデータだけ読み書きできる。提出済みの月は直せない（入金・支払の記録と修正依頼だけできる）
   │
 [D1 データベース]  顧問先ごとのデータ。変更のたびに前の版を doc_history に残す
```

| ファイル | 内容 |
|---|---|
| `src/worker.js` | ログインの確認、権限の判定、API |
| `public/t/<ひな形>/index.html` | 顧問先のページ。顧問先ごとに使うひな形を選ぶ（`peters`・`std`） |
| `src/templates.js` | ひな形の一覧（名前と説明） |
| `public/office/index.html` | 事務所のページ（仕訳変換・JDL／MJS出力・月末残高・修正依頼の承認・顧問先の登録） |
| `migrations/0001_init.sql` | データベースの表 |
| `wrangler.toml` | Cloudflare の設定 |

## はじめの設定（1回だけ）

### 1. ドメインを Cloudflare で管理する
kabaoffice.com を Cloudflare に追加して、Xserver でネームサーバーを Cloudflare のものに変えます。
今のホームページのレコード（`kabaoffice.com`、`www`）は**灰色の雲（DNSのみ）**のままにしてください。ホームページには影響しません。

### 2. データベース（D1）を作る
1. Cloudflare のダッシュボード →「ストレージとデータベース」→「D1」→「データベースを作成」
2. 名前は `komon-portal`
3. 作成後に表示される **データベースID** を `wrangler.toml` の `database_id` に入れる
4. そのデータベースの「コンソール」を開き、`migrations/` の SQL を番号順（`0001`、`0002`…）にすべて貼り付けて実行する

### 3. ログイン（Cloudflare Access）を設定する
1. ダッシュボード →「Zero Trust」を開き、チーム名を決める（例：`kabaoffice` → `kabaoffice.cloudflareaccess.com`）
2. 「設定」→「認証」→ ログイン方法に **ワンタイムPIN** を追加する
3. 「Access」→「アプリケーション」→「アプリケーションを追加」→「セルフホスト」
   - アプリケーションのドメイン：サブドメイン `*`、ドメイン `kabaoffice.com`
   - ポリシー：「許可」、含める：「すべての人」
     （メールアドレスの本人確認だけを Access で行い、どのページを見てよいかは Worker が登録済みのメールアドレスで判定します）
4. 作ったアプリケーションの「概要」にある **アプリケーション対象者（AUD）タグ** をコピーする
5. `wrangler.toml` の `TEAM_DOMAIN` にチームのドメイン、`ACCESS_AUD` に AUD タグを入れる

### 4. DNS にレコードを追加する
「DNS」→「レコードを追加」
- タイプ `AAAA`、名前 `*`、IPv6アドレス `100::`、**プロキシ有効（オレンジの雲）**

### 5. スタッフのメールアドレスを入れる
`wrangler.toml` の `STAFF_EMAILS` に、事務所のページを使う人のメールアドレスをカンマ区切りで入れる。

### 6. 公開する（GitHub と連携）
1. ダッシュボード →「Workers と Pages」→「作成」→「リポジトリをインポート」
2. GitHub の `komon-portal` を選ぶ
3. デプロイコマンドは `npx wrangler deploy` のまま
4. 以後は、このリポジトリに変更を入れるたびに自動で公開されます

### 7. 使い始める
1. `https://office.kabaoffice.com` を開き、スタッフのメールアドレスでログイン
2. 「顧問先とログインできるメールアドレス」で顧問先を追加し、顧問先の担当者のメールアドレスを登録する
3. 表に出る顧問先のページのアドレスを、顧問先に伝える

## 顧問先ごとの画面（ひな形）

顧問先のページは、顧問先ごとに「ひな形」を選んで使います。
- `peters`：現金出納帳（入金・経費精算・その他）、売上精算書・入金確認、仕入一覧（請求書）、給与（全員分の合計）
- `std`（標準）：出納帳をいくつでも持てる。出納帳ごとに、記入の種類（入金・出金・経費精算）、入力する項目（相手先・部署・科目・登録番号）、現金残高確認票、経費精算書の印刷を選ぶ。設定は事務所のページの「顧問先ページの設定」で行い、データベースの `config` に保存する（顧問先は読むだけで書けない）。メールアドレスごとに使える出納帳も選べる（使えない出納帳は、その人にはデータも渡さず、書き込みもサーバーで止める）
- ほかの顧問先用の画面は、`public/t/<名前>/index.html` を作り、`src/templates.js` に名前と説明を足します
- 事務所のページで顧問先を追加するときに、使うひな形を選びます
- 事務所のページの仕訳変換は、今は `peters` と `std` 用です（`public/office/index.html` の `JOURNAL_TEMPLATES`）

## データベースの変更（migrations）を足したとき
`migrations/` に新しい SQL を足したときは、D1 の「コンソール」でその SQL を実行してから公開してください。

## 手元での動作確認

```sh
printf 'DEV_EMAIL=staff@example.com\nSTAFF_EMAILS=staff@example.com\n' > .dev.vars
npx wrangler d1 migrations apply komon-portal --local
# 事務所として動かす
npx wrangler dev --local-upstream office.kabaoffice.com
curl http://127.0.0.1:8787/api/me
# 顧問先として動かす（c-xxxx は登録したサブドメイン）
npx wrangler dev --local-upstream c-xxxx.kabaoffice.com
```
`DEV_EMAIL` を入れたときはログインの確認を飛ばします。**本番の設定には入れないでください。**

## データの保存期間
帳簿は原則7年（欠損金がある年は10年）保存が必要です。`docs` と `doc_history` の行は消さないでください。
