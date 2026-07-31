'use strict';

/* ============================================================
   洗剤記録アプリ — 浴槽自動洗浄の洗剤量を記録する
   データはブラウザの localStorage にのみ保存される。
   ============================================================ */

const STORAGE_KEY = 'senzai-flow/v1';

const DEFAULT_CONFIG = {
  tankCapacity: 850,   // タンク総量 (ml)
  refillUnit: 300,     // 詰め替え1個 (ml)
  lowThreshold: 350,   // low シグナル: 残量 < 350ml
  minThreshold: 150,   // min シグナル: 残量 < 150ml
  nominalPerWash: 25,  // 1回あたり公称使用量 (ml)
};

const TYPE_LABEL = { add: '洗剤追加', low: 'low', min: 'min', rest: '洗浄休み' };
const TYPE_ICON_CLASS = { add: 'ic-add', low: 'ic-low', min: 'ic-min', rest: 'ic-rest' };

const WEATHER_KEY = 'senzai-flow/weather/v1';

/* ---------- 状態 ---------- */
let state = loadState();
let weather = loadWeather();
let lastAction = null;   // Undo 用: { kind:'add', id } または { kind:'edit', before } など
let editingId = null;    // 編集モーダルで操作中のイベントID
let pendingImport = null; // 読み込み待ちのデータ
let pendingImportWeather = null; // 読み込み待ちの気温データ
let toastTimer = null;

/* ============================================================
   永続化
   ============================================================ */
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return freshState();
    const parsed = JSON.parse(raw);
    return normalizeState(parsed);
  } catch (e) {
    console.warn('読み込みに失敗しました。新規作成します。', e);
    return freshState();
  }
}

function freshState() {
  return { schemaVersion: 1, config: { ...DEFAULT_CONFIG }, events: [] };
}

function normalizeState(obj) {
  const s = freshState();
  if (obj && typeof obj === 'object') {
    if (obj.config && typeof obj.config === 'object') {
      s.config = { ...DEFAULT_CONFIG, ...obj.config };
    }
    if (Array.isArray(obj.events)) {
      s.events = obj.events.filter(isValidEvent).map(cleanEvent);
    }
  }
  return s;
}

function isValidEvent(e) {
  return e && typeof e === 'object' &&
    ['add', 'low', 'min', 'rest'].includes(e.type) &&
    typeof e.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.date);
}

function cleanEvent(e) {
  const ev = {
    id: e.id || genId(),
    type: e.type,
    date: e.date,
    note: typeof e.note === 'string' ? e.note : '',
    createdAt: e.createdAt || new Date().toISOString(),
  };
  if (e.type === 'add') ev.amount = (e.amount === 300 || e.amount === 600) ? e.amount : 600;
  return ev;
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function genId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

/* ============================================================
   日付ユーティリティ（ローカル暦日・YYYY-MM-DD）
   ============================================================ */
function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${da}`;
}
function todayStr() { return ymd(new Date()); }
function parseYmd(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function daysBetween(a, b) { return Math.round((parseYmd(b) - parseYmd(a)) / 86400000); }
function addDays(s, n) { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); }
function formatDateJa(s) {
  const d = parseYmd(s);
  const w = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}（${w}）`;
}

/* ============================================================
   残量推定
   イベント列を1日ずつ走査し、各時点の推定残量(ml)を出す。
   - 起点は最初の add（その前の最後のシグナル閾値を仮の残量とする）
   - 毎日 1 回洗浄＝nominalPerWash 消費。rest の日は消費0。
   - low/min は表示用のチェックポイント（badge は推定残量から判定）。
   ============================================================ */
function estimateLevels(events, config) {
  const sorted = sortEvents(events);
  const byId = {};
  if (sorted.length === 0) return { byId, current: { known: false, level: null } };

  const restDates = new Set(sorted.filter(e => e.type === 'rest').map(e => e.date));
  const byDate = {};
  for (const e of sorted) (byDate[e.date] = byDate[e.date] || []).push(e);

  const start = sorted[0].date;
  const today = todayStr();
  const lastDate = sorted[sorted.length - 1].date;
  // 今日 か 最後のイベント日 の遅い方まで走査する
  const finalDate = daysBetween(start, today) > daysBetween(start, lastDate) ? today : lastDate;

  let level = null;
  let known = false;

  function seedBefore(date) {
    // date より前の最後のシグナル閾値を仮残量とする
    let seed = 0;
    for (const e of sorted) {
      if (e.date >= date) break;
      if (e.type === 'min') seed = config.minThreshold;
      else if (e.type === 'low') seed = config.lowThreshold;
    }
    return seed;
  }

  let cur = start;
  let guard = 0;
  while (guard++ < 100000) {
    const todays = byDate[cur] || [];
    // 1) 追加を反映
    for (const e of todays) {
      if (e.type === 'add') {
        if (!known) { level = Math.min(seedBefore(cur) + (e.amount || 0), config.tankCapacity); known = true; }
        else { level = Math.min(level + (e.amount || 0), config.tankCapacity); }
      }
    }
    // 2) その日の洗浄消費（rest の日は0）
    if (known) {
      const washed = restDates.has(cur) ? 0 : 1;
      level = Math.max(0, level - washed * config.nominalPerWash);
    }
    // 3) その日のイベントに推定残量を割り当て
    for (const e of todays) byId[e.id] = known ? Math.round(level) : null;

    if (cur === finalDate) break;
    cur = addDays(cur, 1);
  }

  return { byId, current: { known, level: known ? Math.round(level) : null } };
}

function sortEvents(events) {
  return [...events].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return (a.createdAt || '') < (b.createdAt || '') ? -1 : 1;
  });
}

function signalState(level) {
  if (level == null) return 'unknown';
  if (level < state.config.minThreshold) return 'min';
  if (level < state.config.lowThreshold) return 'low';
  return 'normal';
}

/* ============================================================
   記録の追加・編集・削除
   ============================================================ */
function getSelectedDate() {
  const v = $('#recordDate').value;
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : todayStr();
}

function addEvent(type, amount) {
  const date = getSelectedDate();
  const note = $('#noteInput').value.trim();
  const ev = { id: genId(), type, date, note, createdAt: new Date().toISOString() };
  if (type === 'add') ev.amount = amount;
  state.events.push(ev);
  saveState();
  lastAction = { kind: 'add', id: ev.id };

  // 備考をクリア＆閉じる
  $('#noteInput').value = '';
  $('#noteBox').open = false;

  render();
  const amtText = type === 'add' ? `（+${amount}ml）` : '';
  showToast(`${formatDateJa(date)} に「${TYPE_LABEL[type]}」${amtText}を記録`, { undo: true, note: true, noteId: ev.id });
}

