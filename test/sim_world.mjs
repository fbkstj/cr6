// 整場比賽模擬（本機記憶體資料庫，不連任何雲端服務）：
// 用 videos/ 裡的 8 支真實影片，分成專題組 4 組、創意組 4 組；3 位評審各自評分，外部 AI 的評分檔匯入當第 4 位；
// 然後結算（處理同分）並公布。用法：SIM=1 node test/devserver.mjs ，再打開 http://localhost:8790/
// 評分是「模擬」：每組的基準分和每位評審的差異是人工設定的，用來展示整個流程，不代表真實評分。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 組別：代碼、組別名稱、作品名稱、所屬類別、說明（依 影片原檔/對照表.txt）
const TEAMS = [
  ['team01', '第1組', '後面有車!', 'project', '倒車與後方來車的智慧警示'],
  ['team02', '第2組', 'Careing', 'project', '居家照護與健康提醒'],
  ['team03', '第3組', '聲波也是火的剋星', 'project', '用聲波滅火的裝置'],
  ['team06', '第6組', '鏟屎官別擔心 AI 來幫你', 'project', 'AI 貓砂盆健康監測'],
  ['team04', '第4組', '小水滴智飲家：兒童智慧喝水監控與提醒系統', 'creative', '偵測兒童喝水量並提醒'],
  ['team05', '第5組', 'The Watchful Fatman', 'creative', '守護長者的 AI 看護'],
  ['team07', '第7組', 'AI 無接觸守護：不在身邊也能安心', 'creative', '無接觸式的居家守護'],
  ['team08', '第8組', '宇宙銀河系霹靂無敵超自適應時控天才 Tomato 檯燈', 'creative', '依番茄鐘自動調光的檯燈'],
];

// 三位評審各自的四項分數（順序＝該組別評分表的四項：40／25／25／10）
const SCORES = {
  team01: [[30, 20, 19, 8], [32, 19, 20, 8], [31, 20, 19, 9]],
  team02: [[34, 22, 21, 8], [33, 21, 22, 9], [35, 22, 20, 8]],
  team03: [[33, 21, 20, 8], [31, 20, 22, 8], [32, 21, 20, 9]],
  team06: [[30, 20, 19, 8], [31, 19, 19, 9], [30, 21, 18, 8]],   // 第 1 項會依 AI 分數分攤微調，讓它和 team01 同分（演示同分處理）
  team04: [[34, 22, 21, 8], [33, 22, 20, 8], [35, 21, 21, 9]],
  team05: [[30, 20, 19, 7], [31, 19, 20, 8], [29, 20, 19, 7]],
  team07: [[36, 22, 22, 8], [35, 23, 21, 9], [37, 22, 22, 8]],
  team08: [[32, 22, 23, 9], [33, 21, 22, 9], [31, 22, 23, 8]],
};

// 評語：每組一組基本句，三位評審各加一句不同的補充
const COMMENT = {
  team01: ['倒車警示的判斷流程清楚，實車測試畫面有說服力', '建議說明在雨天與夜間的偵測誤差與改善方式'],
  team02: ['居家照護情境完整，提醒與紀錄功能整合得很好', '建議補充長輩實際使用後的回饋與操作難易度'],
  team03: ['聲波滅火的原理說明清楚，實驗過程安全且有對照', '建議量化有效距離與頻率，並說明實際場域的限制'],
  team06: ['貓砂盆監測的感測設計具體，數據呈現直觀易懂', '建議說明辨識錯誤時的處理，以及長期使用的耐用度'],
  team04: ['軟硬體與雲端同框實測流暢，加水與喝水的區分準確', '建議改善套筒體積與線材外露，並補充防水與續航測試'],
  team05: ['看護情境貼近生活，畫面敘事有趣且記憶點強', '建議補充實際偵測的準確率，以及隱私保護的做法'],
  team07: ['無接觸的方案切中需求，成品完成度高、展示完整', '建議說明在多人同時活動時的辨識能力與誤報處理'],
  team08: ['檯燈造型與番茄鐘調光結合有創意，商品化想像清楚', '建議補充成本估算、量產可行性與使用者的測試意見'],
};
const EXTRA = ['簡報節奏掌握得宜。', '口語表達自然流暢。', '影片剪輯乾淨、重點清楚。'];

const AI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'AI評分結果');

