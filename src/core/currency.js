import { MS_PER_DAY, getCurrentTimeInTimezone, getTimezoneDateParts } from './time.js';

const CATEGORY_SEPARATOR_REGEX = /[\/，,\s]+/;

// 匯率配置（語義：1 CNY 可兌換的外幣數量，與 base=CNY 的匯率 API 一致）
// 當 API 不可用、或 API 缺少特定幣種（如 TWD）時作為兜底
const FALLBACK_RATES = {
  'CNY': 1,
  'USD': 0.14,
  'HKD': 1.09,
  'TWD': 4.50,
  'JPY': 20.5,
  'EUR': 0.13,
  'GBP': 0.11,
  'KRW': 190,
  'TRY': 4.60
};

/** 儀表板可切換的統計幣別（預設 CNY，保留舊行為） */
const DISPLAY_CURRENCIES = ['CNY', 'TWD', 'USD'];

// 匯率來源：優先用涵蓋 TWD 的來源，失敗再退回 ECB 參考匯率
const RATE_SOURCES = [
  'https://open.er-api.com/v6/latest/CNY',
  'https://api.frankfurter.dev/v1/latest?base=CNY'
];

/**
 * 抓單一來源的匯率表（base=CNY）。失敗回傳 null，不拋錯。
 *
 * @param {string} sourceUrl
 * @returns {Promise<Record<string, number>|null>}
 */
async function fetchRatesFrom(sourceUrl) {
  try {
    const response = await fetch(sourceUrl);
    if (!response.ok) return null;
    const data = await response.json();
    const rates = data && data.rates;
    if (!rates || typeof rates !== 'object') return null;
    return rates;
  } catch (error) {
    console.warn('[匯率] 來源失敗:', sourceUrl, error && error.message ? error.message : error);
    return null;
  }
}

async function getDynamicRates(env) {
  // 版本化 key：舊版快取（TWD 方向錯誤）不再沿用
  const CACHE_KEY = 'SYSTEM_EXCHANGE_RATES_V2';
  const CACHE_TTL = 21600000; // 6小時（盡量貼近即時匯率）

  try {
    const cached = await env.SUBSCRIPTIONS_KV.get(CACHE_KEY, { type: 'json' });
    if (cached && cached.ts && (Date.now() - cached.ts < CACHE_TTL)) {
      return cached.rates;
    }

    let newRates = null;
    for (const sourceUrl of RATE_SOURCES) {
      const apiRates = await fetchRatesFrom(sourceUrl);
      if (!apiRates) continue;
      const merged = { ...FALLBACK_RATES, ...apiRates, 'CNY': 1 };
      // 優先採用包含 TWD 的來源（ECB 參考匯率不含 TWD）
      if (!newRates || merged['TWD']) newRates = merged;
      if (merged['TWD']) break;
    }

    if (!newRates) {
      console.warn('[匯率] 所有來源失敗，使用兜底匯率');
      return FALLBACK_RATES;
    }

    await env.SUBSCRIPTIONS_KV.put(CACHE_KEY, JSON.stringify({
      ts: Date.now(),
      rates: newRates
    }));

    return newRates;
  } catch (error) {
    console.error('[匯率] 獲取過程出錯:', error);
  }
  return FALLBACK_RATES;
}

function convertToCNY(amount, currency, rates) {
  if (!amount || amount <= 0) return 0;
  const code = currency || 'CNY';
  if (code === 'CNY') return amount;
  const rate = rates[code];
  if (!rate) return amount;
  return amount / rate;
}

/**
 * 任意幣別換算。rates 為「1 CNY 可兌換的外幣數量」表。
 *
 * @param {number} amount
 * @param {string} fromCurrency
 * @param {string} toCurrency
 * @param {Record<string, number>} rates
 * @returns {number}
 */
function convertCurrency(amount, fromCurrency, toCurrency, rates) {
  if (!amount || amount <= 0) return 0;
  const from = String(fromCurrency || 'CNY').toUpperCase();
  const to = String(toCurrency || 'CNY').toUpperCase();
  if (from === to) return amount;
  const table = rates || FALLBACK_RATES;
  const fromRate = table[from] || 1;
  const toRate = table[to] || 1;
  return (amount / fromRate) * toRate;
}

