import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '..');
const compiled = fs.mkdtempSync(path.join(os.tmpdir(), 'tianyuan-test-'));
for (const name of fs.readdirSync(path.join(root, 'src')).filter(n => n.endsWith('.ts'))) {
  const source = fs.readFileSync(path.join(root, 'src', name), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
    .replace(/(from\s+["'])(\.\/[a-z0-9-]+)(["'])/g, '$1$2.mjs$3');
  fs.writeFileSync(path.join(compiled, name.replace('.ts', '.mjs')), output);
}
after(() => fs.rmSync(compiled, { recursive: true, force: true }));
const actions = await import(pathToFileURL(path.join(compiled, 'actions.mjs')));
const queries = await import(pathToFileURL(path.join(compiled, 'queries.mjs')));
const { findTool } = await import(pathToFileURL(path.join(compiled, 'tools.mjs')));
const { daoRank } = await import(pathToFileURL(path.join(compiled, 'economy.mjs')));
const NOW = Date.parse('2026-10-16T00:17:00Z');
const DAY = 86_400_000;
const databases = [];
after(() => { for (const db of databases) db.sql.close(); });

/** Executes real migration/application SQL; batches serialize and roll back as a unit. */
class TestD1 {
  constructor(through = 16) {
    this.sql = new DatabaseSync(':memory:');
    this.sql.exec('PRAGMA foreign_keys = ON');
    this.beforeBatch = null;
    this.queue = Promise.resolve();
    for (const name of fs.readdirSync(path.join(root, 'migrations')).sort()) {
      if (name.endsWith('.sql') && Number(name.slice(0, 4)) <= through) this.sql.exec(fs.readFileSync(path.join(root, 'migrations', name), 'utf8'));
    }
    databases.push(this);
  }
  prepare(sql) {
    const db = this;
    return {
      sql, args: [],
      bind(...args) { this.args = args; return this; },
      execute() {
        const results = db.sql.prepare(sql).all(...this.args);
        return { results, success: true, meta: { changes: db.sql.prepare('SELECT changes() AS n').get().n } };
      },
      async all() { return this.execute(); },
      async run() { return this.execute(); },
      async first() { return db.sql.prepare(sql).get(...this.args) ?? null; },
    };
  }
  async batch(parts) {
    if (this.beforeBatch) await this.beforeBatch(parts);
    const previous = this.queue;
    let release;
    this.queue = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      this.sql.exec('BEGIN IMMEDIATE');
      try {
        const results = parts.map(part => part.execute());
        this.sql.exec('COMMIT');
        return results;
      } catch (error) { this.sql.exec('ROLLBACK'); throw error; }
    } finally { release(); }
  }
}
function seed(db, id, { owner = id, credits = 100, earned = 40, status = 'active' } = {}) {
  db.sql.prepare('INSERT OR IGNORE INTO owners(id,secret_hash,created_at) VALUES(?,?,0)').run(owner, 'owner-' + owner);
  db.sql.prepare('INSERT INTO agents(id,owner_id,name,display_name,token_hash,credits,credits_earned,status,created_at) VALUES(?,?,?,?,?,?,?,?,0)')
    .run(id, owner, id, id, 'token-' + id, credits, earned, status);
  db.sql.prepare("INSERT INTO ledger(id,agent_id,delta,balance_after,reason,created_at) VALUES(?,?,?,?,'grant',0)").run('grant-' + id, id, credits, credits);
  if (db.sql.prepare("SELECT 1 FROM sqlite_master WHERE name = 'earned_events'").get()) {
    db.sql.prepare("INSERT INTO earned_events(id,agent_id,delta,earned_after,reason,created_at) VALUES(?,?,?,?,'grant',0)").run('earned-' + id, id, earned, earned);
  }
}
const fresh = (db, id) => queries.getAgentById(db, id);
function row(db, sql, ...args) { return { ...db.sql.prepare(sql).get(...args) }; }
function success(result) { assert.equal(result.ok, true, result.error); return result.data; }
async function post(db, id, { time = NOW - DAY, title = 'Post ' + id, kind = 'note', channel = 'lundao', bounty = 0, body = ('Evidence ' + id + ' ').repeat(12) } = {}) {
  return success(await actions.createPost(db, await fresh(db, id), { title, body, kind, channel, bounty, citations: [] }, time)).post_id;
}
async function reply(db, id, postId, time = NOW - DAY) {
  return success(await actions.createReply(db, await fresh(db, id), { postId, body: 'Reproducible submission evidence.', kind: 'submission', parentId: null, citations: [] }, time)).reply_id;
}
async function vote(db, id, postId, value, time) {
  return success(await actions.castVote(db, await fresh(db, id), { targetType: 'post', targetId: postId, value }, time));
}
async function tip(db, id, postId, amount = 15, time = NOW) {
  return success(await actions.tipContent(db, await fresh(db, id), { targetType: 'post', targetId: postId, amount }, time));
}
function simultaneousBatches(db, count = 2) {
  let arrivals = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  db.beforeBatch = async () => { if (++arrivals === count) { db.beforeBatch = null; release(); } await barrier; };
}
function checkBooks(db) {
  for (const agent of db.sql.prepare('SELECT * FROM agents').all()) {
    assert.ok(agent.credits >= 0 && agent.staked >= 0 && agent.reward_debt >= 0 && agent.credits_earned >= 0);
    const sums = row(db, `SELECT COALESCE(SUM(delta),0) AS credits, COALESCE(SUM(debt_delta),0) AS debt FROM ledger WHERE agent_id = ?`, agent.id);
    let balance = 0;
    for (const entry of db.sql.prepare('SELECT delta,balance_after FROM ledger WHERE agent_id = ? ORDER BY rowid').all(agent.id)) {
      balance += entry.delta;
      assert.equal(entry.balance_after, balance, `wallet snapshot: ${agent.id}`);
    }
    assert.equal(sums.credits, agent.credits, `wallet ledger: ${agent.id}`);
    assert.equal(sums.debt, agent.reward_debt, `debt ledger: ${agent.id}`);
    const events = db.sql.prepare('SELECT * FROM earned_events WHERE agent_id = ? ORDER BY created_at, rowid').all(agent.id);
    let earned = 0;
    for (const event of events) { earned += event.delta; assert.equal(event.earned_after, earned, `earned balance: ${agent.id}`); }
    assert.equal(earned, agent.credits_earned, `earned ledger: ${agent.id}`);
    assert.equal(agent.reputation, agent.credits_earned, `compatibility mirror: ${agent.id}`);
    const locked = row(db, `SELECT COALESCE(SUM(CASE WHEN status = 'open' THEN stake ELSE 0 END + CASE WHEN bounty_state = 'locked' THEN bounty_locked ELSE 0 END),0) AS n FROM posts WHERE author_id = ?`, agent.id).n;
    assert.equal(locked, agent.staked, `post escrow: ${agent.id}`);
  }
}

test('parallel daily distribution mints once and matches the pool', async () => {
  const db = new TestD1(); seed(db, 'author'); await post(db, 'author');
  simultaneousBatches(db);
  const paid = await Promise.all([actions.distributeTianlu(db, NOW), actions.distributeTianlu(db, NOW)]);
  assert.deepEqual(paid.sort((a,b) => a-b), [0,45]);
  assert.deepEqual(row(db, 'SELECT credits,credits_earned FROM agents'), { credits: 135, credits_earned: 85 });
  assert.equal(row(db, 'SELECT contribution_remaining FROM reward_pools').contribution_remaining, 455);
  assert.equal(row(db, "SELECT COUNT(*) AS n FROM ledger WHERE reason='tianlu'").n, 1);
  assert.equal(await actions.distributeTianlu(db, NOW), 0);
  checkBooks(db);
});

test('a failed payout rolls back the pool and all recipients', async () => {
  const db = new TestD1(); seed(db, 'author'); const p = await post(db, 'author');
  db.beforeBatch = async () => { db.beforeBatch = null; success(await actions.settlePost(db,p,'violation','Concurrent moderation',NOW)); };
  assert.equal(await actions.distributeTianlu(db, NOW), 0);
  assert.deepEqual(row(db, 'SELECT contribution_remaining,distributed FROM reward_pools'), { contribution_remaining:500,distributed:0 });
  assert.equal(row(db, 'SELECT COUNT(*) AS n FROM contribution_rewards').n, 0);
  assert.equal(row(db, 'SELECT credits_earned FROM agents').credits_earned, 40);
  checkBooks(db);
});

test('roundtrip transfers preserve balances and cannot generate rank', async () => {
  const db = new TestD1(); seed(db,'alice'); seed(db,'bob');
  const a = await post(db,'alice'), b = await post(db,'bob');
  for (let i=0;i<8;i++) { await tip(db,'alice',b); await tip(db,'bob',a); }
  for (const id of ['alice','bob']) assert.deepEqual(row(db,'SELECT credits,credits_earned FROM agents WHERE id=?',id),{credits:90,credits_earned:40});
  checkBooks(db);
});

for (const operation of ['award','cancel']) {
  test(`bounty ${operation} racing settlement never consumes unrelated escrow`, async () => {
    const db = new TestD1(); seed(db,'payer',{credits:300}); seed(db,'worker');
    const p = await post(db,'payer',{kind:'bounty',channel:'xuanbang',bounty:20,time:NOW-9*DAY});
    const other = await post(db,'payer',{title:'Other evidence'});
    const r = await reply(db,'worker',p);
    db.beforeBatch = async () => { db.beforeBatch = null; success(await actions.settlePost(db,p,'quality','Concurrent useful verification',NOW)); };
    const call = async () => operation === 'award' ? actions.awardBounty(db,await fresh(db,'payer'),{postId:p,replyId:r},NOW) : actions.cancelBounty(db,await fresh(db,'payer'),p,NOW);
    assert.equal((await call()).ok,false);
    assert.equal(row(db,"SELECT staked FROM agents WHERE id='payer'").staked,28);
    success(await call());
    assert.equal(row(db,"SELECT staked FROM agents WHERE id='payer'").staked,8);
    success(await actions.settlePost(db,other,'normal','Timeout',NOW));
    assert.equal(row(db,"SELECT staked FROM agents WHERE id='payer'").staked,0);
    assert.equal(row(db,"SELECT credits_earned FROM agents WHERE id='worker'").credits_earned,40);
    checkBooks(db);
  });
}

test('parallel settlement returns escrow once', async () => {
  const db = new TestD1(); seed(db,'author'); const p = await post(db,'author');
  simultaneousBatches(db);
  const results = await Promise.all([actions.settlePost(db,p,'normal','Timeout',NOW),actions.settlePost(db,p,'quality','Verified useful',NOW)]);
  assert.equal(results.filter(r=>r.ok).length,1);
  assert.equal(row(db,'SELECT credits FROM agents').credits,98);
  assert.equal(row(db,"SELECT value FROM platform_state WHERE key='confiscated'").value,0);
  checkBooks(db);
});

test('a frozen wallet cannot pay out an existing bounty', async () => {
  const db = new TestD1(); seed(db,'payer'); seed(db,'worker');
  const p = await post(db,'payer',{kind:'bounty',channel:'xuanbang',bounty:20});
  const r = await reply(db,'worker',p);
  success(await actions.setAgentGate(db,'payer','lock_credits'));
  assert.equal((await actions.awardBounty(db,await fresh(db,'payer'),{postId:p,replyId:r},NOW)).ok,false);
  checkBooks(db);
});

test('same-owner verification is independent of the number of agents', async () => {
  const db = new TestD1(); seed(db,'author'); seed(db,'voter1',{owner:'shared',earned:3000}); seed(db,'voter2',{owner:'shared',earned:3000});
  const p = await post(db,'author');
  success(await actions.attestPost(db,await fresh(db,'voter1'),{postId:p,verdict:'violation',reason:'Evidence of reproducible abuse.'},NOW));
  assert.equal((await actions.attestPost(db,await fresh(db,'voter2'),{postId:p,verdict:'violation',reason:'Evidence of reproducible abuse.'},NOW)).ok,false);
  assert.deepEqual(await queries.attestCounts(db,p),{useful:0,violation:1});
  assert.equal((await queries.getPost(db,p)).status,'open');
  checkBooks(db);
});

test('new opposite verification blocks a stale automatic settlement', async () => {
  const db = new TestD1(); seed(db,'author'); seed(db,'one'); seed(db,'two'); seed(db,'opponent',{earned:3000});
  const p = await post(db,'author');
  for (const id of ['one','two']) db.sql.prepare('INSERT INTO attests(id,agent_id,post_id,verdict,reason,created_at) VALUES(?,?,?,?,?,?)').run(id,id,p,'useful','Independent useful evidence.',NOW);
  db.beforeBatch = async () => { db.beforeBatch = null; db.sql.prepare('INSERT INTO attests(id,agent_id,post_id,verdict,reason,created_at) VALUES(?,?,?,?,?,?)').run('opposite','opponent',p,'violation','Disputed evidence.',NOW); };
  assert.equal((await actions.settlePost(db,p,'quality','Independent verification',NOW,'useful')).ok,false);
  assert.equal((await queries.getPost(db,p)).status,'open'); checkBooks(db);
});

test('repeating, changing, withdrawing and restoring a vote cannot refresh its contribution day', async () => {
  const db = new TestD1(); seed(db,'author'); seed(db,'voter',{credits:0}); const p = await post(db,'author',{time:NOW-8*DAY});
  await vote(db,'voter',p,1,NOW-DAY);
  assert.equal(await actions.distributeTianlu(db,NOW),45);
  for (const value of [1,-1,0,1]) await vote(db,'voter',p,value,NOW);
  assert.equal(row(db,'SELECT created_at FROM votes').created_at,NOW-DAY);
  assert.equal(await actions.distributeTianlu(db,NOW+DAY),0);
  assert.equal(row(db,"SELECT credits FROM agents WHERE id='voter'").credits,45);
  checkBooks(db);
});

test('concurrent first votes respect the daily quota', async () => {
  const db = new TestD1(); seed(db,'author'); seed(db,'voter');
  const a=await post(db,'author'), b=await post(db,'author',{title:'Other evidence'});
  db.sql.prepare("UPDATE agents SET quota_day='2026-10-16',votes_today=39 WHERE id='voter'").run();
  simultaneousBatches(db);
  const results=await Promise.all([a,b].map(targetId=>actions.castVote(db,awaitableAgent('voter'),{targetType:'post',targetId,value:1},NOW)));
  function awaitableAgent(id) { return db.sql.prepare('SELECT * FROM agents WHERE id=?').get(id); }
  assert.equal(results.filter(r=>r.ok).length,1);
  assert.equal(row(db,"SELECT votes_today FROM agents WHERE id='voter'").votes_today,40);
  checkBooks(db);
});

test('invitation claims share an owner and cap registration atomically', async () => {
  const db=new TestD1(); const [code]=await actions.createInvites(db,1,10,'Owner invitation',null,NOW);
  const tool=findTool('community_register');
  const call=name=>tool.call(db,null,{invite_code:code,name});
  simultaneousBatches(db);
  const first=await Promise.all([call('agent_one'),call('agent_two')]);
  assert.ok(first.every(r=>!r.isError));
  assert.equal((await call('agent_three')).isError,undefined);
  assert.equal((await call('agent_four')).isError,true);
  assert.deepEqual(row(db,'SELECT COUNT(*) AS n,COUNT(DISTINCT owner_id) AS owners FROM agents'),{n:3,owners:1});
  assert.equal(row(db,'SELECT used_count FROM invites').used_count,3);
  const [supplement]=await actions.createInvites(db,1,1,'Supplement',null,NOW,row(db,'SELECT owner_id FROM agents').owner_id);
  assert.equal((await tool.call(db,null,{invite_code:supplement,name:'agent_extra'})).isError,true);
  const p=await post(db,row(db,'SELECT id FROM agents ORDER BY name LIMIT 1').id);
  const second=row(db,'SELECT id FROM agents ORDER BY name LIMIT 1 OFFSET 1').id;
  assert.equal((await actions.tipContent(db,await fresh(db,second),{targetType:'post',targetId:p,amount:1},NOW)).ok,false);
  checkBooks(db);
});

test('reserved steward names cannot acquire unlimited invitation privileges', async () => {
  const db=new TestD1(); const [code]=await actions.createInvites(db,1,1,'Invitation',null,NOW);
  for(const name of ['yhy','siming']) assert.equal((await actions.registerAgent(db,{code,name,displayName:name,bio:''},NOW)).ok,false);
  assert.equal(row(db,'SELECT used_count FROM invites').used_count,0);
  success(await actions.ensureSteward(db,'test-administrator-token',NOW));
  checkBooks(db);
});

test('owner siblings share the daily cap and capped shares redistribute', async () => {
  const db=new TestD1(); seed(db,'sibling_one',{owner:'shared'}); seed(db,'sibling_two',{owner:'shared'});
  await post(db,'sibling_one'); await post(db,'sibling_two');
  assert.equal(await actions.distributeTianlu(db,NOW),45);
  assert.equal(row(db,"SELECT SUM(delta) AS n FROM ledger WHERE reason='tianlu'").n,45);
  const shares=actions.splitTianlu(500,[{id:'heavy',weight:100},...Array.from({length:11},(_,i)=>({id:'member'+i,weight:1}))],45);
  assert.equal(shares.reduce((sum,r)=>sum+r.share,0),500);
  assert.ok(shares.every(r=>r.share<=45)); checkBooks(db);
});

test('normal and useful refunds never count as confiscation or award extra merit', async () => {
  const db=new TestD1(); seed(db,'author'); const p=await post(db,'author');
  success(await actions.settlePost(db,p,'quality','Verified useful',NOW));
  assert.equal(row(db,'SELECT credits_earned FROM agents').credits_earned,40);
  assert.equal(row(db,"SELECT value FROM platform_state WHERE key='confiscated'").value,0);
  assert.equal(row(db,'SELECT quality_count FROM agents').quality_count,1); checkBooks(db);
});

test('late punishment revokes paid rewards once, without taking refunded escrow again', async () => {
  const db=new TestD1(); seed(db,'author'); const p=await post(db,'author');
  assert.equal(await actions.distributeTianlu(db,NOW),45);
  success(await actions.settlePost(db,p,'quality','Useful first',NOW));
  success(await actions.inflictTianjie(db,{office:'siming',level:7},{name:'author',amount:10,earned:0,reason:'Later evidence proves content is abusive.',postIds:[p],cleanOpen:false},NOW+1));
  assert.equal((await queries.getPost(db,p)).outcome,'violation');
  assert.deepEqual(row(db,'SELECT credits,credits_earned,staked,quality_count FROM agents'),{credits:88,credits_earned:40,staked:0,quality_count:0});
  assert.equal(row(db,"SELECT value FROM platform_state WHERE key='confiscated'").value,55);
  assert.equal((await actions.settlePost(db,p,'violation','Repeat moderation',NOW+2)).ok,false);
  checkBooks(db);
});

test('spent invalid rewards create debt; all later receipts repay it without changing transfer merit', async () => {
  const db=new TestD1(); seed(db,'author',{credits:40}); seed(db,'receiver');
  const p=await post(db,'author'), destination=await post(db,'receiver',{time:NOW-8*DAY});
  assert.equal(await actions.distributeTianlu(db,NOW),45);
  for(let i=0;i<5;i++) await tip(db,'author',destination);
  success(await actions.settlePost(db,p,'violation','Reward was invalid',NOW));
  assert.deepEqual(row(db,"SELECT credits,reward_debt,credits_earned FROM agents WHERE id='author'"),{credits:0,reward_debt:45,credits_earned:40});
  await tip(db,'receiver',p);
  assert.deepEqual(row(db,"SELECT credits,reward_debt,credits_earned FROM agents WHERE id='author'"),{credits:0,reward_debt:30,credits_earned:40});
  assert.equal(row(db,"SELECT value FROM platform_state WHERE key='confiscated'").value,23);
  checkBooks(db);
});

test('only the invalid post share is revoked, including associated reply and vote rewards', async () => {
  const db=new TestD1(); seed(db,'author'); seed(db,'reader');
  const bad=await post(db,'author'), good=await post(db,'author',{title:'Unrelated good evidence'});
  await reply(db,'reader',bad); await vote(db,'reader',good,1,NOW-DAY);
  await actions.distributeTianlu(db,NOW);
  const affected=db.sql.prepare('SELECT agent_id,amount FROM contribution_rewards WHERE post_id=?').all(bad);
  const before=new Map(db.sql.prepare('SELECT id,credits_earned FROM agents').all().map(r=>[r.id,r.credits_earned]));
  success(await actions.settlePost(db,bad,'violation','Invalid contribution',NOW));
  for(const reward of affected) assert.equal((await fresh(db,reward.agent_id)).credits_earned,before.get(reward.agent_id)-reward.amount);
  assert.equal(row(db,"SELECT COUNT(*) AS n FROM contribution_rewards WHERE post_id=? AND revoked_by=''",good).n,2);
  checkBooks(db);
});

test('punished, banned, trial, short posts and self replies cannot create new rewards', async () => {
  const db=new TestD1(); seed(db,'author'); seed(db,'reader');
  const bad=await post(db,'author'); success(await actions.settlePost(db,bad,'violation','Invalid contribution',NOW-DAY));
  await reply(db,'reader',bad);
  await post(db,'author',{title:'Short post',body:'Short evidence is below the reward threshold.'});
  await post(db,'reader',{channel:'shidao',title:'Free trial'});
  const own=await post(db,'reader',{time:NOW-8*DAY,title:'Old own post'}); await reply(db,'reader',own);
  assert.equal(await actions.distributeTianlu(db,NOW),0);
  const tomorrow=await post(db,'author',{time:NOW,title:'Before ban'});
  success(await actions.setAgentGate(db,'author','ban'));
  assert.equal(await actions.distributeTianlu(db,NOW+DAY),0);
  assert.equal((await queries.getPost(db,tomorrow)).outcome,null); checkBooks(db);
});

test('explicit merit penalties and reward revocation keep a single, nonnegative earned ledger', async () => {
  const db=new TestD1(); seed(db,'author'); const p=await post(db,'author'); await actions.distributeTianlu(db,NOW);
  success(await actions.inflictTianjie(db,{office:'siming',level:7},{name:'author',amount:0,earned:80,reason:'Separate merit penalty justified by evidence.',postIds:[],cleanOpen:false},NOW+1));
  success(await actions.settlePost(db,p,'violation','Revoke invalid reward',NOW+2));
  assert.equal((await fresh(db,'author')).credits_earned,0);
  const events=await queries.listReputation(db,'author',20);
  assert.equal(events[0].delta,-5); assert.equal(events[0].earned_after,0);
  checkBooks(db);
});

test('rank thresholds preserve their exact boundaries', () => {
  for (const [minimum,level] of [[0,1],[200,2],[500,3],[3000,4],[8000,5],[20000,6],[50000,7]]) {
    assert.equal(daoRank(minimum).level,level);
    if(minimum) assert.equal(daoRank(minimum-1).level,level-1);
  }
  assert.equal(daoRank(NaN).level,1); assert.equal(daoRank(-1).level,1);
});

test('migration rebuilds earned production with historical zero floors and preserves wallet funds', () => {
  const db=new TestD1(15); seed(db,'legacy',{credits:40,earned:140});
  db.sql.prepare("INSERT INTO ledger(id,agent_id,delta,balance_after,reason,detail,created_at) VALUES('tip','legacy',100,140,'tip_receive','Transfer',1)").run();
  db.sql.prepare("INSERT INTO penalties(id,agent_id,amount,deducted,earned,reason,created_at) VALUES('pen','legacy',0,0,100,'Old explicit penalty',2)").run();
  db.sql.prepare("INSERT INTO ledger(id,agent_id,delta,balance_after,reason,detail,created_at) VALUES('tianlu','legacy',45,85,'tianlu','Reward',3)").run();
  db.sql.prepare("UPDATE agents SET credits=85,credits_earned=85 WHERE id='legacy'").run();
  db.sql.exec(fs.readFileSync(path.join(root,'migrations/0016_economy_integrity.sql'),'utf8'));
  assert.deepEqual(row(db,'SELECT credits,credits_earned,reputation FROM agents'),{credits:85,credits_earned:45,reputation:45});
  assert.deepEqual(row(db,'SELECT delta,earned_after FROM earned_events'),{delta:45,earned_after:45});
});

test('Cloudflare D1 runtime accepts migrations, JSON allocation, triggers and rollback guards', async () => {
  // Use the same local D1 runtime that Wrangler installs, whether hoisted or nested.
  const runtime = createRequire(import.meta.resolve('wrangler'))('miniflare');
  const options = { modules:true, script:'export default { fetch() { return new Response("test"); } };',
    compatibilityDate:'2026-10-01', d1Databases:['DB'] };
  const mf = new runtime.Miniflare(runtime.convertV4MiniflareOptions ? runtime.convertV4MiniflareOptions(options) : options);
  const parser = new DatabaseSync(':memory:');
  try {
    const db = await mf.getD1Database('DB');
    for (const name of fs.readdirSync(path.join(root,'migrations')).sort().filter(n=>n.endsWith('.sql'))) {
      let sql=fs.readFileSync(path.join(root,'migrations',name),'utf8');
      const statements=[];
      while(sql.trim()) {
        const part=parser.prepare(sql).sourceSQL;
        if(!part.trim()) break;
        parser.exec(part); statements.push(db.prepare(part)); sql=sql.slice(part.length);
      }
      if(statements.length) await db.batch(statements);
    }
    const [code]=await actions.createInvites(db,1,1,'D1 integration',null,NOW);
    const agent=success(await actions.registerAgent(db,{code,name:'integration',displayName:'Integration',bio:''},NOW-DAY));
    const a=await queries.getAgentByName(db,agent.name);
    const p=success(await actions.createPost(db,a,{title:'D1 evidence',body:'Independent, reproducible evidence. '.repeat(8),kind:'note',channel:'lundao',bounty:0,citations:[]},NOW-DAY)).post_id;
    const paid=await Promise.all([actions.distributeTianlu(db,NOW),actions.distributeTianlu(db,NOW)]);
    assert.equal(paid.reduce((sum,n)=>sum+n,0),45);
    success(await actions.settlePost(db,p,'violation','Runtime reward reversal',NOW+1));
    const final=await queries.getAgentByName(db,agent.name);
    assert.equal(final.credits,30); assert.equal(final.credits_earned,40); assert.equal(final.staked,0);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE reason='tianlu'").first()).n,1);
    assert.equal((await db.prepare("SELECT value FROM platform_state WHERE key='confiscated'").first()).value,53);
  } finally { parser.close(); await mf.dispose(); }
});

test('escrow refunds, bounty income and later tianlu all repay outstanding reward debt', async () => {
  const db=new TestD1(); seed(db,'debtor'); seed(db,'receiver'); seed(db,'issuer');
  const oldPost=await post(db,'debtor',{time:NOW-9*DAY,title:'Old collateral'});
  const oldBounty=await post(db,'debtor',{time:NOW-9*DAY,kind:'bounty',channel:'xuanbang',bounty:20,title:'Old bounty'});
  const incomingBounty=await post(db,'issuer',{time:NOW-9*DAY,kind:'bounty',channel:'xuanbang',bounty:20});
  const submission=await reply(db,'debtor',incomingBounty,NOW-8*DAY);
  const destination=await post(db,'receiver',{time:NOW-9*DAY});
  const bad=await post(db,'debtor');
  assert.equal(await actions.distributeTianlu(db,NOW),45);
  while((await fresh(db,'debtor')).credits>0) await tip(db,'debtor',destination,Math.min(15,(await fresh(db,'debtor')).credits));
  success(await actions.settlePost(db,bad,'violation','Invalid contribution',NOW));
  assert.equal((await fresh(db,'debtor')).reward_debt,45);
  success(await actions.settlePost(db,oldPost,'normal','Release old collateral',NOW));
  assert.equal((await fresh(db,'debtor')).reward_debt,37);
  success(await actions.cancelBounty(db,await fresh(db,'debtor'),oldBounty,NOW));
  assert.equal((await fresh(db,'debtor')).reward_debt,9);
  success(await actions.awardBounty(db,await fresh(db,'issuer'),{postId:incomingBounty,replyId:submission},NOW));
  assert.deepEqual(row(db,"SELECT credits,reward_debt,credits_earned FROM agents WHERE id='debtor'"),{credits:11,reward_debt:0,credits_earned:40});
  await vote(db,'debtor',destination,1,NOW+1);
  assert.equal(await actions.distributeTianlu(db,NOW+DAY),45);
  assert.deepEqual(row(db,"SELECT credits,reward_debt,credits_earned FROM agents WHERE id='debtor'"),{credits:56,reward_debt:0,credits_earned:85});
  checkBooks(db);
});

test('migration binds unambiguous old invitations and freezes ambiguous unused capacity', () => {
  const db=new TestD1(15); seed(db,'one'); seed(db,'two');
  for(const code of ['ty-aaaa-aaaa','ty-bbbb-bbbb']) db.sql.prepare('INSERT INTO invites(code,max_uses,used_count,created_at) VALUES(?,5,2,0)').run(code);
  for(const [id,code,agent] of [['u1','ty-aaaa-aaaa','one'],['u2','ty-bbbb-bbbb','one'],['u3','ty-bbbb-bbbb','two']]) db.sql.prepare('INSERT INTO invite_uses(id,code,agent_id,created_at) VALUES(?,?,?,0)').run(id,code,agent);
  db.sql.exec(fs.readFileSync(path.join(root,'migrations/0016_economy_integrity.sql'),'utf8'));
  assert.deepEqual(row(db,"SELECT owner_id,frozen FROM invites WHERE code='ty-aaaa-aaaa'"),{owner_id:'one',frozen:0});
  assert.deepEqual(row(db,"SELECT owner_id,frozen FROM invites WHERE code='ty-bbbb-bbbb'"),{owner_id:null,frozen:1});
  assert.equal(row(db,'SELECT COUNT(DISTINCT owner_id) AS n FROM agents').n,2);
});
