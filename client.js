/**
 * 密钥管理插件 Web 客户端半区。
 *
 * - 会话页右上角 utilities slot 注册钥匙按钮,弹出悬浮框:
 *   自定义供应商下拉(含取消纳管)、密钥列表(无边框图标按钮,
 *   每行按钮组最左侧圆环余额,tooltip 式明细弹层带立即刷新,
 *   删除走 tooltip 式二次确认)、添加密钥、刷新扫描、可纳管常驻区、
 *   后台探测设置(探测开关 + 轮间隔 + 组内间隔,折叠在面板底部);
 * - 设置页供应商卡片注册"已纳入管理"徽标。
 *
 * 数据走 Host 半区的同源 HTTP 路由(POST JSON),不引宿主 UI 原语包,
 * 控件按宿主主题令牌(--dsw-alias-*)自绘。
 */
window.__ModuleLoader__.load({
  id: 'dsh-key-managment',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef, useContext } = React

    /** 窄屏判定断点:手机 Web 视图统一用它,matchMedia 与语义共用一份。 */
    const NARROW_MEDIA_QUERY = '(max-width: 480px)'

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
      tune: 'M4 7h8M16 7h4M4 17h4M12 17h8M14 4v6M8 14v6',
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

    /** 窄屏布局上下文:面板子树内共享"手机布局"状态,控件免逐层传参。 */
    const NarrowContext = React.createContext(false)

    /** 纯图标、无边框按钮:悬停有 title 提示;可选 onMouseDown 供弹层触发器防抖。 */
    function IconButton(props) {
      // 触控目标:窄屏加到 32px,满足手机可点性;桌面保持 26px 紧凑布局。
      const narrow = useContext(NarrowContext)
      const buttonSize = narrow ? 32 : 26
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
          width: buttonSize,
          height: buttonSize,
          borderRadius: 7,
          border: 'none',
          background: props.primary
            ? (props.danger
              ? 'var(--dsw-alias-fg-danger, #e07070)'
              : 'var(--dsw-alias-bg-accent, #4a6cf7)')
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

    /**
     * 窄屏(手机 Web 视图)判断:视口 ≤ 480px 视为移动端布局。
     * matchMedia 不可用或非浏览器环境兜底返回 false,保持桌面行为不变。
     * 多个组件共用同一 media query 实例的监听成本可忽略,不做全局单例。
     */
    function useNarrowScreen() {
      const [narrow, setNarrow] = useState(() => {
        try {
          return window.matchMedia(NARROW_MEDIA_QUERY).matches
        } catch {
          return false
        }
      })
      useEffect(() => {
        let mediaQuery
        try {
          mediaQuery = window.matchMedia(NARROW_MEDIA_QUERY)
        } catch {
          return undefined
        }
        const onChange = (event) => setNarrow(event.matches)
        // 老浏览器无 addEventListener: Safari < 14 用 addListener。
        if (typeof mediaQuery.addEventListener === 'function') {
          mediaQuery.addEventListener('change', onChange)
          return () => mediaQuery.removeEventListener('change', onChange)
        }
        mediaQuery.addListener(onChange)
        return () => mediaQuery.removeListener(onChange)
      }, [])
      return narrow
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
      // 约束:onClose 必须是稳定引用(setState 类)。依赖只留 open 是刻意的,
      // 否则每次父渲染都重绑 document 监听;传依赖渲染期变量的 onClose 会静默失效。
    }

    /**
     * tooltip 式弹层的公共外壳:绝对定位、小尺寸、暗边框,跟随锚点容器。
     * 放在 position:relative 的父容器内,默认 right:0 顶到锚点右缘、向左展开
     * (锚点多在行右侧,左展不会撑破面板)。窄屏只钳宽,不改变对齐方向——
     * 强制左对齐会让行尾弹层向右溢出,把面板顶出横向滚动(真机回归)。
     */
    function Popover(props) {
      const ref = useRef(null)
      useOutside(true, ref, props.onClose)
      // 窄屏宽度:min() 混用单位合法,钳住视口但不超过原 minWidth。
      const narrowWidth = props.narrow
        ? { width: `min(${props.minWidth ?? 200}px, calc(100vw - 32px))`, minWidth: 0 }
        : null
      // 窄屏垂直居中(centered):锚点在行尾,原地弹出容易贴边/被裁,
      // 改为 fixed 相对视口居中;桌面端一律保持原地弹出,不走该分支。
      const centered = props.narrow && props.centered
      return h('div', {
        ref,
        onClick: event => event.stopPropagation(),
        style: {
          ...(centered
            ? {
              position: 'fixed',
              top: '50%',
              left: 8,
              right: 8,
              transform: 'translateY(-50%)',
              maxHeight: '80vh',
              overflowY: 'auto',
              margin: 'auto',
              // left/right 双向约束下宽度由内容撑,钳住上限避免超宽。
              width: 'fit-content',
              maxWidth: 'calc(100vw - 32px)',
            }
            : {
              position: 'absolute',
              // flip=true 向上弹出:滚动面板底部的行,向下弹会被裁掉且滚不到(审查 P2-6)。
              ...(props.flip
                ? { bottom: 'calc(100% + 6px)' }
                : { top: 'calc(100% + 6px)' }),
              right: props.alignLeft ? undefined : 0,
              left: props.alignLeft ? 0 : undefined,
              ...narrowWidth,
            }),
          zIndex: 80,
          minWidth: props.narrow ? undefined : (props.minWidth ?? 200),
          ...narrowWidth,
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
      // 局部变量不要叫 window:会遮蔽全局 window 对象,后续改动极易踩坑。
      const win = payload.windows[0]
      if (typeof win.usedPercent === 'number') return Math.min(100, Math.max(0, win.usedPercent))
      if (typeof win.remainingPercent === 'number') {
        return Math.min(100, Math.max(0, 100 - win.remainingPercent))
      }
      return undefined
    }

    /** 从探测负载读"剩余百分比"(0-100);适配器报的是已用,取反展示。 */
    function remainingPercentOf(payload) {
      const used = usedPercentOf(payload)
      return used === undefined ? undefined : 100 - used
    }

    /**
     * 读余额型窗口(DeepSeek 官方 /user/balance):返回金额与官方可用性。
     * 这类窗口没有百分比,不能套用 usedPercent/remainingPercent 的展示逻辑。
     */
    function balanceWindowOf(payload) {
      if (payload?.status !== 'ok' || !Array.isArray(payload.windows)) return undefined
      const win = payload.windows.find(item => item?.tier === 'balance'
        && typeof item.remainingValue === 'number')
      if (win === undefined) return undefined
      return { value: win.remainingValue, unit: win.unit, available: win.available }
    }

    /** 余额是否已不可用:官方 is_available=false,或余额 ≤0(含透支)。 */
    function isBalanceEmpty(balance) {
      if (balance === undefined) return false
      return balance.available === false || balance.value <= 0
    }

    /** 金额展示:适配器只产出 cny/usd,未知单位按人民币兜底。 */
    function formatAmount(value, unit) {
      const symbol = unit === 'usd' ? '$' : '¥'
      const abs = Math.abs(value)
      // 余额可能只有几分钱,保留两位;上千后小数没有意义,取整避免撑破弹层。
      const text = abs >= 1000 ? abs.toFixed(0) : abs.toFixed(2)
      return `${value < 0 ? '-' : ''}${symbol}${text}`
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
      // 窄屏取值必须在顶层:不能放在条件表达式里,否则违反 Hooks 规则。
      const narrow = useContext(NarrowContext)
      useOutside(open, wrapRef, () => setOpen(false))
      const payload = props.payload
      const balance = balanceWindowOf(payload)
      const balanceEmpty = isBalanceEmpty(balance)
      // 展示语义与 token-usage 一致:环与数字都是"剩余额度"。
      // 余额型窗口没有百分比,环改为金额状态,不能画成 100% 误导用户。
      const remaining = balance === undefined ? remainingPercentOf(payload) : undefined
      const remainingRatio = remaining !== undefined ? remaining / 100 : undefined
      const radius = 7
      const circumference = 2 * Math.PI * radius
      const color = balance !== undefined
        ? (balanceEmpty ? '#d95c5c' : '#4caf78')
        : remainingColor(remaining)
      const amountText = balance === undefined ? undefined : formatAmount(balance.value, balance.unit)
      const title = payload === undefined
        ? props.t('quotaLoading')
        : balance !== undefined
          ? (balanceEmpty ? props.t('quotaBalanceEmpty') : `${props.t('quota')} ${amountText}`)
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
            // 余额不可用时用虚线,与错误态一致,提示"不是百分比进度"。
            strokeDasharray: payload?.status === 'error' || (balance !== undefined && balanceEmpty) ? '2 3' : undefined,
          }),
          // 余额型窗口画整圈表示"已充值";颜色只区分可用(绿)/不足(红),
          // 金额本身在 title 与明细弹层里给出。
          balance !== undefined ? h('circle', {
            cx: 9, cy: 9, r: radius, fill: 'none',
            stroke: color,
            strokeWidth: 2.5,
            strokeLinecap: 'round',
            strokeDasharray: balanceEmpty ? '2 3' : undefined,
          }) : null,
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
            : balance !== undefined
              ? h('text', {
                x: 9, y: 9, textAnchor: 'middle', dominantBaseline: 'central',
                fontSize: 7, fill: color,
              }, balanceEmpty ? '!' : (balance.unit === 'usd' ? '$' : '¥'))
              : payload?.status === 'unsupported'
                ? h('text', {
                  x: 9, y: 9, textAnchor: 'middle', dominantBaseline: 'central',
                  fontSize: 8, fill: 'var(--dsw-alias-fg-tertiary, #777)',
                }, '?')
                : null,
        )),
        // tooltip 式明细弹层:列各窗口用量 + 立即刷新(纯图标)。
        // narrow 从上下文取:手机布局下宽度钳在视口内、左对齐。
        open ? h(Popover, { minWidth: 230, flip: props.flip, narrow, centered: true, onClose: () => setOpen(false) },
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
              ? (payload.windows ?? []).map((win, index) => {
                // 余额型窗口:展示金额与可用性,没有百分比条和重置时间。
                if (win?.tier === 'balance') {
                  const amount = typeof win.remainingValue === 'number'
                    ? formatAmount(win.remainingValue, win.unit)
                    : '-'
                  const empty = win.available === false
                    || (typeof win.remainingValue === 'number' && win.remainingValue <= 0)
                  return h('div', { key: `${win.tier}-${index}`, style: { display: 'flex', flexDirection: 'column', gap: 3 } },
                    h('div', { style: { display: 'flex', justifyContent: 'space-between' } },
                      h('span', null, props.t('quota')),
                      h('strong', { style: { color: empty ? '#d95c5c' : '#4caf78' } }, amount)),
                    empty ? h('div', { style: { opacity: 0.7 } }, props.t('quotaBalanceEmpty')) : null)
                }
                const used = typeof win.usedPercent === 'number'
                  ? win.usedPercent
                  : typeof win.remainingPercent === 'number' ? win.remainingPercent : undefined
                // 与环一致:展示剩余;usedPercent 是已用,取反。
                const remaining = used === undefined
                  ? undefined
                  : typeof win.usedPercent === 'number' ? 100 - used : used
                const barColor = remainingColor(remaining)
                return h('div', { key: win.tier ?? index, style: { display: 'flex', flexDirection: 'column', gap: 3 } },
                  h('div', { style: { display: 'flex', justifyContent: 'space-between' } },
                    h('span', null, `${tierLabel(win.tier)} ${props.t('quotaRemaining')}`),
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
                  h('div', { style: { opacity: 0.6 } }, `${formatReset(win.resetAt)} ${props.t('resetSuffix')}`))
              })
              : h('div', { style: { opacity: 0.75 } },
                payload.status === 'unsupported'
                  ? props.t('quotaUnsupported')
                  : `${props.t('quotaError')}:${payload.error?.message ?? props.t('unknownError')}`),
        ) : null,
      )
    }

    /** tooltip 式二次确认弹层:确认/取消都是纯图标。flip 决定向上/向下弹出。 */
    function ConfirmPopover(props) {
      // 总是渲染在 NarrowContext.Provider 子树内,自读窄屏状态,免调用方逐层透传。
      const narrow = useContext(NarrowContext)
      // 翻译函数自给自足:调用方不传 t 时回退内置中文。此前依赖 props.t,
      // 而三个调用点都没传——确认弹层一渲染就崩,把整个入口槽位拖垮。
      const translate = props.t ?? fallbackText
      // danger:危险操作(如恢复会覆盖整个密钥池)的确认按钮用红色区分,
      // 避免与"纳入池"等良性确认在视觉上无法区分。
      return h(Popover, { minWidth: 190, alignLeft: props.alignLeft, flip: props.flip, narrow, onClose: props.onCancel },
        h('div', null, props.message),
        h('div', { style: { display: 'flex', gap: 6, justifyContent: 'flex-end' } },
          h(IconButton, {
            icon: 'check',
            title: props.confirmLabel,
            primary: true,
            danger: props.danger === true,
            disabled: props.busy,
            onClick: props.onConfirm,
          }),
          h(IconButton, { icon: 'close', title: translate('cancel'), onClick: props.onCancel })))
    }

    /** 小型文本输入行。窄屏加大内边距,保证手机上的触控目标高度。 */
    function TextField(props) {
      const narrow = useContext(NarrowContext)
      return h('input', {
        type: props.type ?? 'text',
        value: props.value,
        placeholder: props.placeholder,
        onChange: event => props.onChange(event.target.value),
        onBlur: props.onBlur,
        onKeyDown: event => {
          if (event.key === 'Enter' && props.onEnter) props.onEnter()
        },
        style: {
          flex: '1',
          minWidth: 0,
          padding: narrow ? '8px 10px' : '4px 8px',
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
        // 窄屏才钳宽截断;桌面保持原有溢出可见行为,不做视觉变化。
        open ? h('div', {
          style: {
            marginTop: 6,
            padding: 4,
            borderRadius: 8,
            border: '1px solid var(--dsw-alias-border-secondary, #333)',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            ...(useContext(NarrowContext)
              ? { maxWidth: '100%', overflow: 'hidden', boxSizing: 'border-box' }
              : null),
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
            // 仅窄屏钳宽:桌面保持原有无上限宽度,长模式名可撑开。
            ...(useContext(NarrowContext)
              ? { maxWidth: 'min(180px, calc(100vw - 32px))' }
              : null),
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

    /** 悬浮框主体。 */
    function PoolPanel() {
      // 手机布局:视口 ≤ 480px 时面板改为近全屏宽,子树通过上下文共享该状态。
      const narrow = useNarrowScreen()
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
      // 卸载守卫:挂载时复位为 true,卸载时置 false。
      // 只在 cleanup 里置 false 是不够的——React 18 StrictMode 会"挂载→卸载→再挂载",
      // 第二次挂载后 mounted.current 会一直停在 false,面板从此不再更新。
      useEffect(() => {
        mounted.current = true
        return () => { mounted.current = false }
      }, [])

      const run = useCallback(async (fn) => {
        setBusy(true)
        setError('')
        try {
          const next = await fn()
          // 视图字段兜底:响应缺 providers/available/quotas 时补空集合,
          // 避免渲染直接抛错把整块面板打白(不变量:响应必须含完整视图字段)。
          const normalized = {
            ...next,
            providers: Array.isArray(next?.providers) ? next.providers : [],
            available: Array.isArray(next?.available) ? next.available : [],
            quotas: next?.quotas ?? {},
          }
          if (mounted.current) setState(normalized)
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
          // 服务端下发的是 `供应商/密钥 id`:按最后一个 '/' 切分,
          // 供应商名里若含 '/' 也不会取错段。
          const keyId = cacheKey.slice(cacheKey.lastIndexOf('/') + 1)
          if (keyId !== undefined && keyId.length > 0) map[keyId] = payload
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
              setError('')
            }
          })
          .catch((cause) => {
            // 失败必须让用户看见:否则圆环停在旧值上,
            // 看起来像"余额没变",实际是探测请求挂了。
            if (mounted.current) setError(cause?.message ?? String(cause))
          })
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
          // 余额型窗口为 0 时显示"余额不足",避免把"账户没钱"误报成"限流"。
          const keyBalance = balanceWindowOf(quotas[key.id])
          const keyBalanceEmpty = isBalanceEmpty(keyBalance)
          const healthInfo = {
            ok: { label: t('healthOk'), color: '#4caf78' },
            limited: {
              label: key.limited
                ? (keyBalanceEmpty ? t('quotaBalanceEmpty') : `${t('healthLimited')} ${formatReset(key.cooldownUntil)}`)
                : t('healthOk'),
              color: keyBalanceEmpty ? '#d95c5c' : '#d9a13c',
            },
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
      // 手机:密钥输入框独占一行,名称与按钮一行——单行三控件在窄屏会被挤到不可用。
      const addKeyButton = h('button', {
        onClick: () => act('addKey', { value: newValue, alias: newAlias })
          .then(ok => { if (ok) { setNewValue(''); setNewAlias('') } }),
        disabled: busy || newValue.trim().length === 0,
        title: t('addKey'),
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          flex: 'none',
          padding: narrow ? '8px 12px' : '4px 10px',
          fontSize: 12,
          borderRadius: 6,
          border: 'none',
          background: 'var(--dsw-alias-bg-accent, #4a6cf7)',
          color: 'var(--dsw-alias-fg-on-accent, #fff)',
          cursor: busy || newValue.trim().length === 0 ? 'default' : 'pointer',
          opacity: busy || newValue.trim().length === 0 ? 0.45 : 1,
          whiteSpace: 'nowrap',
        },
      }, h(Icon, { name: 'plus', size: 13 }), t('addKey'))
      const addKeyFields = h(React.Fragment, null,
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
        }))
      const addKeyBlock = narrow
        ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          addKeyFields,
          h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
            h('div', { style: { flex: 1 } }),
            addKeyButton))
        : h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
          addKeyFields,
          addKeyButton)

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
      // 后台探测设置:与供应商无关,始终挂在面板底部。
      children.push(h(ProbeConfigSection))
      // WebDAV 备份:同样与供应商无关,挂在探测设置之后。
      // onPoolChanged:恢复整体覆盖密钥池后,让面板重拉状态刷新列表。
      children.push(h(BackupSection, { onPoolChanged: () => run(() => api('getState')) }))

      return h(NarrowContext.Provider, { value: narrow }, h('div', {
        style: {
          // 桌面:绝对定位贴按钮右缘,固定 390px。
          // 手机:面板的定位基准是入口按钮的小容器,绝对定位会被它钳宽/算错偏移,
          // 改为 fixed 相对视口:left/right 双向 8px,顶部取按钮底缘实测值。
          ...(narrow
            ? {
              position: 'fixed',
              // 手机:相对可视界面垂直居中,不再贴按钮下方(按钮测量在滚动/
              // 旋转后会漂移);transform 只作用在面板自身,不影响内部弹层。
              top: '50%',
              left: 8,
              right: 8,
              width: 'auto',
              transform: 'translateY(-50%)',
              maxHeight: 'calc(100vh - 24px)',
            }
            : {
              position: 'absolute',
              top: 'calc(100% + 6px)',
              right: 0,
              width: 390,
              maxHeight: 540,
            }),
          overflowY: 'auto',
          // 兜底:overflowY auto 会把横向也变成可滚,一旦子元素超宽就出现
          // 内部横向滚动条、左侧标签被滚出可视区;禁掉横向滚动,超宽裁切。
          overflowX: 'hidden',
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
      }, children))
    }

    /** 头部工具按钮 + 悬浮框容器。 */
    function PoolButton() {
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
        // 错误边界下沉到面板层:面板渲染崩溃只藏面板,入口图标保留——
        // 否则一次崩溃后连面板都打不开,只能刷新整个页面。
        open ? h(SafeSlot, null, h(PoolPanel)) : null,
      )
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

    /**
     * 组内间隔按 100 毫秒取整:schema 限定步长为 100,
     * 用户填 250 这类值会被宿主拒掉并弹出未翻译的英文报错。
     */
    function snapProbeGap(value) {
      const number = Number(value)
      if (!Number.isFinite(number)) return 200
      return Math.min(60_000, Math.max(200, Math.round(number / 100) * 100))
    }

    /**
     * 后台探测设置(收在悬浮框内):探测开关 + 轮间隔 + 组内间隔。
     * 默认折叠:悬浮框主体是密钥列表,探测配置属于低频操作。
     */
    function ProbeConfigSection() {
      const [open, setOpen] = useState(false)
      const [values, setValues] = useState(null)
      const [error, setError] = useState('')
      const [saved, setSaved] = useState(false)
      const mounted = useRef(true)
      // 已落盘确认过的值:与它相同的补丁不再下发——
      // 每次 setConfig 都会写 profile patch 并触发 Loader 复核,徒增重载。
      const confirmed = useRef(null)
      // 是否有保存请求在途:在途时不按"值没变"跳过,
      // 否则连点两次开关时第二次会被误判成重复提交而丢掉。
      const saving = useRef(false)
      // 保存请求的序号:回包乱序时只认最后一次请求的结果,
      // 避免旧回包把新值覆盖回去。
      const seq = useRef(0)
      // 卸载守卫:挂载时复位为 true,卸载时置 false(StrictMode 下会重新挂载)。
      useEffect(() => {
        mounted.current = true
        return () => { mounted.current = false }
      }, [])
      // 展开时才拉配置:打开悬浮框本身不额外发请求。
      useEffect(() => {
        if (!open) return undefined
        let cancelled = false
        api('getConfig')
          .then(next => {
            if (cancelled) return
            confirmed.current = {
              quotaProbe: next.quotaProbe === true,
              quotaIntervalMs: next.quotaIntervalMs,
              quotaProbeGapMs: next.quotaProbeGapMs,
              fallbackOnFailure: next.fallbackOnFailure !== false,
            }
            setValues({
              quotaProbe: next.quotaProbe,
              quotaIntervalMs: next.quotaIntervalMs,
              quotaProbeGapMs: next.quotaProbeGapMs,
              fallbackOnFailure: next.fallbackOnFailure !== false,
            })
          })
          .catch(cause => { if (!cancelled) setError(cause?.message ?? String(cause)) })
        return () => { cancelled = true }
      }, [open])
      const save = async (patch) => {
        // 值没变就不写盘:避免无意义的 profile patch 写入与插件重载。
        if (!saving.current && confirmed.current !== null) {
          const changed = Object.entries(patch).some(([key, value]) => confirmed.current[key] !== value)
          if (!changed) return
        }
        setError('')
        setSaved(false)
        saving.current = true
        const ticket = ++seq.current
        try {
          const next = await api('setConfig', patch)
          if (!mounted.current) return
          // 已有更新的请求在途:这次回包作废,避免用旧值覆盖新值。
          if (ticket !== seq.current) return
          confirmed.current = {
            quotaProbe: next.quotaProbe === true,
            quotaIntervalMs: next.quotaIntervalMs,
            quotaProbeGapMs: next.quotaProbeGapMs,
            fallbackOnFailure: next.fallbackOnFailure !== false,
          }
          setValues({
            quotaProbe: next.quotaProbe,
            quotaIntervalMs: next.quotaIntervalMs,
            quotaProbeGapMs: next.quotaProbeGapMs,
            fallbackOnFailure: next.fallbackOnFailure !== false,
          })
          setSaved(true)
        } catch (cause) {
          if (mounted.current) {
            setError(cause?.message ?? String(cause))
            // 保存失败:回滚到最后一次确认过的值,界面不与服务端状态分叉。
            if (ticket === seq.current && confirmed.current !== null) setValues({ ...confirmed.current })
          }
        } finally {
          saving.current = false
        }
      }
      const numberStyle = {
        width: 78,
        padding: '3px 6px',
        fontSize: 12,
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-secondary, #333)',
        background: 'var(--dsw-alias-bg-secondary, transparent)',
        color: 'var(--dsw-alias-fg-primary, inherit)',
        outline: 'none',
      }
      const toggle = h('button', {
        onClick: () => setOpen(value => !value),
        title: t('probeSettings'),
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '3px 8px',
          fontSize: 12,
          borderRadius: 6,
          border: '1px solid var(--dsw-alias-border-secondary, #333)',
          background: 'transparent',
          color: 'var(--dsw-alias-fg-primary, inherit)',
          cursor: 'pointer',
        },
      },
      h(Icon, { name: 'tune', size: 12 }),
      h('span', { style: { flex: 1, textAlign: 'left' } }, t('probeSettings')),
      h(Icon, { name: 'chevron', size: 11 }))

      // 数组式构建:避免深层嵌套的括号错位。
      const children = [toggle]
      if (open) {
        if (error) {
          children.push(h('div', { style: { color: 'var(--dsw-alias-fg-danger, #e07070)' } }, error))
        }
        if (values === null) {
          // 拉取失败时不再并排显示"加载中…":两者同时出现会让人以为还在等。
          if (error === '') children.push(h('div', { style: { opacity: 0.7 } }, t('loading')))
        } else {
          // 开关:余额探测。先本地翻转再下发,否则受控开关要等回包才动,
          // 连点两次还会因为中间态被 React 复位而"关不掉"。
          children.push(h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' } },
            h('input', {
              type: 'checkbox',
              checked: values.quotaProbe === true,
              onChange: event => {
                const checked = event.target.checked
                setValues(prev => ({ ...prev, quotaProbe: checked }))
                save({ quotaProbe: checked })
              },
            }),
            h('span', null, t('configQuotaProbe'))))
          // 开关:调用失败自动换钥。与探测开关独立——探测关了兜底照样该工作。
          children.push(h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' } },
            h('input', {
              type: 'checkbox',
              checked: values.fallbackOnFailure === true,
              onChange: event => {
                const checked = event.target.checked
                setValues(prev => ({ ...prev, fallbackOnFailure: checked }))
                save({ fallbackOnFailure: checked })
              },
            }),
            h('span', null, t('configFallback'))))
          // 数字:后台探测轮间隔(分钟);清空/非法时钳回服务端下限 1 分钟(审查 P1-2)。
          children.push(h('label', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('span', { style: { flex: 1 } }, t('configInterval')),
            h('input', {
              type: 'number',
              min: 1,
              max: 1440,
              step: 1,
              value: Math.max(1, Math.round(values.quotaIntervalMs / 60_000)),
              disabled: values.quotaProbe !== true,
              onChange: event => setValues(prev => ({
                ...prev,
                // 服务端区间是 1 分钟 ~ 24 小时,这里先钳住,避免把非法值发过去。
                quotaIntervalMs: Math.min(86_400_000, Math.max(60_000, (Number(event.target.value) || 1) * 60_000)),
              })),
              onBlur: () => save({ quotaIntervalMs: values.quotaIntervalMs }),
              style: numberStyle,
            })))
          // 数字:组内间隔(毫秒);清空时钳回 200 下限。
          children.push(h('label', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('span', { style: { flex: 1 } }, t('configGap')),
            h('input', {
              type: 'number',
              min: 200,
              max: 60000,
              step: 100,
              value: values.quotaProbeGapMs,
              disabled: values.quotaProbe !== true,
              // 输入过程中不取整、不钳下限:否则键入 "5" 立刻变成 200,
              // 接着键入 "000" 就成了 2000——想填 5000 根本打不出来。
              onChange: event => setValues(prev => ({
                ...prev,
                quotaProbeGapMs: Math.min(60_000, Math.max(0, Number(event.target.value) || 0)),
              })),
              // 失焦时才按 schema 的步长(100ms 的倍数)取整并下发。
              onBlur: () => {
                const snapped = snapProbeGap(values.quotaProbeGapMs)
                setValues(prev => ({ ...prev, quotaProbeGapMs: snapped }))
                save({ quotaProbeGapMs: snapped })
              },
              style: numberStyle,
            }),
            h('span', { style: { opacity: 0.6 } }, 'ms')))
          if (saved) children.push(h('span', { style: { color: '#4caf78' } }, t('configSaved')))
        }
      }
      return h('div', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          borderTop: '1px solid var(--dsw-alias-border-secondary, #333)',
          paddingTop: 8,
        },
      }, children)
    }

    /**
     * WebDAV 备份面板(收在悬浮框底部):配置 + 手动备份 + 云端备份列表与恢复。
     * 默认折叠:备份是低频操作;展开时才拉取状态与备份列表。
     *
     * @param props.onPoolChanged 恢复会整体覆盖本地密钥池,成功后必须通知
     *   父面板重新拉取状态,否则上方展示的还是恢复前的旧数据。
     */
    function BackupSection(props) {
      const [open, setOpen] = useState(false)
      /** 来自 getConfig 的配置;文本输入的受控值。 */
      const [values, setValues] = useState(null)
      /** 来自 backupStatus 的最近一次备份结果。 */
      const [status, setStatus] = useState(null)
      /** 来自 backupList 的云端备份列表(新到旧)。 */
      const [backups, setBackups] = useState(null)
      const [error, setError] = useState('')
      // 忙碌计数器:并发操作(如恢复进行中又点保存)共用一个布尔会互相
      // 提前解锁,危险操作可能在其完成前重新可点。
      const [busyCount, setBusyCount] = useState(0)
      const busy = busyCount > 0
      const beginTask = () => setBusyCount(count => count + 1)
      const endTask = () => setBusyCount(count => Math.max(0, count - 1))
      const [saved, setSaved] = useState(false)
      /** 恢复成功的独立反馈(与"配置已保存"区分,恢复是覆盖性大事件)。 */
      const [restored, setRestored] = useState(false)
      /** 待确认恢复的备份文件名;null 表示无待确认项。 */
      const [confirmRestore, setConfirmRestore] = useState(null)
      /** 服务端已确认的配置值:失焦时值没变就不发请求,避免路过焦点
       *  也把密码/加密密钥原样上报一次。 */
      const confirmed = useRef(null)
      const mounted = useRef(true)
      useEffect(() => {
        mounted.current = true
        return () => { mounted.current = false }
      }, [])

      /** 拉取备份状态与云端列表;备份未配置时列表请求会报错,静默保留空列表。 */
      const refresh = useCallback(async () => {
        const next = await api('backupStatus')
        if (!mounted.current) return
        setStatus(next.status ?? null)
        try {
          const list = await api('backupList')
          if (mounted.current) setBackups(Array.isArray(list.backups) ? list.backups : [])
        } catch {
          if (mounted.current) setBackups([])
        }
        return next
      }, [])

      useEffect(() => {
        if (!open) return undefined
        let cancelled = false
        // 先拉配置并校验宿主版本,再决定要不要请求备份状态/列表:
        // 旧宿主会把这些请求报成"未知动作",不能让它覆盖版本提示。
        ;(async () => {
          try {
            const next = await api('getConfig')
            if (cancelled) return
            // 旧版宿主不认识备份配置字段:明确提示需要重载插件,
            // 而不是渲染一个永远保存失败、重开就"丢配置"的表单。
            if (next.webdavUrl === undefined) {
              setError(t('backupVersionMismatch'))
              return
            }
            const loaded = {
              webdavEnabled: next.webdavEnabled === true,
              webdavUrl: next.webdavUrl ?? '',
              webdavUsername: next.webdavUsername ?? '',
              webdavPassword: next.webdavPassword ?? '',
              webdavDir: next.webdavDir ?? '',
              webdavEncryptKey: next.webdavEncryptKey ?? '',
              webdavDevice: next.webdavDevice ?? '',
              webdavIntervalMin: next.webdavIntervalMin ?? 60,
              webdavKeep: next.webdavKeep ?? 5,
            }
            confirmed.current = { ...loaded }
            setValues(loaded)
            await refresh()
          } catch (cause) {
            if (!cancelled) setError(cause?.message ?? String(cause))
          }
        })()
        return () => { cancelled = true }
      }, [open, refresh])

      /** 保存一个配置补丁;成功后以服务端确认值为准回填全部字段。 */
      const save = async (patch) => {
        setError('')
        setSaved(false)
        beginTask()
        try {
          const next = await api('setConfig', patch)
          if (!mounted.current) return
          const merged = {
            webdavEnabled: next.webdavEnabled === true,
            webdavUrl: next.webdavUrl ?? '',
            webdavUsername: next.webdavUsername ?? '',
            webdavPassword: next.webdavPassword ?? '',
            webdavDir: next.webdavDir ?? '',
            webdavEncryptKey: next.webdavEncryptKey ?? '',
            webdavDevice: next.webdavDevice ?? '',
            webdavIntervalMin: next.webdavIntervalMin,
            webdavKeep: next.webdavKeep,
          }
          confirmed.current = { ...merged }
          setValues(merged)
          setSaved(true)
        } catch (cause) {
          if (mounted.current) setError(cause?.message ?? String(cause))
        } finally {
          if (mounted.current) endTask()
        }
      }

      /** 手动备份:完成后刷新状态与列表。 */
      const backupNow = async () => {
        setError('')
        beginTask()
        try {
          await api('backupNow')
          await refresh()
        } catch (cause) {
          if (mounted.current) setError(cause?.message ?? String(cause))
        } finally {
          if (mounted.current) endTask()
        }
      }

      /** 恢复指定备份:覆盖本地密钥池,成功后刷新状态并通知父面板重拉池数据。 */
      const restore = async (name) => {
        setConfirmRestore(null)
        setError('')
        setSaved(false)
        beginTask()
        try {
          await api('backupRestore', { file: name })
          // 池数据已被整体覆盖:刷新备份状态与云端列表,并让父面板重拉,
          // 否则上方供应商/密钥列表仍显示恢复前的旧数据(审查 P1-1)。
          await refresh()
          props.onPoolChanged?.()
          if (mounted.current) setRestored(true)
        } catch (cause) {
          if (mounted.current) setError(cause?.message ?? String(cause))
        } finally {
          if (mounted.current) endTask()
        }
      }

      const numberInput = (field, min, max) => h('input', {
        type: 'number',
        min,
        max,
        step: 1,
        value: values[field],
        disabled: busy,
        // 受控组件必须绑 onChange:漏了它输入框打不进任何字符,
        // 失焦时 Number(旧值)||min 会把值钳回下限,表现为"一改就变 5/1"。
        onChange: event => setValues(prev => ({ ...prev, [field]: event.target.value })),
        onBlur: () => {
          const parsed = Math.min(max, Math.max(min, Math.round(Number(values[field]) || min)))
          setValues(prev => ({ ...prev, [field]: parsed }))
          // 值没变(含未编辑过)就不下发:与 textRow 同口径。
          if (confirmed.current?.[field] !== parsed) save({ [field]: parsed })
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

      const textRow = (label, field, options = {}) => h('label', {
        style: { display: 'flex', alignItems: 'center', gap: 8 },
      },
      h('span', { style: { flex: 'none', width: 76, opacity: 0.8 } }, label),
      h(TextField, {
        value: values[field],
        placeholder: options.placeholder,
        type: options.secret ? 'password' : 'text',
        autoComplete: options.secret ? 'off' : undefined,
        disabled: busy,
        onChange: value => setValues(prev => ({ ...prev, [field]: value })),
        // 失焦时只有相对服务端确认值真正变更过才保存:
        // 否则每次路过焦点都会把密码/加密密钥原样上报一次。
        onBlur: () => {
          const current = values[field]
          if (current !== null && current !== undefined && current !== confirmed.current?.[field]) {
            save({ [field]: current })
          }
        },
      }))

      // 最近一次备份的结果行:成功(绿)/失败(红)/从未(灰)。
      const statusLine = status === null || (status.lastRunAt ?? 0) === 0
        ? h('div', { style: { opacity: 0.6 } }, t('backupNever'))
        : status.ok === true
          ? h('div', { style: { color: '#4caf78' } },
            `${t('backupLastOk')} ${new Date(status.lastRunAt).toLocaleString()}`
            + ((status.deletedFailures?.length ?? 0) > 0 ? ` · ${t('backupCleanupWarn')}` : ''))
          : h('div', { style: { color: 'var(--dsw-alias-fg-danger, #e07070)' } },
            `${t('backupLastFail')}: ${status.error ?? t('unknownError')}`)

      const toggle = h('button', {
        onClick: () => setOpen(value => !value),
        title: t('backupSettings'),
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '3px 8px',
          fontSize: 12,
          borderRadius: 6,
          border: '1px solid var(--dsw-alias-border-secondary, #333)',
          background: 'transparent',
          color: 'var(--dsw-alias-fg-primary, inherit)',
          cursor: 'pointer',
        },
      },
      h(Icon, { name: 'manage', size: 12 }),
      h('span', { style: { flex: 1, textAlign: 'left' } }, t('backupSettings')),
      h(Icon, { name: 'chevron', size: 11 }))

      const children = [toggle, statusLine]
      if (open) {
        if (error) {
          children.push(h('div', { role: 'alert', style: { color: 'var(--dsw-alias-fg-danger, #e07070)' } }, `${t('error')}: ${error}`))
        }
        if (restored) {
          children.push(h('div', { role: 'status', style: { color: '#4caf78' } }, t('backupRestoredOk')))
        }
        if (values === null) {
          if (error === '') children.push(h('div', { style: { opacity: 0.7 } }, t('loading')))
        } else {
          // 开关:定时备份。进行中的操作(尤其恢复)期间禁用,防并发互踩。
          children.push(h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, cursor: busy ? 'default' : 'pointer' } },
            h('input', {
              type: 'checkbox',
              checked: values.webdavEnabled === true,
              disabled: busy,
              onChange: event => {
                const checked = event.target.checked
                setValues(prev => ({ ...prev, webdavEnabled: checked }))
                save({ webdavEnabled: checked })
              },
            }),
            h('span', null, t('backupEnabled'))))
          children.push(textRow(t('backupUrl'), 'webdavUrl', { placeholder: 'https://dav.example.com/dav/' }))
          children.push(textRow(t('backupUsername'), 'webdavUsername'))
          children.push(textRow(t('backupPassword'), 'webdavPassword', { secret: true }))
          children.push(textRow(t('backupDir'), 'webdavDir'))
          children.push(textRow(t('backupEncryptKey'), 'webdavEncryptKey', { secret: true }))
          children.push(textRow(t('backupDevice'), 'webdavDevice', { placeholder: t('backupDeviceAuto') }))
          children.push(h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('span', { style: { flex: 1, opacity: 0.8 } }, t('backupInterval')),
            numberInput('webdavIntervalMin', 5, 1440),
            h('span', { style: { opacity: 0.6 } }, t('backupMinutes'))))
          children.push(h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('span', { style: { flex: 1, opacity: 0.8 } }, t('backupKeep')),
            numberInput('webdavKeep', 1, 50)))
          children.push(h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('button', {
              onClick: backupNow,
              disabled: busy,
              title: t('backupNowBtn'),
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: '4px 10px',
                fontSize: 12,
                borderRadius: 6,
                border: 'none',
                background: 'var(--dsw-alias-bg-accent, #4a6cf7)',
                color: 'var(--dsw-alias-fg-on-accent, #fff)',
                cursor: busy ? 'default' : 'pointer',
                opacity: busy ? 0.45 : 1,
              },
            }, t('backupNowBtn')),
            restored ? null : (saved ? h('span', { style: { color: '#4caf78' } }, t('configSaved')) : null)))
          // 云端备份列表:每行 = 设备 + 时间 + 恢复按钮。
          children.push(h('div', { style: { borderTop: '1px solid var(--dsw-alias-border-secondary, #333)', paddingTop: 6 } },
            h('div', { style: { opacity: 0.8, marginBottom: 4 } }, `${t('backupListTitle')}:`),
            backups === null
              ? h('div', { style: { opacity: 0.7 } }, t('loading'))
              : backups.length === 0
                ? h('div', { style: { opacity: 0.6 } }, t('backupListEmpty'))
                : backups.map(entry => h('div', {
                  key: entry.name,
                  style: {
                    position: 'relative',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '3px 0',
                  },
                },
                h('span', {
                  style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                  title: entry.name,
                }, `${entry.device} · ${new Date(entry.time).toLocaleString()}`),
                h('div', { style: { flex: 1 } }),
                confirmRestore === entry.name
                  ? h(ConfirmPopover, {
                    message: t('confirmRestore'),
                    confirmLabel: t('backupRestoreBtn'),
                    danger: true,
                    busy,
                    onConfirm: () => restore(entry.name),
                    onCancel: () => setConfirmRestore(null),
                  })
                  : null,
                h(IconButton, {
                  icon: 'use',
                  title: t('backupRestoreBtn'),
                  disabled: busy,
                  onMouseDown: event => event.stopPropagation(),
                  onClick: () => setConfirmRestore(confirmRestore === entry.name ? null : entry.name),
                })))))
        }
      }
      return h('div', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          borderTop: '1px solid var(--dsw-alias-border-secondary, #333)',
          paddingTop: 8,
        },
      }, children)
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
        quotaBalanceEmpty: '余额不足',
        quotaRemaining: '剩余',
        quotaRefresh: '立即刷新',
        quotaFetchedAt: '探测于',
        probeSettings: '探测与兜底',
        configQuotaProbe: '启用密钥余额探测',
        configFallback: '密钥失效或额度不足时自动切换',
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
        backupSettings: 'WebDAV 备份',
        backupEnabled: '启用定时备份',
        backupUrl: '服务地址',
        backupUsername: '账号',
        backupPassword: '密码',
        backupDir: '远程目录',
        backupEncryptKey: '加密密钥',
        backupDevice: '设备名',
        backupDeviceAuto: '留空则取主机名',
        backupInterval: '备份间隔(分钟)',
        backupKeep: '每设备保留份数',
        backupNowBtn: '立即备份',
        backupLastOk: '上次备份成功',
        backupLastFail: '上次备份失败',
        backupNever: '尚未备份',
        backupListTitle: '云端备份',
        backupListEmpty: '云端还没有备份',
        backupRestoreBtn: '恢复此版本',
        confirmRestore: '恢复将覆盖本地全部密钥池,确认继续?',
        backupCleanupWarn: '部分旧备份清理失败',
        backupVersionMismatch: '插件宿主半区仍是旧版本,请重载/重装插件后再使用备份功能',
        backupRestoredOk: '已恢复,上方密钥池已刷新',
        backupMinutes: '分钟',
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
        quotaBalanceEmpty: 'Insufficient balance',
        quotaRemaining: 'remaining',
        quotaRefresh: 'Refresh now',
        quotaFetchedAt: 'Probed at',
        probeSettings: 'Probing & fallback',
        configQuotaProbe: 'Enable key quota probing',
        configFallback: 'Auto-switch on invalid key or quota exhaustion',
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
        backupSettings: 'WebDAV backup',
        backupEnabled: 'Enable scheduled backup',
        backupUrl: 'Server URL',
        backupUsername: 'Username',
        backupPassword: 'Password',
        backupDir: 'Remote directory',
        backupEncryptKey: 'Encryption key',
        backupDevice: 'Device name',
        backupDeviceAuto: 'Defaults to hostname',
        backupInterval: 'Backup interval (minutes)',
        backupKeep: 'Versions kept per device',
        backupNowBtn: 'Back up now',
        backupLastOk: 'Last backup succeeded',
        backupLastFail: 'Last backup failed',
        backupNever: 'Never backed up',
        backupListTitle: 'Cloud backups',
        backupListEmpty: 'No cloud backups yet',
        backupRestoreBtn: 'Restore this version',
        confirmRestore: 'Restoring overwrites the local key pool. Continue?',
        backupCleanupWarn: 'Some old backups failed to clean up',
        backupVersionMismatch: 'Plugin host half is outdated; reload or reinstall the plugin to use backup',
        backupRestoredOk: 'Restored; the key pool above has been refreshed',
        backupMinutes: 'min',
      },
    }

    /** 内置中文兜底:locale 不可用或返回键名时用它,保证文案永远是中文。 */
    function fallbackText(key, params) {
      const template = DICTS.zh[key] ?? key
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])))
    }

    /** 翻译函数;locale 服务不可用时退回字典直查(默认中文)。 */
    let t = (key, params) => fallbackText(key, params)

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
        console.info('[dsh-key-managment] client build 2026-11-15.2 (confirm-popover-t-fallback + panel-level-safe-slot)')

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
            let served
            try {
              served = translate(key, params)
            } catch {
              // locale 服务自身抛错(缺键/未初始化)也不能让整个面板崩。
              return fallbackText(key, params)
            }
            // locale 服务可能缓存了旧版字典:对新增键它会原样返回键名。
            // 结果为空或等于键名时,回退到内置中文,保证永远是中文文案。
            if (served === undefined || served === null || served === key) {
              return fallbackText(key, params)
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

