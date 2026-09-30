import { DataFrameView, FieldType, toDataFrame, type DataSourceInstanceSettings } from '@grafana/data';

import { MySqlDatasource } from './MySqlDatasource';
import { type MySQLOptions } from './types';

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  getBackendSrv: () => ({ fetch: jest.fn() }),
}));

// Column rows exactly as information_schema.columns returns them for the `otel`
// database on the production Doris (table_name, column_name, data_type).
const OTEL_SCHEMA: string[][] = [
  ['otel_logs', 'timestamp', 'datetime'],
  ['otel_logs', 'service_name', 'varchar'],
  ['otel_logs', 'service_instance_id', 'varchar'],
  ['otel_logs', 'trace_id', 'varchar'],
  ['otel_logs', 'span_id', 'varchar'],
  ['otel_logs', 'severity_number', 'int'],
  ['otel_logs', 'severity_text', 'varchar'],
  ['otel_logs', 'body', 'varchar'],
  ['otel_logs', 'resource_attributes', 'variant'],
  ['otel_logs', 'log_attributes', 'variant'],
  ['otel_logs', 'scope_name', 'varchar'],
  ['otel_logs', 'scope_version', 'varchar'],
  ['otel_traces', 'service_name', 'varchar'],
  ['otel_traces', 'timestamp', 'datetime'],
  ['otel_traces', 'service_instance_id', 'varchar'],
  ['otel_traces', 'trace_id', 'varchar'],
  ['otel_traces', 'span_id', 'varchar'],
  ['otel_traces', 'trace_state', 'varchar'],
  ['otel_traces', 'parent_span_id', 'varchar'],
  ['otel_traces', 'span_name', 'varchar'],
  ['otel_traces', 'span_kind', 'varchar'],
  ['otel_traces', 'end_time', 'datetime'],
  ['otel_traces', 'duration', 'bigint'],
  ['otel_traces', 'span_attributes', 'variant'],
  ['otel_traces', 'events', 'array'],
  ['otel_traces', 'links', 'array'],
  ['otel_traces', 'status_message', 'varchar'],
  ['otel_traces', 'status_code', 'varchar'],
  ['otel_traces', 'resource_attributes', 'variant'],
  ['otel_traces', 'scope_name', 'varchar'],
  ['otel_traces', 'scope_version', 'varchar'],
  ['otel_traces_graph', 'timestamp', 'datetime'],
  ['otel_traces_graph', 'caller_service_name', 'varchar'],
  ['otel_traces_graph', 'caller_service_instance_id', 'varchar'],
  ['otel_traces_graph', 'callee_service_name', 'varchar'],
  ['otel_traces_graph', 'callee_service_instance_id', 'varchar'],
  ['otel_traces_graph', 'count', 'bigint'],
  ['otel_traces_graph', 'error_count', 'bigint'],
];

const TABLES = ['otel_logs', 'otel_traces', 'otel_traces_graph'];
const ANCHOR = '2026-09-30 15:00:00';

// runSql hands back a DataFrameView in production, not an array: it supports
// map/get(i) but not `view[0]`. Mocking it with plain arrays hides that.
function frameOf(rows: string[][]): DataFrameView<string[]> {
  const width = rows[0]?.length ?? 0;
  const fields = Array.from({ length: width }, (_, i) => ({
    name: `c${i}`,
    type: FieldType.string,
    values: rows.map((row) => row[i]),
  }));
  return new DataFrameView<string[]>(toDataFrame({ fields }));
}

function setup() {
  const instanceSettings = { jsonData: { database: 'otel' } } as unknown as DataSourceInstanceSettings<MySQLOptions>;
  const ds = new MySqlDatasource(instanceSettings);
  const sqls: string[] = [];
  jest.spyOn(ds, 'runSql').mockImplementation((async (sql: string) => {
    sqls.push(sql);
    if (sql.includes('information_schema.columns')) {
      return frameOf(OTEL_SCHEMA);
    }
    if (sql.includes('DATE_FORMAT(MAX(')) {
      return frameOf([[ANCHOR]]);
    }
    return frameOf([['k1,k2']]);
  }) as unknown as MySqlDatasource['runSql']);
  return { ds, sqls };
}

describe('getTagKeys against the production otel schema', () => {
  it('resolves the time anchor once for every table that is probed', async () => {
    const { ds, sqls } = setup();
    await ds.getTagKeys();
    const anchored = sqls.filter((s) => s.includes('DATE_FORMAT(MAX('));
    for (const table of TABLES) {
      expect(anchored.filter((s) => s.endsWith(`FROM otel.${table}`))).toHaveLength(1);
    }
  });

  it('bounds every JSON key probe to the recent window', async () => {
    const { ds, sqls } = setup();
    await ds.getTagKeys();
    const probes = sqls.filter((s) => s.startsWith('SELECT array_join(JSON_KEYS('));
    expect(probes.length).toBeGreaterThan(0);
    const unbounded = probes.filter((s) => !s.includes(`TIMESTAMP('${ANCHOR}')`));
    expect(unbounded).toEqual([]);
  });
});

// Grafana's backend service cancels an in-flight request when a new one is sent with
// the same requestId, and runSql uses the refId as the requestId. Model that here.
function setupWithCancellation() {
  const instanceSettings = { jsonData: { database: 'otel' } } as unknown as DataSourceInstanceSettings<MySQLOptions>;
  const ds = new MySqlDatasource(instanceSettings);
  const sqls: string[] = [];
  const inFlight = new Map<string, (err: Error) => void>();
  jest.spyOn(ds, 'runSql').mockImplementation((async (sql: string, options?: { refId?: string }) => {
    sqls.push(sql);
    const refId = options?.refId ?? 'meta';
    inFlight.get(refId)?.(new Error('request cancelled'));
    const cancelled = new Promise<never>((_, reject) => inFlight.set(refId, reject));
    const answer = async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (sql.includes('information_schema.columns')) {
        return frameOf(OTEL_SCHEMA);
      }
      if (sql.includes('DATE_FORMAT(MAX(')) {
        return frameOf([[ANCHOR]]);
      }
      return frameOf([['k1,k2']]);
    };
    return Promise.race([answer(), cancelled]);
  }) as unknown as MySqlDatasource['runSql']);
  return { ds, sqls };
}

describe('getTagKeys when concurrent requests with the same refId cancel each other', () => {
  it('still anchors every probe of every table', async () => {
    const { ds, sqls } = setupWithCancellation();
    await ds.getTagKeys();
    const probes = sqls.filter((s) => s.startsWith('SELECT array_join(JSON_KEYS('));
    expect(probes.length).toBeGreaterThan(0);
    const unbounded = probes.filter((s) => !s.includes(`TIMESTAMP('${ANCHOR}')`));
    expect(unbounded).toEqual([]);
  });
});
