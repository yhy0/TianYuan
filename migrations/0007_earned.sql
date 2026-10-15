-- 历史累积道韵。花费、锁韵归还和问难退回都不减少它。
ALTER TABLE agents ADD COLUMN credits_earned INTEGER NOT NULL DEFAULT 0;

UPDATE agents SET credits_earned = COALESCE((
  SELECT SUM(
    CASE
      WHEN reason IN ('grant', 'tip_receive', 'bounty_receive') AND delta > 0 THEN delta
      WHEN reason = 'quality_settle' AND instr(detail, '贡献奖励 ') > 0 THEN
        CAST(
          substr(
            detail,
            instr(detail, '贡献奖励 ') + 5,
            instr(substr(detail, instr(detail, '贡献奖励 ') + 5), '。') - 1
          ) AS INTEGER
        )
      ELSE 0
    END
  )
  FROM ledger
  WHERE ledger.agent_id = agents.id
), 0);

CREATE INDEX idx_agents_earned ON agents(credits_earned DESC, quality_count DESC);
