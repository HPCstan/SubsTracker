// @ts-check
/**
 * 定時排程：用 Durable Object alarm 代替 Cron Trigger。
 *
 * 背景：Workers Free 方案每個帳號最多 5 個 Cron Trigger，本帳號已用滿，
 * `0 * * * *` 掛不上去（error 10072）。改為 DO alarm 自排程，不佔 Cron 名額。
 *
 * 行為：
 *   - 任一請求到達 Worker 時呼叫 `/arm`：當前沒有 alarm 就預約到下一個整點（UTC）。
 *   - alarm 觸發時執行與 cron 完全相同的「遷移 + 排程」，然後預約下一個整點。
 *   - 排程邏輯本身（時區、允許傳送小時、去重）完全沿用 services/scheduler.js。
 */

import { ensureMigrations } from '../data/migrate.js';
import { checkExpiringSubscriptions } from './scheduler.js';

const HOUR_MS = 60 * 60 * 1000;

/**
 * 下一個整點（UTC）的時間戳，用於對齊原本的 `0 * * * *` 觸發點。
 *
 * @param {number} nowMs
 * @returns {number}
 */
function nextHourStart(nowMs) {
  return nowMs - (nowMs % HOUR_MS) + HOUR_MS;
}

export class SchedulerAlarm {
  /**
   * @param {DurableObjectState} state
   * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
   */
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  /**
   * 冪等預約：只在沒有待觸發 alarm 時設定，重複呼叫不會推遲已排定的時間。
   *
   * @param {Request} request
   * @returns {Promise<Response>}
   */
  async fetch(request) {
    let alarm = await this.state.storage.getAlarm();
    if (alarm === null) {
      await this.state.storage.setAlarm(nextHourStart(Date.now()));
      alarm = await this.state.storage.getAlarm();
      console.log('[scheduler-alarm] armed for', new Date(alarm || 0).toISOString());
    }
    return Response.json({ alarm });
  }

  /**
   * alarm 觸發：跑一次排程，然後預約下一個整點。
   *
   * @returns {Promise<void>}
   */
  async alarm() {
    const startedAt = new Date().toISOString();
    try {
      await ensureMigrations(this.env);
      const entry = await checkExpiringSubscriptions(this.env);
      await this.state.storage.put('lastRun', startedAt);
      await this.state.storage.delete('lastError');
      console.log('[scheduler-alarm] run ok', startedAt, entry?.status);
    } catch (err) {
      const message = err instanceof Error ? (err.stack || err.message) : String(err);
      await this.state.storage.put('lastError', message);
      console.error('[scheduler-alarm] run failed', message);
    } finally {
      await this.state.storage.setAlarm(nextHourStart(Date.now()));
    }
  }
}
