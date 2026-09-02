/**
 * STUDIO CORE - 予約 API（Google Apps Script Web アプリ）
 * ---------------------------------------------------------------------------
 * GET  {GAS_URL}?date=2026-09-15
 *      -> { "date": "2026-09-15", "slots": ["10:00","11:30","14:30"] }
 *
 * POST {GAS_URL}
 *      body: { date, time, name, email, tel, message, token }
 *      -> { "status": "success", "reservationId": "R-20260915-1030" }
 *      -> { "status": "conflict" }                  同一枠が既に埋まっている
 *      -> { "status": "error", "message": "..." }   入力不正・サーバーエラー
 *
 * セットアップ手順は README.md「GAS側のセットアップ」を参照。
 */

/* =========================================================================
   設定
   ========================================================================= */
var CONFIG = {
  /** 予約を書き込むスプレッドシートのID（URL の /d/ と /edit の間の文字列） */
  SPREADSHEET_ID: 'PUT_YOUR_SPREADSHEET_ID_HERE',
  SHEET_NAME: '予約一覧',

  /** 営業時間と枠の刻み（フロントの config.js と必ず揃えること） */
  OPEN_HOUR: 10,
  CLOSE_HOUR: 21,
  SLOT_MINUTES: 90,
  /** 定休日（0=日 ... 6=土）。水曜定休。 */
  CLOSED_WEEKDAYS: [3],

  /** 予約を受け付ける範囲（当日からの日数） */
  MIN_DAYS_AHEAD: 1,
  MAX_DAYS_AHEAD: 60,

  TIMEZONE: 'Asia/Tokyo',

  /** 予約完了メールを送るか（送信元は Web アプリの実行ユーザー） */
  SEND_MAIL: false,
  MAIL_TO_ADMIN: ''
};

var HEADERS = ['受付日時', '予約番号', '希望日', '希望時間', '氏名', 'メール', '電話', '相談内容', 'token', 'ステータス'];

/* =========================================================================
   エントリポイント
   ========================================================================= */

function doGet(e) {
  try {
    var date = (e && e.parameter && e.parameter.date) || '';
    if (!isValidDateString(date)) {
      return jsonResponse({ status: 'error', message: 'date は YYYY-MM-DD 形式で指定してください' });
    }
    if (!isBookableDate(date)) {
      // 定休日・受付期間外は空配列を返す（フロントは「枠ゼロ」として扱う）
      return jsonResponse({ date: date, slots: [] });
    }
    return jsonResponse({ date: date, slots: getAvailableSlots(date) });
  } catch (err) {
    return jsonResponse({ status: 'error', message: 'サーバーエラーが発生しました' });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    // 同時POSTによる二重予約を防ぐため、書き込み全体をロックで囲む
    lock.waitLock(20000);
  } catch (err) {
    return jsonResponse({ status: 'error', message: '混み合っています。少し時間をおいてお試しください' });
  }

  try {
    var body = parseBody(e);
    var input = {
      date: sanitize(body.date, 10),
      time: sanitize(body.time, 5),
      name: sanitize(body.name, 50),
      email: sanitize(body.email, 100),
      tel: sanitize(body.tel, 20).replace(/[^0-9]/g, ''),
      message: sanitize(body.message, 1000),
      token: sanitize(body.token, 64)
    };

    var invalid = validateInput(input);
    if (invalid) return jsonResponse({ status: 'error', message: invalid });

    if (isSlotTaken(input.date, input.time)) {
      return jsonResponse({ status: 'conflict' });
    }

    var reservationId = buildReservationId(input.date, input.time);
    appendReservation(reservationId, input);
    if (CONFIG.SEND_MAIL) sendMails(reservationId, input);

    return jsonResponse({ status: 'success', reservationId: reservationId });
  } catch (err) {
    return jsonResponse({ status: 'error', message: 'サーバーエラーが発生しました' });
  } finally {
    lock.releaseLock();
  }
}

/* =========================================================================
   空き枠の算出
   ========================================================================= */

/** 営業時間から開始時刻の一覧を作る（10:00〜21:00 / 90分刻み → 終了が閉店を超える枠は作らない） */
function buildBusinessSlots() {
  var slots = [];
  var open = CONFIG.OPEN_HOUR * 60;
  var close = CONFIG.CLOSE_HOUR * 60;
  for (var t = open; t + CONFIG.SLOT_MINUTES <= close; t += CONFIG.SLOT_MINUTES) {
    slots.push(pad2(Math.floor(t / 60)) + ':' + pad2(t % 60));
  }
  return slots;
}

/** 予約済みを差し引いた空き枠を返す */
function getAvailableSlots(date) {
  var taken = getTakenTimes(date);
  return buildBusinessSlots().filter(function (time) {
    return taken.indexOf(time) === -1;
  });
}

/** 指定日の予約済み時刻の配列 */
function getTakenTimes(date) {
  var sheet = getSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  var values = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
  var dateIndex = HEADERS.indexOf('希望日');
  var timeIndex = HEADERS.indexOf('希望時間');
  var statusIndex = HEADERS.indexOf('ステータス');

  var taken = [];
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    if (String(row[statusIndex]) === 'キャンセル') continue;
    if (normalizeDate(row[dateIndex]) !== date) continue;
    taken.push(normalizeTime(row[timeIndex]));
  }
  return taken;
}

function isSlotTaken(date, time) {
  if (buildBusinessSlots().indexOf(time) === -1) return true; // 営業時間外は受け付けない
  return getTakenTimes(date).indexOf(time) !== -1;
}

/* =========================================================================
   書き込み
   ========================================================================= */

