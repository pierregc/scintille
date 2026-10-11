-- Flashes per hour, source and 1° cell.
SELECT
    date_trunc('hour', event_time) AS hour,
    source,
    CAST(floor(lat) AS INTEGER) AS lat_cell,
    CAST(floor(lon) AS INTEGER) AS lon_cell,
    count(*) AS flashes,
    sum(energy_raw) AS energy_raw_sum,
    avg(area_km2) AS mean_area_km2
FROM {flashes}
WHERE event_time >= $start AND event_time < $end
GROUP BY ALL
ORDER BY ALL
