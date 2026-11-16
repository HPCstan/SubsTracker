// @ts-check
import { describe, it, expect } from 'vitest';
import {
  FALLBACK_RATES,
  convertCurrency,
  calculateMonthlyExpense,
  calculateYearlyExpense,
  getExpenseByType
} from '../../src/core/currency.js';

/** 測試用匯率表：語義為「1 CNY 可兌換的外幣數量」 */
const RATES = { CNY: 1, USD: 0.15, TWD: 4.9, HKD: 1.09, JPY: 24 };

describe('convertCurrency', () => {
  it('同幣別原樣返回', () => {
    expect(convertCurrency(50, 'TWD', 'TWD', RATES)).toBe(50);
  });

  it('TWD → CNY：50 元台幣約 10.2 人民幣', () => {
    expect(convertCurrency(50, 'TWD', 'CNY', RATES)).toBeCloseTo(50 / 4.9, 6);
  });

  it('CNY → USD：100 人民幣 = 15 美金', () => {
    expect(convertCurrency(100, 'CNY', 'USD', RATES)).toBeCloseTo(15, 6);
  });

  it('跨幣別往返換算不失真', () => {
    const usd = convertCurrency(50, 'TWD', 'USD', RATES);
    expect(convertCurrency(usd, 'USD', 'TWD', RATES)).toBeCloseTo(50, 6);
  });

  it('金額為 0 或負數時回傳 0', () => {
    expect(convertCurrency(0, 'TWD', 'CNY', RATES)).toBe(0);
    expect(convertCurrency(-5, 'TWD', 'CNY', RATES)).toBe(0);
  });
});

describe('FALLBACK_RATES 方向', () => {
  it('以 1 CNY 為基準（TWD 大於 1、USD 小於 1）', () => {
    expect(FALLBACK_RATES.CNY).toBe(1);
    expect(FALLBACK_RATES.TWD).toBeGreaterThan(1);
    expect(FALLBACK_RATES.USD).toBeLessThan(1);
  });

  it('50 元台幣不會被放大成人民幣（舊版除以 0.22 會得到 227）', () => {
    const cny = convertCurrency(50, 'TWD', 'CNY', FALLBACK_RATES);
    expect(cny).toBeGreaterThan(5);
    expect(cny).toBeLessThan(20);
  });
});

describe('統計函式支援目標幣別', () => {
  const today = new Date().toISOString();
  const subscriptions = [
    {
      isActive: true,
      currency: 'TWD',
      customType: '音樂平台',
      paymentHistory: [{ amount: 50, date: today }]
    }
  ];

  it('calculateMonthlyExpense 預設仍以 CNY 統計（向下相容）', () => {
    const result = calculateMonthlyExpense(subscriptions, 'UTC', RATES);
    expect(result.amount).toBeCloseTo(50 / 4.9, 6);
  });

  it('calculateMonthlyExpense 指定 TWD 時維持原幣別金額', () => {
    const result = calculateMonthlyExpense(subscriptions, 'UTC', RATES, 'TWD');
    expect(result.amount).toBeCloseTo(50, 6);
  });

  it('calculateMonthlyExpense 指定 USD 時換算為美金', () => {
    const result = calculateMonthlyExpense(subscriptions, 'UTC', RATES, 'USD');
    expect(result.amount).toBeCloseTo((50 / 4.9) * 0.15, 6);
  });

  it('calculateYearlyExpense 指定 TWD 時，金額與月均都換算', () => {
    const month = new Date().getUTCMonth() + 1;
    const result = calculateYearlyExpense(subscriptions, 'UTC', RATES, 'TWD');
    expect(result.amount).toBeCloseTo(50, 6);
    expect(result.monthlyAverage).toBeCloseTo(50 / month, 6);
  });

  it('getExpenseByType 指定 TWD 時，排行金額換算但百分比不變', () => {
    const result = getExpenseByType(subscriptions, 'UTC', RATES, 'TWD');
    expect(result).toHaveLength(1);
    expect(result[0].amount).toBeCloseTo(50, 6);
    expect(result[0].percentage).toBe(100);
  });
});
