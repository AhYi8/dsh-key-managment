/**
 * 验证:客户端半区的配色只使用宿主真实存在的主题令牌,且不残留硬编码颜色。
 *
 * 这条守护的是一个真实缺陷:client.js 曾大量使用 `--dsw-alias-bg-primary`、
 * `--dsw-alias-fg-primary`、`--dsw-alias-border-secondary` 这批**宿主并不存在**
 * 的令牌名。`var()` 取不到值时会静默回落兜底值,于是面板在暗色主题下"看着正常"
 * (兜底值恰好是深色),一旦切到亮色主题就变成深底 + 深字,文字完全看不清。
 *
 * 由于令牌名写错不会报错、也不会让任何运行时测试失败,只能用静态白名单把它钉死:
 * 新增令牌必须同时加进 ALLOWED_TOKENS,强迫改动者先去宿主里确认名字真实存在。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = join(here, 'client.js')

/**
 * 宿主主题令牌白名单:只列插件实际用到的那些。
 * 每一项都已在宿主产物(`app.asar` 的 `body{...}` 与 `body[data-ds-dark-theme]{...}`
 * 两块令牌表)里核对过存在,且亮/暗两套主题下都有定义。
 */
const ALLOWED_TOKENS = new Set([
  // 表面与层级。浮层不透明底靠 bg-layer-2 同色叠三层实现(见 client.js 的
  // OPAQUE_SURFACE_STYLE),只用到这一层;bg-layer-1 不再被引用。
  '--dsw-alias-bg-layer-2',
  // 边框
  '--dsw-alias-border-l2',
  // 文字
  '--dsw-alias-label-primary',
  '--dsw-alias-label-tertiary',
  '--dsw-alias-label-primary-foreground',
  // 蓝底正文色:徽标用 label-primary-bluish 而非 state-business-primary,
  // 后者作 11px 文字只有 3.60/4.39,低于 AA。
  '--dsw-alias-label-primary-bluish',
  // 强调色与按钮
  '--dsw-alias-button-primary-fill',
  // 交互态背景
  '--dsw-alias-interactive-bg-active',
  // 业务蓝:「已纳入管理」徽标沿用宿主的业务色而非单色的 brand-primary,
  // 后者在亮色主题下是近黑色、暗色下是近白色,不适合做强调色。
  '--dsw-alias-state-business-primary',
  '--dsw-alias-state-business-tertiary',
  // 语义状态色(配额分档、健康徽章、备份结果)。
  // 注意:这些令牌不直接当文字色用 —— 白底上 success 仅 2.28:1、warn 仅 2.15:1。
  // 实际取值统一经 STATUS_COLOR 混向 label-primary 后再使用。
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-primary',
  '--dsw-alias-state-error-primary',
])

/** 阴影令牌单独列:它们不是颜色值,但同样必须存在于宿主令牌表。 */
const ALLOWED_SHADOW_TOKENS = new Set([
  '--dsw-shadow-lv3',
])

/**
 * 曾经踩过的坑:这些令牌名在宿主里根本不存在,出现即失败。
 * 单独列出是为了让失败信息直接指出"这个名字不是宿主令牌",而不是只说"未在白名单"。
 */
const KNOWN_BOGUS_TOKENS = [
  '--dsw-alias-bg-primary',
  '--dsw-alias-bg-secondary',
  '--dsw-alias-bg-tertiary',
  '--dsw-alias-bg-accent',
  '--dsw-alias-bg-danger',
  '--dsw-alias-fg-primary',
  '--dsw-alias-fg-secondary',
  '--dsw-alias-fg-tertiary',
  '--dsw-alias-fg-accent',
  '--dsw-alias-fg-danger',
  '--dsw-alias-fg-on-accent',
  '--dsw-alias-border-secondary',
  '--dsw-alias-border-accent',
]

/**
 * 宿主主题令牌名统一是 `--dsw-` 前缀的连字符串,且 CSS 自定义属性**区分大小写**。
 * 故这里用不区分大小写的匹配再统一转小写比较:既能拦住 `--DSW-ALIAS-FG-PRIMARY`
 * 这类大小写变体(宿主里取不到值,属同一类缺陷),也能让白名单比对只看名字本身。
 */
const TOKEN_PATTERN = /--dsw-[a-z0-9-]+/gi

/**
 * 历史问题色:单独列出,失败信息能直接指出"这就是上次那批颜色"。
 * 只钉这几个具体值挡不住下一次新增的硬编码色,所以另配通用模式。
 */
