-- phase: expand
-- The connectors (plan §Z.6): the groups of tools a person and the owner can switch off.
--
-- The owner's switch, one row per connector: is it on for this site at all, and how many calls one person may make
-- to it in one UTC day (daily_cap null = no cap). Written only by the owner (server/http/api.js, the admin routes).
CREATE TABLE actor_connector_settings (
    connector_id text COLLATE "C" PRIMARY KEY,
    enabled boolean NOT NULL DEFAULT true,
    daily_cap integer CHECK (daily_cap IS NULL OR daily_cap > 0),
    updated_by text COLLATE "C",
    updated_at text COLLATE "C" NOT NULL
);

-- The person's own switch, one row per connector: enabled true, false, or no row at all (null = the connector's
-- default). A connector the owner turned off is off for everyone and this row is left alone.
CREATE TABLE actor_person_connector_settings (
    requester text COLLATE "C" NOT NULL,
    connector_id text COLLATE "C" NOT NULL,
    enabled boolean,
    updated_at text COLLATE "C" NOT NULL,
    PRIMARY KEY (requester, connector_id)
);
CREATE INDEX actor_person_connector_settings_requester ON actor_person_connector_settings (requester);

-- The calls of one person to one connector on one UTC day: the counter behind the owner's daily cap.
CREATE TABLE actor_connector_calls (
    requester text COLLATE "C" NOT NULL,
    connector_id text COLLATE "C" NOT NULL,
    day text COLLATE "C" NOT NULL,
    calls integer NOT NULL DEFAULT 0 CHECK (calls >= 0),
    PRIMARY KEY (requester, connector_id, day)
);