function updateEvent(id, patch) {
  const ev = state.events.find(e => e.id === id);
  if (!ev) return;
  Object.assign(ev, patch);
  if (ev.type !== 'add') delete ev.amount;
  saveState();
  render();
}

function deleteEvent(id) {
  state.events = state.events.filter(e => e.id !== id);
  saveState();
  render();
}

/* ============================================================
   レンダリング
   ============================================================ */
function render() {
  const est = estimateLevels(state.events, state.config);
  renderHeader(est);
  renderHistory(est);
  renderConfig();
  renderAnalysis();
}

function renderHeader(est) {
  const lvl = est.current.level;
  $('#levelValue').textContent = lvl == null ? '—' : `${lvl}`;
  const pct = lvl == null ? 0 : Math.max(0, Math.min(100, (lvl / state.config.tankCapacity) * 100));
  $('#levelFill').style.width = pct + '%';

  const sig = signalState(lvl);
  const badge = $('#signalBadge');
  badge.className = 'badge badge-' + sig;
  badge.textContent = { unknown: '—', normal: 'OK', low: 'low', min: 'min' }[sig];

  // 日付の注意表示
  const sel = getSelectedDate();
  const notice = $('#dateNotice');
  if (sel !== todayStr()) {
    notice.hidden = false;
    notice.textContent = `⚠ ${formatDateJa(sel)} として記録します（過去日の入力）`;
  } else {
    notice.hidden = true;
  }
}

function renderHistory(est) {
  const list = $('#historyList');
  const empty = $('#historyEmpty');
  const summary = $('#historySummary');

  const events = sortEvents(state.events).reverse(); // 新しい順
  if (events.length === 0) {
    list.innerHTML = '';
    empty.hidden = false;
    summary.innerHTML = '';
    return;
  }
  empty.hidden = true;

  // サマリ
  const counts = { add: 0, low: 0, min: 0, rest: 0 };
  for (const e of state.events) counts[e.type]++;
  summary.innerHTML =
    chip('追加', counts.add) + chip('low', counts.low) +
    chip('min', counts.min) + chip('休み', counts.rest) +
    chip('合計', state.events.length);

  list.innerHTML = events.map(e => {
    const lvl = est.byId[e.id];
    const iconText = e.type === 'add' ? `+${e.amount}` : TYPE_LABEL[e.type];
    const meta = e.type === 'add' ? `洗剤追加 +${e.amount}ml` : `${TYPE_LABEL[e.type]} シグナル/状態`;
    const lvlText = lvl == null ? '' : `<div class="hist-level">推定 ${lvl}ml</div>`;
    const noteHtml = e.note ? `<div class="hist-note">📝 ${escapeHtml(e.note)}</div>` : '';
    return `<li><button class="hist-item" data-id="${e.id}" type="button">
      <span class="hist-icon ${TYPE_ICON_CLASS[e.type]}">${escapeHtml(iconText)}</span>
      <span class="hist-main">
        <span class="hist-date">${formatDateJa(e.date)}</span>
        <span class="hist-meta">${escapeHtml(meta)}</span>
        ${noteHtml}
      </span>
      ${lvlText}
    </button></li>`;
  }).join('');
}

function chip(label, n) { return `<span class="sum-chip">${label} <b>${n}</b></span>`; }

function renderConfig() {
  const c = state.config;
  $('#configList').innerHTML = [
    ['タンク総量', `${c.tankCapacity} ml`],
    ['詰め替え1個', `${c.refillUnit} ml`],
    ['low シグナル', `< ${c.lowThreshold} ml`],
    ['min シグナル', `< ${c.minThreshold} ml`],
    ['1回あたり公称', `${c.nominalPerWash} ml`],
  ].map(([k, v]) => `<li><span>${k}</span><span class="cfg-val">${v}</span></li>`).join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ============================================================
   トースト（Undo / 備考）
   ============================================================ */
function showToast(msg, opts = {}) {
  const toast = $('#toast');
  $('#toastMsg').textContent = msg;
  $('#toastUndo').hidden = !opts.undo;
  $('#toastNote').hidden = !opts.note;
  toast.dataset.noteId = opts.noteId || '';
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 6000);
}
function hideToast() { $('#toast').hidden = true; }

function undoLast() {
  if (!lastAction) return;
  if (lastAction.kind === 'add') deleteEvent(lastAction.id);
  lastAction = null;
  hideToast();
}

/* ============================================================
   インポート / エクスポート
   ============================================================ */
function exportJson() {
  const data = JSON.stringify({ ...state, weather }, null, 2);
  download(`senzai-flow-${todayStr()}.json`, data, 'application/json');
}

function exportCsv() {
  const est = estimateLevels(state.events, state.config);
  const rows = [['date', 'type', 'amount', 'note', 'estimatedRemaining']];
  for (const e of sortEvents(state.events)) {
    rows.push([
      e.date,
      e.type,
      e.type === 'add' ? e.amount : '',
      e.note || '',
      est.byId[e.id] == null ? '' : est.byId[e.id],
    ]);
  }
  const csv = '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n');
  download(`senzai-flow-${todayStr()}.csv`, csv, 'text/csv');
}

function csvCell(v) {
  const s = String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function handleImportFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      const incoming = normalizeState(parsed);
      pendingImport = incoming;
      pendingImportWeather = parsed.weather ? normalizeWeather(parsed.weather) : null;
      const wInfo = pendingImportWeather
        ? `、気温 ${Object.keys(pendingImportWeather.daily).length} 日分` : '';
      $('#importInfo').textContent =
        `読み込むデータ: ${incoming.events.length} 件${wInfo}。現在の記録は ${state.events.length} 件です。`;
      openModal('#importModal');
    } catch (e) {
      alert('ファイルを読み込めませんでした。JSON 形式を確認してください。');
    }
  };
  reader.readAsText(file);
}

function applyImport(mode) {
  if (!pendingImport) return;
  if (mode === 'replace') {
    state = pendingImport;
    if (pendingImportWeather) weather = pendingImportWeather;
  } else {
    const existing = new Set(state.events.map(e => e.id));
    for (const e of pendingImport.events) {
      if (!existing.has(e.id)) { state.events.push(e); existing.add(e.id); }
    }
    state.config = { ...state.config, ...pendingImport.config };
    if (pendingImportWeather) {
      Object.assign(weather.daily, pendingImportWeather.daily);
      // 地点が未設定の端末では、読み込んだデータの地点を引き継ぐ（機種変更時など）
      if (!weather.location && pendingImportWeather.location) weather.location = pendingImportWeather.location;
    }
  }
  pendingImport = null;
  pendingImportWeather = null;
  saveState();
  saveWeather();
  closeModal('#importModal');
  render();
  switchTab('history');
  showToast('読み込みが完了しました');
}

