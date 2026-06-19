import { type AdHocVariableFilter } from '@grafana/data';

import { quoteIdentifierIfNecessary, quoteLiteral, unquoteIdentifier } from './sqlUtil';

// Matches the `$__adHocFilter()` macro (whitespace inside the parentheses is allowed).
const AD_HOC_FILTER_MACRO = /\$__adHocFilter\(\s*\)/g;

// Expression used when no ad hoc filters are active. Keeps the resulting SQL valid
// regardless of where the macro is placed (e.g. directly after `WHERE`).
const NO_FILTER_EXPRESSION = '1=1';

// Matches JSON accessors like `["channel_id"]` or `['channel_id']` (one or more,
// possibly nested) appended to a column, e.g. `otel_logs.body["channel_id"]`.
const JSON_ACCESSOR = /\[\s*(?:"([^"]*)"|'([^']*)')\s*\]/g;

export interface ParsedAdHocKey {
  /** Table name when the key is qualified as `table.column`, otherwise undefined. */
  table?: string;
  /** Bare column name (e.g. `body`). */
  column: string;
  /** JSON path segments drilled into the column, e.g. `['channel_id']`. */
  jsonPath: string[];
}

/**
 * Splits an ad hoc filter key into its table, column, and JSON path parts. Keys
 * produced by {@link buildTagKeysQuery} are `table.column`, but a user may also
 * type a bare `column` or drill into a JSON column with bracket accessors, e.g.
 * `otel_logs.body["channel_id"]` → `{ table: 'otel_logs', column: 'body', jsonPath: ['channel_id'] }`.
 */
export function parseAdHocKey(key: string): ParsedAdHocKey {
  const jsonPath: string[] = [];
  // Strip the bracket accessors so the remainder is a plain `table.column`.
  const base = key.replace(JSON_ACCESSOR, (_match, doubleQuoted, singleQuoted) => {
    jsonPath.push(doubleQuoted !== undefined ? doubleQuoted : singleQuoted);
    return '';
  });
  const parts = base.split('.');
  const column = parts[parts.length - 1];
  const table = parts.length > 1 ? parts[parts.length - 2] : undefined;
  return { table, column, jsonPath };
}

/**
 * Returns the column part of an ad hoc filter key. Keys produced by
 * {@link buildTagKeysQuery} are formatted as `table.column`, but a user may also
 * configure a bare `column` key manually. The WHERE clause is generated using the
 * column only so it matches unqualified references in the user's query.
 */
export function adHocColumn(key: string): string {
  return parseAdHocKey(key).column;
}

/**
 * Builds a MySQL JSON path literal (`$."a"."b"`) from path segments, escaping
 * backslashes and double quotes so arbitrary JSON keys are safe.
 */
