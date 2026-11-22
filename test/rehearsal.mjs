// P6 整體演練：node test/rehearsal.mjs
// 用正式的影片處理腳本產生的影片＋core.js（記憶體資料庫），照實際比賽的順序跑完整流程：
//   演練 A（5 位評審、4 組）：建立組別 → 收件與檔案檢查 → 補件（新版本設為正式版本）→ 鎖版開始評分
//     → 評審評分（暫存、送出）→ 主辦方退回與重送 → 結算 → 同分處理 → 匯出 CSV → 公布 → 撤回 → 重新公布
//   演練 B（3 位評審、2 組）：最精簡的完整流程
// 每個檢查點對應原規格第 7 節的驗收項目；結果寫到 test/out/rehearsal_report.json，匯出的 CSV 也存在 test/out/。
// 全部是合成資料，不會連任何雲端服務。
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApi } from '../supabase/functions/api/core.js';
import { createMemDb } from './memdb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test', 'out');
const VID = path.join(OUT, 'rehearsal_videos');
const results = [];
let clock = Date.parse('2026-12-01T00:30:00Z');   // 台灣時間 12/1 08:30 開始
const tick = min => { clock += min * 60 * 1000; };

async function check(spec, name, fn) {
  try {
    const note = await fn();
    results.push({ spec, name, ok: true, note: note || '' });
    console.log('  ✓', `[${spec}]`, name, note ? '— ' + note : '');
  } catch (e) {
    results.push({ spec, name, ok: false, note: e.message });
    console.log('  ✗', `[${spec}]`, name, '—', e.message);
  }
}

function makeVideos(stage) {
  execFileSync('python', [path.join(ROOT, 'test', 'make_rehearsal_videos.py'), String(stage)],
    { stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }) });
}
const readManifest = () => JSON.parse(fs.readFileSync(path.join(VID, 'manifest.json'), 'utf8'));

async function world({ judgeCount, teams }) {
  const db = createMemDb();
  await db.seedDemo({ judgeCount, teams: 0 });
  const api = createApi({ db, secret: 'rehearsal-secret-0123456789-abcdefghij', now: () => clock, siteBaseUrl: 'https://example.test/', fetchJson: async () => readManifest() });
  const call = async (fn, ...args) => { const r = await api.handle({ fn, args }); if (!r.ok) throw new Error(fn + '：' + r.error); return r.result; };
  const fails = async (re, fn, ...args) => { const r = await api.handle({ fn, args }); if (r.ok) throw new Error(fn + ' 應該被拒絕'); if (!re.test(r.error)) throw new Error(fn + ' 錯誤訊息不符：' + r.error); return r.error; };
  const admin = (await call('login', 'admin01', 'admin-pass-01')).token;
  const J = {};
  for (let i = 1; i <= 5; i++) J[i] = (await call('login', 'judge0' + i, 'judge-pass-0' + i)).token;
  void teams;
  return { db, api, call, fails, admin, J };
}

const COMMENT = {
  strengths: '感測器與控制模組整合完整，實際操作展示清楚',
  improvements: '建議補充不同環境下的測試數據並與對照組比較',
};

