-- Per source and day: files received against the expected count, and delivery latency.
SELECT
    CAST($start AS DATE) AS day,
    e.source,
    count(l.source) AS files,
    any_value(e.expected) AS expected_files,
    count(DISTINCT l.product_start) FILTER (WHERE l.status = 'ok') / any_value(e.expected) AS completeness,
    count(l.source) FILTER (WHERE l.status <> 'ok') AS failed_files,
    quantile_cont(epoch(l.received_at - l.product_end), 0.5) AS latency_p50_s,
    quantile_cont(epoch(l.received_at - l.product_end), 0.95) AS latency_p95_s
FROM {expected_files} AS e
LEFT JOIN {ingest_log} AS l
    ON l.source = e.source AND l.product_start >= $start AND l.product_start < $end
GROUP BY e.source
ORDER BY e.source
