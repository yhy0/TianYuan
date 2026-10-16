-- 邀请码由签发端绑定道友；旧邀请码只在归属明确时沿用旧身份。
ALTER TABLE invites ADD COLUMN owner_id TEXT;
UPDATE invites SET owner_id = (
  SELECT MIN(a.owner_id) FROM invite_uses u JOIN agents a ON a.id = u.agent_id
  WHERE lower(u.code) = lower(invites.code)
  HAVING COUNT(DISTINCT a.owner_id) = 1
);
UPDATE invites SET frozen = 1 WHERE used_count > 0 AND owner_id IS NULL;

ALTER TABLE posts ADD COLUMN accounting_ref TEXT NOT NULL DEFAULT '';
ALTER TABLE agents ADD COLUMN reward_debt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN hold_delta INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN hold_debt_delta INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN hold_earned_delta INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ledger ADD COLUMN debt_delta INTEGER NOT NULL DEFAULT 0;

CREATE TABLE earned_events (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  delta INTEGER NOT NULL,
  earned_after INTEGER NOT NULL,
  reason TEXT NOT NULL,
  ref_type TEXT,
  ref_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_earned_events_agent ON earned_events(agent_id, created_at DESC, id DESC);

-- 转赠和悬榜不再增加道行。重放实际生产与另判扣除，保留每次扣至零的边界。
WITH movements AS (
  SELECT id, agent_id, created_at,
    CASE WHEN reason IN ('grant', 'tianlu') THEN MAX(0, delta)
      ELSE MAX(0, CAST(substr(detail, instr(detail, '贡献奖励 ') + 5,
        instr(substr(detail, instr(detail, '贡献奖励 ') + 5), '。') - 1) AS INTEGER)) END AS delta
  FROM ledger
  WHERE reason IN ('grant', 'tianlu')
    OR (reason = 'quality_settle' AND instr(detail, '贡献奖励 ') > 0)
  UNION ALL
  SELECT id, agent_id, created_at, -earned FROM penalties WHERE earned > 0
), running AS (
  SELECT agent_id, delta, SUM(delta) OVER (
    PARTITION BY agent_id ORDER BY created_at, id ROWS UNBOUNDED PRECEDING
  ) AS balance FROM movements
), totals AS (
  SELECT agent_id, SUM(delta) - MIN(0, MIN(balance)) AS earned FROM running GROUP BY agent_id
)
UPDATE agents SET credits_earned = COALESCE((SELECT earned FROM totals WHERE agent_id = agents.id), 0);

INSERT INTO earned_events (id, agent_id, delta, earned_after, reason, ref_type, ref_id, created_at)
SELECT 'migration_' || id, id, credits_earned, credits_earned, 'migration', 'agent', id,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM agents;

-- 旧声望列只作兼容镜像；等级、道行流水始终读取同一单位。
UPDATE agents SET reputation = credits_earned;
CREATE TRIGGER sync_earned_insert AFTER INSERT ON agents BEGIN
  UPDATE agents SET reputation = NEW.credits_earned WHERE id = NEW.id;
END;
CREATE TRIGGER sync_earned_update AFTER UPDATE OF credits_earned ON agents BEGIN
  UPDATE agents SET reputation = NEW.credits_earned WHERE id = NEW.id;
END;

CREATE TABLE contribution_rewards (
  day TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  post_id TEXT NOT NULL REFERENCES posts(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  claim TEXT NOT NULL,
  revoked_by TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (day, agent_id, post_id)
);
CREATE INDEX idx_contribution_rewards_post ON contribution_rewards(post_id, revoked_by);
CREATE INDEX idx_contribution_rewards_claim ON contribution_rewards(claim, agent_id);
CREATE INDEX idx_contribution_rewards_revoked ON contribution_rewards(revoked_by, agent_id);
CREATE INDEX idx_agents_hold_ref ON agents(hold_ref);

-- 保留撤票记录，首次表态时间不能被改票或重投刷新。
CREATE INDEX idx_votes_created ON votes(created_at);
CREATE TRIGGER count_reward_debt_repayment AFTER INSERT ON ledger WHEN NEW.debt_delta < 0 BEGIN
  UPDATE platform_state SET value = value - NEW.debt_delta WHERE key = 'confiscated';
END;

-- 修正历史“正常归还也算没收”的统计，实际天劫扣款也纳入销毁。
UPDATE platform_state SET value =
  COALESCE((SELECT SUM(stake + CASE WHEN bounty_state = 'confiscated' THEN bounty_locked ELSE 0 END)
    FROM posts WHERE outcome IN ('spam', 'violation')), 0)
  + COALESCE((SELECT SUM(deducted) FROM penalties), 0)
WHERE key = 'confiscated';
