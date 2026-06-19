import { type AdHocVariableFilter } from '@grafana/data';

import {
  adHocColumn,
  applyAdHocFilters,
  buildAdHocFilterClause,
  buildTagKeysQuery,
  buildTagValuesQuery,
  filterToSql,
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
