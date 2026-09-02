/**
 * 計測 - dataLayer への push を一箇所に集約する
 * ---------------------------------------------------------------------------
 * 送信イベント:
 *   cta_click     : location (hero / pricing / sticky / faq)
 *   scroll_depth  : depth (25 / 50 / 75 / 100)
 *   simulator_use : frequency, months, options
 *   form_step     : step (1-3)
 *   form_error    : type (network / validation / conflict / timeout / empty)
 *   form_submit   : date, time
 *
 * デバッグ: config.js の DEBUG:true または URL に ?debug=1 を付けると
 *          push した内容をコンソールへ出力します。
 */
var SCAnalytics = (function () {
  'use strict';

  window.dataLayer = window.dataLayer || [];

  var config = window.SC_CONFIG || {};
  var debug = false;
  try {
    debug = config.DEBUG === true ||
      new URLSearchParams(window.location.search).get('debug') === '1';
  } catch (e) {
    debug = config.DEBUG === true;
  }

  /**
   * dataLayer へ1件 push する。
   * @param {string} event イベント名
   * @param {object} [params] 付帯情報
   */
  function push(event, params) {
    var payload = { event: event };
    if (params) {
      for (var key in params) {
        if (Object.prototype.hasOwnProperty.call(params, key)) payload[key] = params[key];
      }
    }
    payload.timestamp = Date.now();
    window.dataLayer.push(payload);
    if (debug) {
      // デバッグモード: 何がいつ送られたかを追えるようにする
      console.info('%c[dataLayer]%c ' + event, 'color:#2e5a50;font-weight:bold', '', payload);
    }
    return payload;
  }

  /** CTA クリック計測（data-cta 属性を持つ要素をイベント委譲で拾う） */
  function trackCtaClicks() {
    document.addEventListener('click', function (ev) {
      var target = ev.target.closest ? ev.target.closest('[data-cta]') : null;
      if (!target) return;
      push('cta_click', { location: target.getAttribute('data-cta') });
    });
  }

  /**
   * スクロール到達率の計測。
   * scroll イベントは使わず、ページ内に高さ1pxの目印を置いて
   * IntersectionObserver で通過を検知する。
   */
  function trackScrollDepth() {
    if (!('IntersectionObserver' in window)) return;

    var depths = [25, 50, 75, 100];
    var fired = {};

    // 目印の入れ物は body と同じ高さを持つ絶対配置の箱。
    // 高さを % で指定するので、文書が伸び縮みしても再計算が不要（レイアウトにも影響しない）。
    document.body.style.position = 'relative';
    var host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText =
      'position:absolute;top:0;left:0;width:1px;height:100%;pointer-events:none;visibility:hidden';
    document.body.appendChild(host);

    var markers = depths.map(function (depth) {
      var el = document.createElement('div');
      // 100% は文書の最下端。ビューポート内に入った時点で到達とみなす。
      el.style.cssText = 'position:absolute;left:0;width:1px;height:1px;top:calc(' + depth + '% - 2px)';
      el.dataset.depth = String(depth);
      host.appendChild(el);
      return el;
    });

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var depth = Number(entry.target.dataset.depth);
        if (fired[depth]) return;
        fired[depth] = true;
        push('scroll_depth', { depth: depth });
        observer.unobserve(entry.target);
      });
    });

    markers.forEach(function (el) { observer.observe(el); });
  }

  function init() {
    trackCtaClicks();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', trackScrollDepth);
    } else {
      trackScrollDepth();
    }
    if (debug) {
      console.info('[STUDIO CORE] analytics debug mode. window.dataLayer を確認できます。');
    }
  }

  init();

  return { push: push, isDebug: function () { return debug; } };
})();
