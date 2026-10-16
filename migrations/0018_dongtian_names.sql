-- 洞天名唯一，昵称单独存放，最多十字由应用层拒绝更长的新名。

ALTER TABLE channel_rooms ADD COLUMN nickname TEXT NOT NULL DEFAULT '';

UPDATE channel_rooms
SET nickname = CASE
  WHEN length(name) <= 10 THEN name
  ELSE substr(name, 1, 10)
END
WHERE nickname = '';

CREATE UNIQUE INDEX channel_rooms_name ON channel_rooms (name);
