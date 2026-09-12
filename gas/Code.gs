/**
 * STUDIO CORE - 予約 API（Google Apps Script Web アプリ）
 * ---------------------------------------------------------------------------
 * GET  {GAS_URL}?date=2026-09-15
 *      -> { "date": "2026-09-15", "slots": ["10:00","11:30","14:30"] }
 *
 * POST {GAS_URL}
 *      body: { date, time, name, email, tel, message, token,
 *              turnstileToken, company_url, elapsed }
 *      -> { "status": "success", "reservationId": "R-20260915-1030" }
 *      -> { "status": "conflict" }                  同一枠が既に埋まっている
 *      -> { "status": "error", "message": "..." }   スパム判定・入力不正・サーバーエラー
 *                                                    （判定理由は攻撃者へ返さず、常に同じ文言にする）
 *
 * スパム対策（doPost 内で次の順に検証。失敗したら以降を評価せず同じ理由で拒否する）
 *   1. JSON パースに失敗                    → 破棄
 *   2. ハニーポット（company_url）が非空     → 破棄
 *   3. elapsed が 3秒未満 / 1時間超          → 破棄
 *   4. 氏名・メール・電話・備考の形式/文字数 → 破棄
 *   5. Cloudflare Turnstile のトークン検証   → 破棄（hostname 検証込み）
 *   6. 当日の受付件数が上限（100件）に到達   → 破棄（初回のみ管理者へ通知）
 *   7. 同一枠の二重予約                      → { "status": "conflict" } を返す
 * 上記 1〜6 のどれで拒否されたかは Logger.log にのみ残し、レスポンスには出さない。
 *
 * メール通知は2系統。予約者本人へは appendReservation 直後に確認メールを即時送信し、
 * 管理者へは即時送信せず、時間主導トリガーで notifyPendingReservations() を1日1回実行して
 * 未通知分をまとめて1通で送る（MailApp の1日あたり送信上限を踏まえた設計。下記参照）。
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

  /**
   * 通知メールの送り先。空のままだと notifyPendingReservations() と
   * 日次上限到達の通知は送信をスキップし、Logger.log にのみ記録する。
   */
  MAIL_TO_ADMIN: '',

  /**
   * Turnstile の siteverify が返す hostname の期待値。
   * 本番ドメイン以外（localhost 等）からのトークンは本番では許可しない。
   */
  TURNSTILE_EXPECTED_HOSTNAME: 'wada3333.github.io',

  /** ページ表示から送信までの許容時間（ミリ秒）。速すぎる=bot、遅すぎる=リプレイの疑い。 */
  MIN_ELAPSED_MS: 3000,
  MAX_ELAPSED_MS: 3600000,

  /**
   * 1日あたりの受付上限。到達したらその日は受付を停止し、管理者へ1回だけ通知する。
   * MailApp（Gmail）の送信上限は1日100通。顧客への即時確認メール（最大でこの件数分）＋
   * 管理者へのまとめ通知1通で、上限の半分（50通）に収まるようにしている。
   */
  DAILY_LIMIT: 50
};

var HEADERS = ['受付日時', '予約番号', '希望日', '希望時間', '氏名', 'メール', '電話', '相談内容', 'token', 'ステータス', '通知済み'];

