# MySQL/Doris 数据源 — Ad-hoc 过滤器使用说明

## 一、它能做什么

在仪表盘顶部加一个**过滤器（Ad hoc filters）**变量，让你像搭积木一样选 `字段 + 操作符 + 值` 来过滤日志，无需改 SQL。本插件在标准能力上额外支持：

- ✅ **自动列出所有表的列**作为可选字段
- ✅ **JSON 列下钻**：`body`、`resource_attributes`、`log_attributes` 这类 JSON / variant 列，能自动识别并把里面的**子字段**列出来直接过滤
- ✅ varchar 存的 JSON 和 Doris `variant` 类型都支持

## 二、一次性配置（仪表盘里做两步）

### 1. 建过滤器变量

Dashboard → **Settings → Variables → New variable**

- **Variable type**：`Ad hoc filters`
- **Name**：`filters`（随意）
- **Data source**：选你的 MySQL/Doris 数据源（如 `Doris_HOC`）
- **Allow custom values**：建议**勾上**（采样没覆盖到的 JSON key 可以手输补上）

### 2. 在查询里放过滤宏

在面板的 SQL 里，把过滤器要生效的位置写上 `$__adHocFilter()` 宏：

```sql
SELECT timestamp, service_name, body
FROM otel.otel_logs
WHERE timestamp >= $__timeFrom() AND timestamp <= $__timeTo()
  AND $__adHocFilter()          -- ← 过滤器会展开到这里
ORDER BY timestamp DESC
LIMIT 100
```

- 没有任何过滤条件时，`$__adHocFilter()` 自动变成 `1=1`，SQL 始终合法。
- 多个条件之间用 `AND` 连接。

> ⚠️ 必须有这个宏，过滤器才会作用到查询上。

## 三、日常使用

### 普通列

顶部过滤器点 **+**，字段下拉直接选 `otel_logs.service_name`、`otel_logs.status_code` 等 → 选操作符 → 选值。

### JSON 字段下钻（重点）

字段下拉里会**自动出现**形如下面的下钻项（无需手动构造）：

| 显示的字段 | 含义 |
|---|---|
| `otel_logs.body["channel_id"]` | body JSON 里的 channel_id |
| `otel_logs.resource_attributes["k8s.pod.name"]` | k8s pod 名 |
| `otel_logs.log_attributes["response_code"]` | HTTP 状态码 |

选中后，值下拉会自动拉出该字段的**去重值列表**（如 `200/301/404…`），点选即可。

**手动输入语法**（自动列表没覆盖到时）：

```
表名.列名["json键名"]
```

- 嵌套：`otel_logs.body["a"]["b"]`
- 键名带点没问题：`otel_logs.resource_attributes["k8s.pod.name"]`
- 单/双引号都行：`otel_logs.body['channel_id']`

### 支持的操作符

`=`、`!=`、`<` `<=` `>` `>=`、`=~`（正则 REGEXP）、`!~`（NOT REGEXP）；多选值时 `=`/`!=` 自动转成 `IN`/`NOT IN`。

### 生成的 SQL 示例

选了 `otel_logs.log_attributes["response_code"] = 200` 后，`$__adHocFilter()` 会展开为：

```sql
JSON_UNQUOTE(JSON_EXTRACT(log_attributes, '$."response_code"')) = '200'
```

该写法对 varchar 存的 JSON 和 Doris `variant` 列都兼容。

## 四、自动识别原理（简述）

打开字段下拉时，插件的 `getTagKeys` 会：

1. 读 `information_schema.columns` 拿到所有列及其 `data_type`；
2. 对 `variant`/`json` 和文本列（`varchar`/`text`/...）采样
   `SELECT array_join(JSON_KEYS(CAST(列 AS STRING)), ',') ... LIMIT 500`，在前端把各行的键**去重合并**
   （非 JSON 列返回 `NULL`，自动忽略，不报错）。
   > 用 `array_join` 而非裸 `JSON_KEYS`，是因为 Doris 的 `JSON_KEYS` 返回 `array<text>`，
   > Grafana 的 MySQL 后端无法序列化该类型会丢行，拼成普通字符串后才稳定；
3. 把发现了键的 JSON 列替换成 `列["键"]` 形式列出（裸的 JSON 列会被隐藏，
   因为它无法直接 `DISTINCT` 取唯一值）；数字/时间列跳过探测；
4. 探测并发执行，最多探测 40 列，避免超宽 schema 把下拉打开变慢。

取值与 WHERE 条件统一走 `JSON_UNQUOTE(JSON_EXTRACT(列, '$."键"'))`。

## 五、稀疏 JSON 键（重要）

像 `body` 这种**自由格式**的 JSON 列，不同日志类型的键差别很大，某些键只占极小比例
（例如 `channel_id` 只出现在 `one-api` 的访问日志里，约占全表 0.2%）。对这类**稀疏键**：

