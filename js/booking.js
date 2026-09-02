/**
 * 予約フォーム
 * ---------------------------------------------------------------------------
 * 二段階選択（日付 → 空き時間）＋ お客様情報入力の3STEP。
 *
 * 設計方針
 *   - 状態は state 1つに集約し、DOM への反映は render() だけが行う
 *   - 通信は request() に集約し、AbortController で10秒のタイムアウトを掛ける
 *   - config.js の GAS_URL が空のときはモック（gas/Code.gs と同じ応答）に切り替える
 *
 * 動作確認用のクエリ:
 *   ?mock=error   通信失敗
 *   ?mock=timeout タイムアウト
 *   ?mock=empty   空き枠ゼロ
 *   ?mock=conflict 二重予約（POST が conflict を返す）
 */
(function () {
  'use strict';

  var config = window.SC_CONFIG || {};
  var booking = config.BOOKING || {};
  var TIMEOUT = config.REQUEST_TIMEOUT_MS || 10000;
  var track = window.SCAnalytics ? window.SCAnalytics.push : function () {};

  var mockMode = '';
  try {
    mockMode = new URLSearchParams(window.location.search).get('mock') || '';
  } catch (e) { /* URLSearchParams 非対応は無視 */ }

  /* ====================================================================
     状態（単一オブジェクト）
     ==================================================================== */
  var state = {
    step: 1,
    selectedDate: '',
    selectedTime: '',
    slots: [],
    loading: { slots: false, submit: false },
    /** @type {{scope:string, type:string, message:string, retry:boolean}|null} */
    error: null,
    fieldErrors: {},
    submitted: false,
    reservationId: '',
    token: createToken()
  };

  var dom = {};
  var inflight = { slots: null, submit: null };

  function createToken() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return 'tk-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  /* ====================================================================
     日付・時刻のユーティリティ
     ==================================================================== */
  var WEEK = ['日', '月', '火', '水', '木', '金', '土'];

  function toISODate(date) {
    var y = date.getFullYear();
    var m = String(date.getMonth() + 1).padStart(2, '0');
    var d = String(date.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }

  function parseISODate(value) {
    var parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
    if (!parts) return null;
    var date = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
    if (date.getMonth() !== Number(parts[2]) - 1) return null;
    return date;
  }

  function formatDateJa(value) {
    var date = parseISODate(value);
    if (!date) return value;
    return date.getFullYear() + '年' + (date.getMonth() + 1) + '月' + date.getDate() + '日（' +
      WEEK[date.getDay()] + '）';
  }

  function shiftDays(days) {
    var date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() + days);
    return date;
  }

  /** 営業時間から開始時刻の一覧を作る（gas/Code.gs と同じ規則） */
  function businessSlots() {
    var open = (booking.openHour || 10) * 60;
    var close = (booking.closeHour || 21) * 60;
    var span = booking.slotMinutes || 90;
    var result = [];
    for (var t = open; t + span <= close; t += span) {
      result.push(String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'));
    }
    return result;
  }

  function isClosedDay(value) {
    var date = parseISODate(value);
    if (!date) return false;
    var closed = booking.closedWeekdays || [];
    return closed.indexOf(date.getDay()) !== -1;
  }

  /* ====================================================================
     バリデーション（純粋関数）
     ==================================================================== */
  var RE_EMAIL = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;

  function validateDate(value) {
    if (!value) return '希望日を選択してください。';
    var date = parseISODate(value);
    if (!date) return '日付の形式が正しくありません。';
    var min = shiftDays(booking.minDaysAhead == null ? 1 : booking.minDaysAhead);
    var max = shiftDays(booking.maxDaysAhead == null ? 60 : booking.maxDaysAhead);
    if (date < min) return '翌日以降の日付を選択してください。';
    if (date > max) return toISODate(max) + ' までの日付を選択してください。';
    if (isClosedDay(value)) return '水曜は定休日です。他の曜日を選択してください。';
    return '';
  }

  function validateName(value) {
    var v = (value || '').trim();
    if (!v) return 'お名前を入力してください。';
    if (v.length > 50) return 'お名前は50文字以内で入力してください。';
    return '';
  }

  function validateEmail(value) {
    var v = (value || '').trim();
    if (!v) return 'メールアドレスを入力してください。';
    if (!RE_EMAIL.test(v)) return 'メールアドレスの形式が正しくありません（例: name@example.com）。';
    return '';
  }

  function validateTel(value) {
    var v = (value || '').replace(/[-\s()＋]/g, '');
    if (!v) return '電話番号を入力してください。';
    if (!/^0\d{9,10}$/.test(v)) return 'ハイフンなしの半角数字10〜11桁で入力してください（例: 09012345678）。';
    return '';
  }

  function validateMessage(value) {
    if ((value || '').length > 1000) return 'ご相談内容は1000文字以内で入力してください。';
    return '';
  }

  /* ====================================================================
     通信（AbortController によるタイムアウト付き）
     ==================================================================== */

  /**
   * @returns {{promise:Promise<any>, abort:function}}
   */
  function request(url, options) {
    var controller = new AbortController();
    var timedOut = false;
    var timer = setTimeout(function () {
      timedOut = true;
      controller.abort();
    }, TIMEOUT);

    var opts = Object.assign({ signal: controller.signal }, options || {});
    var promise = fetch(url, opts)
      .then(function (res) {
        if (!res.ok) {
          var err = new Error('HTTP ' + res.status);
          err.code = 'network';
          throw err;
        }
        return res.json();
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') {
          var abortErr = new Error(timedOut ? 'timeout' : 'aborted');
          abortErr.code = timedOut ? 'timeout' : 'aborted';
          throw abortErr;
        }
        if (!err.code) err.code = 'network';
        throw err;
      })
      .finally(function () { clearTimeout(timer); });

    return {
      promise: promise,
      abort: function () { clearTimeout(timer); controller.abort(); }
    };
  }

  function delay(ms, signal) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(resolve, ms);
      if (signal) {
        signal.addEventListener('abort', function () {
          clearTimeout(timer);
          var err = new Error('aborted');
          err.code = 'aborted';
          reject(err);
        });
      }
    });
  }

  /* --- モック（GAS_URL 未設定時。gas/Code.gs と同じ応答を返す） --- */

  function mockBookedKey() { return 'sc_mock_bookings'; }

  function mockBooked() {
    try { return JSON.parse(sessionStorage.getItem(mockBookedKey()) || '[]'); }
    catch (e) { return []; }
  }

  function mockAddBooked(key) {
    try {
      var list = mockBooked();
      list.push(key);
      sessionStorage.setItem(mockBookedKey(), JSON.stringify(list));
    } catch (e) { /* プライベートモード等では保存しない */ }
  }

  /** 日付文字列から決定的に「埋まっている枠」を作る（読み込みごとに変わらない） */
  function hashOf(text) {
    var hash = 0;
    for (var i = 0; i < text.length; i++) {
      hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    }
    return hash;
  }

  function mockGetSlots(date) {
    var controller = new AbortController();
    var promise = delay(420, controller.signal).then(function () {
      if (mockMode === 'error') {
        var err = new Error('mock network error');
        err.code = 'network';
        throw err;
      }
      if (mockMode === 'timeout') return delay(TIMEOUT + 2000, controller.signal);
      if (mockMode === 'empty' || isClosedDay(date)) return { date: date, slots: [] };

      var all = businessSlots();
      var hash = hashOf(date);
      var booked = mockBooked();
      var open = all.filter(function (time, index) {
        if (booked.indexOf(date + ' ' + time) !== -1) return false;
        return ((hash >> index) & 1) === 1 || index % 3 === 0;
      });
      return { date: date, slots: open };
    });
    return { promise: promise, abort: function () { controller.abort(); } };
  }

  function mockPostReservation(payload) {
    var controller = new AbortController();
    var promise = delay(700, controller.signal).then(function () {
      if (mockMode === 'error') {
        var err = new Error('mock network error');
        err.code = 'network';
        throw err;
      }
      if (mockMode === 'timeout') return delay(TIMEOUT + 2000, controller.signal);

      var key = payload.date + ' ' + payload.time;
      if (mockMode === 'conflict' || mockBooked().indexOf(key) !== -1) {
        return { status: 'conflict' };
      }
      mockAddBooked(key);
      return {
        status: 'success',
        reservationId: 'R-' + payload.date.replace(/-/g, '') + '-' + payload.time.replace(':', '')
      };
    });
    return { promise: promise, abort: function () { controller.abort(); } };
  }

  /* --- 実 API / モックの切り替え --- */

  /**
   * モックにも実通信と同じ10秒のタイムアウトを掛ける。
   * （request() は内部にタイマーを持つため、こちらは mock 用のラッパー）
   */
  function withTimeout(call) {
    var timedOut = false;
    var timer = setTimeout(function () {
      timedOut = true;
      call.abort();
    }, TIMEOUT);

    var promise = call.promise.then(function (value) {
      clearTimeout(timer);
      return value;
    }, function (err) {
      clearTimeout(timer);
      if (timedOut) {
        var timeoutErr = new Error('timeout');
        timeoutErr.code = 'timeout';
        throw timeoutErr;
      }
      throw err;
    });

    return { promise: promise, abort: function () { clearTimeout(timer); call.abort(); } };
  }

  function apiGetSlots(date) {
    var url = (config.GAS_URL || '').trim();
    if (!url) return withTimeout(mockGetSlots(date));
    return request(url + (url.indexOf('?') === -1 ? '?' : '&') + 'date=' + encodeURIComponent(date), {
      method: 'GET'
    });
  }

  function apiPostReservation(payload) {
    var url = (config.GAS_URL || '').trim();
    if (!url) return withTimeout(mockPostReservation(payload));
    return request(url, {
      method: 'POST',
      // GAS の Web アプリはプリフライトを避けるため text/plain で送るのが定石
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });
  }

  /* ====================================================================
     描画
     ==================================================================== */

  function setStatus(node, kind, html) {
    if (!node) return;
    node.className = 'status' + (kind ? ' status--' + kind : '');
    node.innerHTML = html || '';
  }

  function renderSteps() {
    Array.prototype.forEach.call(dom.stepList.children, function (li) {
      if (Number(li.dataset.step) === state.step) {
        li.setAttribute('aria-current', 'step');
      } else {
        li.removeAttribute('aria-current');
      }
    });
    dom.step2.hidden = state.step < 2;
    dom.step3.hidden = state.step < 3;
    dom.form.hidden = state.submitted;
    dom.done.hidden = !state.submitted;
  }

  /**
   * 空き枠の描画。
   * 一覧の中身が変わっていないときは innerHTML を書き換えない。
   * 書き換えると選択中のラジオが作り直され、キーボード操作中のフォーカスが外れるため。
   */
  var renderedSlotsKey = null;

  function renderSlots() {
    var key = state.selectedDate + '|' + state.slots.join(',');
    if (key === renderedSlotsKey) {
      var inputs = dom.slots.querySelectorAll('input');
      Array.prototype.forEach.call(inputs, function (input) {
        input.checked = input.value === state.selectedTime;
      });
      return;
    }
    renderedSlotsKey = key;

    if (!state.slots.length) {
      dom.slots.innerHTML = '';
      return;
    }
    dom.slots.innerHTML = state.slots.map(function (time) {
      var id = 'slot-' + time.replace(':', '');
      var checked = state.selectedTime === time ? ' checked' : '';
      return '<label class="choice" for="' + id + '">' +
        '<input type="radio" id="' + id + '" name="time" value="' + time + '"' + checked + '>' +
        '<span>' + time + '</span></label>';
    }).join('');
  }

  function renderSlotsStatus() {
    if (state.loading.slots) {
      setStatus(dom.slotsStatus, 'loading', '<span class="spinner" aria-hidden="true"></span>空き枠を確認しています…');
      return;
    }
    if (state.error && state.error.scope === 'slots') {
      var retry = state.error.retry
        ? '<span class="status__retry"><button type="button" class="btn btn--ghost btn--small" id="retry-slots">もう一度試す</button></span>'
        : '';
      setStatus(dom.slotsStatus, state.error.type === 'empty' ? 'empty' : 'error',
        state.error.message + retry);
      return;
    }
    setStatus(dom.slotsStatus, '', '');
  }

  function renderFieldErrors() {
    var map = {
      date: [dom.date, dom.dateError],
      name: [dom.name, dom.nameError],
      email: [dom.email, dom.emailError],
      tel: [dom.tel, dom.telError],
      message: [dom.message, dom.messageError],
      time: [null, dom.timeError]
    };
    Object.keys(map).forEach(function (key) {
      var input = map[key][0];
      var output = map[key][1];
      var message = state.fieldErrors[key] || '';
      if (output) output.textContent = message;
      if (input) {
        if (message) input.setAttribute('aria-invalid', 'true');
        else input.removeAttribute('aria-invalid');
      }
    });
  }

  function renderSummary() {
    if (!state.selectedDate || !state.selectedTime) return;
    dom.summary.innerHTML = 'ご希望：<b>' + formatDateJa(state.selectedDate) + ' ' +
      state.selectedTime + '〜</b>（60分／体験トレーニング込み）';
  }

  function renderSubmit() {
    dom.submit.disabled = state.loading.submit;
    dom.submit.textContent = state.loading.submit ? '送信しています…' : 'この内容で予約する';
    if (state.loading.submit) {
      setStatus(dom.submitStatus, 'loading', '<span class="spinner" aria-hidden="true"></span>予約を送信しています。画面を閉じずにお待ちください。');
    } else if (state.error && state.error.scope === 'submit') {
      var retry = state.error.type === 'conflict'
        ? '<span class="status__retry"><button type="button" class="btn btn--ghost btn--small" id="pick-other-time">別の時間を選ぶ</button></span>'
        : '';
      setStatus(dom.submitStatus, 'error', state.error.message + retry);
    } else if (state.error && state.error.scope === 'validation') {
      setStatus(dom.submitStatus, 'error', state.error.message);
    } else {
      setStatus(dom.submitStatus, '', '');
    }
  }

  function renderDone() {
    if (!state.submitted) return;
    dom.doneDetail.textContent = formatDateJa(state.selectedDate) + ' ' + state.selectedTime +
      '〜（60分）でお待ちしています。当日は動きやすい服装でお越しください。着替えとシューズはご用意があります。';
    dom.doneId.textContent = '予約番号　' + state.reservationId;
  }

  function render() {
    renderSteps();
    renderSlots();
    renderSlotsStatus();
    renderFieldErrors();
    renderSummary();
    renderSubmit();
    renderDone();
  }

  /** 新しく現れた領域へフォーカスを移す */
  function focusStep(step) {
    var target = document.getElementById('step-' + step + '-title');
    if (target) target.focus();
  }

  function goToStep(step) {
    if (state.step === step) return;
    state.step = step;
    render();
    track('form_step', { step: step });
    focusStep(step);
  }

  function setError(scope, type, message, retry) {
    state.error = { scope: scope, type: type, message: message, retry: retry !== false };
    track('form_error', { type: type });
  }

  /* ====================================================================
     操作
     ==================================================================== */

  function loadSlots(date) {
    if (inflight.slots) inflight.slots.abort();
    state.loading.slots = true;
    state.error = null;
    state.slots = [];
    state.selectedTime = '';
    state.fieldErrors.time = '';
    if (state.step > 1) state.step = 1;
    render();

    var call = apiGetSlots(date);
    inflight.slots = call;

    call.promise.then(function (data) {
      if (inflight.slots !== call) return; // 後発のリクエストに置き換わっている
      state.loading.slots = false;
      state.slots = (data && Array.isArray(data.slots)) ? data.slots : [];
      if (!state.slots.length) {
        setError('slots', 'empty',
          isClosedDay(date)
            ? 'この日は定休日のため、ご予約を承っていません。他の日付をお選びください。'
            : 'この日はすべての枠が埋まっています。別の日付をお選びください。',
          false);
        render();
        return;
      }
      render();
      goToStep(2);
    }).catch(function (err) {
      if (inflight.slots !== call) return;
      if (err && err.code === 'aborted') return;
      state.loading.slots = false;
      if (err && err.code === 'timeout') {
        setError('slots', 'timeout', '通信に時間がかかっています（10秒で中断しました）。電波状況をご確認のうえ、もう一度お試しください。');
      } else {
        setError('slots', 'network', '空き枠を取得できませんでした。通信環境をご確認のうえ、もう一度お試しください。');
      }
      render();
    });
  }

  function onDateChange() {
    var value = dom.date.value;
    state.selectedDate = value;
    var message = validateDate(value);
    state.fieldErrors.date = message;
    if (message) {
      state.error = null;
      state.slots = [];
      state.step = 1;
      track('form_error', { type: 'validation' });
      render();
      return;
    }
    render();
    loadSlots(value);
  }

  function onSlotChange(ev) {
    if (ev.target.name !== 'time') return;
    state.selectedTime = ev.target.value;
    state.fieldErrors.time = '';
    render();
  }

  function validateStep3() {
    state.fieldErrors.name = validateName(dom.name.value);
    state.fieldErrors.email = validateEmail(dom.email.value);
    state.fieldErrors.tel = validateTel(dom.tel.value);
    state.fieldErrors.message = validateMessage(dom.message.value);
    var order = ['name', 'email', 'tel', 'message'];
    for (var i = 0; i < order.length; i++) {
      if (state.fieldErrors[order[i]]) return order[i];
    }
    return '';
  }

  function onSubmit(ev) {
    ev.preventDefault();
    if (state.loading.submit) return; // 二重送信防止（ボタン無効化に加えた保険）

    var firstInvalid = validateStep3();
    if (firstInvalid) {
      setError('validation', 'validation', '入力内容をご確認ください。誤りのある項目に印を付けています。');
      render();
      dom[firstInvalid].focus();
      return;
    }
    if (!state.selectedDate || !state.selectedTime) {
      setError('validation', 'validation', '日付と時間を選び直してください。');
      render();
      return;
    }

    state.loading.submit = true;
    state.error = null;
    render();

    var payload = {
      date: state.selectedDate,
      time: state.selectedTime,
      name: dom.name.value.trim(),
      email: dom.email.value.trim(),
      tel: dom.tel.value.replace(/[-\s()＋]/g, ''),
      message: dom.message.value.trim(),
      token: state.token
    };

    var call = apiPostReservation(payload);
    inflight.submit = call;

    call.promise.then(function (data) {
      state.loading.submit = false;
      if (data && data.status === 'conflict') {
        setError('submit', 'conflict', 'ちょうどこの枠が埋まってしまいました。お手数ですが別の時間をお選びください。');
        render();
        return;
      }
      if (!data || data.status !== 'success') {
        setError('submit', 'network', '予約を確定できませんでした。時間をおいて、もう一度お試しください。');
        render();
        return;
      }
      state.submitted = true;
      state.reservationId = data.reservationId || '';
      state.error = null;
      render();
      track('form_submit', { date: state.selectedDate, time: state.selectedTime });
      var doneTitle = document.getElementById('booking-done-title');
      if (doneTitle) doneTitle.focus();
    }).catch(function (err) {
      state.loading.submit = false;
      if (err && err.code === 'aborted') return;
      if (err && err.code === 'timeout') {
        setError('submit', 'timeout', '送信に時間がかかっています（10秒で中断しました）。二重予約を避けるため、まだ送信は確定していません。もう一度お試しください。');
      } else {
        setError('submit', 'network', '送信に失敗しました。通信環境をご確認のうえ、もう一度お試しください。');
      }
      render();
    });
  }

  /* ====================================================================
     初期化
     ==================================================================== */

  function collect() {
    dom.form = document.getElementById('booking-form');
    dom.stepList = document.getElementById('booking-steps');
    dom.step2 = document.getElementById('step-2');
    dom.step3 = document.getElementById('step-3');
    dom.date = document.getElementById('booking-date');
    dom.dateError = document.getElementById('booking-date-error');
    dom.slots = document.getElementById('slots');
    dom.slotsStatus = document.getElementById('slots-status');
    dom.timeError = document.getElementById('booking-time-error');
    dom.name = document.getElementById('booking-name');
    dom.nameError = document.getElementById('booking-name-error');
    dom.email = document.getElementById('booking-email');
    dom.emailError = document.getElementById('booking-email-error');
    dom.tel = document.getElementById('booking-tel');
    dom.telError = document.getElementById('booking-tel-error');
    dom.message = document.getElementById('booking-message');
    dom.messageError = document.getElementById('booking-message-error');
    dom.summary = document.getElementById('booking-summary');
    dom.submit = document.getElementById('booking-submit');
    dom.submitStatus = document.getElementById('submit-status');
    dom.done = document.getElementById('booking-done');
    dom.doneDetail = document.getElementById('booking-done-detail');
    dom.doneId = document.getElementById('booking-done-id');
    return !!(dom.form && dom.date && dom.slots && dom.submit);
  }

  function init() {
    if (!collect()) return;

    var min = shiftDays(booking.minDaysAhead == null ? 1 : booking.minDaysAhead);
    var max = shiftDays(booking.maxDaysAhead == null ? 60 : booking.maxDaysAhead);
    dom.date.min = toISODate(min);
    dom.date.max = toISODate(max);

    dom.date.addEventListener('change', onDateChange);
    dom.slots.addEventListener('change', onSlotChange);
    dom.form.addEventListener('submit', onSubmit);

    document.getElementById('to-step-3').addEventListener('click', function () {
      if (!state.selectedTime) {
        state.fieldErrors.time = '希望時間を選択してください。';
        track('form_error', { type: 'validation' });
        render();
        var first = dom.slots.querySelector('input');
        if (first) first.focus();
        return;
      }
      state.fieldErrors.time = '';
      goToStep(3);
    });

    document.getElementById('back-to-step-1').addEventListener('click', function () {
      state.step = 1;
      state.selectedTime = '';
      render();
      dom.date.focus();
      track('form_step', { step: 1 });
    });

    document.getElementById('back-to-step-2').addEventListener('click', function () {
      state.step = 2;
      state.error = null;
      render();
      focusStep(2);
      track('form_step', { step: 2 });
    });

    // 再試行 / 別の時間を選ぶ（描画のたびに要素が作り直されるため委譲で拾う）
    document.addEventListener('click', function (ev) {
      if (!ev.target.id) return;
      if (ev.target.id === 'retry-slots' && state.selectedDate) {
        loadSlots(state.selectedDate);
      }
      if (ev.target.id === 'pick-other-time' && state.selectedDate) {
        state.error = null;
        state.step = 2;
        render();
        loadSlots(state.selectedDate);
      }
    });

    // 入力中の再検証（エラー表示後のみ。入力の途中で赤くしない）
    [['name', validateName], ['email', validateEmail], ['tel', validateTel]].forEach(function (pair) {
      dom[pair[0]].addEventListener('blur', function () {
        if (!state.fieldErrors[pair[0]]) return;
        state.fieldErrors[pair[0]] = pair[1](dom[pair[0]].value);
        render();
      });
    });

    // 初期状態（STEP1 のみ表示・エラーなし）は index.html の初期マークアップと
    // 一致しているため、ここでの render() は不要。読み込み時の余計な再レイアウトを避ける。
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