function getSheet() {
  var book = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var sheet = book.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) {
    sheet = book.insertSheet(CONFIG.SHEET_NAME);
    sheet.appendRow(HEADERS);
  }
  return sheet;
}

function appendReservation(reservationId, input) {
  var sheet = getSheet();
  if (sheet.getLastRow() === 0) sheet.appendRow(HEADERS);
  sheet.appendRow([
    Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss'),
    reservationId,
    // 先頭に ' を付け、日付・時刻がシリアル値へ自動変換されるのを防ぐ
    "'" + input.date,
    "'" + input.time,
    input.name,
    input.email,
    "'" + input.tel,
    input.message,
    input.token,
    '受付'
  ]);
}

function buildReservationId(date, time) {
  return 'R-' + date.replace(/-/g, '') + '-' + time.replace(':', '');
}

function sendMails(reservationId, input) {
  var subject = '【STUDIO CORE】無料カウンセリングのご予約を承りました';
  var body = [
    input.name + ' 様',
    '',
    '無料カウンセリングのご予約を承りました。',
    '',
    '予約番号：' + reservationId,
    '日　　時：' + input.date + ' ' + input.time + '〜（60分）',
    '場　　所：東京都渋谷区○○ 1-2-3 コアビル 4F',
    '',
    '持ち物は不要です。動きやすい服装でお越しください。',
    '日時の変更は前日21時まで承ります。',
    '',
    'STUDIO CORE'
  ].join('\n');

  MailApp.sendEmail(input.email, subject, body);
  if (CONFIG.MAIL_TO_ADMIN) {
    MailApp.sendEmail(CONFIG.MAIL_TO_ADMIN, '[新規予約] ' + reservationId,
      body + '\n\n電話: ' + input.tel + '\n相談内容: ' + input.message);
  }
}

/* =========================================================================
   入力の検証とサニタイズ
   ========================================================================= */

/**
 * 文字列化・長さ制限・制御文字と HTML 記号の除去を行う。
 * スプレッドシートの数式インジェクション（先頭 = + - @）も無効化する。
 */
function sanitize(value, maxLength) {
  if (value === null || value === undefined) return '';
  var text = String(value);
  text = text.replace(/[ -]/g, ' ');       // 制御文字
  text = text.replace(/[<>]/g, '');                          // タグの断片
  text = text.replace(/^[=+\-@\t\r]+/, '');                  // 数式インジェクション対策
  text = text.trim();
  if (maxLength && text.length > maxLength) text = text.slice(0, maxLength);
  return text;
}

function parseBody(e) {
  if (!e) return {};
  if (e.postData && e.postData.contents) {
    try {
      return JSON.parse(e.postData.contents);
    } catch (err) {
      // フォーム形式で送られた場合のフォールバック
      return e.parameter || {};
    }
  }
  return e.parameter || {};
}

function validateInput(input) {
  if (!isValidDateString(input.date)) return '希望日の形式が正しくありません';
  if (!isBookableDate(input.date)) return 'ご指定の日付は予約を受け付けていません';
  if (!/^\d{2}:\d{2}$/.test(input.time)) return '希望時間の形式が正しくありません';
  if (!input.name) return 'お名前を入力してください';
  if (!/^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(input.email)) return 'メールアドレスの形式が正しくありません';
  if (!/^0\d{9,10}$/.test(input.tel)) return '電話番号の形式が正しくありません';
  if (!input.token) return '不正なリクエストです';
  return '';
}

function isValidDateString(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  var parts = value.split('-');
  var date = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  return date.getMonth() === Number(parts[1]) - 1;
}

/** 定休日・受付期間内かどうか */
function isBookableDate(value) {
  var parts = value.split('-');
  var target = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  if (CONFIG.CLOSED_WEEKDAYS.indexOf(target.getDay()) !== -1) return false;

  var today = new Date();
  today.setHours(0, 0, 0, 0);
  var diffDays = Math.round((target.getTime() - today.getTime()) / 86400000);
  return diffDays >= CONFIG.MIN_DAYS_AHEAD && diffDays <= CONFIG.MAX_DAYS_AHEAD;
}

/* =========================================================================
   ユーティリティ
   ========================================================================= */

function jsonResponse(object) {
  return ContentService
    .createTextOutput(JSON.stringify(object))
    .setMimeType(ContentService.MimeType.JSON);
}

function pad2(number) {
  return ('0' + number).slice(-2);
}

/** セルが日付型でも文字列でも 'YYYY-MM-DD' に揃える */
function normalizeDate(value) {
  if (value instanceof Date) return Utilities.formatDate(value, CONFIG.TIMEZONE, 'yyyy-MM-dd');
  return String(value).replace(/^'/, '').trim();
}

/** セルが時刻型でも文字列でも 'HH:mm' に揃える */
function normalizeTime(value) {
  if (value instanceof Date) return Utilities.formatDate(value, CONFIG.TIMEZONE, 'HH:mm');
  return String(value).replace(/^'/, '').trim();
}

/* =========================================================================
   初回セットアップ用（GAS エディタから1度だけ手動実行する）
   ========================================================================= */

function setup() {
  var sheet = getSheet();
  if (sheet.getLastRow() === 0) sheet.appendRow(HEADERS);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
  Logger.log('セットアップ完了: ' + CONFIG.SHEET_NAME);
}

/** 動作確認用（GAS エディタから実行してログを確認する） */
function testGetSlots() {
  var date = Utilities.formatDate(new Date(Date.now() + 2 * 86400000), CONFIG.TIMEZONE, 'yyyy-MM-dd');
  Logger.log(date + ' の空き枠: ' + JSON.stringify(getAvailableSlots(date)));
}