export async function buildSim(api, log = console.log) {
  const call = async (fn, ...args) => { const r = await api.handle({ fn, args }); if (!r.ok) throw new Error(fn + '：' + r.error); return r.result; };
  const admin = (await call('login', 'admin01', 'admin-pass-01')).token;
  const J = [1, 2, 3].map(async i => (await call('login', 'judge0' + i, 'judge-pass-0' + i)).token);
  const judges = await Promise.all(J);

  await call('adminUpdateCompetition', admin, { name: '桃園市立楊梅高中115年專題及創意製作競賽初賽（模擬）', showItemScores: true, showStatusPage: true });
  for (const [code, name, workTitle, category, workDesc] of TEAMS) await call('adminUpsertTeam', admin, { code, name, workTitle, workDesc, members: '', category });
  log('· 建立 8 組：專題組 4、創意組 4');
  await call('adminSetPhase', admin, 'collecting');
  await call('adminSyncVideos', admin);
  let board = await call('adminGetBoard', admin);
  for (const t of board.teams) {
    const v = t.versions[0];
    await call('adminSetCurrentVersion', admin, t.id, v.id);
  }
  log('· 同步 8 支影片、設定正式版本');
  await call('adminSetPhase', admin, 'judging');
  board = await call('adminGetBoard', admin);
  const teamId = code => board.teams.find(t => t.code === code).id;
  const rubric = { project: board.rubrics.project.items, creative: board.rubrics.creative.items };
  const itemsOf = (category, arr) => Object.fromEntries(rubric[category].map((it, i) => [it.id, arr[i]]));
  log('· 開始評分（鎖定版本）：3 位評審＋AI（評審4）');

  // AI：匯入外部 AI 的評分檔（八組各一個 JSON）
  const aiTotal = {};
  for (const [code, , , category] of TEAMS) {
    const f = path.join(AI_DIR, code + '.json');
    if (!fs.existsSync(f)) { log('  （找不到 ' + f + '，略過 AI）'); continue; }
    const j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
    Object.keys(j).filter(k => k.startsWith('_')).forEach(k => delete j[k]);
    aiTotal[code] = j.items.reduce((s, x) => s + (x.score || 0), 0);
    const b = await call('adminAiLocalBegin', admin, teamId(code), false, '外部 AI（模擬匯入）');
    const r = await call('adminAiLocalFinish', admin, b.runId, { text: JSON.stringify(j), usage: {}, draft: false });
    if (r.status !== 'done') throw new Error(`${code} AI 匯入：${r.status} ${(r.problems || []).join('；')}`);
  }
  log('· 匯入 8 份外部 AI 評分檔（評審4）');

  // 演示同分：調整 team06 第 3 位評審的第 1 項，使 team06 總分和 = team01 總分和
  const sum = a => a.reduce((s, x) => s + x, 0);
  if (aiTotal.team01 !== undefined && aiTotal.team06 !== undefined) {
    const want = SCORES.team01.reduce((s, a) => s + sum(a), 0) + aiTotal.team01;
    const have = SCORES.team06.reduce((s, a) => s + sum(a), 0) + aiTotal.team06;
    let d = want - have;   // 平均分攤到 3 位評審的第 1 項（每人最多動 8 分），避免某一位評審的分數突兀
    for (let k = 0; k < 3 && d !== 0; k++) {
      const share = Math.trunc(d / (3 - k));
      const cur = SCORES.team06[k][0], next = Math.min(40, Math.max(cur - 8, Math.min(cur + 8, cur + share)));
      SCORES.team06[k][0] = next; d -= next - cur;
    }
  }

  for (let j = 0; j < 3; j++) {
    for (const [code, , , category] of TEAMS) {
      const [good, improve] = COMMENT[code];
      await call('judgeSubmit', judges[j], teamId(code), { items: itemsOf(category, SCORES[code][j]), strengths: good + '。' + EXTRA[j], improvements: improve + '。' });
    }
  }
  log('· 3 位評審各自送出 8 件評分');

  await call('adminSetPhase', admin, 'settling');
  let r = await call('adminRanking', admin);
  for (const t of r.ties) {
    const cat = r.categories.find(c => c.category === t.category);
    const ids = t.teamIds.slice();
    await call('adminDecideTie', admin, ids, ids, `同分：依「${cat.items[0].title}」項目總分高者在前（模擬）`);
    log(`· 處理同分：${t.codes.join('、')}（${cat.categoryLabel}）`);
  }
  r = await call('adminRanking', admin);
  if (!r.ready) throw new Error('模擬：排名還沒準備好公布');
  await call('adminPublish', admin);
  log('· 公布結果');
  return { admin };
}
