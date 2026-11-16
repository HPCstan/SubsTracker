// @ts-check
/**
 * Worker 入口
 *
 * fetch handler 委託給 Hono 應用（src/app.js）。
 * scheduled handler 觸發定時任務執行。
 *
 */

import app from './app.js';
import { ensureMigrations } from './data/migrate.js';
import { checkExpiringSubscriptions } from './services/scheduler.js';
import { SchedulerAlarm } from './services/scheduler-alarm.js';

// Durable Object：Free 方案 Cron 名額已滿，改由 DO alarm 觸發定時排程。
export { SchedulerAlarm };

/**
 * 冪等地預約下一次排程（只在沒有待觸發 alarm 時生效）。
 *
 * @param {{ SCHEDULER?: DurableObjectNamespace }} env
 * @returns {Promise<void>}
 */
async function armScheduler(env) {
  if (!env.SCHEDULER) return;
  const stub = env.SCHEDULER.get(env.SCHEDULER.idFromName('hourly'));
  const res = await stub.fetch('https://scheduler.internal/arm', { method: 'POST' });
  await res.text();
}

export default {
  /**
   * @param {Request} request
   * @param {{ SCHEDULER?: DurableObjectNamespace, SUBSCRIPTIONS_KV: KVNamespace }} env
   * @param {ExecutionContext} ctx
   */
  fetch(request, env, ctx) {
    ctx.waitUntil(
      armScheduler(env).catch((err) => console.error('[index] arm scheduler failed:', err))
    );
    return app.fetch(request, env, ctx);
  },

  /**
   * 每小時由 Cron 觸發一次。
   *
   * @param {ScheduledEvent} event
   * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
   * @param {ExecutionContext} ctx
   */
  async scheduled(event, env, ctx) {
    void ctx;
    try {
      await ensureMigrations(env);
    } catch (err) {
      console.error('[index] scheduled 遷移失敗:', err);
    }
    console.log(
      '[Workers] 定時任務觸發',
      'cron:',
      event?.cron || '(unknown)',
      'UTC:',
      new Date().toISOString()
    );
    await checkExpiringSubscriptions(env);
  }
};