/* ============================================================
   モーダル
   ============================================================ */
function openModal(sel) { $(sel).hidden = false; }
function closeModal(sel) { $(sel).hidden = true; }

function openEdit(id) {
  const ev = state.events.find(e => e.id === id);
  if (!ev) return;
  editingId = id;
  $('#editDate').value = ev.date;
  $('#editType').value = ev.type;
  $('#editNote').value = ev.note || '';
  $('#editAmount').value = String(ev.amount || 600);
  toggleEditAmount();
  openModal('#editModal');
}

function toggleEditAmount() {
  $('#editAmountField').hidden = $('#editType').value !== 'add';
}

function saveEdit() {
  if (!editingId) return;
  const type = $('#editType').value;
  const patch = {
    date: $('#editDate').value,
    type,
    note: $('#editNote').value.trim(),
  };
  if (type === 'add') patch.amount = Number($('#editAmount').value);
  updateEvent(editingId, patch);
  editingId = null;
  closeModal('#editModal');
}

/* ============================================================
   タブ切り替え
   ============================================================ */
function switchTab(name) {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
}

/* ============================================================
   ヘルパ
   ============================================================ */
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return Array.from(document.querySelectorAll(sel)); }

/* ============================================================
   イベント配線
   ============================================================ */
function wireUp() {
  // 日付の初期値 = 今日
  $('#recordDate').value = todayStr();
  $('#recordDate').addEventListener('change', () => renderHeader(estimateLevels(state.events, state.config)));
  $('#todayBtn').addEventListener('click', () => {
    $('#recordDate').value = todayStr();
    renderHeader(estimateLevels(state.events, state.config));
  });

  // タブ
  $$('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  // 記録ボタン（low / min / rest）
  $$('.rec-btn[data-type]').forEach(btn =>
    btn.addEventListener('click', () => addEvent(btn.dataset.type)));

  // 洗剤追加 → チップ表示
  $('#addBtn').addEventListener('click', () => {
    const chips = $('#addChips');
    chips.hidden = !chips.hidden;
  });
  $$('#addChips .chip').forEach(chip =>
    chip.addEventListener('click', () => {
      addEvent('add', Number(chip.dataset.amount));
      $('#addChips').hidden = true;
    }));

  // トースト
  $('#toastUndo').addEventListener('click', undoLast);
  $('#toastNote').addEventListener('click', () => {
    const id = $('#toast').dataset.noteId;
    hideToast();
    if (id) openEdit(id);
  });

  // 履歴アイテム → 編集
  $('#historyList').addEventListener('click', e => {
    const item = e.target.closest('.hist-item');
    if (item) openEdit(item.dataset.id);
  });

  // 編集モーダル
  $('#editType').addEventListener('change', toggleEditAmount);
  $('#editSave').addEventListener('click', saveEdit);
  $('#editCancel').addEventListener('click', () => { editingId = null; closeModal('#editModal'); });
  $('#editDelete').addEventListener('click', () => {
    if (editingId && confirm('この記録を削除しますか？')) {
      deleteEvent(editingId);
      editingId = null;
      closeModal('#editModal');
    }
  });

  // データタブ
  $('#exportJsonBtn').addEventListener('click', exportJson);
  $('#exportCsvBtn').addEventListener('click', exportCsv);
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', e => {
    if (e.target.files[0]) handleImportFile(e.target.files[0]);
    e.target.value = '';
  });
  $('#importMerge').addEventListener('click', () => applyImport('merge'));
  $('#importReplace').addEventListener('click', () => {
    if (confirm('現在の記録をすべて消して入れ替えます。よろしいですか？')) applyImport('replace');
  });
  $('#importCancel').addEventListener('click', () => { pendingImport = null; pendingImportWeather = null; closeModal('#importModal'); });

  $('#resetBtn').addEventListener('click', () => {
    if (confirm('この端末の記録をすべて削除します。よろしいですか？') &&
        confirm('本当に削除しますか？（取り消せません）')) {
      state = freshState();
      saveState();
      render();
      showToast('すべて削除しました');
    }
  });

  // 分析タブ
  ['#analysisBy', '#analysisField', '#analysisIncludeEst'].forEach(sel => {
    const el = $(sel);
    if (el) el.addEventListener('change', renderAnalysis);
  });
  // 気温の取得範囲の初期値（記録の最初の日 〜 今日）
  if ($('#weatherStart') && !$('#weatherStart').value) {
    $('#weatherStart').value = state.events.length ? sortEvents(state.events)[0].date : todayStr();
  }
  if ($('#weatherEnd') && !$('#weatherEnd').value) $('#weatherEnd').value = todayStr();

  // 観測地点の設定
  $('#locSaveBtn').addEventListener('click', () => {
    const loc = normalizeLocation({
      name: $('#locName').value,
      lat: $('#locLat').value,
      lon: $('#locLon').value,
    });
    if (!loc) {
      showToast('緯度・経度を入力してください（緯度 -90〜90 / 経度 -180〜180）');
      return;
    }
    weather.location = loc;
    saveWeather();
    document.activeElement && document.activeElement.blur();
    renderAnalysis();
    showToast(`観測地点を「${loc.name}」に設定しました`);
  });

  $('#locGeoBtn').addEventListener('click', () => {
    if (!navigator.geolocation) { showToast('この端末では現在地を取得できません'); return; }
    const btn = $('#locGeoBtn');
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '取得中…';
    const done = () => { btn.disabled = false; btn.textContent = label; };
    navigator.geolocation.getCurrentPosition(pos => {
      done();
      // 小数2桁（約1km）に丸めて、住居が特定できる精度では扱わない
      $('#locLat').value = (Math.round(pos.coords.latitude * 100) / 100).toFixed(2);
      $('#locLon').value = (Math.round(pos.coords.longitude * 100) / 100).toFixed(2);
      if (!$('#locName').value.trim()) $('#locName').value = '現在地';
      showToast('現在地を入力しました。「地点を保存」で確定してください');
    }, err => {
      done();
      showToast('現在地の取得に失敗: ' + ((err && err.message) || '不明'));
    }, { timeout: 10000, maximumAge: 600000 });
  });

  $('#weatherFetchBtn').addEventListener('click', async () => {
    const s = $('#weatherStart').value || (state.events.length ? sortEvents(state.events)[0].date : todayStr());
    const e = $('#weatherEnd').value || todayStr();
    const btn = $('#weatherFetchBtn');
    btn.dataset.busy = '1';
    btn.disabled = true;
    btn.textContent = '取得中…';
    const res = await fetchWeather(s, e);
    delete btn.dataset.busy;
    btn.disabled = false;
    renderAnalysis();  // ボタン文言は renderWeatherLocation が戻す
    if (res.ok) {
      showToast(`気温を ${res.fetchedDays} 日分 取得しました${res.missingRecent ? '（直近約6日はアーカイブ未掲載）' : ''}`);
    } else {
      showToast('気温の取得に失敗: ' + (res.error || '不明') + '（オフライン時はCSV読込を）');
    }
  });

  $('#weatherCsvBtn').addEventListener('click', () => $('#weatherCsvFile').click());
  $('#weatherCsvFile').addEventListener('change', e => {
    const f = e.target.files[0];
    if (f) {
      const r = new FileReader();
      r.onload = () => {
        const res = importWeatherCsv(r.result);
        renderAnalysis();
        showToast(`気温CSVを ${res.added} 日分 読込（スキップ ${res.skipped}）${res.error ? ' — ' + res.error : ''}`);
      };
      r.readAsText(f);
    }
    e.target.value = '';
  });

  // モーダル背景タップで閉じる
  $$('.modal').forEach(m => m.addEventListener('click', e => {
    if (e.target === m) {
      m.hidden = true;
      editingId = null;
      if (m.id === 'importModal') { pendingImport = null; pendingImportWeather = null; }
    }
  }));
}

