/**
 * 验证:插件卸载(执行清理函数)后,公平调度探测循环的等待定时器被取消。
 *
 * 这条守护的是一个真实缺陷:探测循环用 setTimeout 等待下一把,
 * 而清理函数若只置停止标志、不取消挂起的定时器——插件卸载后进程会
 * 多等一个探测间隔才退出。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from './index.js'

/** 当前事件循环里挂起的定时器数量。 */
function pendingTimers() {
  return process.getActiveResourcesInfo().filter(kind => kind === 'Timeout').length
}

test('index.js:卸载后后台探测定时器被取消,不再吊住进程', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-key-timer-'))
  const previous = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = dir
  const disposers = []
  try {
    const ctx = {
      credentials: {
        async resolve() { return undefined },
        async set() { },
        async unset() { },
      },
      llm: { async listConfigurableProviders() { return [] } },
      webServer: { register() { } },
      settings: { describe() { return [] } },
      configEditor: undefined,
      effect(fn) {
        const dispose = fn()
        disposers.push(dispose)
        return dispose
      },
      inject(names, callback) { return callback({ settings: ctx.settings, configEditor: undefined }) },
      on() { return () => { } },
      warn() { },
    }
    // 探测开着、间隔很长:公平调度循环会挂起一枚长等待的定时器。
    apply(ctx, { quotaProbe: true, fairProbeIntervalSec: 3600 })

    // 等插件把启动闸门放行、建好队列并进入探测间隔等待。
    await new Promise(resolve => setTimeout(resolve, 100))
    const before = pendingTimers()
    assert.ok(before > 0, '插件应当在后台探测里挂着一枚等待定时器')

    // 卸载:清理函数应当取消那枚定时器。
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch { /* 尽力清理 */ }
    }
    await new Promise(resolve => setTimeout(resolve, 100))
    const after = pendingTimers()
    assert.ok(after < before, `卸载后挂起的定时器应变少:卸载前 ${before} 个,卸载后 ${after} 个`)
  } finally {
    if (previous === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previous
    await rm(dir, { recursive: true, force: true })
  }
})
