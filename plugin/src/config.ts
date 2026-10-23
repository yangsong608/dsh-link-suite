/**
 * 配置：默认值 + 校验。
 *
 * 手写校验而不是 zod：这个插件的依赖面越小，dsh 升级时的重新验证成本越低。
 * 校验失败要**说清楚是哪个字段、期望什么、当前是什么**——配置错误是用户最常见的求助来源。
 */

export type BindMode = 'loopback' | 'lan'

export interface LinkConfig {
  readonly enabled: boolean
  readonly gateway: {
    readonly enabled: boolean
    readonly port: number
    readonly bind: BindMode
    /**
     * 承载方式。
     *   standalone：自己监听 port（默认）。可在 dsh 没开 web 时工作，但明文。
     *   dsh-web   ：复用 dsh 的端口与 TLS（M0 只留配置位，upgrade 挂载在 M1 落地）。
     */
    readonly via: 'standalone' | 'dsh-web'
    readonly relayUrl?: string
    /** 心跳间隔；客户端据此判断死线，改这里要同步 App。 */
    readonly heartbeatMs: number
    /** 配对码有效期。 */
    readonly pairTtlMs: number
    /** 额外允许的 Origin（dsh 自己的域名 / 反代地址）。 */
    readonly allowedOrigins: readonly string[]
  }
  readonly lock: {
    readonly enabled: boolean
    /** 0 = 只手动锁 */
    readonly idleMinutes: number
    /** 0 = 不进入只读半锁 */
    readonly softLockHours: number
    readonly maxAttempts: number
    readonly windowMinutes: number
    /** 是否允许已配对设备直接输密码解锁（默认关：手机可能是捡到的） */
    readonly allowDeviceUnlock: boolean
    /** 解锁失败是否发通知 */
    readonly notifyOnFail: boolean
    /** 重启后的宽限窗口（毫秒），只允许本机回环访问 */
    readonly graceAfterBootMs: number
  }
  readonly files: {
    readonly maxUploadBytes: number
    /** 是否跟随软链。默认 false——上传路径必须逐段 lstat。 */
    readonly followSymlinks: boolean
    /** 单次 `fs.read` 返回的字节上限。手机上再大也渲染不动。 */
    readonly maxReadBytes: number
    /** 判断二进制时探测开头多少字节（找 NUL）。 */
    readonly probeBytes: number
    /** 超过这个大小就不算 `stat.lines`，省一次全文件扫描。 */
    readonly maxCountLinesBytes: number
  }
  readonly trace: {
    /** 终端输出只保留尾部行数；完整内容走 trace.detail。 */
    readonly maxTailLines: number
    /** trace.detail 单条返回上限。 */
    readonly maxDetailBytes: number
    /** 内存里每个会话保留多少条 trace（超出落盘滚动）。 */
    readonly ringSize: number
  }
  readonly queue: {
    /** 单会话队列上限。20 条是"能排但有感"的经验值。 */
    readonly maxItems: number
    /** 会话空闲后是否自动发送队首。关掉就变成纯手工确认。 */
    readonly autoStart: boolean
  }
  readonly repo: {
    /** 是否允许 git 浏览。宿主机没有 git 时即使为 true 也会降级。 */
    readonly gitEnabled: boolean
    /** 单次 diff 返回上限，超了截断并标 truncated。 */
    readonly maxDiffBytes: number
    /** 是否允许浏览工作区之外的仓库（如 ~/code）。默认 false，守住工作区边界。 */
    readonly allowOutsideWorkspace: boolean
    readonly github: {
      /** GitHub 远程浏览总开关。 */
      readonly enabled: boolean
      /**
       * PAT。**只存在 PC 上**，绝不下发给 App，也不写进审计日志。
       * 空串表示未配置；启用 gh 却没配置 token 时，设备会拿到 repo/auth 错误而不是空白列表。
       */
      readonly token: string
      /** 允许访问的仓库白名单（`owner/repo`）；空数组表示不限制。 */
      readonly allowlist: readonly string[]
    }
  }
  readonly plugins: {
    /** 远程装插件 = 远程 RCE，默认关 */
    readonly allowRemoteInstall: boolean
    /** 允许的 registry 前缀白名单；空数组表示只允许 package.json 里已声明的 */
    readonly allowedRegistries: readonly string[]
  }
}