const FORBIDDEN_COLOR_LITERALS = [
  '#4caf78',
  '#d95c5c',
  '#d9a13c',
  '#e07070',
  '#4a6cf7',
  '#7c8cf8',
  '#1b1b1f',
]

/**
 * 任意字面量颜色的通用模式:插件只能引用宿主令牌,不允许写死颜色。
 *
 * 本次缺陷的根因正是"硬编码状态色在亮色主题下不可读",如果只钉上述 7 个
 * 具体值,下次换一个新色值就完全拦不住。这里覆盖 hex / rgb / rgba /
 * hsl / hsla 及其大写形式(颜色函数名不区分大小写)。
 * 注释已在 stripComments 中剥离,所以注释里的示例色不会误判。
 */
const COLOR_LITERAL_PATTERN = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\s*\(/gi

/**
 * 去掉注释,但用**等长空白**占位而不是直接删除。
 *
 * 删除会让后续所有断言的报号整体前移(实测 client.js 最多偏移 92 行),
 * 报错指向错误的代码位置,按报号去改会改错地方。换成空白占位后
 * 行号、列号都与原始文件完全一致。
 *
 * 局限:这是正则剥离而非词法器,字符串里出现"未闭合的块注释起始符"或
 * 紧邻的 `//` 仍可能被误吞。assertStrippedSourceIsSane 用 V8 解析器兜底。
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '))
    .replace(
      /(^|[^:])\/\/[^\n]*/g,
      (match, prefix) => prefix + ' '.repeat(match.length - prefix.length),
    )
}

/**
 * 自检:剥离注释后的源码必须仍是**合法 JS**。
 *
 * 原先靠手数 () [] {} 是否配平,但被注释规则误吞的通常是字符串内容
 * (如 `'a//b'` 被吞成 `'a`),此时括号计数 1:1 不变、配平恒成立,
 * 自检放行而语法早已非法 —— 所有断言会在"集合为空"时全绿。
 * 直接交给 V8 解析器判定最准,也不必为新增语法维护计数逻辑。
 *
 * client.js 是 `window.__ModuleLoader__.load({...})` 表达式、无顶层 import,
 * 所以 vm.Script 足够;若将来出现顶层 ESM 语法需换 vm.SourceTextModule。
 */
function assertStrippedSourceIsSane(rawSource) {
  try {
    new vm.Script(stripComments(rawSource), { filename: 'client.stripped.js' })
  } catch (error) {
    assert.fail(`剥离注释后源码无法解析,注释剥离可能吞掉了代码:${error.message}`)
  }
}

async function loadClientSource() {
  const raw = await readFile(CLIENT_PATH, 'utf8')
  assertStrippedSourceIsSane(raw)
  return stripComments(raw)
}

test('theme:客户端半区引用的主题令牌全部在宿主令牌白名单内', async () => {
  const source = await loadClientSource()
  // 不转小写,严格按原样比对。CSS 自定义属性区分大小写:
  // `var(--DSW-ALIAS-LABEL-PRIMARY)` 在浏览器里取不到值,与拼错完全同类,
  // 若在这里统一小写化,等于把这些写法洗成合法名放行(等于放回原缺陷)。
  const used = new Set(source.match(TOKEN_PATTERN) ?? [])

  const bogus = [...used].filter(token => KNOWN_BOGUS_TOKENS.includes(token))
  assert.deepEqual(
    bogus,
    [],
    `发现宿主不存在的令牌名(会静默回落到兜底值):${bogus.join(', ')}`,
  )

  const unknown = [...used].filter(
    token => !ALLOWED_TOKENS.has(token) && !ALLOWED_SHADOW_TOKENS.has(token),
  )
  assert.deepEqual(
    unknown,
    [],
    `发现未登记或大小写不正确的令牌:${unknown.join(', ')}；`
    + '请先在宿主产物中确认该令牌存在(注意 CSS 自定义属性区分大小写),再加入 ALLOWED_TOKENS',
  )
})

test('theme:白名单里不允许残留未使用的令牌', async () => {
  const source = await loadClientSource()
  const used = new Set(source.match(TOKEN_PATTERN) ?? [])
  // 白名单一旦能登记"暂时没在用"的令牌,就退化成"可能用到"的许可清单,
  // 失去了"每个令牌都经过核实"的意义。
  const unused = [...ALLOWED_TOKENS, ...ALLOWED_SHADOW_TOKENS].filter(token => !used.has(token))
  assert.deepEqual(
    unused,
    [],
    `白名单登记但源码未使用:${unused.join(', ')}；请删除,避免白名单变成许可清单`,
  )
})