/* ═══════════════ 演練 A：5 位評審、4 組 ═══════════════ */
console.log('\n演練 A：5 位評審、4 組');
{
  const ctx = await world({ judgeCount: 5 });
  const { db, call, fails, J } = ctx;
  let admin = ctx.admin;
  /** 隔天重新登入（登入有效 12 小時） */
  const nextDayLogin = async () => {
    admin = (await call('login', 'admin01', 'admin-pass-01')).token;
    for (let i = 1; i <= 5; i++) J[i] = (await call('login', 'judge0' + i, 'judge-pass-0' + i)).token;
  };
  const board = () => call('adminGetBoard', admin);
  const teamId = async code => (await board()).teams.find(t => t.code === code).id;
  const ver = async (code, no) => (await board()).teams.find(t => t.code === code).versions.find(v => v.no === no);

  await check('1 身分與權限', '主辦方建立 4 個組別與作品資料', async () => {
    const data = [['team01', '智慧澆花系統', '自動偵測土壤濕度並澆水'], ['team02', '教室空氣品質監測', 'CO2 與溫濕度看板'],
      ['team03', '智慧門禁', 'RFID 刷卡與紀錄'], ['team04', '自走車避障', '超音波避障自走車']];
    for (const [code, title, desc] of data) await call('adminUpsertTeam', admin, { code, name: '第' + code.slice(-1) + '組', workTitle: title, workDesc: desc, members: '合成資料' });
    assert.equal((await board()).teams.length, 4);
    return '4 組';
  });

  await check('1 身分與權限', '評審不能使用後台、讀不到別組資料', async () => {
    await fails(/不能使用此功能/, 'adminGetBoard', J[1]);
    await fails(/不能使用此功能/, 'adminListScores', J[1]);
    await fails(/還沒有開始評分/, 'judgeGetWork', J[1], await teamId('team01'));
    return '';
  });

  await check('2 收件與轉檔', '第一次收件：影片腳本檢查與轉檔', async () => {
    makeVideos(1);
    const m = readManifest().versions;
    const bad = m.filter(v => !v.check_ok).map(v => `${v.team}_v${v.version}（${v.check_notes}）`);
    assert.deepEqual(bad, ['team02_v1（沒有聲音（音軌））']);
    for (const v of m.filter(x => x.check_ok)) assert.ok(fs.existsSync(path.join(VID, path.basename(v.playback_path))), v.playback_path + ' 不存在');
    return `${m.length} 支，不合格 1 支：${bad.join('')}`;
  });

  await check('2 收件與轉檔', '1080p 原檔轉成播放版（保留 1080p）、時長一致', async () => {
    const v = readManifest().versions.find(x => x.team === 'team04');
    assert.equal(v.width, 1920);
    assert.equal(v.playback_height, 1080);   // 現行規則：保留原檔解析度（最高 1080p）
    assert.ok(Math.abs(v.duration_sec - 16) < 0.2);
    return `1920×1080 → ${v.playback_width}×${v.playback_height}`;
  });

  await check('2 收件與轉檔', '後台同步影片清單、填寫收件時間', async () => {
    tick(30);
    const r = await call('adminSyncVideos', admin);
    assert.equal(r.added.length, 5);
    for (const code of ['team01', 'team02', 'team03', 'team04']) {
      const t = (await board()).teams.find(x => x.code === code);
      for (const v of t.versions) await call('adminSetReceivedAt', admin, v.id, new Date(clock - 20 * 60 * 1000).toISOString());
    }
    const again = await call('adminSyncVideos', admin);
    assert.equal(again.added.length, 0);
    return `新增 5 個版本，重複同步不會重複建立`;
  });

  await check('2 收件與轉檔', '檔案檢查不合格的版本不能設為正式版本', async () => {
    await fails(/檢查沒有通過/, 'adminSetCurrentVersion', admin, await teamId('team02'), (await ver('team02', 1)).id);
    return '';
  });

  await call('adminSetPhase', admin, 'collecting');
  for (const [code, no] of [['team01', 1], ['team02', 2]]) await call('adminSetCurrentVersion', admin, await teamId(code), (await ver(code, no)).id);

  await check('3 收件與補件', '沒有資格審查：設定正式版本的組別「可評分」，其他維持「已收件」', async () => {
    const st = (await board()).teams.map(t => `${t.code}:${t.status.label}`);
    assert.deepEqual(st, ['team01:可評分', 'team02:可評分', 'team03:已收件', 'team04:已收件']);
    return st.join('、');
  });

  await check('3 收件與補件', '公開狀態頁只顯示狀態', async () => {
    const p = await call('publicStatus');
    const text = JSON.stringify(p);
    assert.ok(text.includes('可評分') && !text.includes('sha') && !text.includes('reason'));
    return p.teams.map(t => `${t.code}:${t.status}`).join('、');
  });

  await check('3 收件與補件', '沒有設定正式版本的組別，開始評分前會列出', async () => {
    const p = await call('adminJudgingPreview', admin);
    assert.deepEqual(p.excluded.map(e => e.code), ['team03', 'team04']);
    return p.excluded.map(e => `${e.code}（${e.reason}）`).join('、');
  });

  await check('3 收件與補件', '補件：新版本設為正式版本，舊版本仍可查', async () => {
    tick(60 * 24);
    await fails(/登入已逾時/, 'adminGetBoard', admin);   // 隔天：前一天的登入已失效
    await nextDayLogin();
    makeVideos(2);
    const r = await call('adminSyncVideos', admin);
    assert.deepEqual(r.added.map(a => a.label), ['team03_v2']);
    await call('adminSetCurrentVersion', admin, await teamId('team03'), (await ver('team03', 2)).id);
    await call('adminSetReceivedAt', admin, (await ver('team03', 2)).id, new Date(clock - 10 * 60 * 1000).toISOString());
    assert.equal((await board()).teams.find(t => t.code === 'team03').status.label, '可評分');
    assert.equal((await ver('team03', 1)).no, 1, '舊版本仍可查');
    return 'v2 設為正式版本，v1 仍保留';
  });

  await check('3 收件與補件', '開始評分：鎖定 3 件，沒有正式版本的 team04 不進入評分', async () => {
    tick(60);
    const r = await call('adminSetPhase', admin, 'judging');
    assert.equal(r.locked, 3);
    assert.deepEqual(r.excluded, ['team04']);
    await fails(/已經開始評分/, 'adminSetCurrentVersion', admin, await teamId('team03'), (await ver('team03', 1)).id);
    return '鎖定後不能再換版本';
  });

  const ids = (await board()).rubric.items.map(i => i.id);
  const items = (...v) => Object.fromEntries(ids.map((id, i) => [id, v[i]]));
  // 分數表：team01 先是 81×5 = 405，評審5 被退回後改成 80 → 404；team03 = 81+80+81+81+81 = 404 → 兩組同分；team02 最高
  const plan = {
    team01: [[32, 20, 21, 8], [33, 20, 20, 8], [32, 21, 20, 8], [33, 20, 20, 8], [32, 20, 20, 9]],
    team02: [[36, 22, 22, 9], [35, 22, 23, 9], [36, 23, 22, 9], [35, 22, 22, 9], [36, 22, 22, 8]],
    team03: [[33, 20, 20, 8], [32, 20, 20, 8], [32, 21, 20, 8], [33, 20, 20, 8], [32, 20, 20, 9]],
  };
  const sum = arr => arr.reduce((a, b) => a + b, 0);

  await check('4 評分與公布', '評審只看到進入評分的 3 件作品，影片是鎖定版本', async () => {
    const l = await call('judgeListWorks', J[1]);
    assert.deepEqual(l.works.map(w => w.code), ['team01', 'team02', 'team03']);
    const w = await call('judgeGetWork', J[1], await teamId('team03'));
    assert.equal(w.video.path, 'videos/team03_v2.mp4');
    assert.ok(fs.existsSync(path.join(VID, 'team03_v2.mp4')));
    return '評審看到的是補件後的 v2';
  });

  await check('4 評分與公布', '暫存後再正式送出；必填評語與分數範圍', async () => {
    const t1 = await teamId('team01');
    await call('judgeSaveDraft', J[2], t1, { items: { [ids[0]]: 33 }, strengths: '初步印象' });
    await fails(/還有 3 個項目/, 'judgeSubmit', J[2], t1, { items: { [ids[0]]: 33 }, ...COMMENT });
    await fails(/至少要 10 個字/, 'judgeSubmit', J[2], t1, { items: items(...plan.team01[1]), strengths: '不錯', improvements: COMMENT.improvements });
    await fails(/0～40 之間/, 'judgeSubmit', J[2], t1, { items: items(45, 20, 20, 8), ...COMMENT });
    return '';
  });

  await check('4 評分與公布', '5 位評審評完 3 件（共 15 份）', async () => {
    for (let j = 1; j <= 5; j++) {
      tick(20);
      for (const code of ['team01', 'team02', 'team03']) await call('judgeSubmit', J[j], await teamId(code), { items: items(...plan[code][j - 1]), ...COMMENT });
    }
    const s = await call('adminListScores', admin);
    assert.equal(s.completeWorks, 3);
    return s.rows.map(r => `${r.code}:${r.cells.map(c => c.total).join('/')}`).join('、');
  });

  await check('4 評分與公布', '評審之間看不到彼此的評分', async () => {
    const w = await call('judgeGetWork', J[2], await teamId('team02'));
    assert.deepEqual(Object.values(w.score.items), plan.team02[1]);
    const l = JSON.stringify(await call('judgeListWorks', J[2]));
    for (const other of [sum(plan.team02[0]), sum(plan.team02[2])]) if (other !== sum(plan.team02[1])) assert.ok(!l.includes(`"total":${other}`));
    return '';
  });

  await check('4 評分與公布', '主辦方退回評分（必填原因）→ 評審修改重送 → 更正歷程保留', async () => {
    tick(30);
    const row = (await call('adminListScores', admin)).rows.find(r => r.code === 'team01');
    await call('adminReturnScore', admin, row.cells[4].scoreId, '「作品說明」分數與評語不一致，請再確認');
    const s = await call('adminListScores', admin);
    assert.equal(s.rows.find(r => r.code === 'team01').complete, false, '退回後變成待完成');
    await fails(/team01（4\/5）/, 'adminSetPhase', admin, 'settling');
    const w = await call('judgeGetWork', J[5], await teamId('team01'));
    assert.match(w.score.returnReason, /作品說明/);
    await call('judgeSubmit', J[5], await teamId('team01'), { items: items(32, 20, 20, 8), ...COMMENT });   // 81 → 80
    const d = await call('adminGetScore', admin, row.cells[4].scoreId);
    assert.deepEqual(d.history.map(h => `${h.action}:${h.total ?? ''}`), ['submit:81', 'return:81', 'resubmit:80']);
    return '81 → 退回 → 80';
  });

  await check('4 評分與公布', '收齊後計算平均；未四捨五入判斷同分', async () => {
    tick(30);
    await call('adminSetPhase', admin, 'settling');
    const r = await call('adminRanking', admin);
    const avg = Object.fromEntries(r.rows.map(x => [x.code, x.average]));
    assert.equal(r.rows[0].code, 'team02');
    assert.equal(r.ties.length, 1);
    assert.deepEqual(r.ties[0].codes, ['team01', 'team03']);
    return `平均 team02=${avg.team02.toFixed(2)}、team01=${avg.team01.toFixed(2)}、team03=${avg.team03.toFixed(2)}`;
  });

  await check('4 評分與公布', '同分要處理才能公布；決定先後並記錄理由', async () => {
    await fails(/同分沒有處理/, 'adminPublish', admin);
    const tie = (await call('adminRanking', admin)).ties[0];
    await call('adminDecideTie', admin, tie.teamIds, [await teamId('team03'), await teamId('team01')], '依「應用及整合性」分項總和，team03 較高');
    const r = await call('adminRanking', admin);
    assert.deepEqual(r.rows.map(x => `${x.rank}:${x.code}`), ['1:team02', '2:team03', '3:team01']);
    return r.rows.map(x => `${x.rank} ${x.code}`).join('、');
  });

  await check('4 評分與公布', '匯出 CSV（五份總分、平均、名次、同分紀錄）', async () => {
    const { filename, csv } = await call('adminExportCsv', admin);
    fs.writeFileSync(path.join(OUT, 'rehearsal_成績.csv'), '﻿' + csv);
    const lines = csv.trim().split('\r\n');
    assert.equal(lines.length, 4);
    assert.match(lines[2], /^專題組,2,,team03,.*順序 team03 > team01/);   // 第一欄是類別
    return `${filename}（已存 test/out/rehearsal_成績.csv）`;
  });

  await check('4 評分與公布', '公布前公開頁看不到分數', async () => {
    const r = await call('publicResults');
    assert.equal(r.published, false);
    return '';
  });

  await check('4 評分與公布', '公布：公開結果有名次、平均、評審1～5 評語，無評審姓名', async () => {
    tick(60);
    await call('adminPublish', admin);
    const r = await call('publicResults');
    const text = JSON.stringify(r);
    assert.deepEqual(r.teams.map(t => t.code), ['team02', 'team03', 'team01']);
    assert.ok(r.teams[1].tieBroken && r.teams[2].tieBroken);
    assert.ok(!/測試評審|judge0|主辦人員/.test(text));
    assert.ok(!r.teams.some(t => t.code === 'team04'), '未通過的組別不在結果中');
    return r.teams.map(t => `${t.rank} ${t.code} ${t.average.toFixed(2)}`).join('、');
  });

  await check('4 評分與公布', '公布後不能再評分、退回；撤回後可修正再公布', async () => {
    await fails(/目前不是評分階段/, 'judgeSubmit', J[1], await teamId('team01'), { items: items(1, 1, 1, 1), ...COMMENT });
    await call('adminRevoke', admin, '校方決定同分改為並列');
    assert.equal((await call('publicResults')).published, false);
    const tie = (await call('adminRanking', admin)).ties[0];
    await call('adminDecideTie', admin, tie.teamIds, 'tied', '校方決定同分並列');
    await call('adminPublish', admin);
    const r = await call('publicResults');
    assert.deepEqual(r.teams.map(t => `${t.rank}${t.tied ? '並列' : ''}`), ['1', '2並列', '2並列']);
    return '改為並列後重新公布';
  });

  await check('6 演練紀錄', '操作紀錄完整（鎖版、退回、同分、公布、撤回）', async () => {
    const actions = new Set((await call('adminLogs', admin, 500)).map(l => l.action));
    const need = ['create_team', 'sync_videos', 'set_received_at', 'set_current_version', 'lock_for_judging', 'judge_submit', 'return_score', 'decide_tie', 'export_csv', 'publish', 'revoke'];
    const missing = need.filter(a => !actions.has(a));
    assert.deepEqual(missing, []);
    return `${need.length} 種動作都有記錄`;
  });
  void db;
}

