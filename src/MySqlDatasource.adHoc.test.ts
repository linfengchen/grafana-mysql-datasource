import { type DataSourceInstanceSettings } from '@grafana/data';

import { MySqlDatasource } from './MySqlDatasource';
import { type MySQLOptions } from './types';

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  getBackendSrv: () => ({ fetch: jest.fn() }),
}));

type Deferred = { promise: Promise<void>; resolve: () => void };

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const COLUMNS: string[][] = [
  ['otel_logs', 'timestamp', 'datetime'],
  ['otel_logs', 'body', 'varchar'],
  ['otel_logs', 'log_attributes', 'variant'],
  ['otel_logs', 'resource_attributes', 'variant'],
  ['otel_logs', 'scope_name', 'varchar'],
  ['otel_logs', 'severity_number', 'int'],
];

const PROBE_COLUMNS = COLUMNS.filter(([, , type]) => type !== 'datetime' && type !== 'int').length;

interface Harness {
  ds: MySqlDatasource;
  sqls: string[];
  gate?: Deferred;
  maxProbesInFlight: () => number;
  failNextQuery: () => void;
}

function setup(opts?: { gateProbes?: boolean }): Harness {
  const instanceSettings = { jsonData: { database: 'otel' } } as unknown as DataSourceInstanceSettings<MySQLOptions>;
  const ds = new MySqlDatasource(instanceSettings);
  const sqls: string[] = [];
  const gate = opts?.gateProbes ? deferred() : undefined;
  let inFlight = 0;
  let peak = 0;
  let failNext = false;

  jest.spyOn(ds, 'runSql').mockImplementation((async (sql: string) => {
    sqls.push(sql);
    if (failNext) {
      failNext = false;
      throw new Error('boom');
    }
    if (sql.includes('information_schema.columns')) {
      return COLUMNS;
    }
    if (sql.includes('DATE_FORMAT(MAX(')) {
      return [['2026-09-22 21:34:25']];
    }
    inFlight++;
    peak = Math.max(peak, inFlight);
    if (gate) {
      await gate.promise;
    }
    inFlight--;
    return [['appname,level']];
  }) as unknown as MySqlDatasource['runSql']);

  return {
    ds,
    sqls,
    gate,
    maxProbesInFlight: () => peak,
    failNextQuery: () => {
      failNext = true;
    },
  };
}

const probeSqls = (sqls: string[]) => sqls.filter((s) => s.includes('JSON_KEYS'));
const maxTimeSqls = (sqls: string[]) => sqls.filter((s) => s.includes('DATE_FORMAT(MAX('));

describe('getTagKeys probe fan-out', () => {
  it('probes every JSON-capable column once', async () => {
    const { ds, sqls } = setup();
    await ds.getTagKeys();
    expect(probeSqls(sqls)).toHaveLength(PROBE_COLUMNS);
  });

  it('bounds probes with a literal time anchor, never a subquery', async () => {
    const { ds, sqls } = setup();
    await ds.getTagKeys();
    for (const sql of probeSqls(sqls)) {
      expect(sql).toContain("TIMESTAMP('2026-09-22 21:34:25')");
      expect(sql).not.toContain('SELECT MAX(');
    }
  });

  it('resolves the time anchor once per table, not once per column', async () => {
    const { ds, sqls } = setup();
    await ds.getTagKeys();
    expect(maxTimeSqls(sqls)).toHaveLength(1);
  });

  it('keeps at most JSON_PROBE_CONCURRENCY probes in flight', async () => {
    const { ds, gate, maxProbesInFlight } = setup({ gateProbes: true });
    const pending = ds.getTagKeys();
    await new Promise((r) => setTimeout(r, 0));
    expect(maxProbesInFlight()).toBeLessThanOrEqual(4);
    expect(maxProbesInFlight()).toBeGreaterThan(0);
    gate!.resolve();
    await pending;
  });
});

describe('getTagKeys caching', () => {
  it('collapses concurrent callers onto one fan-out', async () => {
    const { ds, sqls } = setup();
    const [a, b] = await Promise.all([ds.getTagKeys(), ds.getTagKeys()]);
    expect(probeSqls(sqls)).toHaveLength(PROBE_COLUMNS);
    expect(b).toEqual(a);
  });

  it('serves a repeat call from cache', async () => {
    const { ds, sqls } = setup();
    await ds.getTagKeys();
    const afterFirst = sqls.length;
    await ds.getTagKeys();
    expect(sqls).toHaveLength(afterFirst);
  });

  it('re-runs when the active filters change, since they cascade into the probes', async () => {
    const { ds, sqls } = setup();
    await ds.getTagKeys();
    const afterFirst = probeSqls(sqls).length;
    await ds.getTagKeys({ filters: [{ key: 'otel_logs.scope_name', operator: '=', value: 'x' }] });
    expect(probeSqls(sqls).length).toBeGreaterThan(afterFirst);
  });

  it('does not cache a failed fan-out', async () => {
    const { ds, failNextQuery } = setup();
    failNextQuery();
    await expect(ds.getTagKeys()).rejects.toThrow('boom');
    await expect(ds.getTagKeys()).resolves.toEqual(expect.any(Array));
  });
});