function jsonPathLiteral(jsonPath: string[]): string {
  const segments = jsonPath.map((p) => `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  return '$.' + segments.join('.');
}

/**
 * Maps a (column, jsonPath) pair to the SQL expression used on the left-hand side
 * of filters and as the projected value. Plain columns are quoted as identifiers;
 * JSON drill-downs become `JSON_UNQUOTE(JSON_EXTRACT(col, '$."path"'))` so the
 * extracted scalar compares and lists as unquoted text.
 */
function columnExpr(column: string, jsonPath: string[]): string {
  const col = quoteIdentifierIfNecessary(column);
  if (jsonPath.length === 0) {
    return col;
  }
  return `JSON_UNQUOTE(JSON_EXTRACT(${col}, ${quoteLiteral(jsonPathLiteral(jsonPath))}))`;
}

/**
 * Returns the SQL expression for an ad hoc filter key, resolving JSON drill-downs.
 */
export function adHocColumnExpr(key: string): string {
  const { column, jsonPath } = parseAdHocKey(key);
  return columnExpr(column, jsonPath);
}

/**
 * Maps a Grafana ad hoc filter to a MySQL boolean expression. Identifiers and
 * literals are escaped to prevent SQL injection.
 */
export function filterToSql(filter: AdHocVariableFilter): string | undefined {
  const column = adHocColumnExpr(filter.key);
  const values = filter.values && filter.values.length > 0 ? filter.values : [filter.value];

  switch (filter.operator) {
    case '=':
      if (values.length > 1) {
        return `${column} IN (${values.map(quoteLiteral).join(', ')})`;
      }
      return `${column} = ${quoteLiteral(values[0])}`;
    case '!=':
      if (values.length > 1) {
        return `${column} NOT IN (${values.map(quoteLiteral).join(', ')})`;
      }
      return `${column} != ${quoteLiteral(values[0])}`;
    case '<':
    case '<=':
    case '>':
    case '>=':
      return `${column} ${filter.operator} ${quoteLiteral(filter.value)}`;
    case '=~':
      return `${column} REGEXP ${quoteLiteral(filter.value)}`;
    case '!~':
      return `${column} NOT REGEXP ${quoteLiteral(filter.value)}`;
    default:
      return undefined;
  }
}

/**
 * Builds the boolean expression injected by the `$__adHocFilter()` macro. Returns
 * `1=1` when there are no usable filters so the surrounding SQL stays valid.
 */
export function buildAdHocFilterClause(filters?: AdHocVariableFilter[]): string {
  if (!filters || filters.length === 0) {
    return NO_FILTER_EXPRESSION;
  }

  const expressions = filters
    .filter((f) => f.key)
    .map(filterToSql)
    .filter((expr): expr is string => expr !== undefined);

  if (expressions.length === 0) {
    return NO_FILTER_EXPRESSION;
  }

  return expressions.join(' AND ');
}

/**
 * Replaces every `$__adHocFilter()` macro in the SQL with the conditions derived
 * from the active ad hoc filters.
 */
export function applyAdHocFilters(rawSql: string, filters?: AdHocVariableFilter[]): string {
  if (!AD_HOC_FILTER_MACRO.test(rawSql)) {
    return rawSql;
  }
  // Reset lastIndex because the regex is global and was advanced by `test`.
  AD_HOC_FILTER_MACRO.lastIndex = 0;
  const clause = buildAdHocFilterClause(filters);
  return rawSql.replace(AD_HOC_FILTER_MACRO, clause);
}

/**
 * Query that lists the available ad hoc filter keys as `table.column` entries for
 * the given database (defaults to the connection's current database).
 */
export function buildTagKeysQuery(database?: string): string {
  const schema = database ? quoteLiteral(unquoteIdentifier(database)) : 'database()';
  return (
    `SELECT CONCAT(table_name, '.', column_name) FROM information_schema.columns ` +
    `WHERE table_schema = ${schema} ORDER BY table_name, ordinal_position`
  );
}

/**
 * Like {@link buildTagKeysQuery} but also returns each column's data type so the
 * caller can decide which columns to probe for JSON keys.
 */
export function buildTagColumnsQuery(database?: string): string {
  const schema = database ? quoteLiteral(unquoteIdentifier(database)) : 'database()';
  return (
    `SELECT table_name, column_name, data_type FROM information_schema.columns ` +
    `WHERE table_schema = ${schema} ORDER BY table_name, ordinal_position`
  );
}

// Column types that may hold a JSON object and are therefore worth probing for
// drillable keys. `variant`/`json` are JSON for sure; text types are sampled
// because a plain string column can still store serialized JSON (e.g. `body`).
const JSON_PROBE_TYPES = new Set([
  'variant',
  'json',
  'jsonb',
  'varchar',
  'char',
  'string',
  'text',
  'tinytext',
  'mediumtext',
  'longtext',
]);

/**
 * Returns true when a column of the given SQL data type might contain a JSON
 * object whose keys can be auto-discovered.
 */
export function shouldProbeForJsonKeys(dataType: string): boolean {
  return JSON_PROBE_TYPES.has(dataType.trim().toLowerCase());
}

/**
 * Query that samples a column and returns, per row, the JSON object's top-level
 * keys as a JSON array (or NULL for non-JSON values). The caller unions the
 * arrays across rows. `CAST(... AS STRING)` lets this work for both `variant`
 * and plain text columns; `JSON_KEYS` yields NULL (not an error) for non-JSON.
 */
export function buildJsonKeysSampleQuery(table: string, column: string, database?: string, sampleSize = 500): string {
  const col = quoteIdentifierIfNecessary(column);
  const tableName = quoteIdentifierIfNecessary(table);
  const from = database ? `${quoteIdentifierIfNecessary(database)}.${tableName}` : tableName;
  return `SELECT JSON_KEYS(CAST(${col} AS STRING)) FROM ${from} WHERE ${col} IS NOT NULL LIMIT ${sampleSize}`;
}

/**
 * Unions the JSON-key arrays returned by {@link buildJsonKeysSampleQuery} into a
 * sorted, de-duplicated list. Each input cell is a JSON array string such as
 * `["level", "method"]`; NULL/empty/malformed cells are skipped.
 */
export function collectJsonKeys(rows: string[][], limit = 200): string[] {
  const keys = new Set<string>();
  for (const row of rows) {
    const cell = row?.[0];
    if (!cell) {
      continue;
    }
    try {
      const parsed = JSON.parse(cell);
      if (Array.isArray(parsed)) {
        for (const k of parsed) {
          if (typeof k === 'string') {
            keys.add(k);
          }
        }
      }
    } catch {
      // Not a JSON array (non-JSON column) — ignore.
    }
  }
  return Array.from(keys)
    .sort()
    .slice(0, limit);
}

/**
 * Builds an ad hoc filter key that drills into a JSON column, e.g.
 * `otel_logs.body["channel_id"]`. The bracketed form round-trips through
 * {@link parseAdHocKey}.
 */
export function buildJsonAdHocKey(table: string, column: string, jsonKey: string): string {
  return `${table}.${column}[${JSON.stringify(jsonKey)}]`;
}

/**
 * Query that lists the distinct values of an ad hoc filter key (`table.column`).
 */
export function buildTagValuesQuery(key: string, database?: string, limit = 1000): string {
  const { table, column, jsonPath } = parseAdHocKey(key);
  const tableName = quoteIdentifierIfNecessary(table ?? column);
  const from = database ? `${quoteIdentifierIfNecessary(database)}.${tableName}` : tableName;
  const expr = columnExpr(column, jsonPath);
  return `SELECT DISTINCT ${expr} FROM ${from} WHERE ${expr} IS NOT NULL ORDER BY 1 LIMIT ${limit}`;
}