/* ============================================================
   分析: 消費区間の抽出
   「残量を確定できるアンカー」間の消費量÷洗浄回数で 1回あたり消費量を出す。
   - アンカー残量: low→350, min→150（実測クロッシング）、add→直前残量+amount（既知時のみ・上限850）
   - rest はアンカーでなく洗浄回数の控除に使う（1日1回洗浄を仮定）
   - 両端が low/min の区間は observed（バイアスなし）、add を含めば estimated
   ============================================================ */
function consumptionSegments(events, config) {
  // 同日に min/low と add がある場合、物理的順序（先にシグナル→その後 追加）に並べる。
  const typeOrder = { low: 0, min: 0, rest: 0, add: 1 };
  const sorted = [...events].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (typeOrder[a.type] !== typeOrder[b.type]) return typeOrder[a.type] - typeOrder[b.type];
    return (a.createdAt || '') < (b.createdAt || '') ? -1 : 1;
  });
  const restDates = new Set(sorted.filter(e => e.type === 'rest').map(e => e.date));
  const cap = config.tankCapacity;
  const segments = [];
  let prev = null; // { date, level, kind, clamped }

  function restCountIn(aDate, bDate) {
    let c = 0;
    for (const d of restDates) if (d > aDate && d <= bDate) c++;
    return c;
  }

  for (const e of sorted) {
    if (e.type === 'rest') continue; // アンカーではない
    let level = null, kind = null, clampedHere = false;
    if (e.type === 'low') { level = config.lowThreshold; kind = 'low'; }
    else if (e.type === 'min') { level = config.minThreshold; kind = 'min'; }
    else if (e.type === 'add') {
      if (prev && prev.level != null) {
        const raw = prev.level + (e.amount || 0);
        level = Math.min(raw, cap);
        clampedHere = raw > cap;
        kind = 'add';
      } else {
        prev = null; // 直前残量が不明 → 鎖を切る（最初の add 等）
        continue;
      }
    }
    // 区間 prev -> 現在（残量が下がったときのみ）
    if (prev && prev.level != null && level != null && prev.level > level) {
      const spanDays = daysBetween(prev.date, e.date);
      if (spanDays > 0) {
        const restDays = restCountIn(prev.date, e.date);
        const washes = spanDays - restDays;
        if (washes > 0) {
          const consumed = prev.level - level;
          const reliability = (prev.kind !== 'add' && kind !== 'add') ? 'observed' : 'estimated';
          segments.push({
            startDate: prev.date, endDate: e.date,
            midDate: addDays(prev.date, Math.round(spanDays / 2)),
            startLevel: prev.level, endLevel: level,
            startKind: prev.kind, endKind: kind,
            consumed, spanDays, restDays, washes,
            mlPerWash: consumed / washes, mlPerDay: consumed / spanDays,
            reliability,
            clamped: !!(prev.clamped || clampedHere),
          });
        }
      }
    }
    prev = { date: e.date, level, kind, clamped: clampedHere };
  }
  return segments;
}

/* ============================================================
   分析: 集計（全体 / 年 / 季節 / 月）
   洗浄回数加重平均 = Σ消費 / Σ洗浄回数（物理的に正しく、区間の切り方に不変）
   ============================================================ */
const SEASON_OF = { 12: '冬', 1: '冬', 2: '冬', 3: '春', 4: '春', 5: '春', 6: '夏', 7: '夏', 8: '夏', 9: '秋', 10: '秋', 11: '秋' };
const SEASON_ORDER = { 冬: 0, 春: 1, 夏: 2, 秋: 3 };

function bucketKey(seg, by) {
  const d = parseYmd(seg.midDate);
  const y = d.getFullYear(), m = d.getMonth() + 1;
  if (by === 'year') return { key: String(y), sortKey: String(y), label: `${y}年`, year: y };
  if (by === 'month') {
    const mm = String(m).padStart(2, '0');
    return { key: `${y}-${mm}`, sortKey: `${y}-${mm}`, label: `${y}/${m}`, year: y, month: m };
  }
  if (by === 'season') {
    const s = SEASON_OF[m];
    const sy = m === 12 ? y + 1 : y; // 12月は翌年の冬へ
    return { key: `${sy}-${s}`, sortKey: `${sy}-${SEASON_ORDER[s]}`, label: `${sy} ${s}`, season: s, seasonYear: sy };
  }
  return { key: 'all', sortKey: 'all', label: '全体' }; // overall
}