export const DEFAULT_CONFIG: LinkConfig = {
  enabled: true,
  gateway: {
    enabled: true,
    port: 7443,
    bind: 'lan',
    via: 'standalone',
    // 20s 是设计文档的结论（docs/09 §7）：2s 会让手机基带长期处于 connected 态，
    // 而 NAT 保活 20s 足够。
    heartbeatMs: 20_000,
    pairTtlMs: 120_000,
    allowedOrigins: [],
  },
  lock: {
    /*
     * 默认关闭。
     *
     * 这个锁是 MOSS Link 自己的操作门（不是 DSH 的登录屏）。默认开启等于
     * 给所有用户塞一个他们没要的功能：空闲 10 分钟自动上锁，手机上又没有
     * 解锁入口，结果就是"我在用 DSH，App 却说主机已锁定"。
     *
     * 想要就显式打开：配置 lock.enabled = true 并设置密码。
     */
    enabled: false,
    idleMinutes: 10,
    softLockHours: 8,
    maxAttempts: 5,
    windowMinutes: 5,
    allowDeviceUnlock: false,
    notifyOnFail: true,
    graceAfterBootMs: 90_000,
  },
  files: {
    maxUploadBytes: 512 * 1024 * 1024,
    followSymlinks: false,
    maxReadBytes: 256 * 1024,
    probeBytes: 8 * 1024,
    maxCountLinesBytes: 4 * 1024 * 1024,
  },
  trace: {
    maxTailLines: 40,
    maxDetailBytes: 512 * 1024,
    ringSize: 2000,
  },
  queue: {
    maxItems: 20,
    autoStart: true,
  },
  repo: {
    gitEnabled: true,
    maxDiffBytes: 512 * 1024,
    // 默认守住工作区：能看工作区里的仓库就够，"顺带浏览整个家目录"是权限放大
    allowOutsideWorkspace: false,
    github: {
      enabled: false,
      token: '',
      allowlist: [],
    },
  },
  plugins: {
    allowRemoteInstall: false,
    allowedRegistries: [],
  },
}

class ConfigError extends Error {
  constructor(path: string, expected: string, actual: unknown) {
    super(`dsh-link config: \`${path}\` 期望 ${expected}，收到 ${JSON.stringify(actual)}`)
    this.name = 'ConfigError'
  }
}

const asBool = (v: unknown, path: string, fallback: boolean): boolean => {
  if (v === undefined) return fallback
  if (typeof v !== 'boolean') throw new ConfigError(path, 'boolean', v)
  return v
}

const asInt = (v: unknown, path: string, fallback: number, min: number, max: number): number => {
  if (v === undefined) return fallback
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new ConfigError(path, 'integer', v)
  if (v < min || v > max) throw new ConfigError(path, `integer in [${min}, ${max}]`, v)
  return v
}

const asString = (v: unknown, path: string, fallback: string): string => {
  if (v === undefined) return fallback
  if (typeof v !== 'string' || v.length === 0) throw new ConfigError(path, 'non-empty string', v)
  return v
}

/** 允许空串：token 这类"可以配置为空 = 未配置"的字段不能用 asString。 */
const asText = (v: unknown, path: string, fallback: string): string => {
  if (v === undefined) return fallback
  if (typeof v !== 'string') throw new ConfigError(path, 'string', v)
  return v
}

const asStringArray = (v: unknown, path: string): string[] => {
  if (v === undefined) return []
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new ConfigError(path, 'string[]', v)
  }
  return [...(v as string[])]
}

const record = (v: unknown, path: string): Record<string, unknown> => {
  if (v === undefined) return {}
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new ConfigError(path, 'object', v)
  }
  return v as Record<string, unknown>
}

