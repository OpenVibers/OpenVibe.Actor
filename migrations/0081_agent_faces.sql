-- phase: expand
-- Faces: the pictures of a person's Actor and their agents (the owner, 11-16: "you never added the image generator, like
-- avatar system … you can't … edit your actor … or rename it"). A face is made on the image models OpenVibe.AI routes to
-- (the admin's guided setup; the same route Exchange sells) or uploaded, kept here as the bytes (at most 2 MB, PNG, JPEG
-- or WebP, checked by their first bytes), and served at /faces/<id>. An agent's face is its ref 'face:<id>' (actor_agents.face),
-- and the Actor's (actors.avatar) follows its first agent's.
CREATE TABLE IF NOT EXISTS actor_faces (
    id text COLLATE "C" PRIMARY KEY,
    owner text COLLATE "C" NOT NULL,
    mime text COLLATE "C" NOT NULL,
    bytes bytea NOT NULL,
    prompt text,
    style text COLLATE "C",
    created_at text COLLATE "C" NOT NULL
);
CREATE INDEX IF NOT EXISTS actor_faces_owner ON actor_faces (owner, created_at DESC);