/** 判定理由を問わず常に同じ文言を返す（攻撃者に判定理由を教えないため）。 */
var GENERIC_ERROR_MESSAGE = 'ただいま予約を受け付けられません。時間をおいて再度お試しください。';

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
    // 同時POSTによる二重予約・日次カウンタの競合を防ぐため、書き込み全体をロックで囲む
    lock.waitLock(10000);
  } catch (err) {
    return jsonResponse({ status: 'error', message: '混み合っています。少し時間をおいてお試しください' });
  }

  try {
    // 1. JSON パース（失敗したら破棄。フォーム形式へのフォールバックはしない）
    var raw = (e && e.postData && e.postData.contents) || '';
    var body;
    try {
      body = JSON.parse(raw);
    } catch (err) {
      return rejectSpam('JSONパース失敗');
    }
    if (!body || typeof body !== 'object') return rejectSpam('body が object ではない');

    // 2. ハニーポット（company_url）。人間なら空のまま送られてくるはずの項目
    if (body.company_url) return rejectSpam('ハニーポット検知: ' + String(body.company_url).slice(0, 100));

    // 3. ページ表示からの経過時間
    var elapsed = Number(body.elapsed);
    if (!isFinite(elapsed) || elapsed < CONFIG.MIN_ELAPSED_MS || elapsed > CONFIG.MAX_ELAPSED_MS) {
      return rejectSpam('elapsed 範囲外: ' + body.elapsed);
    }

    // 4. 項目の検証・サニタイズ（サニタイズは数式インジェクション対策も兼ねる）
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
    if (invalid) return rejectSpam('入力検証NG: ' + invalid);

    // 5. Cloudflare Turnstile 検証（hostname 検証込み）
    var turnstileToken = sanitize(body.turnstileToken, 2048);
    if (!verifyTurnstile(turnstileToken)) {
      return rejectSpam('Turnstile 検証失敗');
    }

    // 6. 日次受付上限。上限到達時は受付を止め、その日最初の到達時だけ管理者へ通知する
    if (!checkAndIncrementDailyCount()) {
      return rejectSpam('日次受付上限（' + CONFIG.DAILY_LIMIT + '件）に到達');
    }

    // 7. 同一枠の二重予約チェック（この時点まで来た＝スパム判定は通過しているので
    //    conflict は通常のビジネスロジックとして具体的なステータスを返してよい）
    if (isSlotTaken(input.date, input.time)) {
      return jsonResponse({ status: 'conflict' });
    }

    var reservationId = buildReservationId(input.date, input.time);
    appendReservation(reservationId, input);
    sendConfirmationEmail(reservationId, input);

    return jsonResponse({ status: 'success', reservationId: reservationId });
  } catch (err) {
    Logger.log('[spam-guard] 予期しないエラー: ' + err);
    return jsonResponse({ status: 'error', message: GENERIC_ERROR_MESSAGE });
  } finally {
    lock.releaseLock();
  }
}

/**
 * スパム/不正入力と判定してリクエストを拒否する。
 * 判定理由は Logger.log にのみ残し、レスポンスは常に同じ汎用文言にする
 * （具体的な理由を返すと、攻撃者が検証ロジックを逆算する材料になるため）。
 */
function rejectSpam(reason) {
  Logger.log('[spam-guard] 受付を拒否しました: ' + reason);
  return jsonResponse({ status: 'error', message: GENERIC_ERROR_MESSAGE });
}

/* =========================================================================
   スパム対策
   ========================================================================= */

/**
 * Cloudflare Turnstile のトークンをサーバー側で検証する。
 * シークレットはスクリプトプロパティ TURNSTILE_SECRET から取得する（コードに書かない）。
 * hostname が本番ドメインと一致するかも確認する（localhost 等のトークンは本番で拒否）。
 * 設定手順は README.md「GAS側のセットアップ」を参照。
 */
function verifyTurnstile(token) {
  if (!token) return false;

  var secret = PropertiesService.getScriptProperties().getProperty('TURNSTILE_SECRET');
  if (!secret) {
    Logger.log('[spam-guard] スクリプトプロパティ TURNSTILE_SECRET が未設定です');
    return false; // 未設定は fail-closed（受け付けない）
  }

  try {
    var res = UrlFetchApp.fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'post',
      contentType: 'application/x-www-form-urlencoded',
      payload: { secret: secret, response: token },
      muteHttpExceptions: true
    });
    var result = JSON.parse(res.getContentText());

    if (result.success !== true) {
      Logger.log('[spam-guard] Turnstile 検証失敗: ' + JSON.stringify(result['error-codes'] || result));
      return false;
    }
    if (result.hostname !== CONFIG.TURNSTILE_EXPECTED_HOSTNAME) {
      Logger.log('[spam-guard] Turnstile hostname 不一致: ' + result.hostname);
      return false;
    }
    return true;
  } catch (err) {
    Logger.log('[spam-guard] Turnstile 検証中に例外: ' + err);
    return false;
  }
}

/**
 * 1日あたりの受付件数を数え、上限に達していないかを確認する。
 * この関数は doPost() のロック内から呼ばれるため、確認と加算がアトミックに行われる。
 * 上限に達した日は、最初にそれを検知したリクエストのときだけ管理者へ通知する
 * （スクリプトプロパティに通知済みフラグを立てて多重送信を防ぐ）。
 * @returns {boolean} 受け付けてよければ true（このとき件数を1加算している）
 */
