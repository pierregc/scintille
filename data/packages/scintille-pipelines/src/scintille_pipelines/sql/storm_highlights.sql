-- Rank published storms for highlights. $ref is the latest observation, not the wall clock.
-- Only big storms qualify: at least $min_flashes flashes over at least $min_hours hours.
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
    WHERE epoch(t_end - t_start) / 3600 >= $min_hours AND flashes >= $min_flashes
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
            * least(2, sqrt(hours / 2))
            * least(1.5, greatest(0.5, pow(max_area_km2 / 2000, 0.25)))
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
    UNION ALL
    SELECT 'stationary', NULL, slug, row_number() OVER (ORDER BY flashes DESC, slug)
    FROM week
    WHERE hours >= $stationary_hours AND drift_km <= $stationary_km
),
-- Where each day, week or area winner ranks among the storms it was compared with.
pools AS (
    SELECT 'day' AS kind, NULL AS pool, * FROM day
    UNION ALL
    SELECT 'week', NULL, * FROM week
    UNION ALL
    SELECT 'area', area, * FROM day
),
pool_ranks AS (
    SELECT
        kind,
        pool,
        slug,
        rank() OVER (PARTITION BY kind, pool ORDER BY flashes DESC) AS flashes_rank,
        rank() OVER (PARTITION BY kind, pool ORDER BY countries DESC) AS countries_rank,
        rank() OVER (PARTITION BY kind, pool ORDER BY distance_km DESC NULLS LAST)
            AS distance_km_rank,
        rank() OVER (PARTITION BY kind, pool ORDER BY hours DESC) AS hours_rank
    FROM pools
)
SELECT c.kind, c.area, c.slug, r.flashes_rank, r.countries_rank, r.distance_km_rank, r.hours_rank
FROM candidates AS c
LEFT JOIN pool_ranks AS r
    ON r.kind = c.kind AND r.pool IS NOT DISTINCT FROM c.area AND r.slug = c.slug
WHERE c.rank = 1
ORDER BY c.kind, c.area
