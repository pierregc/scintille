-- Per source and day: files received against the expected count, and delivery latency.
SELECT
    CAST($start AS DATE) AS day,
    l.source,
    count(*) AS files,
    any_value(e.expected) AS expected_files,
    count(DISTINCT l.product_start) FILTER (WHERE l.status = 'ok') / any_value(e.expected) AS completeness,
    count(*) FILTER (WHERE l.status <> 'ok') AS failed_files,
    quantile_cont(epoch(l.received_at - l.product_end), 0.5) AS latency_p50_s,
    quantile_cont(epoch(l.received_at - l.product_end), 0.95) AS latency_p95_s
FROM {ingest_log} AS l
JOIN {expected_files} AS e ON e.source = l.source
WHERE l.product_start >= $start AND l.product_start < $end
GROUP BY l.source
ORDER BY l.source