function checkAndIncrementDailyCount() {
  var props = PropertiesService.getScriptProperties();
  var dateKey = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
  var countKey = 'RESERVATION_COUNT_' + dateKey;
  var notifiedKey = 'RESERVATION_LIMIT_NOTIFIED_' + dateKey;

  var current = Number(props.getProperty(countKey) || '0');
  if (current >= CONFIG.DAILY_LIMIT) {
    if (!props.getProperty(notifiedKey)) {
      props.setProperty(notifiedKey, '1');
      notifyDailyLimitReached(dateKey, current);
    }
    return false;
  }

  props.setProperty(countKey, String(current + 1));
  return true;
}

/** 日次上限に到達したことを管理者へ1通だけ通知する。 */
function notifyDailyLimitReached(dateKey, count) {
  if (!CONFIG.MAIL_TO_ADMIN) {
    Logger.log('[spam-guard] MAIL_TO_ADMIN 未設定のため上限到達を通知できません（' + dateKey + '）');
    return;
  }
  try {
    MailApp.sendEmail(
      CONFIG.MAIL_TO_ADMIN,
      '[STUDIO CORE] 本日の予約受付上限（' + CONFIG.DAILY_LIMIT + '件）に達しました',
      dateKey + ' の受付件数が上限の ' + CONFIG.DAILY_LIMIT + ' 件に達したため、' +
      'これ以降の予約受付を停止しています。\n' +
      'スプレッドシートで状況をご確認ください。'
    );
  } catch (err) {
    Logger.log('[spam-guard] 上限到達の通知メール送信に失敗: ' + err);
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
    '受付',
    '' // 通知済み（空 = 未通知。notifyPendingReservations() が送信後にタイムスタンプを入れる）
  ]);
}

function buildReservationId(date, time) {
  return 'R-' + date.replace(/-/g, '') + '-' + time.replace(':', '');
}

/**
 * 予約者本人へ確認メールを即時送信する（管理者への通知は別途 notifyPendingReservations で
 * まとめて送る。こちらは顧客体験のため即時にしている）。
 * 送信に失敗しても予約自体は成立しているので、例外は投げずログにのみ残す
 * （ここで例外を投げると、doPost の外側 catch が success を error にすり替えてしまう）。
 */
function sendConfirmationEmail(reservationId, input) {
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

  try {
    MailApp.sendEmail(input.email, subject, body);
  } catch (err) {
    Logger.log('[mail] 確認メール送信に失敗（' + reservationId + '）: ' + err);
  }
}

/* =========================================================================
   管理者への通知メール（1日1回の digest）
   ---------------------------------------------------------------------
   予約者本人への確認メールは sendConfirmationEmail() で即時送信するが、
   管理者への通知はまとめて1日1回にしている。理由は主に2つ:
     - スパムがすり抜けた場合に大量の即時メールが管理者に飛ぶのを避ける
     - MailApp の1日あたり送信数クォータ（Gmailは100通）を圧迫しない。
       DAILY_LIMIT（顧客への即時確認メールの上限）を50件にしているのは、
       これに管理者へのまとめ通知1通を足しても上限の半分に収まるようにするため
   シートの「通知済み」列を見て、未通知の行だけをまとめて1通のメールで送る。
   時間主導トリガーで1日1回実行する想定（トリガーの設定手順は README.md を参照。
   installNotifyTrigger() でコードから設定することもできる）。
   ========================================================================= */

/**
 * 未通知の予約をまとめて1通のメールで管理者へ送る。
 * 送信できた行だけ「通知済み」列にタイムスタンプを入れる
 * （メール送信に失敗した行は次回また対象になる）。
 */
