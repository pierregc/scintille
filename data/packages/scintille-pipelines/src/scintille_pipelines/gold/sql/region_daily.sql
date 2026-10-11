-- Flashes per country, source and day (Natural Earth admin-0 borders; sea flashes have no country).
SELECT
    CAST($start AS DATE) AS day,
    c.code AS country_code,
    c.name AS country_name,
    f.source,
    count(*) AS flashes
FROM {flashes} AS f
JOIN {countries} AS c ON ST_Contains(c.geom, ST_Point(f.lon, f.lat))
WHERE f.event_time >= $start AND f.event_time < $end
GROUP BY ALL
ORDER BY ALL
