import { type AdHocVariableFilter } from '@grafana/data';

import {
  adHocColumn,
  applyAdHocFilters,
  buildAdHocFilterClause,
  buildJsonAdHocKey,
  buildJsonKeysSampleQuery,
  buildTagColumnsQuery,
  buildTagKeysQuery,
  buildTagValuesQuery,
  collectJsonKeys,
  filterToSql,
  parseAdHocKey,
  shouldProbeForJsonKeys,
  whereFromFilters,
} from './adHocFilters';

const filter = (overrides: Partial<AdHocVariableFilter>): AdHocVariableFilter => ({
  key: 'host',
  operator: '=',
  value: 'web01',
  ...overrides,
});

describe('adHocColumn', () => {
  it('returns the column part of a table.column key', () => {
    expect(adHocColumn('metrics.host')).toBe('host');
  });

  it('returns a bare key unchanged', () => {
    expect(adHocColumn('host')).toBe('host');
  });
});

describe('JSON drill-down keys', () => {
  it('filters on a JSON path with JSON_UNQUOTE(JSON_EXTRACT(...))', () => {
    expect(filterToSql(filter({ key: 'otel_logs.body["channel_id"]', value: '6' }))).toBe(
      `JSON_UNQUOTE(JSON_EXTRACT(body, '$."channel_id"')) = '6'`
    );
  });

  it('supports nested JSON paths', () => {
    expect(filterToSql(filter({ key: 'logs.payload["a"]["b"]', value: 'x' }))).toBe(
      `JSON_UNQUOTE(JSON_EXTRACT(payload, '$."a"."b"')) = 'x'`
    );
  });

  it('lists distinct values of a JSON path with a bounded inner scan', () => {
    expect(buildTagValuesQuery('otel_logs.body["channel_id"]', 'otel')).toBe(
      `SELECT DISTINCT JSON_UNQUOTE(JSON_EXTRACT(body, '$."channel_id"')) FROM ` +
        `(SELECT body FROM otel.otel_logs WHERE body IS NOT NULL LIMIT 200000) t ` +
        `WHERE JSON_UNQUOTE(JSON_EXTRACT(body, '$."channel_id"')) IS NOT NULL ORDER BY 1 LIMIT 1000`
    );
  });
});

describe('filterToSql', () => {
  it('handles equality', () => {
    expect(filterToSql(filter({ operator: '=', value: 'web01' }))).toBe("host = 'web01'");
  });

  it('handles inequality', () => {
    expect(filterToSql(filter({ operator: '!=', value: 'web01' }))).toBe("host != 'web01'");
  });

  it('handles comparison operators', () => {
    expect(filterToSql(filter({ key: 'cpu', operator: '>', value: '90' }))).toBe("cpu > '90'");
  });

  it('maps =~ to REGEXP', () => {
    expect(filterToSql(filter({ operator: '=~', value: '^web' }))).toBe("host REGEXP '^web'");
  });

  it('maps !~ to NOT REGEXP', () => {
    expect(filterToSql(filter({ operator: '!~', value: '^web' }))).toBe("host NOT REGEXP '^web'");
  });

  it('uses IN for multi-value equality', () => {
    expect(filterToSql(filter({ operator: '=', value: 'web01', values: ['web01', 'web02'] }))).toBe(
      "host IN ('web01', 'web02')"
    );
  });

  it('uses NOT IN for multi-value inequality', () => {
    expect(filterToSql(filter({ operator: '!=', value: 'web01', values: ['web01', 'web02'] }))).toBe(
      "host NOT IN ('web01', 'web02')"
    );
  });

  it('uses only the column part of a table.column key', () => {
    expect(filterToSql(filter({ key: 'metrics.host', value: 'web01' }))).toBe("host = 'web01'");
  });

  it('quotes reserved-word columns with backticks', () => {
    expect(filterToSql(filter({ key: 'order', value: 'x' }))).toBe("`order` = 'x'");
  });

  it('escapes single quotes in values to prevent injection', () => {
    expect(filterToSql(filter({ value: "x' OR '1'='1" }))).toBe("host = 'x'' OR ''1''=''1'");
  });

  it('returns undefined for unknown operators', () => {
    expect(filterToSql(filter({ operator: 'foo' }))).toBeUndefined();
  });
});

