-- 顧問先
CREATE TABLE clients (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  subdomain  TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

-- 顧問先ページにログインできるメールアドレス
CREATE TABLE members (
  client_id TEXT NOT NULL REFERENCES clients(id),
  email     TEXT NOT NULL,
  PRIMARY KEY (client_id, email)
);
CREATE INDEX members_email ON members(email);

-- 帳簿のデータ。key は 'master'（業者・精算書の設定など）、'm:2026-10'（月ごと）、'office'（事務所だけが見る設定）
CREATE TABLE docs (
  client_id  TEXT NOT NULL REFERENCES clients(id),
  key        TEXT NOT NULL,
  data       TEXT NOT NULL,
  version    INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (client_id, key)
);

-- 変更のたびに前の版を残す（帳簿の保存期間のあいだ消さない）
CREATE TABLE doc_history (
  client_id  TEXT NOT NULL,
  key        TEXT NOT NULL,
  version    INTEGER NOT NULL,
  data       TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (client_id, key, version)
);

-- 操作の記録
CREATE TABLE audit (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT,
  at        TEXT NOT NULL,
  email     TEXT NOT NULL,
  action    TEXT NOT NULL,
  detail    TEXT
);
CREATE INDEX audit_client ON audit(client_id, at);