/**
 * 週期換算係數：把「一個週期的金額」折算成「每月金額」。
 * 1 個月 → ×1、1 年 → ÷12、1 天 → ×30.4375。
 *
 * @param {{periodValue?: number, periodUnit?: string}} sub
 * @returns {number}
 */
function getMonthlyShare(sub) {
  const value = Number(sub.periodValue) > 0 ? Number(sub.periodValue) : 1;
  const unit = String(sub.periodUnit || 'month');
  if (unit === 'day') return 30.4375 / value;
  if (unit === 'year') return 1 / (value * 12);
  return 1 / value;
}

/**
 * 月度支出 = 所有啟用中訂閱「攤平到月」的總額（年繳 ÷12、日租 ×30.4375）。
 * 不依賴本月是否已產生付款紀錄，避免月初尚未扣款時低估。
 */
function calculateMonthlyExpense(subscriptions, timezone, rates, targetCurrency = 'CNY') {
  const now = getCurrentTimeInTimezone(timezone);
  const parts = getTimezoneDateParts(now, timezone);
  const currentYear = parts.year;
  const currentMonth = parts.month;

  let amount = 0;
  let lastMonthAmount = 0;

  subscriptions.forEach(sub => {
    if (!sub.isActive) return;
    if (!sub.amount || sub.amount <= 0) return;

    const monthlyCNY = convertToCNY(sub.amount, sub.currency, rates) * getMonthlyShare(sub);
    amount += monthlyCNY;

    // 趨勢基準：只計「本月之前就已存在」的訂閱攤平值
    const startParts = sub.startDate ? getTimezoneDateParts(new Date(sub.startDate), timezone) : null;
    const startedBeforeThisMonth = !startParts ||
      startParts.year < currentYear ||
      (startParts.year === currentYear && startParts.month < currentMonth);
    if (startedBeforeThisMonth) lastMonthAmount += monthlyCNY;
  });

  let trend = 0;
  let trendDirection = 'flat';
  if (lastMonthAmount > 0) {
    trend = Math.round(((amount - lastMonthAmount) / lastMonthAmount) * 100);
    if (trend > 0) trendDirection = 'up';
    else if (trend < 0) trendDirection = 'down';
  } else if (amount > 0) {
    trend = 100;
    trendDirection = 'up';
  }
  return { amount: convertCurrency(amount, 'CNY', targetCurrency, rates), trend: Math.abs(trend), trendDirection };
}

function calculateYearlyExpense(subscriptions, timezone, rates, targetCurrency = 'CNY') {
  const now = getCurrentTimeInTimezone(timezone);
  const parts = getTimezoneDateParts(now, timezone);
  const currentYear = parts.year;

  let amount = 0;
  subscriptions.forEach(sub => {
    const paymentHistory = sub.paymentHistory || [];
    paymentHistory.forEach(payment => {
      if (!payment.amount || payment.amount <= 0) return;
      const paymentDate = new Date(payment.date);
      const paymentParts = getTimezoneDateParts(paymentDate, timezone);
      if (paymentParts.year === currentYear) {
        amount += convertToCNY(payment.amount, sub.currency, rates);
      }
    });
  });

  const monthlyAverage = amount / parts.month;
  return {
    amount: convertCurrency(amount, 'CNY', targetCurrency, rates),
    monthlyAverage: convertCurrency(monthlyAverage, 'CNY', targetCurrency, rates)
  };
}

function getRecentPayments(subscriptions, timezone) {
  const now = getCurrentTimeInTimezone(timezone);
  const sevenDaysAgo = new Date(now.getTime() - 7 * MS_PER_DAY);
  const recentPayments = [];
  subscriptions.forEach(sub => {
    const paymentHistory = sub.paymentHistory || [];
    paymentHistory.forEach(payment => {
      if (!payment.amount || payment.amount <= 0) return;
      const paymentDate = new Date(payment.date);
      if (paymentDate >= sevenDaysAgo && paymentDate <= now) {
        recentPayments.push({
          name: sub.name,
          amount: payment.amount,
          currency: sub.currency || 'CNY',
          customType: sub.customType,
          paymentDate: payment.date,
          note: payment.note
        });
      }
    });
  });
  return recentPayments.sort((a, b) => new Date(b.paymentDate) - new Date(a.paymentDate));
}