function bucketSegments(segments, by, opts = {}) {
  const includeEstimated = opts.includeEstimated !== false;
  const map = new Map();
  for (const seg of segments) {
    if (!includeEstimated && seg.reliability !== 'observed') continue;
    const k = bucketKey(seg, by);
    if (!map.has(k.key)) map.set(k.key, { meta: k, segs: [] });
    map.get(k.key).segs.push(seg);
  }
  const buckets = [];
  for (const { meta, segs } of map.values()) {
    const totalWashes = segs.reduce((s, x) => s + x.washes, 0);
    const totalConsumed = segs.reduce((s, x) => s + x.consumed, 0);
    const totalDays = segs.reduce((s, x) => s + x.spanDays, 0);
    const obs = segs.filter(x => x.reliability === 'observed');
    const obsW = obs.reduce((s, x) => s + x.washes, 0);
    const obsC = obs.reduce((s, x) => s + x.consumed, 0);
    buckets.push({
      key: meta.key, sortKey: meta.sortKey, label: meta.label,
      year: meta.year, month: meta.month, season: meta.season, seasonYear: meta.seasonYear,
      segmentCount: segs.length,
      totalWashes, totalConsumed, totalDays,
      mlPerWash: totalWashes ? totalConsumed / totalWashes : null,
      mlPerDay: totalDays ? totalConsumed / totalDays : null,
      mlPerWashObserved: obsW ? obsC / obsW : null,
      simpleMean: segs.length ? segs.reduce((s, x) => s + x.mlPerWash, 0) / segs.length : null,
    });
  }
  buckets.sort((a, b) => a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0);
  return buckets;
}

/* ============================================================
   気温データ — ストア / 取得 / CSVインポート
   観測地点は端末ごとの設定。既定値は持たず、利用者が分析タブで設定する。
   ============================================================ */
function freshWeather() {
  return { schemaVersion: 1, location: null, daily: {} };
}
function loadWeather() {
  try {
    const raw = localStorage.getItem(WEATHER_KEY);
    if (!raw) return freshWeather();
    return normalizeWeather(JSON.parse(raw));
  } catch (e) { return freshWeather(); }
}
function saveWeather() { localStorage.setItem(WEATHER_KEY, JSON.stringify(weather)); }

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* 地点を検証して正規化する。緯度経度が不正なら null（＝未設定）。
   緯度経度は小数2桁（約1km）に丸め、必要以上に細かい位置を保存しない。 */
function normalizeLocation(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const lat = numOrNull(obj.lat);
  const lon = numOrNull(obj.lon);
  if (lat == null || lon == null) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  const name = String(obj.name == null ? '' : obj.name).trim().slice(0, 30);
  return { name: name || '設定した地点', lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100 };
}

function normalizeWeather(obj) {
  const w = freshWeather();
  if (obj && typeof obj === 'object') {
    w.location = normalizeLocation(obj.location);
    if (obj.daily && typeof obj.daily === 'object') {
      for (const [d, v] of Object.entries(obj.daily)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !v || typeof v !== 'object') continue;
        w.daily[d] = { min: numOrNull(v.min), max: numOrNull(v.max), mean: numOrNull(v.mean) };
      }
    }
  }
  return w;
}

async function fetchWeather(startDate, endDate) {
  const loc = weather.location;
  if (!loc) {
    return { ok: false, error: '観測地点が未設定です', missingRecent: false, fetchedDays: 0 };
  }
  const clampEnd = addDays(todayStr(), -6); // archive(ERA5) は直近約5日が未掲載
  let missingRecent = false;
  if (endDate > clampEnd) { endDate = clampEnd; missingRecent = true; }
  if (!startDate || startDate > endDate) {
    return { ok: false, error: '取得できる範囲がありません（約6日前まで）', missingRecent, fetchedDays: 0 };
  }
  let fetchedDays = 0;
  try {
    let chunkStart = startDate;
    while (chunkStart <= endDate) {
      const y = parseYmd(chunkStart).getFullYear();
      let chunkEnd = `${y}-12-31`;
      if (chunkEnd > endDate) chunkEnd = endDate;
      const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${loc.lat}&longitude=${loc.lon}` +
        `&start_date=${chunkStart}&end_date=${chunkEnd}` +
        `&daily=temperature_2m_max,temperature_2m_min,temperature_2m_mean&timezone=Asia%2FTokyo`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      const dl = json && json.daily;
      if (dl && Array.isArray(dl.time)) {
        for (let i = 0; i < dl.time.length; i++) {
          const min = dl.temperature_2m_min ? dl.temperature_2m_min[i] : null;
          const max = dl.temperature_2m_max ? dl.temperature_2m_max[i] : null;
          const mean = dl.temperature_2m_mean ? dl.temperature_2m_mean[i] : null;
          if (min == null && max == null && mean == null) continue;
          weather.daily[dl.time[i]] = { min: numOrNull(min), max: numOrNull(max), mean: numOrNull(mean) };
          fetchedDays++;
        }
        saveWeather(); // チャンク毎に保存（途中失敗でも既取得分は残る）
      }
      chunkStart = addDays(chunkEnd, 1);
    }
    return { ok: true, fetchedDays, missingRecent };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), fetchedDays, missingRecent };
  }
}

function splitCsvLine(line) {
  const out = [];
  let cur = '', inq = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inq) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inq = false; }
      else cur += c;
    } else if (c === '"') inq = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

function normalizeDateStr(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!m) return null;
  return `${m[1]}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[3])).padStart(2, '0')}`;
}

function parseTemp(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === '' || s === '-' || s === '--' || s === '×' || s === '///' || s === '#') return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function detectWeatherColumns(cells) {
  const map = { date: -1, min: -1, max: -1, mean: -1 };
  cells.forEach((h, i) => {
    const l = h.toLowerCase();
    if (map.date < 0 && (l === 'date' || l.includes('date') || h.includes('年月日') || h === '日付')) map.date = i;
    else if (map.max < 0 && (l === 'max' || h.includes('最高'))) map.max = i;
    else if (map.min < 0 && (l === 'min' || h.includes('最低'))) map.min = i;
    else if (map.mean < 0 && (l === 'mean' || l === 'avg' || l === 'average' || h.includes('平均'))) map.mean = i;
  });
  return map;
}

// CSV（date,min,max,mean / 気象庁形式 年月日・最高/最低/平均気温(℃)）を取り込む
function importWeatherCsv(text) {
  const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(l => l.length);
  let headerIdx = -1, cols = null;
  for (let i = 0; i < lines.length; i++) {
    const m = detectWeatherColumns(splitCsvLine(lines[i]));
    if (m.date >= 0 && (m.mean >= 0 || m.min >= 0 || m.max >= 0)) { headerIdx = i; cols = m; break; }
  }
  if (headerIdx < 0) {
    return { added: 0, skipped: lines.length, error: 'ヘッダ（date/min/max/mean か 年月日/気温）を認識できませんでした' };
  }
  let added = 0, skipped = 0;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const date = normalizeDateStr(cells[cols.date]);
    if (!date) { skipped++; continue; }
    const rec = {
      min: cols.min >= 0 ? parseTemp(cells[cols.min]) : null,
      max: cols.max >= 0 ? parseTemp(cells[cols.max]) : null,
      mean: cols.mean >= 0 ? parseTemp(cells[cols.mean]) : null,
    };
    if (rec.min == null && rec.max == null && rec.mean == null) { skipped++; continue; }
    weather.daily[date] = rec;
    added++;
  }
  saveWeather();
  return { added, skipped };
}

// 区間の平均気温（start翌日〜end）。欠測は present のみで平均。coverage<0.5 は null。
function segmentTemperature(seg, w, field = 'mean') {
  let sum = 0, count = 0;
  let d = addDays(seg.startDate, 1);
  while (d <= seg.endDate) {
    const rec = w.daily[d];
    const v = rec ? rec[field] : null;
    if (v != null) { sum += v; count++; }
    d = addDays(d, 1);
  }
  const total = seg.spanDays;
  const coverage = total > 0 ? count / total : 0;
  const meanTemp = (count > 0 && coverage >= 0.5) ? sum / count : null;
  return { meanTemp, coverage, daysCovered: count, daysTotal: total };
}

/* ============================================================
   自作SVGチャート（外部ライブラリなし・文字列を返す）
   ============================================================ */
function scaleLinear(d0, d1, r0, r1) {
  const dd = (d1 - d0) || 1;
  return v => r0 + (v - d0) * (r1 - r0) / dd;
}
function niceTicks(min, max, count = 5) {
  if (!(max > min)) max = min + 1;
  const step0 = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const ticks = [];
  for (let t = Math.ceil(min / step) * step; t <= max + 1e-9; t += step) {
    ticks.push(Math.round(t * 100) / 100);
  }
  return ticks;
}
function linfit(points) {
  const n = points.length;
  if (n < 2) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
  for (const p of points) { sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y; syy += p.y * p.y; }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const rdenom = Math.sqrt(denom * (n * syy - sy * sy));
  const r = rdenom === 0 ? 0 : (n * sxy - sx * sy) / rdenom;
  return { slope, intercept, r };
}
function svgWrap(W, H, inner) {
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" ` +
    `xmlns="http://www.w3.org/2000/svg" font-family="sans-serif">${inner}</svg>`;
}
function emptyChart(W, H, msg) {
  return svgWrap(W, H, `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-size="12" fill="#6b7b7d">${escapeHtml(msg)}</text>`);
}