describe('buildAdHocFilterClause', () => {
  it('returns 1=1 when there are no filters', () => {
    expect(buildAdHocFilterClause()).toBe('1=1');
    expect(buildAdHocFilterClause([])).toBe('1=1');
  });

  it('joins multiple filters with AND', () => {
    const clause = buildAdHocFilterClause([
      filter({ key: 'host', operator: '=', value: 'web01' }),
      filter({ key: 'env', operator: '!=', value: 'prod' }),
    ]);
    expect(clause).toBe("host = 'web01' AND env != 'prod'");
  });

  it('skips filters with no key and unsupported operators', () => {
    expect(buildAdHocFilterClause([filter({ key: '' }), filter({ operator: 'foo' })])).toBe('1=1');
  });
});

describe('applyAdHocFilters', () => {
  it('replaces the macro with the filter clause', () => {
    const sql = 'SELECT * FROM t WHERE $__adHocFilter()';
    expect(applyAdHocFilters(sql, [filter({ key: 'host', value: 'web01' })])).toBe(
      "SELECT * FROM t WHERE host = 'web01'"
    );
  });

  it('replaces the macro with 1=1 when no filters are active', () => {
    const sql = 'SELECT * FROM t WHERE $__adHocFilter()';
    expect(applyAdHocFilters(sql, [])).toBe('SELECT * FROM t WHERE 1=1');
  });

  it('replaces every occurrence of the macro', () => {
    const sql = 'SELECT * FROM t WHERE $__adHocFilter() UNION SELECT * FROM u WHERE $__adHocFilter()';
    expect(applyAdHocFilters(sql, [filter({ key: 'host', value: 'web01' })])).toBe(
      "SELECT * FROM t WHERE host = 'web01' UNION SELECT * FROM u WHERE host = 'web01'"
    );
  });

  it('tolerates whitespace inside the parentheses', () => {
    expect(applyAdHocFilters('WHERE $__adHocFilter(  )', [])).toBe('WHERE 1=1');
  });

  it('leaves SQL without the macro unchanged', () => {
    const sql = 'SELECT * FROM t';
    expect(applyAdHocFilters(sql, [filter({})])).toBe(sql);
  });
});

describe('buildTagKeysQuery', () => {
  it('uses the provided database', () => {
    expect(buildTagKeysQuery('mydb')).toContain("table_schema = 'mydb'");
  });

  it('falls back to database() when no database is given', () => {
    expect(buildTagKeysQuery()).toContain('table_schema = database()');
  });
});

describe('JSON key auto-discovery', () => {
  it('parses a bracketed JSON key into table/column/path', () => {
    expect(parseAdHocKey('otel_logs.resource_attributes["k8s.pod.name"]')).toEqual({
      table: 'otel_logs',
      column: 'resource_attributes',
      jsonPath: ['k8s.pod.name'],
    });
  });

  it('round-trips buildJsonAdHocKey through parseAdHocKey', () => {
    const key = buildJsonAdHocKey('otel_logs', 'log_attributes', 'response_code');
    expect(key).toBe('otel_logs.log_attributes["response_code"]');
    expect(parseAdHocKey(key).jsonPath).toEqual(['response_code']);
  });

  it('treats variant/json and text types as JSON probe candidates', () => {
    expect(shouldProbeForJsonKeys('variant')).toBe(true);
    expect(shouldProbeForJsonKeys('JSON')).toBe(true);
    expect(shouldProbeForJsonKeys('varchar')).toBe(true);
    expect(shouldProbeForJsonKeys('int')).toBe(false);
    expect(shouldProbeForJsonKeys('datetime')).toBe(false);
  });

  it('builds a bounded JSON_KEYS sampling query that flattens the key array', () => {
    expect(buildJsonKeysSampleQuery('otel_logs', 'body', 'otel')).toBe(
      "SELECT array_join(JSON_KEYS(CAST(body AS STRING)), ',') FROM otel.otel_logs WHERE body IS NOT NULL LIMIT 500"
    );
  });

  it('unions, sorts and de-duplicates the comma-joined key strings', () => {
    const rows = [['b,a'], ['a,c'], [null as unknown as string], [''], ['  c , a ']];
    expect(collectJsonKeys(rows)).toEqual(['a', 'b', 'c']);
  });

  it('selects column metadata including data_type', () => {
    expect(buildTagColumnsQuery('otel')).toContain('table_name, column_name, data_type');
    expect(buildTagColumnsQuery('otel')).toContain("table_schema = 'otel'");
  });
});