test('theme:客户端半区不残留硬编码颜色', async () => {
  const source = await loadClientSource()

  // 先报历史问题色:措辞更具体,能直接指出"这就是上次那批"。
  const lowered = source.toLowerCase()
  const known = FORBIDDEN_COLOR_LITERALS.filter(literal => lowered.includes(literal))
  assert.deepEqual(
    known,
    [],
    `发现历史问题色:${known.join(', ')}；状态色必须改用 --dsw-alias-state-* 语义令牌`,
  )

  // 再兜住任何新引入的字面量颜色(hex / rgb / rgba / hsl / hsla)。
  const anyLiteral = [...new Set(source.match(COLOR_LITERAL_PATTERN) ?? [])]
  assert.deepEqual(
    anyLiteral,
    [],
    `发现硬编码颜色:${anyLiteral.join(', ')}；请改用 --dsw-alias-* 令牌,否则亮色主题下对比度不可控`,
  )
})

test('theme:颜色令牌不再携带深色兜底值', async () => {
  const source = await loadClientSource()
  // 兜底值会让令牌失效时"看起来还能用",正是本次缺陷难以发现的根源:
  // 暗色主题下兜底值恰好是深色,掩盖了令牌名写错的事实。
  const withFallback = source.match(/var\(\s*--dsw-[a-z0-9-]+\s*,[^)]+\)/gi) ?? []
  assert.deepEqual(
    withFallback,
    [],
    `颜色令牌不应带兜底值:${withFallback.join(', ')}`,
  )
})

test('theme:浮层底色必须是"不透明兜底 + 皮肤色调"两段结构', async () => {
  const source = await loadClientSource()
  // 这条守的是结构,不是令牌名:只查令牌是否合法的话,把浮层改回单层半透明
  // 依然能全绿(实测过——把 backgroundImage 改成 'none',5 条断言全部通过)。
  // 浮层要真正不透,必须同时满足:
  //   1) backgroundColor 是一个**不会**被主题/壁纸/弹窗滑块改写的令牌
  //      (label-primary-foreground),它决定最终不透明度;
  //   2) backgroundImage 保留一层 layer-2 渐变,负责带上皮肤自己的色调。
  const marker = 'const OPAQUE_SURFACE_STYLE = {'
  const at = source.indexOf(marker)
  assert.notEqual(at, -1, 'OPAQUE_SURFACE_STYLE 已不存在,浮层不透明底没有来源')

  const block = readBalancedBlock(source, source.indexOf('{', at))
  assert.notEqual(block, null, 'OPAQUE_SURFACE_STYLE 的花括号不配平')
  const body = source.slice(block.start, block.end)

  assert.match(
    body,
    /backgroundColor:\s*'var\(--dsw-alias-label-primary-foreground\)'/,
    'backgroundColor 必须是不透明兜底令牌 label-primary-foreground:'
    + '改用 bg-base 会被壁纸洗成半透明,改用 bg-layer-2 会被弹窗透明度滑块拖成半透明',
  )
  assert.match(
    body,
    /backgroundImage:\s*'linear-gradient\(var\(--dsw-alias-bg-layer-2\),\s*var\(--dsw-alias-bg-layer-2\)\)'/,
    'backgroundImage 必须保留一层 layer-2 渐变来带皮肤色调,否则浮层会变成无色调的纯白/纯黑',
  )
})

/* ---------------------- SVG 演示属性扫描 ---------------------- */

/**
 * 从 `{` 起配平读取一个完整块,返回块的内外边界。
 *
 * 逐字符前进并跳过字符串字面量(单引号/双引号/模板串,含反斜杠转义),
 * 避免属性值里的花括号干扰配平。找不到配平则返回 null。
 */
function readBalancedBlock(source, openIndex) {
  let depth = 0
  let index = openIndex
  while (index < source.length) {
    const char = source[index]
    if (char === "'" || char === '"' || char === '`') {
      const quote = char
      index += 1
      while (index < source.length) {
        if (source[index] === '\\') {
          index += 2
          continue
        }
        if (source[index] === quote) {
          index += 1
          break
        }
        index += 1
      }
      continue
    }
    if (char === '{') {
      depth += 1
      index += 1
      continue
    }
    if (char === '}') {
      depth -= 1
      index += 1
      if (depth === 0) return { start: openIndex, end: index }
      continue
    }
    index += 1
  }
  return null
}

/**
 * 从一个属性值的起点找到它结束的位置(同层的逗号或块的收尾括号)。
 * 同样跳过字符串,并让括号内的逗号不影响判断。
 */
