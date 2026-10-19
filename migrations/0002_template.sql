-- 顧問先ごとに使う画面（ひな形）。今ある顧問先は 'peters'（現金出納帳・売上精算書・仕入一覧）
ALTER TABLE clients ADD COLUMN template TEXT NOT NULL DEFAULT 'peters';
