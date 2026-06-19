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
   `SELECT JSON_KEYS(CAST(列 AS STRING)) ... LIMIT 500`，在前端把各行的键数组**去重合并**
   （非 JSON 列返回 `NULL`，自动忽略，不报错）；
3. 把发现了键的 JSON 列替换成 `列["键"]` 形式列出（裸的 JSON 列会被隐藏，
   因为它无法直接 `DISTINCT` 取唯一值）；数字/时间列跳过探测；
4. 探测并发执行，最多探测 40 列，避免超宽 schema 把下拉打开变慢。

取值与 WHERE 条件统一走 `JSON_UNQUOTE(JSON_EXTRACT(列, '$."键"'))`。

## 五、注意事项 / 限制

1. **强刷页面**：插件更新后首次使用，按 `Ctrl/Cmd + Shift + R` 清掉浏览器缓存的旧前端。
2. **键来自采样**：只在很老数据里出现的 JSON 键可能不在自动列表里 → 用手输 + “Allow custom values” 补。
3. **值下拉性能**：JSON 字段取唯一值是全表扫描，大表会慢几秒（已限制最多 1000 个值）。
4. **探测上限**：自动探测最多 40 列，超宽 schema 不会全扫。
5. 这是未签名的自定义插件，需在 Grafana 用 `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=evomap-mysql-datasource` 放行。

## 六、相关代码

- 过滤器宏 / JSON 下钻 / 键值查询：[`src/adHocFilters.ts`](../src/adHocFilters.ts)
- 字段自动发现（`getTagKeys` / `getTagValues`）：[`src/MySqlDatasource.ts`](../src/MySqlDatasource.ts)
- 单元测试：[`src/adHocFilters.test.ts`](../src/adHocFilters.test.ts)
