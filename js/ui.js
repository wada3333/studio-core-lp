/**
 * UI - 料金シミュレーターの描画・追従CTA・その他の細かい挙動
 * ---------------------------------------------------------------------------
 * 計算は js/simulator.js（純粋関数）に任せ、ここでは DOM だけを扱います。
 */
(function () {
  'use strict';

  var track = window.SCAnalytics ? window.SCAnalytics.push : function () {};

  /* ======================================================================
     料金シミュレーター
     ====================================================================== */

  var simState = {
    plans: null,
    frequency: 2,
    months: 3,
    options: [],
    joinOnCounselingDay: true
  };

  var el = {};

  function collectSimElements() {
    el.form = document.getElementById('sim-form');
    el.frequency = document.getElementById('sim-frequency');
    el.months = document.getElementById('sim-months');
    el.options = document.getElementById('sim-options');
    el.waiver = document.getElementById('sim-waiver');
    el.planName = document.getElementById('sim-plan-name');
    el.rows = document.getElementById('sim-rows');
    el.monthly = document.getElementById('sim-monthly');
    el.sub = document.getElementById('sim-sub');
    return !!(el.form && el.frequency && el.months && el.rows);
  }

  /** ラジオ（週回数・期間）を plans.json から組み立てる */
  function buildChoices(container, name, items, valueKey, checkedValue) {
    var html = items.map(function (item, index) {
      var value = item[valueKey];
      var id = name + '-' + value;
      var checked = value === checkedValue ? ' checked' : '';
      return '<label class="choice" for="' + id + '">' +
        '<input type="radio" id="' + id + '" name="' + name + '" value="' + value + '"' + checked + '>' +
        '<span>' + item.label + '</span></label>';
    }).join('');
    container.innerHTML = html;
  }

  function buildOptions(container, options) {
    container.innerHTML = options.map(function (opt) {
      var id = 'sim-opt-' + opt.id;
      return '<label class="check" for="' + id + '">' +
        '<input type="checkbox" id="' + id + '" name="options" value="' + opt.id + '">' +
        '<span>' + opt.label + ' ＋' + SCSimulator.formatYen(opt.monthly) + '円/月' +
        '<small>' + opt.note + '</small></span></label>';
    }).join('');
  }

  function row(label, value) {
    return '<div class="receipt__row"><dt>' + label + '</dt><dd>' + value + '</dd></div>';
  }

  /** 計算結果を伝票として描画する（描画のみ。計算はしない） */
  function renderReceipt(result) {
    el.planName.textContent = result.matchedPlan
      ? result.matchedPlan.name + '（' + result.frequencyLabel + '・' + result.termLabel + '）'
      : 'カスタム（' + result.frequencyLabel + '・' + result.termLabel + '）';

    var rows = '';
    rows += row('基準月額', SCSimulator.formatYen(result.baseMonthly) + ' 円');
    if (result.totalDiscountRate > 0) {
      rows += row('継続割引 ' + SCSimulator.formatRate(result.totalDiscountRate),
        '−' + SCSimulator.formatYen(result.discountAmountMonthly) + ' 円');
    }
    rows += row('プラン月額', SCSimulator.formatYen(result.planMonthly) + ' 円');
    result.optionsBreakdown.forEach(function (opt) {
      rows += row(opt.label, '＋' + SCSimulator.formatYen(opt.monthly) + ' 円');
    });
    rows += row('月あたり回数', result.sessionsPerMonth + ' 回');
    rows += row('1回あたり', SCSimulator.formatYen(result.sessionUnitPrice) + ' 円');
    rows += row('入会金', result.enrollmentFeeWaived
      ? '0 円（無料）'
      : SCSimulator.formatYen(result.enrollmentFee) + ' 円');
    el.rows.innerHTML = rows;

    el.monthly.textContent = SCSimulator.formatYen(result.monthlyTotal);
    el.sub.textContent = result.termLabel + 'の総額 ' + SCSimulator.formatYen(result.grandTotal) +
      ' 円（全' + result.sessionsTotal + '回' +
      (result.enrollmentFeeWaived ? '・入会金無料' : '・入会金込み') + '）';
  }

  function recalcAndRender(fromUserInput) {
    if (!simState.plans) return;
    var result;
    try {
      result = SCSimulator.calculate(simState.plans, {
        frequency: simState.frequency,
        months: simState.months,
        options: simState.options,
        joinOnCounselingDay: simState.joinOnCounselingDay
      });
    } catch (err) {
      el.sub.textContent = '選択内容を計算できませんでした。組み合わせを選び直してください。';
      return;
    }
    renderReceipt(result);
    if (fromUserInput) {
      track('simulator_use', {
        frequency: simState.frequency,
        months: simState.months,
        options: simState.options.join(',') || 'none'
      });
    }
  }

  function bindSimEvents() {
    el.form.addEventListener('change', function (ev) {
      var target = ev.target;
      if (target.name === 'frequency') {
        simState.frequency = Number(target.value);
      } else if (target.name === 'months') {
        simState.months = Number(target.value);
      } else if (target.name === 'options') {
        var checked = el.options.querySelectorAll('input[name="options"]:checked');
        simState.options = Array.prototype.map.call(checked, function (i) { return i.value; });
      } else if (target.name === 'waiver') {
        simState.joinOnCounselingDay = target.checked;
      } else {
        return;
      }
      recalcAndRender(true);
    });
  }

  function initSimulator() {
    if (!collectSimElements()) return;

    fetch('data/plans.json', { cache: 'force-cache' })
      .then(function (res) {
        if (!res.ok) throw new Error('plans.json の取得に失敗しました');
        return res.json();
      })
      .then(function (plans) {
        simState.plans = plans;
        // 予約フォーム側でも料金定義を使えるように共有する
        window.SC_PLANS = plans;
        buildChoices(el.frequency, 'frequency', plans.frequencies, 'value', simState.frequency);
        buildChoices(el.months, 'months', plans.terms, 'months', simState.months);
        buildOptions(el.options, plans.options);
        simState.joinOnCounselingDay = el.waiver ? el.waiver.checked : true;
        bindSimEvents();
        recalcAndRender(false);
      })
      .catch(function () {
        el.sub.textContent = '料金データを読み込めませんでした。お手数ですがページを再読み込みしてください。';
      });
  }

  /* ======================================================================
     追従CTA（ヒーローを抜けたら表示、予約フォーム到達で非表示）
     ====================================================================== */

  function initStickyCta() {
    var cta = document.getElementById('sticky-cta');
    var hero = document.querySelector('.hero');
    var booking = document.getElementById('booking');
    if (!cta || !hero || !booking) return;

    if (!('IntersectionObserver' in window)) {
      // 非対応環境では常時表示（機能を落とさない）
      cta.classList.add('is-visible');
      cta.removeAttribute('inert');
      return;
    }

    var state = { pastHero: false, atBooking: false };

    function apply() {
      var show = state.pastHero && !state.atBooking;
      cta.classList.toggle('is-visible', show);
      // inert でキーボードフォーカスと支援技術から外す（aria-hidden とフォーカス可能要素の同居を避ける）
      if (show) {
        cta.removeAttribute('inert');
      } else {
        cta.setAttribute('inert', '');
      }
    }

    new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        state.pastHero = !entry.isIntersecting && entry.boundingClientRect.top < 0;
        apply();
      });
    }, { threshold: 0 }).observe(hero);

    new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        state.atBooking = entry.isIntersecting;
        apply();
      });
    }, { threshold: 0 }).observe(booking);
  }

  /* ======================================================================
     その他
     ====================================================================== */

  /**
   * ヒーロー背景動画
   * -------------------------------------------------------------------
   * 静止画（hero.webp）は常に敷いたままにし、動画は条件を満たすときだけ
   * あとから生成して重ねる。HTML に <video> を書かないことで、
   * モバイルと prefers-reduced-motion の環境では1バイトも読み込まない。
   *   - 読み込み開始は window の load 後（LCP を妨げないため）
   *   - 幅 48em 未満（モバイル）では読み込まない
   *   - prefers-reduced-motion: reduce では読み込まない／再生中なら破棄する
   */
  function initHeroVideo() {
    var media = document.querySelector('.hero__media');
    if (!media) return;

    var src = media.getAttribute('data-video');
    var poster = media.getAttribute('data-poster');
    if (!src) return;

    var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    var wide = window.matchMedia('(min-width: 48em)');
    var video = null;

    function allowed() {
      return wide.matches && !reduce.matches;
    }

    function mount() {
      if (video || !allowed()) return;
      video = document.createElement('video');
      video.className = 'hero__video';
      // 属性とプロパティの両方を立てる（iOS Safari は属性を見る）
      video.muted = true;
      video.defaultMuted = true;
      video.setAttribute('muted', '');
      video.setAttribute('playsinline', '');
      video.setAttribute('loop', '');
      video.setAttribute('autoplay', '');
      video.setAttribute('aria-hidden', 'true');
      if (poster) video.setAttribute('poster', poster);
      video.preload = 'auto';
      video.addEventListener('playing', function () {
        media.classList.add('is-playing');
      }, { once: true });
      video.src = src;
      media.appendChild(video);
      var played = video.play();
      // 自動再生が拒否された場合は静止画のままにする
      if (played && played.catch) played.catch(function () { unmount(); });
    }

    function unmount() {
      if (!video) return;
      media.classList.remove('is-playing');
      video.pause();
      video.removeAttribute('src');
      video.load(); // 進行中のダウンロードを止める
      if (video.parentNode) video.parentNode.removeChild(video);
      video = null;
    }

    function update() {
      if (allowed()) mount();
      else unmount();
    }

    function later() {
      if (window.requestIdleCallback) window.requestIdleCallback(update, { timeout: 1500 });
      else window.setTimeout(update, 300);
    }

    if (document.readyState === 'complete') later();
    else window.addEventListener('load', later, { once: true });

    if (reduce.addEventListener) reduce.addEventListener('change', update);
    if (wide.addEventListener) wide.addEventListener('change', update);
  }

  /** ページ内リンクのスムーススクロール（prefers-reduced-motion を尊重） */
  function initSmoothScroll() {
    var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    function apply() {
      document.documentElement.style.scrollBehavior = reduce.matches ? 'auto' : 'smooth';
    }
    apply();
    if (reduce.addEventListener) reduce.addEventListener('change', apply);
  }

  function init() {
    initSimulator();
    initStickyCta();
    initHeroVideo();
    initSmoothScroll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
