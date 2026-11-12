export type ExportMetricCell = {
  value: number | null;
  status: string;
};

export type ExportableOwnerReport = {
  schema_version: string;
  venue_id: string;
  source: string;
  report_metadata: {
    calculation_version: string;
    generated_at: string;
    date_window: {
      duration_hours: number;
      start_time: string;
      end_time: string;
    };
    report_status: string;
  };
  dishes: Array<{
    dish_id: string;
    name: string | null;
    evidence_state: string;
    metrics: {
      active_sessions: ExportMetricCell;
      avg_interaction_time_seconds: ExportMetricCell;
      timing_coverage: ExportMetricCell;
      open_rate: ExportMetricCell;
      engagement_rate: ExportMetricCell;
      save_rate: ExportMetricCell;
    };
  }>;
};

const CSV_HEADERS = [
  'schema_version',
  'venue_id',
  'source',
  'calculation_version',
  'window_start',
  'window_end',
  'generated_at',
  'report_status',
  'dish_id',
  'dish_name',
  'evidence_state',
  'active_sessions',
  'active_sessions_status',
  'avg_interaction_time_seconds',
  'avg_interaction_time_seconds_status',
  'timing_coverage',
  'timing_coverage_status',
  'open_rate',
  'open_rate_status',
  'engagement_rate',
  'engagement_rate_status',
  'save_rate',
  'save_rate_status',
] as const;

function escapeCsvCell(rawValue: string | number | null | undefined): string {
  if (rawValue === null || rawValue === undefined) {
    return '';
  }
  const str = String(rawValue);
  const formulaSafe = /^[=+\-@\t\r]/.test(str) ? `'${str}` : str;
  if (/[",\r\n]/.test(formulaSafe)) {
    return `"${formulaSafe.replace(/"/g, '""')}"`;
  }
  return formulaSafe;
}

function formatMetricCells(metric: ExportMetricCell): [string, string] {
  const isSuppressed = metric.status !== 'NORMAL' || metric.value === null;
  return [isSuppressed ? '' : String(metric.value), metric.status];
}

export function serializeOwnerReportCsv(report: ExportableOwnerReport): string {
  const sortedDishes = [...report.dishes].sort((a, b) => a.dish_id.localeCompare(b.dish_id));
  const lines: string[] = [CSV_HEADERS.join(',')];

  for (const dish of sortedDishes) {
    const [activeVal, activeStatus] = formatMetricCells(dish.metrics.active_sessions);
    const [avgTimeVal, avgTimeStatus] = formatMetricCells(
      dish.metrics.avg_interaction_time_seconds,
    );
    const [timingVal, timingStatus] = formatMetricCells(dish.metrics.timing_coverage);
    const [openVal, openStatus] = formatMetricCells(dish.metrics.open_rate);
    const [engagementVal, engagementStatus] = formatMetricCells(dish.metrics.engagement_rate);
    const [saveVal, saveStatus] = formatMetricCells(dish.metrics.save_rate);

    const row = [
      report.schema_version,
      report.venue_id,
      report.source,
      report.report_metadata.calculation_version,
      report.report_metadata.date_window.start_time,
      report.report_metadata.date_window.end_time,
      report.report_metadata.generated_at,
      report.report_metadata.report_status,
      dish.dish_id,
      dish.name ?? '',
      dish.evidence_state,
      activeVal,
      activeStatus,
      avgTimeVal,
      avgTimeStatus,
      timingVal,
      timingStatus,
      openVal,
      openStatus,
      engagementVal,
      engagementStatus,
      saveVal,
      saveStatus,
    ];

    lines.push(row.map(escapeCsvCell).join(','));
  }

  return `${lines.join('\n')}\n`;
}

export function buildOwnerReportExportFilename(venueId: string, generatedAtIso: string): string {
  const safeDate = generatedAtIso.slice(0, 10).replace(/[^0-9-]/g, '');
  const safeVenue = venueId.toLowerCase().replace(/[^a-z0-9-]/g, '');
  return `owner-report-${safeVenue}-${safeDate}.csv`;
}
