/**
 * STUDIO CORE - 設定
 * ---------------------------------------------------------------------------
 * GAS_URL に Google Apps Script の Web アプリ URL を設定すると実サーバー連携に
 * 切り替わります。空文字のままの場合は js/booking.js のモックが自動で使われ、
 * ポートフォリオとして単体で動作します（gas/Code.gs と同じ応答を再現）。
 */
window.SC_CONFIG = {
  /** @type {string} 例: 'https://script.google.com/macros/s/XXXXXXXX/exec' */
  GAS_URL: '',

  /** 通信のタイムアウト（ミリ秒）。AbortController に渡します。 */
  REQUEST_TIMEOUT_MS: 10000,

  /** 予約枠の条件。GAS 側（gas/Code.gs）と同じ値を使うこと。 */
  BOOKING: {
    minDaysAhead: 1,
    maxDaysAhead: 60,
    openHour: 10,
    closeHour: 21,
    slotMinutes: 90,
    /** 定休日（0=日 ... 6=土）。水曜定休。 */
    closedWeekdays: [3]
  },

  /**
   * Cloudflare Turnstile のサイトキー（公開値。フロントに埋め込んでよい）。
   * index.html の `.cf-turnstile` の data-sitekey と必ず同じ値にすること。
   * シークレットキーはここには置かない。GAS側で
   * PropertiesService.getScriptProperties().getProperty('TURNSTILE_SECRET')
   * から取得する（gas/Code.gs 参照、README の設定手順も参照）。
   */
  TURNSTILE_SITE_KEY: '0x4AAAAAAExaLk9Ab67Q0ueS',

  /**
   * デバッグモード。true にするか URL に ?debug=1 を付けると
   * dataLayer へ push した内容をコンソールに出力します。
   */
  DEBUG: false,

  /** Microsoft Clarity のプロジェクトID（未設定のままで可） */
  CLARITY_ID: ''
};
