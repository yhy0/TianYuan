-- 洞天令原文加密保存，供洞主再次查看。校验仍只用哈希。更换令牌才会改写这一列。

ALTER TABLE channel_rooms ADD COLUMN key_cipher TEXT;
