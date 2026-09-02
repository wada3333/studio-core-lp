/**
 * 料金シミュレーター - 計算ロジック（純粋関数のみ）
 * ---------------------------------------------------------------------------
 * このファイルは DOM を一切参照しません。料金定義(data/plans.json)と選択値から
 * 金額を返すだけです。UI への反映は js/ui.js が担当します。
 * Node からも読み込めるよう末尾で module.exports に対応させています。
 */
var SCSimulator = (function () {
  'use strict';

  /** 端数処理（unit 円単位に四捨五入） */
  function roundTo(value, unit) {
    var u = unit && unit > 0 ? unit : 1;
    return Math.round(value / u) * u;
  }

  function findFrequency(plans, frequency) {
    var list = plans.frequencies || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].value === frequency) return list[i];
    }
    return null;
  }

  function findTerm(plans, months) {
    var list = plans.terms || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].months === months) return list[i];
    }
    return null;
  }

  function findOption(plans, id) {
    var list = plans.options || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  }

  /**
   * 選択内容が既定プラン（ライト/スタンダード/コミット）と一致するか判定する。
   * オプションが付いている場合はカスタム扱いとして null を返す。
   */
  function matchPlan(plans, selection) {
    if (selection.options && selection.options.length) return null;
    var list = plans.plans || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].frequency === selection.frequency && list[i].months === selection.months) {
        return list[i];
      }
    }
    return null;
  }

  /**
   * 料金を算出する。
   * @param {object} plans data/plans.json の中身
   * @param {{frequency:number, months:number, options?:string[], joinOnCounselingDay?:boolean}} selection
   * @returns {object} 明細一式（月額・総額・入会金・割引内訳など）
   */
  function calculate(plans, selection) {
    if (!plans || !plans.pricing) throw new TypeError('plans が不正です');
    if (!selection) throw new TypeError('selection が不正です');

    var freq = findFrequency(plans, selection.frequency);
    if (!freq) throw new RangeError('対応していない週回数です: ' + selection.frequency);

    var term = findTerm(plans, selection.months);
    if (!term) throw new RangeError('対応していない期間です: ' + selection.months);

    var pricing = plans.pricing;
    var sessionsPerMonth = freq.value * pricing.sessionsPerMonthPerWeekly;
    var baseMonthly = pricing.unitPrice * sessionsPerMonth;

    // 割引は加算方式（週回数割引 + 期間割引）。定義ミスで負額にならないよう丸める。
    var totalDiscountRate = freq.discountRate + term.discountRate;
    if (totalDiscountRate < 0) totalDiscountRate = 0;
    if (totalDiscountRate > 0.9) totalDiscountRate = 0.9;

    var planMonthly = roundTo(baseMonthly * (1 - totalDiscountRate), pricing.roundTo);

    var ids = selection.options || [];
    var optionsBreakdown = [];
    var optionsMonthly = 0;
    for (var i = 0; i < ids.length; i++) {
      var opt = findOption(plans, ids[i]);
      if (!opt) continue;
      var dup = false;
      for (var j = 0; j < optionsBreakdown.length; j++) {
        if (optionsBreakdown[j].id === opt.id) dup = true;
      }
      if (dup) continue;
      optionsBreakdown.push({ id: opt.id, label: opt.label, monthly: opt.monthly });
      optionsMonthly += opt.monthly;
    }

    var monthlyTotal = planMonthly + optionsMonthly;
    var subtotal = monthlyTotal * term.months;
    var waived = selection.joinOnCounselingDay === true;
    var enrollmentFee = waived ? 0 : pricing.enrollmentFee;

    return {
      frequency: freq.value,
      frequencyLabel: freq.label,
      months: term.months,
      termLabel: term.label,
      sessionsPerMonth: sessionsPerMonth,
      sessionsTotal: sessionsPerMonth * term.months,
      baseMonthly: baseMonthly,
      frequencyDiscountRate: freq.discountRate,
      termDiscountRate: term.discountRate,
      totalDiscountRate: totalDiscountRate,
      discountAmountMonthly: baseMonthly - planMonthly,
      planMonthly: planMonthly,
      optionsMonthly: optionsMonthly,
      optionsBreakdown: optionsBreakdown,
      monthlyTotal: monthlyTotal,
      sessionUnitPrice: sessionsPerMonth > 0 ? roundTo(monthlyTotal / sessionsPerMonth, 1) : 0,
      subtotal: subtotal,
      enrollmentFee: enrollmentFee,
      enrollmentFeeWaived: waived,
      grandTotal: subtotal + enrollmentFee,
      matchedPlan: matchPlan(plans, { frequency: freq.value, months: term.months, options: ids })
    };
  }

  /** 表示用フォーマッタ（純粋関数） */
  function formatYen(value) {
    return Math.round(value).toLocaleString('ja-JP');
  }

  /** 0.2 -> '20%' */
  function formatRate(rate) {
    return Math.round(rate * 1000) / 10 + '%';
  }

  return {
    calculate: calculate,
    matchPlan: matchPlan,
    formatYen: formatYen,
    formatRate: formatRate,
    roundTo: roundTo
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = SCSimulator;
}