function svgBarChart(data, opts = {}) {
  const W = opts.width || 340, H = opts.height || 220;
  const rotate = data.length > 6;
  const padL = 40, padR = 14, padT = 16, padB = rotate ? 54 : 42;
  const plotH = H - padT - padB, plotW = W - padL - padR;
  if (!data.length) return emptyChart(W, H, 'データなし');
  const maxV = (Math.max(opts.baseline || 0, ...data.map(d => d.value || 0)) * 1.15) || 1;
  const y = scaleLinear(0, maxV, padT + plotH, padT);
  const bw = plotW / data.length;
  const barW = Math.min(bw * 0.6, 46);
  const color = opts.color || '#0a7c86';
  let svg = '';
  for (const t of niceTicks(0, maxV, 4)) {
    const yy = y(t);
    svg += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="#e7eded"/>`;
    svg += `<text x="${padL - 4}" y="${yy + 3}" text-anchor="end" font-size="9" fill="#6b7b7d">${t}</text>`;
  }
  if (opts.baseline) {
    const yb = y(opts.baseline);
    svg += `<line x1="${padL}" y1="${yb}" x2="${W - padR}" y2="${yb}" stroke="#d9534f" stroke-width="1.5" stroke-dasharray="4 3"/>`;
    svg += `<text x="${W - padR}" y="${yb - 3}" text-anchor="end" font-size="9" fill="#d9534f">公称 ${opts.baseline}</text>`;
  }
  data.forEach((d, i) => {
    const cx = padL + bw * i + bw / 2;
    const v = d.value || 0;
    const yy = y(v);
    svg += `<rect x="${(cx - barW / 2).toFixed(1)}" y="${yy.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0, padT + plotH - yy).toFixed(1)}" rx="3" fill="${color}"/>`;
    svg += `<text x="${cx.toFixed(1)}" y="${(yy - 4).toFixed(1)}" text-anchor="middle" font-size="9" fill="#1d2b2d">${v.toFixed(1)}</text>`;
    if (rotate) {
      const ly = padT + plotH + 12;
      svg += `<text x="${cx.toFixed(1)}" y="${ly}" transform="rotate(45 ${cx.toFixed(1)} ${ly})" text-anchor="start" font-size="8" fill="#1d2b2d">${escapeHtml(d.label)}</text>`;
    } else {
      svg += `<text x="${cx.toFixed(1)}" y="${padT + plotH + 14}" text-anchor="middle" font-size="9" fill="#1d2b2d">${escapeHtml(d.label)}</text>`;
      if (d.n != null) svg += `<text x="${cx.toFixed(1)}" y="${padT + plotH + 26}" text-anchor="middle" font-size="8" fill="#6b7b7d">n=${d.n}</text>`;
    }
  });
  return svgWrap(W, H, svg);
}

function dateTicks(xmin, xmax, n = 4) {
  const ticks = [];
  for (let i = 0; i <= n; i++) {
    const t = xmin + (xmax - xmin) * i / n;
    const d = new Date(t);
    ticks.push({ v: t, label: `${d.getFullYear()}/${d.getMonth() + 1}` });
  }
  return ticks;
}

function svgScatter(points, opts = {}) {
  const W = opts.width || 340, H = opts.height || 230;
  const padL = 40, padR = 14, padT = 16, padB = 40;
  const plotH = H - padT - padB, plotW = W - padL - padR;
  if (!points.length) return emptyChart(W, H, opts.empty || 'データなし');
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  let xmin = Math.min(...xs), xmax = Math.max(...xs);
  if (xmin === xmax) { xmin -= 1; xmax += 1; }
  let ymin = Math.min(0, ...ys);
  let ymax = (Math.max(opts.baseline || 0, ...ys) * 1.1) || 1;
  const sx = scaleLinear(xmin, xmax, padL, W - padR);
  const sy = scaleLinear(ymin, ymax, padT + plotH, padT);
  let svg = '';
  for (const t of niceTicks(ymin, ymax, 4)) {
    const yy = sy(t);
    svg += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="#eef2f2"/>`;
    svg += `<text x="${padL - 4}" y="${yy + 3}" text-anchor="end" font-size="9" fill="#6b7b7d">${t}</text>`;
  }
  const xticks = opts.xIsDate ? dateTicks(xmin, xmax) : niceTicks(xmin, xmax, 4).map(v => ({ v, label: String(v) }));
  for (const tk of xticks) {
    const xx = sx(tk.v);
    svg += `<text x="${xx.toFixed(1)}" y="${padT + plotH + 14}" text-anchor="middle" font-size="8" fill="#6b7b7d">${escapeHtml(tk.label)}</text>`;
  }
  if (opts.baseline) {
    const yb = sy(opts.baseline);
    svg += `<line x1="${padL}" y1="${yb}" x2="${W - padR}" y2="${yb}" stroke="#d9534f" stroke-width="1.5" stroke-dasharray="4 3"/>`;
  }
  if (opts.fit) {
    const y1 = opts.fit.slope * xmin + opts.fit.intercept;
    const y2 = opts.fit.slope * xmax + opts.fit.intercept;
    svg += `<line x1="${sx(xmin).toFixed(1)}" y1="${sy(y1).toFixed(1)}" x2="${sx(xmax).toFixed(1)}" y2="${sy(y2).toFixed(1)}" stroke="#08636b" stroke-width="1.5"/>`;
  }
  for (const p of points) {
    const cx = sx(p.x).toFixed(1), cy = sy(p.y).toFixed(1);
    if (p.kind === 'estimated') svg += `<circle cx="${cx}" cy="${cy}" r="3.5" fill="none" stroke="#0a7c86" stroke-width="1.5"/>`;
    else svg += `<circle cx="${cx}" cy="${cy}" r="3.5" fill="#0a7c86"/>`;
  }
  if (opts.xLabel) svg += `<text x="${padL + plotW / 2}" y="${H - 3}" text-anchor="middle" font-size="9" fill="#6b7b7d">${escapeHtml(opts.xLabel)}</text>`;
  if (opts.yLabel) svg += `<text x="10" y="${padT + plotH / 2}" text-anchor="middle" font-size="9" fill="#6b7b7d" transform="rotate(-90 10 ${padT + plotH / 2})">${escapeHtml(opts.yLabel)}</text>`;
  return svgWrap(W, H, svg);
}

