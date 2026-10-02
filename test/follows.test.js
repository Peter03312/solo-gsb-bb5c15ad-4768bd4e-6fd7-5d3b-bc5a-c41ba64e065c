'use strict';
// 段号关注与发布通知端到端测试：临时 DB + 真实 HTTP 服务
process.env.DATA_DIR = '/tmp/hrc-follow-test-data';
process.env.PORT = '3991';
process.env.HOST = '127.0.0.1';

const fs = require('fs');
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });

const assert = require('assert');
const BASE = `http://127.0.0.1:${process.env.PORT}`;
let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; console.log('  ✓', msg); }
function eq(a, b, msg) { assert.strictEqual(a, b, msg); passed++; console.log('  ✓', msg); }

async function req(method, path, body, cookie) {
  const hasBody = method !== 'GET' && method !== 'HEAD' && body !== undefined && body !== null;
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: hasBody ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, setCookie: res.headers.get('set-cookie') || '' };
}
async function expectFail(p, statusPart, msgPart, label) {
  const r = await p;
  assert(r.status === statusPart || (r.status >= 400 && statusPart === 400),
    `${label}: 期望失败状态 ${statusPart}，实际 ${r.status}`);
  assert(r.json.error && r.json.error.includes(msgPart),
    `${label}: 错误信息应包含“${msgPart}”，实际：${r.json.error}`);
  ok(true, `${label} -> ${r.status} ${r.json.error}`);
}
async function login(u, p) {
  const r = await req('POST', '/api/login', { username: u, password: p });
  assert.strictEqual(r.status, 200, `登录失败: ${JSON.stringify(r.json)}`);
  return r.setCookie.split(';')[0];
}

// 记录员提议 → 复核员采纳 →（如触及异议则逐条回应）→ 发布，返回新版本号
async function publishChange(cookieRec, cookieRev, seg, start, end, replacement, basis) {
  const p = await req('POST', '/api/proposals', { seg, start, end, replacement, basis }, cookieRec);
  assert.strictEqual(p.status, 201, `提议失败: ${JSON.stringify(p.json)}`);
  const ad = await req('POST', `/api/proposals/${p.json.id}/adopt`, {}, cookieRev);
  assert.strictEqual(ad.status, 200, `采纳失败: ${JSON.stringify(ad.json)}`);
  const check = await req('GET', '/api/publish-check', null, cookieRev);
  for (const it of check.json.items || []) {
    if (!it.satisfied) {
      const r = await req('POST', `/api/objections/${it.objectionId}/respond`,
        { note: `关注测试：回应异议 #${it.objectionId}，不影响发布` }, cookieRev);
      assert.strictEqual(r.status, 201, `回应失败: ${JSON.stringify(r.json)}`);
    }
  }
  const pub = await req('POST', '/api/publish', { note: basis }, cookieRev);
  assert.strictEqual(pub.status, 201, `发布失败: ${JSON.stringify(pub.json)}`);
  return pub.json.versionId;
}