- **key 下拉里可能不会自动出现**（自动发现按采样，采不到就没有）；
- **值下拉可能为空**（取值查询对 JSON 列有扫描上限以保证响应速度，采样没覆盖到就空）。

**正确用法**：直接**手动输入**。前提是变量里勾了 **Allow custom values**。

1. 在 key 输入框打 `otel_logs.body["channel_id"]`，即使提示 “No options found”，**按回车**把它作为自定义 key 加入；
2. 选操作符（如 `=`）；
3. 在值输入框直接打具体值（如 `6`），**按回车**确认。

> 关键认知：**值下拉只是「建议」，过滤本身是精确的**——即使建议列表里没有 `6`，
> 手输 `6` 后过滤会作用到全表所有数据，结果完全准确。

相对地，`resource_attributes`、`log_attributes` 这类**结构化属性列**键集是固定的、覆盖完整，
直接在下拉里选即可（如 `response_code`、`k8s.pod.name`、`service.name`）。

## 六、级联过滤与全局条件

### 级联（已选条件自动收窄后续 key/value）

选过滤器时，**之前已选的条件会自动作用到后面的字段/值下拉**——只列出在「匹配已选条件的行」里真实存在的 key 和 value，避免一堆无关服务的字段/值涌进选择框。

例：先选 `otel_logs.service_name = one-api`，再选 `otel_logs.body["status_code"]` 时，值下拉只列出 one-api 日志里出现过的状态码；`body` 的 JSON 子键发现也只采样 one-api 的行。

原理：插件用 Grafana 传入的 `options.filters`（其他已选过滤 + baseFilters，v10.3+）拼进 `WhERE`：

- **值查询**：`... WHERE 表达式 IS NOT NULL AND <已选条件>`；JSON 字段把已选条件压进内层扫描子查询，保证扫描上限窗口里采到的是相关行。
- **JSON key 采样**：`... WHERE 列 IS NOT NULL AND <已选条件>`。
- 护栏：自动排除正在编辑的那个 key，且只采用**同表**的过滤条件（跨表列名不存在会报错）。

> 注意：顶部的 `namespace/container/pod` 是 constant/query 变量，**不是 ad-hoc 过滤项**，不会参与级联收窄。要让它们也收窄下拉，把它们做成下面的 `baseFilters`。

### 全局过滤条件（baseFilters）

给 ad-hoc 变量配 `baseFilters`：**始终生效、UI 隐藏、不可删**的条件。在变量 JSON（Dashboard settings → Variables → 该变量 → 右上 JSON model，或直接编辑 Dashboard JSON）里加：

```json
{
  "name": "filters",
  "type": "adhoc",
  "datasource": { "type": "evomap-mysql-datasource", "uid": "<你的数据源uid>" },
  "baseFilters": [
    { "key": "otel_logs.service_name", "operator": "=", "value": "one-api" }
  ]
}
```

- baseFilters 会进 `options.filters` → **后续所有 key/value 下拉自动只剩该上下文**（如只剩 one-api）。
- baseFilters 也会进 `$__adHocFilter()` 真正过滤面板数据——**前提是面板 SQL 里有该宏**（见第二节）。

### 静态 key 白名单（可选）

变量编辑页的 **"Use static key dimensions"** 开关：直接 CSV 列出你只想要的 key，从源头干掉噪音。缺点是固定列表、不自动发现 JSON 子键。适合 key 集合明确、不想看到任何其他列的场景。

## 七、注意事项 / 限制

1. **强刷页面**：插件更新后首次使用，按 `Ctrl/Cmd + Shift + R` 清掉浏览器缓存的旧前端
   （走反代域名时可能要刷两次或用无痕窗口）。
2. **键来自采样**：稀疏 / 仅历史数据里出现的 JSON 键可能不在自动列表 → 手输 + “Allow custom values” 补。
3. **值下拉性能**：JSON 字段取值会被限制在「最近一段数据」内（窗口宽度 = 当前仪表盘时间范围，
   锚定在数据自身的 `MAX(时间列)` 上，**与时区无关**，靠按天分区裁剪），并叠加 2 万行扫描上限，
   保证秒级响应。代价是稀疏键/更早数据里的建议值可能不全 → 手输 + “Allow custom values” 补。
   时间列自动从 `information_schema` 探测（datetime/timestamp/date，优先 `timestamp` 等常见名）。
   普通列为完整 DISTINCT（Doris 列式去重很快），不加窗口。
4. **探测上限**：自动发现最多探测 40 列，超宽 schema 不会全扫。
5. 这是未签名的自定义插件，需在 Grafana 用 `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=evomap-mysql-datasource` 放行。

## 八、相关代码

- 过滤器宏 / JSON 下钻 / 键值查询：[`src/adHocFilters.ts`](../src/adHocFilters.ts)
- 字段自动发现（`getTagKeys` / `getTagValues`）：[`src/MySqlDatasource.ts`](../src/MySqlDatasource.ts)
- 单元测试：[`src/adHocFilters.test.ts`](../src/adHocFilters.test.ts)