function readValueEnd(text, startIndex) {
  let depth = 0
  let index = startIndex
  while (index < text.length) {
    const char = text[index]
    if (char === "'" || char === '"' || char === '`') {
      const quote = char
      index += 1
      while (index < text.length) {
        if (text[index] === '\\') {
          index += 2
          continue
        }
        if (text[index] === quote) {
          index += 1
          break
        }
        index += 1
      }
      continue
    }
    if (char === '(' || char === '[' || char === '{') {
      depth += 1
      index += 1
      continue
    }
    if (char === ')' || char === ']' || char === '}') {
      if (depth === 0) return index
      depth -= 1
      index += 1
      continue
    }
    if (char === ',' && depth === 0) return index
    index += 1
  }
  return index
}

/** SVG 标签在 React.createElement 里的调用形式:`h('circle', {...})`。 */
const SVG_TAG_CALL = /h\('(?:svg|circle|text|path|g|line|rect|polyline|polygon|ellipse|defs|linearGradient|stop)'\s*,/g

/** 演示属性上唯一允许的两种取值:显式无填充 / 跟随文字色。 */
const ALLOWED_SVG_VALUES = new Set(["'none'", "'currentColor'", '"none"', '"currentColor"'])

/**
 * 收集所有 SVG 元素属性表里直接写在**顶层**的 `stroke` / `fill`。
 *
 * 关键点(相对早期版本的三处修正):
 * 1. **按括号配平截取属性表**,不用定长字符窗口 —— 窗口会越过元素边界把后面
 *    普通对象的 `stroke` 误判成违规,也会在属性表很长时把坏属性漏在窗口外。
 * 2. **只认顶层属性**:`style: { stroke: ... }` 里的同名键处于更深层级,天然被
 *    排除,不需要额外剥离 style 块,也就不会因为嵌套层级判断失误而漏报。
 * 3. **行号取坏属性自身的偏移**,而不是标签调用的起点,报错能直接定位。
 */
function findSvgPresentationColors(source) {
  const found = []
  let call
  SVG_TAG_CALL.lastIndex = 0
  while ((call = SVG_TAG_CALL.exec(source)) !== null) {
    // 属性表从标签调用之后的第一个 `{` 开始
    const braceStart = source.indexOf('{', call.index + call[0].length - 1)
    if (braceStart < 0) continue
    const block = readBalancedBlock(source, braceStart)
    if (block === null) continue
    const props = source.slice(block.start, block.end)

    let depth = 0
    let index = 0
    while (index < props.length) {
      const char = props[index]
      if (char === "'" || char === '"' || char === '`') {
        const quote = char
        index += 1
        while (index < props.length) {
          if (props[index] === '\\') {
            index += 2
            continue
          }
          if (props[index] === quote) {
            index += 1
            break
          }
          index += 1
        }
        continue
      }
      if (char === '{' || char === '(' || char === '[') {
        depth += 1
        index += 1
        continue
      }
      if (char === '}' || char === ')' || char === ']') {
        depth -= 1
        index += 1
        continue
      }
      // 只看属性表最外层(depth 1),style 等嵌套对象里的同名键不计入
      if (depth === 1 && (char === 's' || char === 'f')) {
        const matched = /^(stroke|fill)\s*:/.exec(props.slice(index))
        if (matched !== null) {
          const valueStart = index + matched[0].length
          const valueEnd = readValueEnd(props, valueStart)
          const value = props.slice(valueStart, valueEnd).trim()
          if (!ALLOWED_SVG_VALUES.has(value)) {
            const absolute = block.start + index
            found.push({
              line: source.slice(0, absolute).split('\n').length,
              attr: matched[1],
              value,
            })
          }
          index = valueEnd
          continue
        }
      }
      index += 1
    }
  }
  return found
}

test('theme:SVG 的 stroke/fill 演示属性只允许 none 或 currentColor', async () => {
  const source = await loadClientSource()
  // SVG 演示属性(stroke/fill)不解析 var() / color-mix(),写在属性上会静默失效。
  // 主题色必须放进 style 对象,演示属性上只保留两种与主题无关的值。
  const violations = findSvgPresentationColors(source).map(
    violation => `第 ${violation.line} 行 ${violation.attr}: ${violation.value}`,
  )
  assert.deepEqual(
    violations,
    [],
    `SVG 演示属性不解析 var()/color-mix():${violations.join(' | ')}；主题色请改为 style: { ... }`,
  )
})
