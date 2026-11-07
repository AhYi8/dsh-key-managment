/**
 * 密钥管理插件 Web 客户端半区。
 *
 * - 会话页右上角 utilities slot 注册钥匙按钮,弹出悬浮框:
 *   自定义供应商下拉(含取消纳管)、密钥列表(无边框图标按钮,
 *   每行按钮组最左侧圆环余额,tooltip 式明细弹层带立即刷新,
 *   删除走 tooltip 式二次确认)、添加密钥、刷新扫描、可纳管常驻区;
 * - 设置页供应商卡片注册"已纳入管理"徽标;
 * - 插件详情页注册配置卡(plugins.row.config):余额探测开关 + 探测间隔。
 *
 * 数据走 Host 半区的同源 HTTP 路由(POST JSON),不引宿主 UI 原语包,
 * 控件按宿主主题令牌(--dsw-alias-*)自绘。
 */
window.__ModuleLoader__.load({
  id: 'dsh-key-managment',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    /** 16px 线性图标集:path 是 24 视窗的描边路径。 */
    const ICON_PATHS = {
      use: 'M5 12l5 5L20 7',
      rename: 'M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4',
      trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
      plus: 'M12 5v14M5 12h14',
      refresh: 'M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5',
      unlink: 'M9 15l6-6M8.5 8.5L5 5M15.5 15.5L19 19M6 12H3M12 6V3M18 12h3M12 18v3',
      manage: 'M12 3l2.5 5.5L20 9l-4 4 1 6-5-2.7L7 19l1-6-4-4 5.5-.5z',
      key: 'M15 9a4 4 0 1 0-3.5 4L14 15h2v2h2v2h3v-3l-6-6z',
      close: 'M6 6l12 12M18 6L6 18',
      chevron: 'M6 9l6 6 6-6',
      check: 'M5 12l5 5L20 7',
    }

    function Icon(props) {
      return h('svg', {
        width: props.size ?? 15,
        height: props.size ?? 15,
        viewBox: '0 0 24 24',
        'aria-hidden': true,
        style: { display: 'block' },
      }, h('path', {
        d: ICON_PATHS[props.name] ?? '',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }))
    }

    /** 纯图标、无边框按钮:悬停有 title 提示;可选 onMouseDown 供弹层触发器防抖。 */
    function IconButton(props) {
      return h('button', {
        onClick: props.onClick,
        disabled: props.disabled,
        title: props.title,
        'aria-label': props.title,
        onMouseDown: props.onMouseDown,
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 26,
          height: 26,
          borderRadius: 7,
          border: 'none',
          background: props.primary
            ? 'var(--dsw-alias-bg-accent, #4a6cf7)'
            : 'transparent',
          color: props.primary
            ? 'var(--dsw-alias-fg-on-accent, #fff)'
            : props.danger
              ? 'var(--dsw-alias-fg-danger, #e07070)'
              : 'var(--dsw-alias-fg-primary, inherit)',
          cursor: props.disabled ? 'default' : 'pointer',
          opacity: props.disabled ? 0.4 : 1,
          flex: 'none',
          padding: 0,
        },
      }, h(Icon, { name: props.icon }))
    }

    /** 轻量标签(chip)。 */
    function Chip(props) {
      return h('span', {
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          padding: '1px 8px',
          borderRadius: 999,
          fontSize: 11,
          flex: 'none',
          color: props.color ?? 'var(--dsw-alias-fg-tertiary, #999)',
          border: `1px solid ${props.color ?? 'var(--dsw-alias-border-secondary, #444)'}`,
          background: 'transparent',
        },
      }, props.label)
    }

    /** 点击容器外部时触发 onClose(供弹层用)。 */
    function useOutside(open, ref, onClose) {
      useEffect(() => {
        if (!open) return undefined
        const close = (event) => {
          if (ref.current && !ref.current.contains(event.target)) onClose()
        }
        const onKey = (event) => { if (event.key === 'Escape') onClose() }
        document.addEventListener('mousedown', close)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', close)
          document.removeEventListener('keydown', onKey)
        }
      }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
    }

    /**
     * tooltip 式弹层的公共外壳:绝对定位、小尺寸、暗边框,跟随锚点容器。
     * 放在 position:relative 的父容器内,right:0 顶到锚点右缘。
     */
    function Popover(props) {
      const ref = useRef(null)
      useOutside(true, ref, props.onClose)
      return h('div', {
        ref,
        onClick: event => event.stopPropagation(),
        style: {
          position: 'absolute',
          // flip=true 向上弹出:滚动面板底部的行,向下弹会被裁掉且滚不到(审查 P2-6)。
          ...(props.flip
            ? { bottom: 'calc(100% + 6px)' }
            : { top: 'calc(100% + 6px)' }),
          right: props.alignLeft ? undefined : 0,
          left: props.alignLeft ? 0 : undefined,
          zIndex: 80,
          minWidth: props.minWidth ?? 200,
          padding: 10,
          borderRadius: 10,
          border: '1px solid var(--dsw-alias-border-secondary, #333)',
          background: 'var(--dsw-alias-bg-primary, #1b1b1f)',
          color: 'var(--dsw-alias-fg-primary, inherit)',
          boxShadow: '0 6px 20px rgba(0,0,0,0.4)',
          fontSize: 12,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        },
      }, props.children)
    }

    /** 从探测负载读已用百分比(0-100);兼容 usedPercent 与 remainingPercent。 */
    function usedPercentOf(payload) {
      if (payload?.status !== 'ok' || !Array.isArray(payload.windows) || payload.windows.length === 0) {
        return undefined
      }
      const window = payload.windows[0]
      if (typeof window.usedPercent === 'number') return Math.min(100, Math.max(0, window.usedPercent))
      if (typeof window.remainingPercent === 'number') {
        return Math.min(100, Math.max(0, 100 - window.remainingPercent))
      }
      return undefined
    }

    /** 从探测负载读"剩余百分比"(0-100);适配器报的是已用,取反展示。 */
    function remainingPercentOf(payload) {
      const used = usedPercentOf(payload)
      return used === undefined ? undefined : 100 - used
    }

    /** 剩余额度的分档色:剩余 <10% 红、<30% 黄、否则绿。 */
    function remainingColor(remaining) {
      if (remaining === undefined) return 'var(--dsw-alias-fg-tertiary, #777)'
      return remaining < 10 ? '#d95c5c' : remaining < 30 ? '#d9a13c' : '#4caf78'
    }

    /** 窗口标签的中文映射。 */
    function tierLabel(tier) {
      const labels = {
        five_hour: '5 小时',
        weekly: '每周',
        monthly: '每月',
        session: '会话',
      }
      return labels[tier] ?? String(tier ?? '窗口')
    }

    function formatReset(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '-'
      const diff = ms - Date.now()
      if (diff <= 0) return '-'
      const minutes = Math.round(diff / 60_000)
      return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`
    }

    /**
     * 圆环形余额展示:展示"剩余额度",颜色按剩余分档。
     * 放在按钮组最左侧;点击弹 tooltip 式明细弹层。
     */
    function QuotaRing(props) {
      const [open, setOpen] = useState(false)
      const wrapRef = useRef(null)
      useOutside(open, wrapRef, () => setOpen(false))
      const payload = props.payload
      // 展示语义与 token-usage 一致:环与数字都是"剩余额度"。
      const remaining = remainingPercentOf(payload)
      const remainingRatio = remaining !== undefined ? remaining / 100 : undefined
      const radius = 7
      const circumference = 2 * Math.PI * radius
      const color = remainingColor(remaining)
      const title = payload === undefined
        ? props.t('quotaLoading')
        : payload.status === 'ok' && remaining !== undefined
          ? `${props.t('quotaRemaining')} ${Math.round(remaining)}%`
          : payload.status === 'unsupported'
            ? props.t('quotaUnsupported')
            : payload.status === 'error'
              ? `${props.t('quotaError')}: ${payload.error?.message ?? ''}`
              : props.t('quotaLoading')
      return h('div', { ref: wrapRef, style: { position: 'relative', display: 'inline-flex', flex: 'none' } },
        h('button', {
          onClick: () => setOpen(value => !value),
          disabled: props.disabled,
          title,
          'aria-label': title,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 22,
            height: 22,
            borderRadius: '50%',
            border: 'none',
            background: 'transparent',
            padding: 0,
            cursor: props.disabled ? 'default' : 'pointer',
          },
        }, h('svg', { width: 18, height: 18, viewBox: '0 0 18 18', 'aria-hidden': true },
          h('circle', {
            cx: 9, cy: 9, r: radius, fill: 'none',
            stroke: 'var(--dsw-alias-border-secondary, #333)',
            strokeWidth: 2.5,
            strokeDasharray: payload?.status === 'error' ? '2 3' : undefined,
          }),
          remainingRatio !== undefined ? h('circle', {
            cx: 9, cy: 9, r: radius, fill: 'none',
            stroke: color,
            strokeWidth: 2.5,
            strokeLinecap: 'round',
            strokeDasharray: `${remainingRatio * circumference} ${circumference}`,
            transform: 'rotate(-90 9 9)',
          }) : null,
          remaining !== undefined
            ? h('text', {
              x: 9, y: 9, textAnchor: 'middle', dominantBaseline: 'central',
              fontSize: 5.5, fill: color,
            }, String(Math.round(remaining)))
            : payload?.status === 'unsupported'
              ? h('text', {
                x: 9, y: 9, textAnchor: 'middle', dominantBaseline: 'central',
                fontSize: 8, fill: 'var(--dsw-alias-fg-tertiary, #777)',
              }, '?')
              : null,
        )),
        // tooltip 式明细弹层:列各窗口用量 + 立即刷新(纯图标)。
        open ? h(Popover, { minWidth: 230, flip: props.flip, onClose: () => setOpen(false) },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            h('strong', null, `${props.alias} · ${props.t('quota')}`),
            h('div', { style: { flex: 1 } }),
            h(IconButton, {
              icon: 'refresh',
              title: props.t('quotaRefresh'),
              disabled: props.refreshing,
              onClick: () => props.onRefresh?.(),
            })),
          payload?.fetchedAt !== undefined
            ? h('div', { style: { opacity: 0.55, fontSize: 11 } },
              `${props.t('quotaFetchedAt')}: ${new Date(payload.fetchedAt).toLocaleTimeString()}`)
            : null,
          payload === undefined
            ? h('div', { style: { opacity: 0.7 } }, props.t('quotaLoading'))
            : payload.status === 'ok'
              ? (payload.windows ?? []).map((window, index) => {
                const used = typeof window.usedPercent === 'number'
                  ? window.usedPercent
                  : typeof window.remainingPercent === 'number' ? window.remainingPercent : undefined
                // 与环一致:展示剩余;usedPercent 是已用,取反。
                const remaining = used === undefined
                  ? undefined
                  : typeof window.usedPercent === 'number' ? 100 - used : used
                const barColor = remainingColor(remaining)
                return h('div', { key: window.tier ?? index, style: { display: 'flex', flexDirection: 'column', gap: 3 } },
                  h('div', { style: { display: 'flex', justifyContent: 'space-between' } },
                    h('span', null, `${tierLabel(window.tier)} ${props.t('quotaRemaining')}`),
                    h('strong', null, remaining === undefined ? '-' : `${Math.round(remaining)}%`)),
                  h('div', {
                    style: {
                      height: 4, borderRadius: 2,
                      background: 'var(--dsw-alias-border-secondary, #333)',
                      overflow: 'hidden',
                    },
                  }, h('div', {
                    style: {
                      height: '100%',
                      width: `${Math.min(100, remaining ?? 0)}%`,
                      background: barColor,
                    },
                  })),
                  h('div', { style: { opacity: 0.6 } }, `${formatReset(window.resetAt)} ${t('resetSuffix')}`))
              })
              : h('div', { style: { opacity: 0.75 } },
                payload.status === 'unsupported'
                  ? props.t('quotaUnsupported')
                  : `${props.t('quotaError')}:${payload.error?.message ?? t('unknownError')}`),
        ) : null,
      )
    }

    /** tooltip 式二次确认弹层:确认/取消都是纯图标。flip 决定向上/向下弹出。 */
    function ConfirmPopover(props) {
      return h(Popover, { minWidth: 190, alignLeft: props.alignLeft, flip: props.flip, onClose: props.onCancel },
        h('div', null, props.message),
        h('div', { style: { display: 'flex', gap: 6, justifyContent: 'flex-end' } },
          h(IconButton, {
            icon: 'check',
            title: props.confirmLabel,
            primary: true,
            disabled: props.busy,
            onClick: props.onConfirm,
          }),
          h(IconButton, { icon: 'close', title: t('cancel'), onClick: props.onCancel })))
    }

    /** 小型文本输入行。 */
    function TextField(props) {
      return h('input', {
        type: props.type ?? 'text',
        value: props.value,
        placeholder: props.placeholder,
        onChange: event => props.onChange(event.target.value),
        onKeyDown: event => {
          if (event.key === 'Enter' && props.onEnter) props.onEnter()
        },
        style: {
          flex: '1',
          minWidth: 0,
          padding: '4px 8px',
          fontSize: 12,
          borderRadius: 6,
          border: '1px solid var(--dsw-alias-border-secondary, #333)',
          background: 'var(--dsw-alias-bg-secondary, transparent)',
          color: 'var(--dsw-alias-fg-primary, inherit)',
          outline: 'none',
        },
      })
    }

    /**
     * 自定义供应商下拉:非原生 select;每个已纳管供应商条目右侧带
     * 取消纳管图标(点击弹 tooltip 确认)。
     */
    function ProviderDropdown(props) {
      const [open, setOpen] = useState(false)
      const [confirming, setConfirming] = useState(null)
      const wrapRef = useRef(null)
      useOutside(open, wrapRef, () => { setOpen(false); setConfirming(null) })
      const current = props.providers.find(entry => entry.provider === props.value)
      return h('div', { ref: wrapRef, style: { position: 'relative' } },
        h('button', {
          onClick: () => setOpen(value => !value),
          style: {
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '5px 8px',
            fontSize: 12,
            borderRadius: 6,
            border: '1px solid var(--dsw-alias-border-secondary, #333)',
            background: 'var(--dsw-alias-bg-secondary, transparent)',
            color: 'var(--dsw-alias-fg-primary, inherit)',
            cursor: 'pointer',
          },
        },
        h(Icon, { name: 'key', size: 12 }),
        h('span', { style: { flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis' } },
          current ? `${current.displayName}(${current.keyCount})` : '-'),
        h(Icon, { name: 'chevron', size: 12 })),
        // 展开式内联列表:撑开布局,不覆盖下方内容。
        open ? h('div', {
          style: {
            marginTop: 6,
            padding: 4,
            borderRadius: 8,
            border: '1px solid var(--dsw-alias-border-secondary, #333)',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          },
        },
        props.providers.map(entry => h('div', {
          key: entry.provider,
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 6px',
            borderRadius: 6,
            background: entry.provider === props.value
              ? 'var(--dsw-alias-bg-tertiary, rgba(128,128,128,0.12))'
              : 'transparent',
          },
        },
        h('button', {
          onClick: () => { props.onSelect(entry.provider); setOpen(false) },
          style: {
            flex: 1, textAlign: 'left', border: 'none', background: 'transparent',
            color: 'inherit', cursor: 'pointer', fontSize: 12, padding: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          },
        }, `${entry.displayName}(${entry.keyCount})`),
        h(IconButton, {
          icon: 'unlink',
          title: props.t('removeProvider'),
          danger: true,
          disabled: props.busy,
          // 阻止 mousedown 冒泡:确认弹层的 outside-close 否则会先关闭、click 又重开,抖动关不掉。
          onMouseDown: event => event.stopPropagation(),
          onClick: () => setConfirming(confirming === entry.provider ? null : entry.provider),
        }),
        // 确认弹层锚定在整块列表左上,贴近所点的行。
        confirming === entry.provider
          ? h(ConfirmPopover, {
            alignLeft: true,
            message: props.t('confirmRemove'),
            confirmLabel: props.t('removeProvider'),
            busy: props.busy,
            onConfirm: () => props.onRemove(entry.provider),
            onCancel: () => setConfirming(null),
          })
          : null))) : null,
      )
    }

    /** 同源 API 路径与统一调用;返回数据或抛出错误消息。 */
    const apiPath = '/dsh-key-managment/api'
    async function api(action, params = {}) {
      const response = await fetch(apiPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...params }),
      })
      const payload = await response.json().catch(() => null)
      if (payload === null || payload.ok !== true) {
        throw new Error(payload?.error ?? `请求失败(${response.status})`)
      }
      return payload
    }

    /**
     * 模式选择器:触发按钮 + 内联展开列表,替代原生 select 的样式。
     * 列表绝对定位(小面板、浮在参数行上方),不挤占布局。
     */
    function ModePicker(props) {
      const [open, setOpen] = useState(false)
      const wrapRef = useRef(null)
      useOutside(open, wrapRef, () => setOpen(false))
      const current = props.options.find(option => option.value === props.value)
      return h('div', { ref: wrapRef, style: { position: 'relative', display: 'inline-flex' } },
        h('button', {
          onClick: () => setOpen(value => !value),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '3px 8px',
            fontSize: 12,
            borderRadius: 6,
            border: '1px solid var(--dsw-alias-border-secondary, #333)',
            background: 'var(--dsw-alias-bg-secondary, transparent)',
            color: 'var(--dsw-alias-fg-primary, inherit)',
            cursor: 'pointer',
          },
        },
        current?.label ?? '-',
        h(Icon, { name: 'chevron', size: 11 })),
        open ? h('div', {
          onClick: event => event.stopPropagation(),
          style: {
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            zIndex: 70,
            minWidth: 130,
            padding: 4,
            borderRadius: 8,
            border: '1px solid var(--dsw-alias-border-secondary, #333)',
            background: 'var(--dsw-alias-bg-primary, #1b1b1f)',
            color: 'var(--dsw-alias-fg-primary, inherit)',
            boxShadow: '0 6px 20px rgba(0,0,0,0.4)',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          },
        },
        props.options.map(option => h('button', {
          key: option.value,
          onClick: () => { props.onChange(option.value); setOpen(false) },
          style: {
            textAlign: 'left',
            padding: '4px 8px',
            fontSize: 12,
            borderRadius: 6,
            border: 'none',
            background: option.value === props.value
              ? 'var(--dsw-alias-bg-tertiary, rgba(128,128,128,0.12))'
              : 'transparent',
            color: 'var(--dsw-alias-fg-primary, inherit)',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          },
        }, option.label))) : null,
      )
    }

    /** 悬浮框主体;props.align 决定面板展开方向(left=向右展开/默认 right)。 */
    function PoolPanel(props) {
      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const [provider, setProvider] = useState('')
      const [newValue, setNewValue] = useState('')
      const [newAlias, setNewAlias] = useState('')
      const [renaming, setRenaming] = useState(null)
      const [renameValue, setRenameValue] = useState('')
      const [confirmDelete, setConfirmDelete] = useState(null)
      /** 批量添加:展开状态、粘贴文本与导入结果。 */
      const [batchOpen, setBatchOpen] = useState(false)
      const [batchText, setBatchText] = useState('')
      const [batchResult, setBatchResult] = useState(null)
      /** keyId → 余额探测负载;undefined 表示尚未探测。 */
      const [quotas, setQuotas] = useState({})
      /** 正在刷新的密钥 id。 */
      const [refreshingKey, setRefreshingKey] = useState(null)
      const mounted = useRef(true)
      useEffect(() => () => { mounted.current = false }, [])

      const run = useCallback(async (fn) => {
        setBusy(true)
        setError('')
        try {
          const next = await fn()
          if (mounted.current) setState(next)
          return true
        } catch (cause) {
          // 返回成功布尔:调用方的 .then 只有在真正成功时才做清空/关编辑器,
          // 失败时保留用户输入(审查 P1-3)。
          if (mounted.current) setError(cause?.message ?? String(cause))
          return false
        } finally {
          if (mounted.current) setBusy(false)
        }
      }, [])

      const act = (action, params) => run(async () => {
        const next = await api(action, { provider, ...params })
        if (next.focus) setProvider(next.focus)
        return next
      })

      useEffect(() => {
        run(() => api('getState'))
      }, [run])

      // 视图返回后校正当前选中的供应商。
      useEffect(() => {
        if (state === null) return
        const names = state.providers.map(entry => entry.provider)
        if (names.length === 0) { setProvider(''); return }
        const wanted = state.focus ?? provider
        setProvider(names.includes(wanted) ? wanted : names[0])
      }, [state]) // eslint-disable-line react-hooks/exhaustive-deps

      const current = state?.providers?.find(entry => entry.provider === provider) ?? null

      // 余额来自 getState 下发的持久化快照(后台定时探测维护);
      // 打开弹窗/切换供应商零探测,避免触发厂商限流。
      // 全量重建而非合并:删除密钥/取消纳管后旧条目必须消失(审查 P2-8)。
      useEffect(() => {
        if (state === undefined || state === null) return
        if (state.quotas === undefined || state.quotas === null) return
        const map = {}
        for (const [cacheKey, payload] of Object.entries(state.quotas)) {
          const keyId = cacheKey.split('/')[1]
          if (keyId !== undefined) map[keyId] = payload
        }
        setQuotas(map)
      }, [state]) // eslint-disable-line react-hooks/exhaustive-deps

      /** 立即刷新一把密钥的余额(force 绕过缓存)。 */
      const refreshQuota = (keyId) => {
        setRefreshingKey(keyId)
        api('quotaKey', { provider, keyId, force: true })
          .then((next) => {
            if (mounted.current && next.ok) {
              setQuotas(prev => ({ ...prev, [keyId]: next.payload }))
            }
          })
          .catch(() => { /* 保持旧值 */ })
          .finally(() => { if (mounted.current) setRefreshingKey(null) })
      }

      const valueNote = (key) => (key.valueMissing ? ` (${t('noValue')})` : '')

      /* ---------------- 区块(数组式构建,避免深层嵌套的括号歧义) ---------------- */

      const headerBlock = h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        h('strong', { style: { fontSize: 13 } }, t('title')),
        h('div', { style: { flex: 1 } }),
        h(IconButton, { icon: 'refresh', title: t('refresh'), disabled: busy, onClick: () => act('refresh') }))

      const errorBlock = error
        ? h('div', {
          style: {
            padding: '4px 8px',
            borderRadius: 6,
            background: 'var(--dsw-alias-bg-danger, rgba(200,60,60,0.15))',
            color: 'var(--dsw-alias-fg-danger, #e07070)',
          },
        }, `${t('error')}: ${error}`)
        : null

      const dropdownBlock = state && state.providers.length > 0
        ? h(ProviderDropdown, {
          providers: state.providers,
          value: provider,
          busy,
          t,
          onSelect: setProvider,
          onRemove: (name) => act('removeProvider', { provider: name }),
        })
        : null

      // 当前生效密钥卡片
      let currentBlock = null
      if (current) {
        let content
        if (current.unknown !== null) {
          content = h(React.Fragment, null,
            h('span', null, `${t('unknownKey')}(…${current.unknown.tail})`),
            h('div', { style: { flex: 1 } }),
            h(IconButton, {
              icon: 'plus',
              title: t('adopt'),
              disabled: busy,
              onClick: () => act('adoptCurrentKey'),
            }))
        } else {
          const active = current.keys.find(key => key.id === current.activeKeyId)
          content = h('span', null, active ? active.alias + valueNote(active) : '-')
        }
        currentBlock = h('div', {
          style: {
            padding: '6px 8px',
            borderRadius: 8,
            background: 'var(--dsw-alias-bg-tertiary, rgba(128,128,128,0.08))',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          },
        },
        h('span', { style: { opacity: 0.7 } }, `${t('currentKey')}:`),
        content)
      }

      // 密钥列表:每行 = 名称 + 生效中标签 + 按钮组(圆环/使用/改名/删除)
      const keyRows = current
        ? current.keys.map((key, keyIndex) => {
          const rowStyle = {
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '3px 4px',
            borderRadius: 8,
            border: key.id === current.activeKeyId && current.unknown === null
              ? '1px solid var(--dsw-alias-border-accent, #4a6cf7)'
              : '1px solid transparent',
          }
          if (renaming === key.id) {
            const input = h(TextField, {
              value: renameValue,
              onChange: setRenameValue,
              onEnter: () => act('renameKey', { keyId: key.id, alias: renameValue }).then(ok => { if (ok) setRenaming(null) }),
            })
            const okButton = h(IconButton, {
              icon: 'check',
              title: t('ok'),
              disabled: busy,
              onClick: () => act('renameKey', { keyId: key.id, alias: renameValue }).then(ok => { if (ok) setRenaming(null) }),
            })
            const cancelButton = h(IconButton, { icon: 'close', title: t('cancel'), onClick: () => setRenaming(null) })
            return h('div', { key: key.id, style: rowStyle }, input, okButton, cancelButton)
          }
          const nameLabel = h('span', {
            style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            title: key.alias,
          }, key.alias + valueNote(key))
          const activeChip = key.id === current.activeKeyId && current.unknown === null
            ? h(Chip, { label: t('active'), color: 'var(--dsw-alias-fg-tertiary, #999)' })
            : null
          // 健康状态徽章:有效(绿)/限流(黄,含冷却剩余)/无效(红)/未知(灰)。
          const healthInfo = {
            ok: { label: t('healthOk'), color: '#4caf78' },
            limited: { label: key.limited ? `${t('healthLimited')} ${formatReset(key.cooldownUntil)}` : t('healthOk'), color: '#d9a13c' },
            invalid: { label: t('healthInvalid'), color: '#d95c5c' },
            unknown: { label: t('healthUnknown'), color: 'var(--dsw-alias-fg-tertiary, #999)' },
          }[key.health ?? 'unknown']
          const healthChip = key.limited || key.health === 'invalid' || key.health === 'unknown'
            ? h(Chip, { label: healthInfo.label, color: healthInfo.color })
            : null
          // 列表后半段的行,弹层向上翻,避免被滚动面板底部裁掉。
          const flip = keyIndex >= Math.ceil(current.keys.length / 2)
          const ring = h(QuotaRing, {
            payload: quotas[key.id],
            alias: key.alias,
            refreshing: refreshingKey === key.id,
            t,
            flip,
            disabled: quotas[key.id]?.status === 'unsupported',
            onRefresh: () => refreshQuota(key.id),
          })
          const useButton = h(IconButton, {
            icon: 'use',
            title: t('activate'),
            disabled: busy || key.valueMissing,
            primary: true,
            onClick: () => act('activateKey', { keyId: key.id }),
          })
          const renameButton = h(IconButton, {
            icon: 'rename',
            title: t('rename'),
            onClick: () => { setRenaming(key.id); setRenameValue(key.alias) },
          })
          const deleteConfirm = confirmDelete === key.id
            ? h(ConfirmPopover, {
              message: t('confirmDelete'),
              confirmLabel: t('delete'),
              busy,
              flip,
              onConfirm: () => { setConfirmDelete(null); act('deleteKey', { keyId: key.id }) },
              onCancel: () => setConfirmDelete(null),
            })
            : null
          const deleteButton = h(IconButton, {
            icon: 'trash',
            title: t('delete'),
            danger: true,
            disabled: busy,
            // 同 unlink:mousedown 停止冒泡,避免确认弹层"先关后开"抖动。
            onMouseDown: event => event.stopPropagation(),
            onClick: () => setConfirmDelete(confirmDelete === key.id ? null : key.id),
          })
          const buttons = h('div', {
            style: { display: 'inline-flex', alignItems: 'center', gap: 2, flex: 'none' },
          }, ring, useButton, renameButton, deleteConfirm, deleteButton)
          return h('div', { key: key.id, style: rowStyle },
            nameLabel,
            activeChip,
            healthChip,
            h('div', { style: { flex: 1 } }),
            buttons)
        })
        : null

      // 添加单条密钥:密钥 + 名称 + “添加密钥”按钮
      const addKeyBlock = h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
        h(TextField, {
          value: newValue,
          placeholder: t('keyPlaceholder'),
          onChange: setNewValue,
          type: 'password',
        }),
        h(TextField, {
          value: newAlias,
          placeholder: t('aliasPlaceholder'),
          onChange: setNewAlias,
        }),
        h('button', {
          onClick: () => act('addKey', { value: newValue, alias: newAlias })
            .then(ok => { if (ok) { setNewValue(''); setNewAlias('') } }),
          disabled: busy || newValue.trim().length === 0,
          title: t('addKey'),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            flex: 'none',
            padding: '4px 10px',
            fontSize: 12,
            borderRadius: 6,
            border: 'none',
            background: 'var(--dsw-alias-bg-accent, #4a6cf7)',
            color: 'var(--dsw-alias-fg-on-accent, #fff)',
            cursor: busy || newValue.trim().length === 0 ? 'default' : 'pointer',
            opacity: busy || newValue.trim().length === 0 ? 0.45 : 1,
            whiteSpace: 'nowrap',
          },
        }, h(Icon, { name: 'plus', size: 13 }), t('addKey')))

      // 批量添加:展开文本域,每行一个密钥
      const batchToggle = h('button', {
        onClick: () => setBatchOpen(value => !value),
        title: t('batchAdd'),
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: '3px 8px',
          fontSize: 12,
          borderRadius: 6,
          border: '1px solid var(--dsw-alias-border-secondary, #333)',
          background: 'transparent',
          color: 'var(--dsw-alias-fg-primary, inherit)',
          cursor: 'pointer',
        },
      }, h(Icon, { name: 'plus', size: 12 }), t('batchAdd'))

      const batchSummary = batchResult
        ? h('span', {
          style: { fontSize: 11, color: batchResult.failures.length > 0 ? '#d9a13c' : '#4caf78' },
        }, t('batchResult', { added: batchResult.added, failed: batchResult.failures.length }))
        : null

      const batchArea = batchOpen
        ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          h('textarea', {
            value: batchText,
            placeholder: t('batchPlaceholder'),
            onChange: event => setBatchText(event.target.value),
            rows: 4,
            style: {
              width: '100%',
              boxSizing: 'border-box',
              padding: '6px 8px',
              fontSize: 12,
              lineHeight: 1.5,
              borderRadius: 6,
              border: '1px solid var(--dsw-alias-border-secondary, #333)',
              background: 'var(--dsw-alias-bg-secondary, transparent)',
              color: 'var(--dsw-alias-fg-primary, inherit)',
              outline: 'none',
              resize: 'vertical',
              fontFamily: 'inherit',
            },
          }),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            h('button', {
              onClick: () => {
                setBatchResult(null)
                // 走 run:与其它变更动作共用 busy 锁,防止飞行期间并发点击(审查 P1-4)。
                void run(async () => {
                  const next = await api('addKeys', { provider, text: batchText })
                  setBatchResult({ added: next.added ?? 0, failures: next.failures ?? [] })
                  if ((next.added ?? 0) > 0) setBatchText('')
                  return next
                })
              },
              disabled: busy || batchText.trim().length === 0,
              title: t('batchImport'),
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: '3px 10px',
                fontSize: 12,
                borderRadius: 6,
                border: 'none',
                background: 'var(--dsw-alias-bg-accent, #4a6cf7)',
                color: 'var(--dsw-alias-fg-on-accent, #fff)',
                cursor: 'pointer',
                opacity: batchText.trim().length === 0 ? 0.45 : 1,
              },
            }, t('batchImport')),
            h('div', { style: { flex: 1 } }),
            h(IconButton, {
              icon: 'close',
              title: t('batchClose'),
              onClick: () => { setBatchOpen(false); setBatchText(''); setBatchResult(null) },
            })),
          batchResult && batchResult.failures.length > 0
            ? h('div', {
              style: {
                maxHeight: 110,
                overflowY: 'auto',
                padding: '4px 6px',
                borderRadius: 6,
                background: 'var(--dsw-alias-bg-tertiary, rgba(128,128,128,0.08))',
                fontSize: 11,
                opacity: 0.85,
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
              },
            }, batchResult.failures.map(failure => h('div', { key: failure.line },
              t('batchFailedLine', { line: failure.line, reason: failure.reason }))))
            : null)
        : null

      const batchBlock = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
          batchToggle,
          h('div', { style: { flex: 1 } }),
          batchSummary),
        batchArea)

      // 可纳管供应商:常驻区
      const availableBlock = state && state.available.length > 0
        ? h('div', {
          style: {
            borderTop: '1px solid var(--dsw-alias-border-secondary, #333)',
            paddingTop: 8,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          },
        },
        h('div', { style: { opacity: 0.8 } }, `${t('available')}:`),
        state.available.map(entry => {
          const manageButton = h(IconButton, {
            icon: 'manage',
            title: t('manage'),
            disabled: busy,
            onClick: () => run(async () => {
              const next = await api('adoptProvider', { provider: entry.provider })
              setProvider(entry.provider)
              return next
            }),
          })
          const label = h('span', {
            style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' },
          }, entry.displayName)
          const icon = h(Icon, { name: 'key', size: 13 })
          return h('div', {
            key: entry.provider,
            style: { display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' },
          }, icon, label, manageButton)
        }))
        : null

      // 自动轮换设置:模式选择 + 参数 + 立即轮换
      const rotationBlock = current
        ? (() => {
          const rotation = current.rotation ?? { mode: 'off', intervalMs: 1_800_000, requests: 50 }
          const modes = [
            { value: 'off', label: t('rotationOff') },
            { value: 'interval', label: t('rotationInterval') },
            { value: 'calls', label: t('rotationCalls') },
          ]
          // 非受控输入(defaultValue):受控组件不配 onChange 会被 React 锁成只读。
          // key 绑定当前值:轮换配置被其它途径改动时输入框随之刷新。
          const numberInput = (value, onApply) => h('input', {
            key: `${value}`,
            type: 'number',
            min: 1,
            defaultValue: value,
            onBlur: event => {
              const parsed = Number(event.target.value)
              if (Number.isFinite(parsed) && parsed >= 1) onApply(parsed)
            },
            onKeyDown: event => {
              if (event.key === 'Enter') {
                const parsed = Number(event.target.value)
                if (Number.isFinite(parsed) && parsed >= 1) onApply(parsed)
              }
            },
            style: {
              width: 64,
              padding: '3px 6px',
              fontSize: 12,
              borderRadius: 6,
              border: '1px solid var(--dsw-alias-border-secondary, #333)',
              background: 'var(--dsw-alias-bg-secondary, transparent)',
              color: 'var(--dsw-alias-fg-primary, inherit)',
              outline: 'none',
            },
          })
          return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
              h('span', { style: { opacity: 0.7 } }, `${t('rotation')}:`),
              h(ModePicker, {
                value: rotation.mode,
                options: modes,
                t,
                onChange: value => act('setRotation', { mode: value }),
              }),
              rotation.mode === 'interval'
                ? h(React.Fragment, null,
                  numberInput(Math.round(rotation.intervalMs / 60_000), minutes => {
                    act('setRotation', { intervalMs: minutes * 60_000 })
                  }),
                  h('span', { style: { opacity: 0.6 } }, t('rotationMinutes')))
                : null,
              rotation.mode === 'calls'
                ? h(React.Fragment, null,
                  t('rotationEvery'),
                  numberInput(rotation.requests, count => {
                    act('setRotation', { requests: count })
                  }),
                  h('span', { style: { opacity: 0.6 } }, t('rotationCallsUnit')))
                : null,
              h('div', { style: { flex: 1 } }),
              h(IconButton, {
                icon: 'refresh',
                title: t('rotateNow'),
                disabled: busy,
                onClick: () => act('rotateNow'),
              })))
        })()
        : null

      /* ---------------- 组装面板 ---------------- */

      const children = []
      children.push(headerBlock)
      if (errorBlock) children.push(errorBlock)
      if (state === null) {
        children.push(h('div', { style: { opacity: 0.7 } }, t('loading')))
      } else {
        if (state.providers.length > 0) {
          children.push(dropdownBlock)
          if (currentBlock) children.push(currentBlock)
          if (keyRows) children.push(keyRows)
          children.push(addKeyBlock)
          children.push(batchBlock)
          if (rotationBlock) children.push(rotationBlock)
        }
        if (availableBlock) children.push(availableBlock)
      }

      return h('div', {
        style: {
          position: 'absolute',
          top: 'calc(100% + 6px)',
          // 对齐方向:头部按钮(right,贴屏幕右缘)与侧栏按钮(left,向右展开)不同。
          ...(props.align === 'left' ? { left: 0 } : { right: 0 }),
          width: 390,
          maxHeight: 540,
          overflowY: 'auto',
          zIndex: 60,
          padding: 12,
          borderRadius: 10,
          border: '1px solid var(--dsw-alias-border-secondary, #333)',
          background: 'var(--dsw-alias-bg-primary, #1b1b1f)',
          color: 'var(--dsw-alias-fg-primary, inherit)',
          boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          fontSize: 12,
        },
        onClick: event => event.stopPropagation(),
      }, children)
    }

    /** 头部工具按钮 + 悬浮框容器;align 决定面板展开方向。 */
    function PoolButton(props) {
      const [open, setOpen] = useState(false)
      const containerRef = useRef(null)
      useOutside(open, containerRef, () => setOpen(false))
      return h('div', { ref: containerRef, style: { position: 'relative', display: 'inline-flex' } },
        h('button', {
          onClick: () => setOpen(value => !value),
          title: t('buttonLabel'),
          'aria-label': t('buttonLabel'),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 28,
            height: 28,
            borderRadius: 8,
            border: 'none',
            background: 'transparent',
            color: 'var(--dsw-alias-fg-primary, inherit)',
            cursor: 'pointer',
          },
        },
        h(Icon, { name: 'key', size: 16 })),
        open ? h(PoolPanel, { align: props.align }) : null,
      )
    }

    /** 侧栏常驻入口:面板向右展开。 */
    function SidebarPoolButton() {
      return h(PoolButton, { align: 'left' })
    }

    /**
     * 设置页供应商卡片内的"已纳入管理"徽标。
     * props.provider.provider 是该卡片的供应商路由键(由宿主派发)。
     */
    function ManagedBadge(props) {
      const providerId = props?.provider?.provider
      const [state, setState] = useState(null)
      useEffect(() => {
        let cancelled = false
        api('getState')
          .then(next => { if (!cancelled) setState(next) })
          .catch(() => { /* 徽标静默 */ })
        return () => { cancelled = true }
      }, [])
      if (providerId === undefined || state === null) return null
      const managed = state.providers?.find(entry => entry.provider === providerId)
      if (managed === undefined) return null
      return h('div', {
        role: 'note',
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '2px 8px',
          borderRadius: 999,
          fontSize: 11,
          border: '1px solid var(--dsw-alias-border-accent, #4a6cf7)',
          color: 'var(--dsw-alias-fg-accent, #7c8cf8)',
          background: 'var(--dsw-alias-bg-accent, rgba(74,108,247,0.12))',
        },
        title: t('managedHint'),
      },
      h(Icon, { name: 'key', size: 11 }),
      h('span', null, `${t('managedBadge')} · ${managed.keyCount}`))
    }

    /** 插件详情页配置卡:探测开关 + 后台间隔 + 组内间隔。 */
    function ConfigCard() {
      const [values, setValues] = useState(null)
      const [error, setError] = useState('')
      const [saved, setSaved] = useState(false)
      const mounted = useRef(true)
      // 卸载守卫:异步回包晚于卸载时不再 setState(审查 P2-7)。
      useEffect(() => () => { mounted.current = false }, [])
      useEffect(() => {
        let cancelled = false
        api('getConfig')
          .then(next => {
            if (!cancelled) setValues({
              quotaProbe: next.quotaProbe,
              quotaIntervalMs: next.quotaIntervalMs,
              quotaProbeGapMs: next.quotaProbeGapMs,
            })
          })
          .catch(cause => { if (!cancelled) setError(cause?.message ?? String(cause)) })
        return () => { cancelled = true }
      }, [])
      const save = async (patch) => {
        setError('')
        setSaved(false)
        try {
          const next = await api('setConfig', patch)
          if (mounted.current) setValues({
            quotaProbe: next.quotaProbe,
            quotaIntervalMs: next.quotaIntervalMs,
            quotaProbeGapMs: next.quotaProbeGapMs,
          })
          if (mounted.current) setSaved(true)
        } catch (cause) {
          if (mounted.current) setError(cause?.message ?? String(cause))
        }
      }
      const numberStyle = {
        width: 90,
        padding: '4px 8px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-secondary, #333)',
        background: 'var(--dsw-alias-bg-secondary, transparent)',
        color: 'var(--dsw-alias-fg-primary, inherit)',
      }
      return h('div', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          padding: 12,
          fontSize: 12,
        },
      },
      h('strong', { style: { fontSize: 13 } }, t('configTitle')),
      error ? h('div', { style: { color: 'var(--dsw-alias-fg-danger, #e07070)' } }, error) : null,
      values === null
        ? h('div', { style: { opacity: 0.7 } }, t('loading'))
        : h(React.Fragment, null,
          // 开关:余额探测
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' } },
            h('input', {
              type: 'checkbox',
              checked: values.quotaProbe === true,
              onChange: event => save({ quotaProbe: event.target.checked }),
            }),
            h('span', null, t('configQuotaProbe'))),
          // 数字:后台探测轮间隔(分钟);清空/非法时钳回服务端下限 1 分钟(审查 P1-2)。
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('span', null, t('configInterval')),
            h('input', {
              type: 'number',
              min: 1,
              max: 1440,
              step: 1,
              value: Math.max(1, Math.round(values.quotaIntervalMs / 60_000)),
              disabled: values.quotaProbe !== true,
              onChange: event => setValues(prev => ({
                ...prev,
                quotaIntervalMs: Math.max(60_000, (Number(event.target.value) || 1) * 60_000),
              })),
              onBlur: () => save({ quotaIntervalMs: values.quotaIntervalMs }),
              style: numberStyle,
            })),
          // 数字:组内间隔(毫秒);清空时钳回 200 下限。
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('span', null, t('configGap')),
            h('input', {
              type: 'number',
              min: 200,
              max: 60000,
              step: 100,
              value: values.quotaProbeGapMs,
              disabled: values.quotaProbe !== true,
              onChange: event => setValues(prev => ({ ...prev, quotaProbeGapMs: Math.max(200, Number(event.target.value) || 200) })),
              onBlur: () => save({ quotaProbeGapMs: values.quotaProbeGapMs }),
              style: numberStyle,
            }),
            h('span', { style: { opacity: 0.6 } }, 'ms')),
          saved ? h('span', { style: { color: '#4caf78' } }, t('configSaved')) : null))
    }

    /** 设置页 models footer 的入口提示行。 */
    function SettingsHint() {
      return h('div', {
        style: {
          padding: '8px 12px',
          fontSize: 12,
          opacity: 0.75,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        },
      },
      h(Icon, { name: 'key', size: 13 }),
      t('settingsHint'))
    }

    // 中英文字典;apply 时注册到 locale 服务。
    const DICTS = {
      zh: {
        buttonLabel: '密钥池',
        title: '密钥池',
        refresh: '刷新扫描',
        currentKey: '当前生效',
        unknownKey: '未纳入管理的密钥',
        adopt: '纳入池',
        addKey: '添加密钥',
        keyPlaceholder: '粘贴 API 密钥',
        batchAdd: '批量添加',
        batchPlaceholder: '每行一个密钥;可用「名称|密钥」指定名称',
        batchImport: '导入',
        batchClose: '关闭',
        batchResult: '成功 {added} 把,失败 {failed} 行',
        batchFailedLine: '第 {line} 行:{reason}',
        aliasPlaceholder: '名称',
        activate: '使用',
        rename: '改名',
        delete: '删除',
        removeProvider: '取消纳管',
        empty: '还没有纳管的供应商,点击右上角刷新扫描',
        noValue: '未保存密钥值',
        active: '生效中',
        error: '操作失败',
        settingsHint: '点击会话右上角的钥匙按钮管理密钥池',
        loading: '加载中…',
        confirmDelete: '确认删除这把密钥?',
        confirmRemove: '确认取消纳管?池内记录将被移除,当前生效密钥不受影响',
        available: '可纳管的供应商',
        manage: '纳管',
        managedBadge: '已纳入管理',
        managedHint: '密钥由密钥池统一管理,切换请用会话右上角的钥匙按钮',
        quota: '余额',
        quotaUnsupported: '该供应商暂不支持余额探测',
        quotaError: '探测失败',
        quotaLoading: '正在探测余额…',
        quotaRemaining: '剩余',
        quotaRefresh: '立即刷新',
        quotaFetchedAt: '探测于',
        configTitle: '密钥池设置',
        configQuotaProbe: '启用密钥余额探测',
        configInterval: '后台探测间隔(分钟)',
        configGap: '组内探测间隔',
        configSaved: '已保存',
        rotation: '自动轮换',
        rotationOff: '关闭',
        rotationInterval: '定时轮换',
        rotationCalls: '按调用次数',
        rotationMinutes: '分钟',
        rotationEvery: '每',
        rotationCallsUnit: '次调用后轮换',
        rotateNow: '立即轮换',
        healthOk: '有效',
        healthLimited: '限流',
        healthInvalid: '无效',
        healthUnknown: '未知',
        cancel: '取消',
        ok: '确定',
        resetSuffix: '后重置',
        unknownError: '未知错误',
      },
      en: {
        buttonLabel: 'Key pool',
        title: 'Key pool',
        refresh: 'Refresh scan',
        currentKey: 'Active key',
        unknownKey: 'Unmanaged key',
        adopt: 'Add to pool',
        addKey: 'Add key',
        keyPlaceholder: 'Paste an API key',
        batchAdd: 'Batch add',
        batchPlaceholder: 'One key per line; "name|key" sets the alias',
        batchImport: 'Import',
        batchClose: 'Close',
        batchResult: '{added} added, {failed} failed',
        batchFailedLine: 'Line {line}: {reason}',
        aliasPlaceholder: 'Name',
        activate: 'Use',
        rename: 'Rename',
        delete: 'Delete',
        removeProvider: 'Unmanage',
        empty: 'No managed providers yet; click refresh to scan',
        noValue: 'No key saved',
        active: 'Active',
        error: 'Operation failed',
        settingsHint: 'Use the key button at the top-right of a conversation to manage the key pool',
        loading: 'Loading…',
        confirmDelete: 'Delete this key?',
        confirmRemove: 'Unmanage this provider? Pool records are removed; the live key is untouched',
        available: 'Manageable providers',
        manage: 'Manage',
        managedBadge: 'Managed',
        managedHint: 'Keys are managed by the key pool; switch via the key button in a conversation header',
        quota: 'Quota',
        quotaUnsupported: 'Quota probing is not supported for this provider',
        quotaError: 'Probe failed',
        quotaLoading: 'Probing quota…',
        quotaRemaining: 'remaining',
        quotaRefresh: 'Refresh now',
        quotaFetchedAt: 'Probed at',
        configTitle: 'Key pool settings',
        configQuotaProbe: 'Enable key quota probing',
        configInterval: 'Background interval (minutes)',
        configGap: 'In-round gap',
        configSaved: 'Saved',
        rotation: 'Auto-rotate',
        rotationOff: 'Off',
        rotationInterval: 'By interval',
        rotationCalls: 'By call count',
        rotationMinutes: 'min',
        rotationEvery: 'Every',
        rotationCallsUnit: 'calls',
        rotateNow: 'Rotate now',
        healthOk: 'OK',
        healthLimited: 'Limited',
        healthInvalid: 'Invalid',
        healthUnknown: 'Unknown',
        cancel: 'Cancel',
        ok: 'OK',
        resetSuffix: 'until reset',
        unknownError: 'Unknown error',
      },
    }

    /** 翻译函数;locale 服务不可用时退回字典直查(默认中文)。 */
    let t = (key, params) => {
      const template = DICTS.zh[key] ?? key
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])))
    }

    /**
     * slot 错误边界:内部组件崩溃时只吞掉自己并留日志,
     * 不让单个组件的异常把整个 slot 打白(slot entry crashed)。
     * children 变化时自动复位:否则崩溃一次入口就永久消失(审查 P1-1)。
     */
    class SafeSlot extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      componentDidCatch(error) {
        console.error('[dsh-key-managment] slot 子组件崩溃:', error)
      }

      componentDidUpdate(prevProps) {
        if (this.state.failed && prevProps.children !== this.props.children) {
          this.setState({ failed: false })
        }
      }

      render() {
        return this.state.failed ? null : this.props.children
      }
    }

    /** 包一层 SafeSlot 的便捷函数。 */
    function safe(component) {
      return function SafeWrapper(props) {
        return h(SafeSlot, null, h(component, props))
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // 构建标记:控制台可确认页面加载的是哪一代客户端代码。
        console.info('[dsh-key-managment] client build 2026-11-07.5 (remaining-semantics + safe-slot)')

        // 全局错误捕获:任何未捕获异常/拒绝都打上插件标记,便于定位崩溃点。
        ctx.effect(() => {
          const onError = (event) => {
            console.error('[dsh-key-managment] window error:', event.message, `${event.filename}:${event.lineno}:${event.colno}`, event.error)
          }
          const onRejection = (event) => {
            console.error('[dsh-key-managment] unhandled rejection:', event.reason)
          }
          window.addEventListener('error', onError)
          window.addEventListener('unhandledrejection', onRejection)
          return () => {
            window.removeEventListener('error', onError)
            window.removeEventListener('unhandledrejection', onRejection)
          }
        }, 'dsh-key-managment: 全局错误捕获')

        try {
          ctx.locale.register('dsh-key-managment', 'zh', DICTS.zh)
          ctx.locale.register('dsh-key-managment', 'en', DICTS.en)
        } catch {
          // locale 服务缺字典时保持回退。
        }
        try {
          const translate = ctx.locale.bind('dsh-key-managment')
          t = (key, params) => {
            const served = translate(key, params)
            // locale 服务可能缓存了旧版字典:对新增键它会原样返回键名。
            // 结果为空或等于键名时,回退到内置中文,保证永远是中文文案。
            if (served === undefined || served === null || served === key) {
              const template = DICTS.zh[key] ?? key
              if (params === undefined) return template
              return template.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])))
            }
            return served
          }
        } catch {
          // 保持回退。
        }

        // 会话页右上角工具区:悬浮框入口(仅已创建的会话显示)。
        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'dsh-key-managment',
          order: 50,
        }, safe(PoolButton)))

        // 侧边栏底部(设置旁):全场景常驻入口——新会话草稿态没有 Session,
        // header utilities 不挂载,这里保证任何页面都能打开密钥池。
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'dsh-key-managment-sidebar',
          order: 5,
        }, safe(PoolButton)))

        // 设置页供应商卡片:逐命名空间注册"已纳入管理"徽标。
        ctx.slots.inject('settings.models.provider-card', () => {
          const disposers = [
            'llm-pi-ai',
            'llm-deepseek-api-key',
            'llm-deepseek',
            'llm-deepseek-account',
          ].map(ns => ctx.slots.register(
            { name: 'settings.models.provider-card', key: ns },
            safe(ManagedBadge),
          ))
          return () => {
            for (const dispose of disposers) dispose()
          }
        })

        // 插件详情页配置卡:键 = `<包名>#<行 id>`。
        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: 'dsh-key-managment#dsh-key-managment',
        }, safe(ConfigCard)))

        // 设置页 models footer:入口提示。
        ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
          name: 'settings.models.footer',
          id: 'dsh-key-managment-hint',
          order: 90,
        }, safe(SettingsHint)))
      },
    }
  },
})

