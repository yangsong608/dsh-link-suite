/**
 * 演示数据。
 *
 * 骨架阶段用它把界面跑起来，M1 联调时删掉整个文件即可
 * （页面里只引用 `demoDevices()` 一个出口，替换成本很低）。
 */

import { DEFAULT_CAPS } from '@dsh-link/protocol'
import type { DeviceCard } from './store'

export function demoDevices(): DeviceCard[] {
  return [
    {
      deviceId: 'dev_mac',
      name: 'MacBook Pro',
      platform: 'desktop',
      role: 'admin',
      createdAt: Date.now() - 86_400_000 * 30,
      lastSeen: Date.now(),
      conn: 'online',
      latencyMs: 12,
      sessionCount: 3,
      runningCount: 1,
      endpointKind: 'lan',
      host: {
        hostId: 'h_mac',
        name: 'MacBook Pro',
        platform: 'darwin',
        dshVersion: '0.2.1-rc.2',
        linkVersion: '0.1.0',
        caps: { ...DEFAULT_CAPS, term: 0 },
        lock: { locked: false, soft: false, failedAttempts: 0 },
      },
      lock: { locked: false, soft: false, failedAttempts: 0 },
    },
    {
      deviceId: 'dev_studio',
      name: 'Studio 工作站',
      platform: 'desktop',
      role: 'operator',
      createdAt: Date.now() - 86_400_000 * 7,
      lastSeen: Date.now() - 30_000,
      conn: 'online',
      latencyMs: 34,
      sessionCount: 1,
      runningCount: 0,
      endpointKind: 'tailscale',
      host: {
        hostId: 'h_studio',
        name: 'Studio',
        platform: 'linux',
        dshVersion: '0.2.1-rc.2',
        linkVersion: '0.1.0',
        caps: { ...DEFAULT_CAPS, term: 0 },
        lock: { locked: true, soft: false, since: Date.now() - 600_000, reason: 'idle', failedAttempts: 0 },
      },
      lock: { locked: true, soft: false, since: Date.now() - 600_000, reason: 'idle', failedAttempts: 0 },
    },
    {
      deviceId: 'dev_mini',
      name: 'Mac mini（家里）',
      platform: 'desktop',
      role: 'approver',
      createdAt: Date.now() - 86_400_000 * 90,
      lastSeen: Date.now() - 3 * 3600_000,
      conn: 'offline',
      sessionCount: 0,
      runningCount: 0,
      endpointKind: 'relay',
      lock: { locked: false, soft: false, failedAttempts: 0 },
    },
  ]
}