function svgLineChart(series, opts = {}) {
  const W = opts.width || 340, H = opts.height || 240;
  const padL = 38, padR = 38, padT = 16, padB = 48;
  const plotH = H - padT - padB, plotW = W - padL - padR;
  const labels = opts.labels || [];
  if (!labels.length || !series.length) return emptyChart(W, H, opts.empty || 'データなし');
  const n = labels.length;
  const xAt = i => padL + (n === 1 ? plotW / 2 : plotW * i / (n - 1));
  const leftS = series.filter(s => s.axis !== 'right');
  const rightS = series.filter(s => s.axis === 'right');
  const domain = ss => {
    const vals = ss.flatMap(s => s.points.map(p => p.y)).filter(v => v != null);
    if (!vals.length) return [0, 1];
    return [Math.min(0, ...vals), (Math.max(...vals) * 1.1) || 1];
  };
  const [lmin, lmax] = domain(leftS);
  const [rmin, rmax] = domain(rightS.length ? rightS : leftS);
  const lY = scaleLinear(lmin, lmax, padT + plotH, padT);
  const rY = scaleLinear(rmin, rmax, padT + plotH, padT);
  let svg = '';
  for (const t of niceTicks(lmin, lmax, 4)) {
    const yy = lY(t);
    svg += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="#eef2f2"/>`;
    svg += `<text x="${padL - 4}" y="${yy + 3}" text-anchor="end" font-size="8" fill="#6b7b7d">${t}</text>`;
  }
  if (rightS.length) {
    for (const t of niceTicks(rmin, rmax, 4)) {
      svg += `<text x="${W - padR + 4}" y="${rY(t) + 3}" text-anchor="start" font-size="8" fill="#6b7b7d">${t}</text>`;
    }
  }
  labels.forEach((lb, i) => {
    const ly = padT + plotH + 12;
    svg += `<text x="${xAt(i).toFixed(1)}" y="${ly}" transform="rotate(45 ${xAt(i).toFixed(1)} ${ly})" text-anchor="start" font-size="7" fill="#1d2b2d">${escapeHtml(lb)}</text>`;
  });
  for (const s of series) {
    const Y = s.axis === 'right' ? rY : lY;
    let path = '';
    s.points.forEach((p, i) => {
      if (p.y == null) return;
      path += `${path ? 'L' : 'M'}${xAt(i).toFixed(1)} ${Y(p.y).toFixed(1)} `;
    });
    if (path) svg += `<path d="${path}" fill="none" stroke="${s.color}" stroke-width="2"/>`;
    s.points.forEach((p, i) => {
      if (p.y == null) return;
      svg += `<circle cx="${xAt(i).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="2.5" fill="${s.color}"/>`;
    });
  }
  return svgWrap(W, H, svg);
}

/* ============================================================
   分析タブの描画
   ============================================================ */
const BY_LABEL = { overall: '全体', year: '年', season: '季節', month: '月' };
const FIELD_LABEL = { mean: '平均', min: '最低', max: '最高' };

function getAnalysisOpts() {
  const byEl = $('#analysisBy'), fEl = $('#analysisField'), incEl = $('#analysisIncludeEst');
  return {
    by: (byEl && byEl.value) || 'season',
    field: (fEl && fEl.value) || 'mean',
    includeEstimated: incEl ? incEl.checked !== false : true,
  };
}

function anCard(title, value, sub) {
  return `<div class="an-card"><div class="an-card-title">${escapeHtml(title)}</div>` +
    `<div class="an-card-value">${escapeHtml(value)}</div>` +
    `${sub ? `<div class="an-card-sub">${escapeHtml(sub)}</div>` : ''}</div>`;
}
function chartTitle(t) { return `<h3 class="chart-title">${escapeHtml(t)}</h3>`; }

function renderWeatherStatus() {
  renderWeatherLocation();
  const el = $('#weatherStatus');
  if (!el) return;
  const days = Object.keys(weather.daily).sort();
  const locLabel = weather.location ? weather.location.name : '観測地点が未設定';
  el.textContent = days.length
    ? `${locLabel}｜気温データ: ${days.length} 日分（${days[0]} 〜 ${days[days.length - 1]}）`
    : `${locLabel}｜気温データ未取得`;
}

/* 地点の入力欄とボタン表示を現在の設定に合わせる。
   入力中の欄は上書きしない（renderAnalysis から繰り返し呼ばれるため）。 */
function renderWeatherLocation() {
  const loc = weather.location;
  const fields = [['#locName', loc ? loc.name : ''], ['#locLat', loc ? loc.lat : ''], ['#locLon', loc ? loc.lon : '']];
  for (const [sel, val] of fields) {
    const el = $(sel);
    if (el && el !== document.activeElement) el.value = val;
  }
  const btn = $('#weatherFetchBtn');
  if (btn && !btn.dataset.busy) {
    btn.disabled = !loc;
    btn.textContent = loc ? `${loc.name}の気温を自動取得` : '気温を自動取得（先に地点を設定）';
  }
}

