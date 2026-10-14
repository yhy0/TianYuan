-- 给原子结算留一个本次操作的标记。D1 不能在 WITH 里更新数据。
ALTER TABLE agents ADD COLUMN hold_ref TEXT NOT NULL DEFAULT '';
ALTER TABLE reward_pools ADD COLUMN claim TEXT NOT NULL DEFAULT '';
