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

/* ---------- 状態 ---------- */
let state = loadState();
let lastAction = null;   // Undo 用: { kind:'add', id } または { kind:'edit', before } など
let editingId = null;    // 編集モーダルで操作中のイベントID
let pendingImport = null; // 読み込み待ちのデータ
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
  const data = JSON.stringify(state, null, 2);
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
      $('#importInfo').textContent =
        `読み込むデータ: ${incoming.events.length} 件。現在の記録は ${state.events.length} 件です。`;
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
  } else {
    const existing = new Set(state.events.map(e => e.id));
    for (const e of pendingImport.events) {
      if (!existing.has(e.id)) { state.events.push(e); existing.add(e.id); }
    }
    state.config = { ...state.config, ...pendingImport.config };
  }
  pendingImport = null;
  saveState();
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
  $('#importCancel').addEventListener('click', () => { pendingImport = null; closeModal('#importModal'); });

  $('#resetBtn').addEventListener('click', () => {
    if (confirm('この端末の記録をすべて削除します。よろしいですか？') &&
        confirm('本当に削除しますか？（取り消せません）')) {
      state = freshState();
      saveState();
      render();
      showToast('すべて削除しました');
    }
  });

  // モーダル背景タップで閉じる
  $$('.modal').forEach(m => m.addEventListener('click', e => {
    if (e.target === m) {
      m.hidden = true;
      editingId = null;
      if (m.id === 'importModal') pendingImport = null;
    }
  }));
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