/* ═══════════════ 演練 B：3 位評審、2 組 ═══════════════ */
console.log('\n演練 B：3 位評審、2 組');
{
  const { call, fails, admin, J } = await world({ judgeCount: 3 });
  await check('4 評分與公布', '3 位評審模式：從建立組別到公布', async () => {
    for (const code of ['team01', 'team02']) await call('adminUpsertTeam', admin, { code, name: code, workTitle: '作品' + code.slice(-1) });
    await call('adminSyncVideos', admin);   // 清單裡 team03、team04 沒有建立組別，只會有警告
    const b = await call('adminGetBoard', admin);
    for (const t of b.teams) {
      const v = t.versions.find(x => x.checkOk);
      await call('adminSetCurrentVersion', admin, t.id, v.id);
    }
    await call('adminSetPhase', admin, 'collecting');
    await call('adminSetPhase', admin, 'judging');
    await fails(/沒有被指派/, 'judgeSubmit', J[4], b.teams[0].id, {});
    const ids = b.rubric.items.map(i => i.id);
    const it = v => Object.fromEntries(ids.map((id, i) => [id, v[i]]));
    for (let j = 1; j <= 3; j++) {
      await call('judgeSubmit', J[j], b.teams[0].id, { items: it([35, 22, 22, 9]), ...COMMENT });
      await call('judgeSubmit', J[j], b.teams[1].id, { items: it([30, 20, 20, 8]), ...COMMENT });
    }
    await call('adminSetPhase', admin, 'settling');
    await call('adminPublish', admin);
    const r = await call('publicResults');
    assert.equal(r.judgeCount, 3);
    assert.deepEqual(r.teams[0].judges.map(j => j.label), ['評審1', '評審2', '評審3']);
    return r.teams.map(t => `${t.rank} ${t.code} ${t.average.toFixed(2)}`).join('、');
  });
}

/* ═══════════════ 報告 ═══════════════ */
const ok = results.filter(r => r.ok).length;
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'rehearsal_report.json'), JSON.stringify({ ranAt: new Date().toISOString(), node: process.version, passed: ok, total: results.length, results }, null, 2));
console.log(`\n演練結果：${ok} / ${results.length} 通過（報告：test/out/rehearsal_report.json）`);
process.exit(ok === results.length ? 0 : 1);
