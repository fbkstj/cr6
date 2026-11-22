// AI 評分檔的讀取：一個檔案可以只有一組（檔名含組別，例如 team01.json），
// 也可以把專題組、創意組的 AI 評分合併成一個檔案。純函式，後台網頁與 tools/import_ai_json.mjs 共用。
//
// 合併檔支援三種寫法（任選一種）：
//   1) 以組別代碼當欄位：  {"team01":{"items":[…],"strengths":"…","improvements":"…"}, "team04":{…}}
//   2) teams 欄位：        {"teams":{"team01":{…}}}  或  {"teams":[{"team":"team01",…}]}
//   3) 陣列：              [{"team":"team01","items":[…],…}, {"team":"team04",…}]
//   4) 依組別分類：        {"專題組":[{"team":"team01","result":{"items":[…],…}}, …], "創意組":[…]}
//      （每筆的評分內容可以直接寫 items，也可以包在 "result" 裡；多餘欄位如 title、video、total 會被忽略）
// 單組檔案（有 items 陣列）則用檔名裡的 teamNN 當組別，也可以自己寫一個 "team" 欄位。
// 以底線開頭的欄位（例如 _source）只是備註，會被忽略。

const CODE = /^team\d{2}$/i;
const isObj = x => x && typeof x === 'object' && !Array.isArray(x);
const CAT_KEYS = ['專題組', '創意組', 'project', 'creative'];

function clean(o) {
  if (isObj(o.result) && Array.isArray(o.result.items)) o = o.result;   // 評分內容包在 result 裡
  const j = {};
  for (const k of Object.keys(o)) if (!k.startsWith('_') && k !== 'team' && k !== 'code') j[k] = o[k];
  return j;
}


/**
 * parsed：JSON.parse 的結果；fileName：檔名（單組檔案用來判斷組別）
 * 回傳 { entries: [{ code, json }], problems: [字串] }；code 一律小寫（team01）
 */
export function splitAiJson(parsed, fileName = '') {
  const entries = [], problems = [];
  const add = (code, o, where) => {
    code = String(code || '').trim().toLowerCase();
    if (!CODE.test(code)) { problems.push(`${where}：找不到組別（要是 team01 這樣的代碼）`); return; }
    if (!isObj(o)) { problems.push(`${code}：內容不是物件`); return; }
    if (entries.some(e => e.code === code)) { problems.push(`${code}：在同一個檔案裡出現兩次`); return; }
    entries.push({ code, json: clean(o) });
  };
  const fromList = (list, where) => list.forEach((o, i) => add(isObj(o) ? o.team || o.code : '', o, `${where}第 ${i + 1} 筆`));
  const fromKeyed = obj => Object.keys(obj).filter(k => !k.startsWith('_')).forEach(k => add(k, obj[k], k));

  if (Array.isArray(parsed)) fromList(parsed, '');
  else if (isObj(parsed) && CAT_KEYS.some(k => Array.isArray(parsed[k]))) CAT_KEYS.forEach(k => { if (Array.isArray(parsed[k])) fromList(parsed[k], k); });
  else if (isObj(parsed) && Array.isArray(parsed.items)) {            // 單組
    const m = /team\d{2}/i.exec(fileName);
    add(parsed.team || parsed.code || (m && m[0]), parsed, fileName || '檔案');
  } else if (isObj(parsed) && Array.isArray(parsed.teams)) fromList(parsed.teams, '');
  else if (isObj(parsed) && isObj(parsed.teams)) fromKeyed(parsed.teams);
  else if (isObj(parsed) && Object.keys(parsed).some(k => CODE.test(k))) fromKeyed(parsed);
  else problems.push('格式不認得：要有 items 陣列（單組），或以 team01、team02… 當欄位／teams／陣列（合併檔）');
  return { entries, problems };
}