async function main() {
  require('../src/server');
  await new Promise((r) => setTimeout(r, 400));

  console.log('\n[关注：权限、无文档、无效段号与重复操作]');
  const rec = await login('recorder', 'recorder123');
  const rev = await login('reviewer', 'reviewer123');
  const par = await login('participant', 'participant123');

  // 第二名参与者（直建账号，用于每人一条/操作他人通知拒绝）
  const { hashPassword, DB_PATH } = require('../src/db');
  const Database = require('better-sqlite3');
  const raw = new Database(DB_PATH);
  raw.prepare(`INSERT INTO users (username, display_name, role, password_hash) VALUES (?,?,?,?)`)
    .run('participant2', '参与者乙', 'participant', hashPassword('participant234'));
  raw.close();
  const par2 = await login('participant2', 'participant234');

  await expectFail(req('GET', '/api/notifications'), 401, '未登录', '未登录查看通知');
  await expectFail(req('POST', '/api/notifications/1/read'), 401, '未登录', '未登录标读通知');
  await expectFail(req('POST', '/api/segments/1/follow', {}, par), 409, '尚未导入', '导入前关注');

  const transcript = ['1. 现在开庭。', '2. 申请人张三称。', '3. 休庭。'].join('\n');
  const imp = await req('POST', '/api/doc/import', { title: '关注测试听证会', text: transcript }, rec);
  assert.strictEqual(imp.status, 201);

  await expectFail(req('POST', '/api/segments/abc/follow', {}, par), 400, '段号', '非数字段号关注');
  await expectFail(req('POST', '/api/segments/999/follow', {}, par), 404, '未知段号', '关注不存在段');
  await expectFail(req('POST', '/api/segments/999/unfollow', {}, par), 404, '未知段号', '取关不存在段');

  let r = await req('POST', '/api/segments/1/follow', {}, par);
  eq(r.status, 201, '参与者关注第1段');
  await req('POST', '/api/segments/2/follow', {}, par);
  let booth = (await req('GET', '/api/booth', null, par)).json;
  ok(JSON.stringify(booth.followedSegs) === JSON.stringify([1, 2]), '总览含本人关注段号集合 [1,2]');
  await expectFail(req('POST', '/api/segments/1/follow', {}, par), 409, '已关注', '重复关注');
  await expectFail(req('POST', '/api/segments/3/unfollow', {}, par), 409, '未关注', '取消未关注段');
  r = await req('POST', '/api/segments/1/unfollow', {}, par);
  eq(r.status, 200, '取消关注成功');
  await req('POST', '/api/segments/1/follow', {}, par); // 重新关注
  ok(true, '取消后可再次关注');

  console.log('\n[通知：正文净变化才通知，含段号与两端版本号]');
  // v2：第1段 现在开庭 → 现在宣布开庭
  const v2 = await publishChange(rec, rev, 1, 0, 4, '现在宣布开庭', '关注测试：v2 第1段变更');
  eq(v2, 2, '发布 v2');
  let view = (await req('GET', '/api/notifications', null, par)).json;
  eq(view.notifications.length, 1, '参与者收到 1 条通知');
  eq(view.unreadCount, 1, '未读数为 1');
  const n1 = view.notifications[0];
  ok(n1.seg === 1 && n1.fromVersionId === 1 && n1.toVersionId === 2 && n1.read === false && n1.createdAt,
    '通知含段号 1 与两端版本号 v1→v2，默认未读，含发布时间');
  let revView = (await req('GET', '/api/notifications', null, rev)).json;
  eq(revView.notifications.length, 0, '未关注的复核员无通知');

  console.log('\n[通知：发布了提议但合版后正文未变 → 不通知]');
  // v3：第2段把“称”替换成相同的“称”（replacement 与原文一致）
  const v3 = await publishChange(rec, rev, 2, 5, 6, '称', '关注测试：v3 第2段等文替换（合版后正文不变）');
  eq(v3, 3, '发布 v3');
  view = (await req('GET', '/api/notifications', null, par)).json;
  eq(view.notifications.length, 1, '等文替换发布后：不新增通知（仍为 1 条）');
  ok(!view.notifications.some((n) => n.seg === 2), '没有第2段通知');
  booth = (await req('GET', '/api/booth', null, par)).json;
  eq(booth.currentVersion.id, 3, '当前版本已到 v3');
  eq(booth.segments.find((s) => s.seg === 2).text, '申请人张三称。', 'v3 第2段正文确实未变');

  console.log('\n[通知：多个关注者各得一条，同版同段每人至多一条]');
  await req('POST', '/api/segments/1/follow', {}, par2);
  await req('POST', '/api/segments/1/follow', {}, rec); // 工作人员也可关注
  // v4：第1段 宣布 → 正式（v3 时第1段为“现在宣布开庭。”）
  const v4 = await publishChange(rec, rev, 1, 2, 4, '正式', '关注测试：v4 第1段变更');
  eq(v4, 4, '发布 v4');
  view = (await req('GET', '/api/notifications', null, par)).json;
  eq(view.notifications.length, 2, '关注者 par 有 2 条通知（v2、v4 各一条）');
  eq(view.notifications.filter((n) => n.seg === 1 && n.toVersionId === 4).length, 1,
    '同版同段每人至多一条：v4 第1段仅 1 条');
  const view2 = (await req('GET', '/api/notifications', null, par2)).json;
  eq(view2.notifications.length, 1, '新关注者 par2 只得之后发布的 1 条（历史不补发）');
  ok(view2.notifications[0].fromVersionId === 3 && view2.notifications[0].toVersionId === 4,
    'par2 的通知两端版本为 v3→v4');
  const viewRec = (await req('GET', '/api/notifications', null, rec)).json;
  eq(viewRec.notifications.length, 1, '记录员关注第1段同样收到 v4 通知（工作人员按现有权限）');

  console.log('\n[通知：取消关注只影响之后发布，既有通知保留；再关注不补发]');
  await req('POST', '/api/segments/1/unfollow', {}, par);
  const v5 = await publishChange(rec, rev, 1, 2, 4, '继续', '关注测试：v5 第1段变更（par 已取关）');
  eq(v5, 5, '发布 v5');
  view = (await req('GET', '/api/notifications', null, par)).json;
  eq(view.notifications.length, 2, '取关后发布：par 不新增通知，既有 2 条保留');
  ok(!view.notifications.some((n) => n.toVersionId === 5), 'par 没有 v5 通知');
  for (const ck of [par2, rec]) {
    const vv = (await req('GET', '/api/notifications', null, ck)).json;
    ok(vv.notifications.some((n) => n.seg === 1 && n.toVersionId === 5), '仍关注者收到 v5 通知');
  }
  await req('POST', '/api/segments/1/follow', {}, par); // 再关注不补发 v5
  view = (await req('GET', '/api/notifications', null, par)).json;
  eq(view.notifications.length, 2, '再次关注不补发已错过的 v5 通知');

  console.log('\n[通知：倒序展示、逐条已读与重复标记幂等]');
  const ids = view.notifications.map((n) => n.id);
  ok(ids[0] > ids[1], '通知按发布时间倒序（新发布在前）');
  const oldId = ids[1];
  r = await req('POST', `/api/notifications/${oldId}/read`, {}, par);
  eq(r.status, 200, '标为已读成功');
  eq(r.json.read, true, '返回已读状态');
  view = (await req('GET', '/api/notifications', null, par)).json;
  eq(view.unreadCount, 1, '未读数随标读下降为 1');
  ok(view.notifications.find((n) => n.id === oldId).read === true, '该条已读');
  r = await req('POST', `/api/notifications/${oldId}/read`, {}, par);
  eq(r.status, 200, '重复标记返回 200（幂等）');
  view = (await req('GET', '/api/notifications', null, par)).json;
  eq(view.notifications.length, 2, '重复标记不新增、不删除通知');
  await expectFail(req('POST', '/api/notifications/99999/read', {}, par), 404, '不存在', '标读不存在通知');
  const otherId = view2.notifications[0].id; // par2 的通知
  await expectFail(req('POST', `/api/notifications/${otherId}/read`, {}, par), 403, '无权操作', '标读他人通知');

  console.log('\n[保密：参与者当前保密段通知整体隐藏、不计未读，解除后恢复原已读状态]');
  await req('POST', '/api/segments/3/follow', {}, par);
  await req('POST', '/api/segments/3/follow', {}, rev); // 工作人员关注
  await req('POST', '/api/segments/3/secret', {}, rev);
  const v6 = await publishChange(rec, rev, 3, 0, 2, '宣布休庭', '关注测试：v6 第3段保密期间变更');
  eq(v6, 6, '保密期间发布 v6');
  view = (await req('GET', '/api/notifications', null, par)).json;
  ok(!view.notifications.some((n) => n.seg === 3), '参与者：保密段通知整体隐藏（无段号/版本号信息）');
  const parUnreadWhileSecret = view.unreadCount;
  view = (await req('GET', '/api/notifications', null, par)).json;
  eq(view.unreadCount, parUnreadWhileSecret, '未读数不含被隐藏的保密段通知');
  booth = (await req('GET', '/api/booth', null, par)).json;
  ok(!booth.notifications.some((n) => n.seg === 3) && booth.unreadCount === parUnreadWhileSecret,
    '总览同样整体隐藏保密段通知且不计未读');
  const revSecView = (await req('GET', '/api/notifications', null, rev)).json;
  ok(revSecView.notifications.some((n) => n.seg === 3 && n.toVersionId === 6),
    '工作人员在保密期间仍可按现有权限看到该段通知');

  // 解除保密：通知恢复，且为未读（此前从未标读）；标读后再保密、再解除，已读状态保持
  await req('POST', '/api/segments/3/unsecret', {}, rev);
  view = (await req('GET', '/api/notifications', null, par)).json;
  const n3 = view.notifications.find((n) => n.seg === 3 && n.toVersionId === 6);
  ok(n3 && n3.fromVersionId === 5 && n3.read === false, '解除保密后通知恢复，原已读状态（未读）保持');
  await req('POST', `/api/notifications/${n3.id}/read`, {}, par);
  await req('POST', '/api/segments/3/secret', {}, rev);
  view = (await req('GET', '/api/notifications', null, par)).json;
  ok(!view.notifications.some((n) => n.seg === 3), '再次保密：通知再次整体隐藏');
  await req('POST', '/api/segments/3/unsecret', {}, rev);
  view = (await req('GET', '/api/notifications', null, par)).json;
  ok(view.notifications.find((n) => n.seg === 3).read === true, '再次解除保密：恢复为此前的已读状态');

  console.log('\n[失败发布不得留下通知]');
  booth = (await req('GET', '/api/booth', null, rec)).json;
  const before = booth.currentVersion.id;
  // 参与者对第2段提异议 [1,4)，记录员提议触及该范围的 [3,5)；不回应时发布必须 409
  const seg2now = booth.segments.find((s) => s.seg === 2).text;
  const o = await req('POST', '/api/objections',
    { seg: 2, start: 1, end: 4, note: '关注测试：制造发布门槛失败' }, par);
  assert.strictEqual(o.status, 201);
  const pFail = await req('POST', '/api/proposals',
    { seg: 2, start: 3, end: 5, replacement: '某某', basis: '关注测试：应被门槛拦下的发布' }, rec);
  assert.strictEqual(pFail.status, 201);
  await req('POST', `/api/proposals/${pFail.json.id}/adopt`, {}, rev);
  await expectFail(req('POST', '/api/publish', { note: '应失败的发布' }, rev),
    409, '未完成有效回应', '异议未回应时发布');
  booth = (await req('GET', '/api/booth', null, rec)).json;
  eq(booth.currentVersion.id, before, '发布失败：当前版本不变');
  view = (await req('GET', '/api/notifications', null, par)).json;
  ok(!view.notifications.some((n) => n.fromVersionId === before),
    '失败发布没有为关注者（par 关注第2段）留下任何通知');

  // 回应异议后直接发布（暂存中的原提议落版）：第2段通知随即产生
  const check = await req('GET', '/api/publish-check', null, rev);
  for (const it of check.json.items || []) {
    if (!it.satisfied) {
      const rr = await req('POST', `/api/objections/${it.objectionId}/respond`,
        { note: '关注测试：回应后允许发布' }, rev);
      assert.strictEqual(rr.status, 201);
    }
  }
  const pub7 = await req('POST', '/api/publish', { note: '关注测试：v7 第2段变更（回应后发布）' }, rev);
  eq(pub7.status, 201, '回应后发布 v7 成功');
  const v7 = pub7.json.versionId;
  eq(v7, before + 1, '新版本号为 v7');
  booth = (await req('GET', '/api/booth', null, rec)).json;
  eq(booth.segments.find((s) => s.seg === 2).text, seg2now.slice(0, 3) + '某某' + seg2now.slice(5),
    'v7 第2段正文已合并替换');
  view = (await req('GET', '/api/notifications', null, par)).json;
  const n2 = view.notifications.find((n) => n.seg === 2);
  ok(n2 && n2.fromVersionId === before && n2.toVersionId === v7, '成功发布：第2段关注通知含两端版本号 v6→v7');
  eq(view.notifications[0].id, n2.id, '新通知排在倒序列表最前');

  console.log(`\n全部通过：${passed} 项断言 ✅`);
  process.exit(0);
}

main().catch((e) => {
  console.error('\n测试失败：', e.message);
  console.error(e.stack);
  process.exit(1);
});