describe('buildTagValuesQuery', () => {
  it('builds a distinct query for a table.column key', () => {
    expect(buildTagValuesQuery('metrics.host', 'mydb')).toBe(
      'SELECT DISTINCT host FROM mydb.metrics WHERE host IS NOT NULL ORDER BY 1 LIMIT 1000'
    );
  });

  it('omits the database prefix when none is configured', () => {
    expect(buildTagValuesQuery('metrics.host')).toBe(
      'SELECT DISTINCT host FROM metrics WHERE host IS NOT NULL ORDER BY 1 LIMIT 1000'
    );
  });

  it('quotes reserved-word identifiers', () => {
    expect(buildTagValuesQuery('order.select')).toBe(
      'SELECT DISTINCT `select` FROM `order` WHERE `select` IS NOT NULL ORDER BY 1 LIMIT 1000'
    );
  });
});

describe('cascading pickers (whereFromFilters)', () => {
  it('joins same-table filters with AND', () => {
    const fs = [
      filter({ key: 'otel_logs.service_name', operator: '=', value: 'one-api' }),
      filter({ key: 'otel_logs.body["func"]', operator: '=', value: 'access' }),
    ];
    expect(whereFromFilters(fs, { table: 'otel_logs' })).toBe(
      `service_name = 'one-api' AND JSON_UNQUOTE(JSON_EXTRACT(body, '$."func"')) = 'access'`
    );
  });

  it('excludes the key being edited and cross-table filters', () => {
    const fs = [
      filter({ key: 'otel_logs.service_name', operator: '=', value: 'one-api' }),
      filter({ key: 'otel_logs.status', operator: '=', value: '200' }),
      filter({ key: 'other_table.x', operator: '=', value: 'y' }),
    ];
    expect(whereFromFilters(fs, { excludeKey: 'otel_logs.status', table: 'otel_logs' })).toBe(
      "service_name = 'one-api'"
    );
  });

  it('returns empty string when nothing applies', () => {
    expect(whereFromFilters(undefined)).toBe('');
    expect(whereFromFilters([], { table: 'otel_logs' })).toBe('');
  });

  it('scopes plain value lookups to the other filters', () => {
    const fs = [filter({ key: 'otel_logs.service_name', operator: '=', value: 'one-api' })];
    expect(buildTagValuesQuery('otel_logs.status', 'otel', fs)).toBe(
      "SELECT DISTINCT status FROM otel.otel_logs WHERE status IS NOT NULL AND service_name = 'one-api' " +
        'ORDER BY 1 LIMIT 1000'
    );
  });

  it('scopes JSON value lookups inside the bounded scan', () => {
    const fs = [filter({ key: 'otel_logs.service_name', operator: '=', value: 'one-api' })];
    expect(buildTagValuesQuery('otel_logs.body["status_code"]', 'otel', fs)).toBe(
      `SELECT DISTINCT JSON_UNQUOTE(JSON_EXTRACT(body, '$."status_code"')) FROM ` +
        `(SELECT body FROM otel.otel_logs WHERE body IS NOT NULL AND service_name = 'one-api' LIMIT 200000) t ` +
        `WHERE JSON_UNQUOTE(JSON_EXTRACT(body, '$."status_code"')) IS NOT NULL ORDER BY 1 LIMIT 1000`
    );
  });

  it('scopes JSON key discovery to the other filters', () => {
    const fs = [filter({ key: 'otel_logs.service_name', operator: '=', value: 'one-api' })];
    expect(buildJsonKeysSampleQuery('otel_logs', 'body', 'otel', fs)).toBe(
      "SELECT array_join(JSON_KEYS(CAST(body AS STRING)), ',') FROM otel.otel_logs " +
        "WHERE body IS NOT NULL AND service_name = 'one-api' LIMIT 500"
    );
  });
});