/** 把用户给的任意对象规范化成 LinkConfig；未知字段被忽略。 */
export function normalizeConfig(raw: unknown): LinkConfig {
  const root = record(raw, '(root)')
  const gw = record(root['gateway'], 'gateway')
  const lk = record(root['lock'], 'lock')
  const fs = record(root['files'], 'files')
  const pl = record(root['plugins'], 'plugins')
  const tr = record(root['trace'], 'trace')
  const qu = record(root['queue'], 'queue')
  const rp = record(root['repo'], 'repo')
  const gh = record(rp['github'], 'repo.github')

  const bindRaw = gw['bind']
  let bind: BindMode = DEFAULT_CONFIG.gateway.bind
  if (bindRaw !== undefined) {
    if (bindRaw !== 'loopback' && bindRaw !== 'lan') throw new ConfigError('gateway.bind', '"loopback" | "lan"', bindRaw)
    bind = bindRaw
  }

  const relayRaw = gw['relayUrl']
  let relayUrl: string | undefined
  if (relayRaw !== undefined) {
    if (typeof relayRaw !== 'string' || !/^wss?:\/\//.test(relayRaw)) {
      throw new ConfigError('gateway.relayUrl', 'ws:// 或 wss:// URL', relayRaw)
    }
    relayUrl = relayRaw
  }

  const viaRaw = gw['via']
  let via: 'standalone' | 'dsh-web' = DEFAULT_CONFIG.gateway.via
  if (viaRaw !== undefined) {
    if (viaRaw !== 'standalone' && viaRaw !== 'dsh-web') {
      throw new ConfigError('gateway.via', '"standalone" | "dsh-web"', viaRaw)
    }
    via = viaRaw
  }

  const registriesRaw = pl['allowedRegistries']
  let allowedRegistries: string[] = []
  if (registriesRaw !== undefined) {
    if (!Array.isArray(registriesRaw) || registriesRaw.some((x) => typeof x !== 'string')) {
      throw new ConfigError('plugins.allowedRegistries', 'string[]', registriesRaw)
    }
    allowedRegistries = [...(registriesRaw as string[])]
  }

  const base = DEFAULT_CONFIG

  return {
    enabled: asBool(root['enabled'], 'enabled', base.enabled),
    gateway: {
      enabled: asBool(gw['enabled'], 'gateway.enabled', base.gateway.enabled),
      // 0 表示"由系统分配随机端口"：测试与容器里都需要，也避免默认端口被占用时直接失败。
      port: asInt(gw['port'], 'gateway.port', base.gateway.port, 0, 65535),
      bind,
      via,
      ...(relayUrl === undefined ? {} : { relayUrl }),
      heartbeatMs: asInt(gw['heartbeatMs'], 'gateway.heartbeatMs', base.gateway.heartbeatMs, 1000, 60_000),
      pairTtlMs: asInt(gw['pairTtlMs'], 'gateway.pairTtlMs', base.gateway.pairTtlMs, 30_000, 10 * 60_000),
      allowedOrigins: asStringArray(gw['allowedOrigins'], 'gateway.allowedOrigins'),
    },
    lock: {
      enabled: asBool(lk['enabled'], 'lock.enabled', base.lock.enabled),
      idleMinutes: asInt(lk['idleMinutes'], 'lock.idleMinutes', base.lock.idleMinutes, 0, 24 * 60),
      softLockHours: asInt(lk['softLockHours'], 'lock.softLockHours', base.lock.softLockHours, 0, 24 * 30),
      maxAttempts: asInt(lk['maxAttempts'], 'lock.maxAttempts', base.lock.maxAttempts, 1, 50),
      windowMinutes: asInt(lk['windowMinutes'], 'lock.windowMinutes', base.lock.windowMinutes, 1, 1440),
      allowDeviceUnlock: asBool(lk['allowDeviceUnlock'], 'lock.allowDeviceUnlock', base.lock.allowDeviceUnlock),
      notifyOnFail: asBool(lk['notifyOnFail'], 'lock.notifyOnFail', base.lock.notifyOnFail),
      graceAfterBootMs: asInt(
        lk['graceAfterBootMs'],
        'lock.graceAfterBootMs',
        base.lock.graceAfterBootMs,
        0,
        10 * 60_000,
      ),
    },
    files: {
      maxUploadBytes: asInt(fs['maxUploadBytes'], 'files.maxUploadBytes', base.files.maxUploadBytes, 1024, 8 * 1024 ** 3),
      followSymlinks: asBool(fs['followSymlinks'], 'files.followSymlinks', base.files.followSymlinks),
      maxReadBytes: asInt(fs['maxReadBytes'], 'files.maxReadBytes', base.files.maxReadBytes, 4096, 8 * 1024 ** 2),
      probeBytes: asInt(fs['probeBytes'], 'files.probeBytes', base.files.probeBytes, 512, 64 * 1024),
      maxCountLinesBytes: asInt(
        fs['maxCountLinesBytes'],
        'files.maxCountLinesBytes',
        base.files.maxCountLinesBytes,
        1024,
        64 * 1024 ** 2,
      ),
    },
    trace: {
      maxTailLines: asInt(tr['maxTailLines'], 'trace.maxTailLines', base.trace.maxTailLines, 0, 500),
      maxDetailBytes: asInt(tr['maxDetailBytes'], 'trace.maxDetailBytes', base.trace.maxDetailBytes, 4096, 16 * 1024 ** 2),
      ringSize: asInt(tr['ringSize'], 'trace.ringSize', base.trace.ringSize, 100, 100_000),
    },
    queue: {
      maxItems: asInt(qu['maxItems'], 'queue.maxItems', base.queue.maxItems, 1, 200),
      autoStart: asBool(qu['autoStart'], 'queue.autoStart', base.queue.autoStart),
    },
    repo: {
      gitEnabled: asBool(rp['gitEnabled'], 'repo.gitEnabled', base.repo.gitEnabled),
      maxDiffBytes: asInt(rp['maxDiffBytes'], 'repo.maxDiffBytes', base.repo.maxDiffBytes, 4096, 16 * 1024 ** 2),
      allowOutsideWorkspace: asBool(
        rp['allowOutsideWorkspace'],
        'repo.allowOutsideWorkspace',
        base.repo.allowOutsideWorkspace,
      ),
      github: {
        enabled: asBool(gh['enabled'], 'repo.github.enabled', base.repo.github.enabled),
        token: asText(gh['token'], 'repo.github.token', base.repo.github.token),
        allowlist: asStringArray(gh['allowlist'], 'repo.github.allowlist'),
      },
    },
    plugins: {
      allowRemoteInstall: asBool(
        pl['allowRemoteInstall'],
        'plugins.allowRemoteInstall',
        base.plugins.allowRemoteInstall,
      ),
      allowedRegistries,
    },
  }
}

/** 监听地址：'lan' 也要落到具体网卡 IP —— dsh 本人拒绝 0.0.0.0（见技术方案 §5.1）。 */
/**
 * 监听地址。
 *
 * lan 模式绑定 `0.0.0.0`，再用 localAddress 白名单在 upgrade 阶段挡掉不该接受
 * 的来源。这一个选择同时解决三件事：
 *   1. 多网卡：这台机器 en0/en6 同网段但默认路由在 en6，只绑一个地址必然有人连不上
 *   2. IP 变化：DHCP 换地址后不需要重启插件
 *   3. 公网/虚拟网卡暴露：白名单在每次建连时重算，VPN、docker、公网地址都被拒
 *
 * 约束是"白名单必须真的执行"——见 gateway/server.ts 的 upgrade 处理。
 */
export function bindHost(bind: BindMode): string {
  return bind === 'loopback' ? '127.0.0.1' : '0.0.0.0'
}

export { ConfigError }
