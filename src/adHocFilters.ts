import { type AdHocVariableFilter } from '@grafana/data';

import { quoteIdentifierIfNecessary, quoteLiteral, unquoteIdentifier } from './sqlUtil';

// Matches the `$__adHocFilter()` macro (whitespace inside the parentheses is allowed).
const AD_HOC_FILTER_MACRO = /\$__adHocFilter\(\s*\)/g;

// Expression used when no ad hoc filters are active. Keeps the resulting SQL valid
// regardless of where the macro is placed (e.g. directly after `WHERE`).
const NO_FILTER_EXPRESSION = '1=1';

/**
 * Returns the column part of an ad hoc filter key. Keys produced by
 * {@link buildTagKeysQuery} are formatted as `table.column`, but a user may also
 * configure a bare `column` key manually. The WHERE clause is generated using the
 * column only so it matches unqualified references in the user's query.
 */
export function adHocColumn(key: string): string {
  const parts = key.split('.');
  return parts[parts.length - 1];
}

/**
 * Maps a Grafana ad hoc filter to a MySQL boolean expression. Identifiers and
 * literals are escaped to prevent SQL injection.
 */
export function filterToSql(filter: AdHocVariableFilter): string | undefined {
  const column = quoteIdentifierIfNecessary(adHocColumn(filter.key));
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
 * Query that lists the distinct values of an ad hoc filter key (`table.column`).
 */
export function buildTagValuesQuery(key: string, database?: string, limit = 1000): string {
  const parts = key.split('.');
  const column = quoteIdentifierIfNecessary(parts[parts.length - 1]);
  const table = quoteIdentifierIfNecessary(parts.length > 1 ? parts[parts.length - 2] : parts[0]);
  const from = database ? `${quoteIdentifierIfNecessary(database)}.${table}` : table;
  return `SELECT DISTINCT ${column} FROM ${from} WHERE ${column} IS NOT NULL ORDER BY 1 LIMIT ${limit}`;
}
