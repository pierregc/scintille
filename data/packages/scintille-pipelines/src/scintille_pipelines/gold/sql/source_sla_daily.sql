-- Per source and day: files received against the expected count, and delivery latency.
SELECT
    CAST($start AS DATE) AS day,
    source,
    count(*) AS files,
    any_value(expected) AS expected_files,
    count(*) / any_value(expected) AS completeness,
    count(*) FILTER (WHERE status <> 'ok') AS failed_files,
    quantile_cont(epoch(received_at - product_end), 0.5) AS latency_p50_s,
    quantile_cont(epoch(received_at - product_end), 0.95) AS latency_p95_s
FROM {ingest_log}
JOIN (VALUES ('glm-east', 4320), ('glm-west', 4320), ('mtg-li', 2880)) AS e(src, expected)
    ON e.src = source
WHERE product_start >= $start AND product_start < $end
GROUP BY source
ORDER BY source
