/**
 * 料金シミュレーターのテスト
 *   実行: node --test test/
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const plans = require('../data/plans.json');
const sim = require('../js/simulator.js');

test('公式3プランの月額が仕様書どおりに一致する', () => {
  assert.equal(sim.calculate(plans, { frequency: 1, months: 3 }).monthlyTotal, 33000);
  assert.equal(sim.calculate(plans, { frequency: 2, months: 3 }).monthlyTotal, 59400);
  assert.equal(sim.calculate(plans, { frequency: 2, months: 6 }).monthlyTotal, 52800);
});

test('期間が長いほど月額が下がる（逓減する）', () => {
  const m3 = sim.calculate(plans, { frequency: 2, months: 3 }).monthlyTotal;
  const m6 = sim.calculate(plans, { frequency: 2, months: 6 }).monthlyTotal;
  const m12 = sim.calculate(plans, { frequency: 2, months: 12 }).monthlyTotal;
  assert.ok(m3 > m6 && m6 > m12, m3 + ' > ' + m6 + ' > ' + m12 + ' であること');
});

test('週回数が多いほど1回あたり単価が下がる', () => {
  const u1 = sim.calculate(plans, { frequency: 1, months: 3 }).sessionUnitPrice;
  const u2 = sim.calculate(plans, { frequency: 2, months: 3 }).sessionUnitPrice;
  const u3 = sim.calculate(plans, { frequency: 3, months: 3 }).sessionUnitPrice;
  assert.ok(u1 > u2 && u2 > u3);
});

test('オプションが月額に加算される', () => {
  const base = sim.calculate(plans, { frequency: 2, months: 3 });
  const meal = sim.calculate(plans, { frequency: 2, months: 3, options: ['meal'] });
  const both = sim.calculate(plans, { frequency: 2, months: 3, options: ['meal', 'stretch'] });
  assert.equal(meal.monthlyTotal - base.monthlyTotal, 11000);
  assert.equal(both.monthlyTotal - base.monthlyTotal, 16500);
  assert.equal(both.optionsBreakdown.length, 2);
});

test('同一オプションを重複指定しても二重加算しない', () => {
  const r = sim.calculate(plans, { frequency: 2, months: 3, options: ['meal', 'meal'] });
  assert.equal(r.optionsMonthly, 11000);
  assert.equal(r.optionsBreakdown.length, 1);
});

test('未知のオプションIDは無視される', () => {
  const r = sim.calculate(plans, { frequency: 1, months: 3, options: ['unknown'] });
  assert.equal(r.optionsMonthly, 0);
});

test('総額 = 月額 x 期間 + 入会金', () => {
  const r = sim.calculate(plans, { frequency: 2, months: 6, options: ['stretch'] });
  assert.equal(r.subtotal, r.monthlyTotal * 6);
  assert.equal(r.grandTotal, r.subtotal + 22000);
});

test('カウンセリング当日入会で入会金が無料になる', () => {
  const paid = sim.calculate(plans, { frequency: 2, months: 3 });
  const free = sim.calculate(plans, { frequency: 2, months: 3, joinOnCounselingDay: true });
  assert.equal(paid.enrollmentFee, 22000);
  assert.equal(free.enrollmentFee, 0);
  assert.equal(free.enrollmentFeeWaived, true);
  assert.equal(paid.grandTotal - free.grandTotal, 22000);
});

test('既定プランに一致する組み合わせはプラン名を返す', () => {
  assert.equal(sim.calculate(plans, { frequency: 2, months: 6 }).matchedPlan.name, 'コミット');
  assert.equal(sim.calculate(plans, { frequency: 1, months: 3 }).matchedPlan.id, 'light');
  assert.equal(sim.calculate(plans, { frequency: 3, months: 12 }).matchedPlan, null);
  assert.equal(sim.calculate(plans, { frequency: 2, months: 6, options: ['meal'] }).matchedPlan, null);
});

test('対応外の入力は例外を投げる', () => {
  assert.throws(() => sim.calculate(plans, { frequency: 5, months: 3 }), RangeError);
  assert.throws(() => sim.calculate(plans, { frequency: 2, months: 9 }), RangeError);
  assert.throws(() => sim.calculate(plans, null), TypeError);
});

test('全組み合わせで金額が非負の整数になる', () => {
  for (const f of [1, 2, 3]) {
    for (const m of [3, 6, 12]) {
      const r = sim.calculate(plans, { frequency: f, months: m, options: ['meal', 'stretch'] });
      for (const k of ['planMonthly', 'monthlyTotal', 'subtotal', 'grandTotal']) {
        assert.ok(Number.isInteger(r[k]) && r[k] >= 0, k + ' が不正: ' + r[k]);
      }
    }
  }
});

test('formatYen / formatRate が表示用文字列を返す', () => {
  assert.equal(sim.formatYen(59400), '59,400');
  assert.equal(sim.formatRate(0.2), '20%');
});