function getUpcomingRenewals(subscriptions, timezone) {
  const now = getCurrentTimeInTimezone(timezone);
  const sevenDaysLater = new Date(now.getTime() + 7 * MS_PER_DAY);
  return subscriptions
    .filter(sub => {
      if (!sub.isActive) return false;
      const renewalDate = new Date(sub.expiryDate);
      return renewalDate >= now && renewalDate <= sevenDaysLater;
    })
    .map(sub => {
      const renewalDate = new Date(sub.expiryDate);
      const daysUntilRenewal = Math.ceil((renewalDate - now) / MS_PER_DAY);
      return {
        name: sub.name,
        amount: sub.amount || 0,
        currency: sub.currency || 'CNY',
        customType: sub.customType,
        renewalDate: sub.expiryDate,
        daysUntilRenewal
      };
    })
    .sort((a, b) => a.daysUntilRenewal - b.daysUntilRenewal);
}

function getExpenseByType(subscriptions, timezone, rates, targetCurrency = 'CNY') {
  const now = getCurrentTimeInTimezone(timezone);
  const parts = getTimezoneDateParts(now, timezone);
  const currentYear = parts.year;
  const typeMap = {};
  let total = 0;
  subscriptions.forEach(sub => {
    const paymentHistory = sub.paymentHistory || [];
    paymentHistory.forEach(payment => {
      if (!payment.amount || payment.amount <= 0) return;
      const paymentDate = new Date(payment.date);
      const paymentParts = getTimezoneDateParts(paymentDate, timezone);
      if (paymentParts.year === currentYear) {
        const type = sub.customType || '未分類';
        const amountCNY = convertToCNY(payment.amount, sub.currency, rates);
        typeMap[type] = (typeMap[type] || 0) + amountCNY;
        total += amountCNY;
      }
    });
  });

  return Object.entries(typeMap)
    .map(([type, amount]) => ({
      type,
      amount: convertCurrency(amount, 'CNY', targetCurrency, rates),
      percentage: total > 0 ? Math.round((amount / total) * 100) : 0
    }))
    .sort((a, b) => b.amount - a.amount);
}

function getExpenseByCategory(subscriptions, timezone, rates, targetCurrency = 'CNY') {
  const now = getCurrentTimeInTimezone(timezone);
  const parts = getTimezoneDateParts(now, timezone);
  const currentYear = parts.year;

  const categoryMap = {};
  let total = 0;
  subscriptions.forEach(sub => {
    const paymentHistory = sub.paymentHistory || [];
    paymentHistory.forEach(payment => {
      if (!payment.amount || payment.amount <= 0) return;
      const paymentDate = new Date(payment.date);
      const paymentParts = getTimezoneDateParts(paymentDate, timezone);
      if (paymentParts.year === currentYear) {
        const categories = sub.category ? sub.category.split(CATEGORY_SEPARATOR_REGEX).filter(c => c.trim()) : ['未分類'];
        const amountCNY = convertToCNY(payment.amount, sub.currency, rates);

        categories.forEach(category => {
          const cat = category.trim() || '未分類';
          categoryMap[cat] = (categoryMap[cat] || 0) + amountCNY / categories.length;
        });
        total += amountCNY;
      }
    });
  });

  return Object.entries(categoryMap)
    .map(([category, amount]) => ({
      category,
      amount: convertCurrency(amount, 'CNY', targetCurrency, rates),
      percentage: total > 0 ? Math.round((amount / total) * 100) : 0
    }))
    .sort((a, b) => b.amount - a.amount);
}

export {
  FALLBACK_RATES,
  DISPLAY_CURRENCIES,
  getDynamicRates,
  convertToCNY,
  convertCurrency,
  calculateMonthlyExpense,
  calculateYearlyExpense,
  getRecentPayments,
  getUpcomingRenewals,
  getExpenseByType,
  getExpenseByCategory
};
