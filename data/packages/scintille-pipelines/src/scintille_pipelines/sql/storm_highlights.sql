-- Rank published storms for highlights. $ref is the latest observation, not the wall clock.
WITH base AS (
    SELECT
        *,
        epoch(t_end - t_start) / 3600 AS hours,
        t_start + (t_end - t_start) / 2 AS mid,
        CASE
            WHEN lon < -25 THEN 'americas'
            WHEN lon < 45 AND lat >= 35 THEN 'europe'
            WHEN lon < 60 AND lat < 35 THEN 'africa'
            ELSE 'asia'
        END AS area
    FROM {storms}
    WHERE t_end - t_start >= INTERVAL 30 MINUTE
),
-- Approximate solar declination and hour angle, good to about a degree.
sun AS (
    SELECT
        *,
        radians(-23.44 * cos(radians(360 / 365 * (dayofyear(mid) + 10)))) AS declination,
        radians((epoch(mid) % 86400 / 3600 + lon / 15 - 12) * 15) AS hour_angle
    FROM base
),
scored AS (
    SELECT
        *,
        score
            * least(1.5, sqrt(hours / 2))
            * CASE WHEN offshore THEN 0.8 ELSE 1 END
            * CASE
                WHEN sin(radians(lat)) * sin(declination)
                    + cos(radians(lat)) * cos(declination) * cos(hour_angle) < sin(radians(-6))
                THEN 1.25
                ELSE 1
            END AS beauty
    FROM sun
),
day AS (SELECT * FROM scored WHERE t_start >= $ref - INTERVAL 24 HOUR),
week AS (SELECT * FROM scored WHERE t_start >= $ref - INTERVAL 7 DAY),
candidates AS (
    SELECT 'day' AS kind, NULL AS area, slug, row_number() OVER (ORDER BY beauty DESC, slug) AS rank
    FROM day
    UNION ALL
    SELECT 'week', NULL, slug, row_number() OVER (ORDER BY beauty DESC, slug) FROM week
    UNION ALL
    SELECT 'area', area, slug, row_number() OVER (PARTITION BY area ORDER BY beauty DESC, slug)
    FROM day
    UNION ALL
    SELECT 'longest', NULL, slug, row_number() OVER (ORDER BY hours DESC, slug) FROM week
    UNION ALL
    SELECT 'intense', NULL, slug, row_number() OVER (ORDER BY peak_rate DESC, slug) FROM week
    UNION ALL
    SELECT 'largest', NULL, slug, row_number() OVER (ORDER BY max_area_km2 DESC, slug) FROM week
)
SELECT kind, area, slug, rank FROM candidates WHERE rank <= 12 ORDER BY kind, area, rank