function analysisTableHtml(buckets) {
  if (!buckets.length) return '';
  const rows = buckets.map(b => `<tr>
    <td>${escapeHtml(b.label)}</td>
    <td>${b.segmentCount}</td>
    <td>${b.totalWashes}</td>
    <td>${b.totalConsumed}</td>
    <td>${b.mlPerWash != null ? b.mlPerWash.toFixed(1) : '—'}</td>
    <td>${b.mlPerWashObserved != null ? b.mlPerWashObserved.toFixed(1) : '—'}</td>
    <td>${b.mlPerDay != null ? b.mlPerDay.toFixed(1) : '—'}</td>
  </tr>`).join('');
  return `<table class="an-table">
    <thead><tr><th>区分</th><th>区間</th><th>洗浄</th><th>消費ml</th><th>ml/回</th><th>ml/回(観測)</th><th>ml/日</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

function renderAnalysis() {
  const panel = $('#tab-analysis');
  if (!panel) return;
  renderWeatherStatus();

  const opts = getAnalysisOpts();
  const segs = consumptionSegments(state.events, state.config);
  const sumEl = $('#analysisSummary');
  const clear = () => ['#chartBars', '#chartSeries', '#chartScatter', '#chartOverlay', '#analysisTable']
    .forEach(s => { const el = $(s); if (el) el.innerHTML = ''; });

  if (!segs.length) {
    if (sumEl) sumEl.innerHTML = `<p class="empty-msg">分析できる区間がまだありません。<br>low / min を数回記録すると、1回あたりの消費量を算出できます。</p>`;
    clear();
    return;
  }

  const all = bucketSegments(segs, 'overall', { includeEstimated: true })[0];
  const obsCount = segs.filter(s => s.reliability === 'observed').length;
  const nominal = state.config.nominalPerWash;
  if (sumEl) {
    sumEl.innerHTML = [
      anCard('全体平均（観測）', all.mlPerWashObserved != null ? all.mlPerWashObserved.toFixed(1) + ' ml/回' : '—', `公称 ${nominal} ml/回`),
      anCard('全体平均（全区間）', all.mlPerWash != null ? all.mlPerWash.toFixed(1) + ' ml/回' : '—', '推定含む'),
      anCard('1日あたり', all.mlPerDay != null ? all.mlPerDay.toFixed(1) + ' ml/日' : '—', ''),
      anCard('総洗浄回数', all.totalWashes + ' 回', `総消費 ${all.totalConsumed} ml`),
      anCard('区間数', segs.length + ' 区間', `観測 ${obsCount} / 推定 ${segs.length - obsCount}`),
    ].join('');
  }

  // (a) 棒: 選択単位での加重平均 ml/回 と ml/日
  const buckets = bucketSegments(segs, opts.by, { includeEstimated: opts.includeEstimated });
  let barsHtml = chartTitle(`平均 ml/回（${BY_LABEL[opts.by]}別）`) +
    svgBarChart(buckets.map(b => ({ label: b.label, value: b.mlPerWash || 0, n: b.totalWashes })), { baseline: nominal });
  barsHtml += chartTitle(`平均 ml/日（${BY_LABEL[opts.by]}別）`) +
    svgBarChart(buckets.map(b => ({ label: b.label, value: b.mlPerDay || 0, n: b.totalDays })), { color: '#5a6b6d' });
  $('#chartBars').innerHTML = barsHtml;

  // (b) 時系列散布
  const tsPts = segs.filter(s => opts.includeEstimated || s.reliability === 'observed')
    .map(s => ({ x: parseYmd(s.midDate).getTime(), y: s.mlPerWash, kind: s.reliability }));
  $('#chartSeries').innerHTML = chartTitle('ml/回 の推移（観測=●／推定=○）') +
    svgScatter(tsPts, { xIsDate: true, baseline: nominal, yLabel: 'ml/回', empty: '区間なし' });

  // (c) 散布: ml/回 vs 区間平均気温
  const tempPts = [];
  for (const s of segs) {
    if (!opts.includeEstimated && s.reliability !== 'observed') continue;
    if (s.clamped) continue; // クランプ区間はトレンドから除外
    const t = segmentTemperature(s, weather, opts.field);
    if (t.meanTemp == null) continue;
    tempPts.push({ x: t.meanTemp, y: s.mlPerWash, kind: s.reliability });
  }
  const fit = linfit(tempPts);
  let scTitle = `ml/回 vs ${FIELD_LABEL[opts.field]}気温`;
  if (fit) scTitle += `（相関 r=${fit.r.toFixed(2)} / 傾き ${fit.slope.toFixed(2)} ml/℃）`;
  $('#chartScatter').innerHTML = chartTitle(scTitle) +
    (tempPts.length
      ? svgScatter(tempPts, { xLabel: `${FIELD_LABEL[opts.field]}気温 (℃)`, yLabel: 'ml/回', baseline: nominal, fit: fit || undefined })
      : emptyChart(340, 200, '気温データがありません（自動取得またはCSV読込）'));

  // (d) 月次オーバーレイ: ml/回 と 平均気温
  const mb = bucketSegments(segs, 'month', { includeEstimated: opts.includeEstimated });
  const labels = mb.map(b => b.label);
  const usage = mb.map(b => ({ y: b.mlPerWash }));
  const temps = mb.map(b => {
    let sum = 0, c = 0;
    for (const s of segs) {
      if (bucketKey(s, 'month').key !== b.key) continue;
      const t = segmentTemperature(s, weather, opts.field);
      if (t.meanTemp != null) { sum += t.meanTemp; c++; }
    }
    return { y: c ? sum / c : null };
  });
  const hasTemp = temps.some(v => v.y != null);
  const overlaySeries = [{ name: 'ml/回', color: '#0a7c86', axis: 'left', points: usage }];
  if (hasTemp) overlaySeries.push({ name: '気温', color: '#e8a23a', axis: 'right', points: temps });
  $('#chartOverlay').innerHTML = chartTitle('月次: ml/回（左軸・緑） と 気温（右軸・橙）') +
    (labels.length ? svgLineChart(overlaySeries, { labels }) : emptyChart(340, 200, 'データなし'));

  // 集計表
  $('#analysisTable').innerHTML = analysisTableHtml(buckets);
}

/* ============================================================
   service worker 登録（オフライン）
   ============================================================ */
function registerSW() {
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(err =>
        console.warn('SW 登録に失敗:', err));
    });
  }
}

/* ---------- 起動 ---------- */
wireUp();
render();
registerSW();
