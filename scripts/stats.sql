-- Usage statistics for Pons, from the Analytics Engine dataset "pons_events" (see src/analytics.ts).
-- The SQL API runs one query per request: run each query below separately (see "Usage statistics" in the README).
--
-- Columns: index1 = user code, blob1 = event type (tool, initialize, login), blob2 = tool name /
-- client name / sign-in outcome, blob3 = "ok" or error kind / client version, blob4 = platform
-- (desktop, web, mobile, other), double1 = milliseconds (tool events).
-- SUM(_sample_interval) counts events even when Analytics Engine has sampled them.

-- Users who called a tool, last 30 days
SELECT COUNT(DISTINCT index1) AS users
FROM pons_events
WHERE blob1 = 'tool' AND timestamp > NOW() - INTERVAL '30' DAY;

-- Calls per tool and outcome, last 30 days
SELECT blob2 AS tool, blob3 AS status, SUM(_sample_interval) AS calls,
       ROUND(SUM(_sample_interval * double1) / SUM(_sample_interval)) AS avg_ms
FROM pons_events
WHERE blob1 = 'tool' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY tool, status
ORDER BY calls DESC;

-- Calls per platform, last 30 days
SELECT blob4 AS platform, SUM(_sample_interval) AS calls, COUNT(DISTINCT index1) AS users
FROM pons_events
WHERE blob1 = 'tool' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY platform
ORDER BY calls DESC;

-- Connections per client app (from initialize), last 30 days
SELECT blob2 AS client, blob3 AS version, blob4 AS platform, SUM(_sample_interval) AS connects, COUNT(DISTINCT index1) AS users
FROM pons_events
WHERE blob1 = 'initialize' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY client, version, platform
ORDER BY connects DESC;

-- Sign-in outcomes, last 30 days
SELECT blob2 AS outcome, SUM(_sample_interval) AS attempts
FROM pons_events
WHERE blob1 = 'login' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY outcome
ORDER BY attempts DESC;