function notifyPendingReservations() {
  var sheet = getSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (err) {
    Logger.log('[notify] ロック取得に失敗したため今回はスキップします: ' + err);
    return;
  }

  try {
    var range = sheet.getRange(2, 1, lastRow - 1, HEADERS.length);
    var values = range.getValues();

    var notifiedIndex = HEADERS.indexOf('通知済み');
    var idIndex = HEADERS.indexOf('予約番号');
    var dateIndex = HEADERS.indexOf('希望日');
    var timeIndex = HEADERS.indexOf('希望時間');
    var nameIndex = HEADERS.indexOf('氏名');
    var emailIndex = HEADERS.indexOf('メール');
    var telIndex = HEADERS.indexOf('電話');
    var msgIndex = HEADERS.indexOf('相談内容');

    var pendingRowNumbers = []; // シート上の行番号（1始まり）
    var lines = [];

    for (var i = 0; i < values.length; i++) {
      var row = values[i];
      if (row[notifiedIndex]) continue; // 既に通知済み
      if (!row[idIndex]) continue; // 空行はスキップ

      pendingRowNumbers.push(2 + i);
      lines.push(
        '・' + normalizeDate(row[dateIndex]) + ' ' + normalizeTime(row[timeIndex]) + '〜　' +
        row[nameIndex] + '様（' + row[idIndex] + '）\n' +
        '  メール: ' + row[emailIndex] + ' / 電話: ' + String(row[telIndex]).replace(/^'/, '') +
        (row[msgIndex] ? '\n  相談内容: ' + row[msgIndex] : '')
      );
    }

    if (!pendingRowNumbers.length) {
      Logger.log('[notify] 未通知の予約はありません');
      return;
    }

    if (!CONFIG.MAIL_TO_ADMIN) {
      Logger.log('[notify] MAIL_TO_ADMIN が未設定のため送信できません（' +
        pendingRowNumbers.length + '件が未通知のままです）');
      return;
    }

    var subject = '[STUDIO CORE] 新規予約 ' + pendingRowNumbers.length + '件（' +
      Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd') + '）';
    var body = '以下の予約を受け付けました。\n\n' + lines.join('\n\n');

    MailApp.sendEmail(CONFIG.MAIL_TO_ADMIN, subject, body);

    var now = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
    pendingRowNumbers.forEach(function (rowNum) {
      sheet.getRange(rowNum, notifiedIndex + 1).setValue(now);
    });

    Logger.log('[notify] ' + pendingRowNumbers.length + '件を通知しました');
  } catch (err) {
    Logger.log('[notify] 通知処理中にエラー: ' + err);
  } finally {
    lock.releaseLock();
  }
}

/**
 * notifyPendingReservations() を1日1回実行する時間主導トリガーを設定する。
 * 既存の同名トリガーは一度削除してから作り直すため、何度実行しても重複しない。
 * GAS エディタからこの関数を1度だけ実行すればよい（Triggers 画面からの手動設定でも可）。
 */
function installNotifyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'notifyPendingReservations') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  ScriptApp.newTrigger('notifyPendingReservations')
    .timeBased()
    .everyDays(1)
    .atHour(9) // 毎朝9時台に実行（実行時刻は±15分程度前後することがある）
    .create();
  Logger.log('notifyPendingReservations の日次トリガーを設定しました（毎朝9時台）');
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

/** 動作確認用：本日の受付件数と上限を確認する（GAS エディタから実行） */
function debugDailyCount() {
  var props = PropertiesService.getScriptProperties();
  var dateKey = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
  var current = props.getProperty('RESERVATION_COUNT_' + dateKey) || '0';
  Logger.log(dateKey + ' の受付件数: ' + current + ' / 上限 ' + CONFIG.DAILY_LIMIT);
}

/** 動作確認用：本日の受付カウンタと上限到達の通知済みフラグをリセットする（GAS エディタから実行） */
function resetDailyCount() {
  var props = PropertiesService.getScriptProperties();
  var dateKey = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
  props.deleteProperty('RESERVATION_COUNT_' + dateKey);
  props.deleteProperty('RESERVATION_LIMIT_NOTIFIED_' + dateKey);
  Logger.log(dateKey + ' のカウンタをリセットしました');
}

/**
 * 動作確認用：TURNSTILE_SECRET が設定されているか、siteverify がダミートークンを
 * 正しく「失敗」判定するかを確認する（GAS エディタから実行）。
 * ダミートークンなので success:false が返るのが正常。
 */
function testTurnstileSecretConfigured() {
  var secret = PropertiesService.getScriptProperties().getProperty('TURNSTILE_SECRET');
  if (!secret) {
    Logger.log('TURNSTILE_SECRET が未設定です。スクリプトプロパティに設定してください。');
    return;
  }
  var ok = verifyTurnstile('dummy-token-for-manual-check');
  Logger.log('TURNSTILE_SECRET は設定済みです。ダミートークンでの検証結果（false が正常）: ' + ok);
}
