CREATE TABLE IF NOT EXISTS public.members (
    nfc_uid TEXT PRIMARY KEY,
    custom_id TEXT UNIQUE,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('Member', 'Officer', 'Executive', 'Admin')),
    points INTEGER NOT NULL DEFAULT 0,
    tier TEXT NOT NULL DEFAULT 'Regular'
);

CREATE TABLE IF NOT EXISTS public.events (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    event_date DATE NOT NULL,
    points INTEGER NOT NULL CHECK (points > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    closed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.attendance_logs (
    id BIGSERIAL PRIMARY KEY,
    nfc_uid TEXT NOT NULL REFERENCES public.members(nfc_uid),
    timestamp TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    event_name TEXT NOT NULL,
    event_id BIGINT REFERENCES public.events(id),
    points_awarded INTEGER NOT NULL DEFAULT 10,
    UNIQUE (nfc_uid, event_id)
);

CREATE TABLE IF NOT EXISTS public.point_adjustments (
    id BIGSERIAL PRIMARY KEY,
    nfc_uid TEXT NOT NULL REFERENCES public.members(nfc_uid),
    delta INTEGER NOT NULL CHECK (delta <> 0),
    reason TEXT NOT NULL,
    actor_role TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.staff_credentials (
    nfc_uid TEXT PRIMARY KEY REFERENCES public.members(nfc_uid) ON DELETE CASCADE,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.announcements (
    id BIGSERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    author_name TEXT NOT NULL,
    author_role TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.announcement_reactions (
    id BIGSERIAL PRIMARY KEY,
    announcement_id BIGINT NOT NULL REFERENCES public.announcements(id) ON DELETE CASCADE,
    reactor_id TEXT NOT NULL,
    reaction TEXT NOT NULL CHECK (reaction IN ('👍', '❤️', '🎮', '🔥')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (announcement_id, reactor_id)
);

CREATE TABLE IF NOT EXISTS public.event_tasks (
    id BIGSERIAL PRIMARY KEY,
    event_id BIGINT NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    committee TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    priority TEXT NOT NULL CHECK (priority IN ('Low', 'Medium', 'High')),
    progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
    status TEXT NOT NULL DEFAULT 'Not started' CHECK (status IN ('Not started', 'Open', 'Complete')),
    link_url TEXT NOT NULL DEFAULT '',
    deadline DATE,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE public.event_tasks ADD COLUMN IF NOT EXISTS deadline DATE;
ALTER TABLE public.event_tasks ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'Not started';

CREATE TABLE IF NOT EXISTS public.event_task_assignees (
    task_id BIGINT NOT NULL REFERENCES public.event_tasks(id) ON DELETE CASCADE,
    guild_id TEXT NOT NULL,
    PRIMARY KEY (task_id, guild_id)
);

CREATE TABLE IF NOT EXISTS public.event_task_subtasks (
    id BIGSERIAL PRIMARY KEY,
    task_id BIGINT NOT NULL REFERENCES public.event_tasks(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    completed BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.event_task_comments (
    id BIGSERIAL PRIMARY KEY,
    task_id BIGINT NOT NULL REFERENCES public.event_tasks(id) ON DELETE CASCADE,
    author_name TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.event_task_attachments (
    id BIGSERIAL PRIMARY KEY,
    task_id BIGINT NOT NULL REFERENCES public.event_tasks(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    content_base64 TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_event_tasks_event_committee ON public.event_tasks(event_id, committee);
CREATE INDEX IF NOT EXISTS idx_event_task_comments_task ON public.event_task_comments(task_id, id);

ALTER TABLE public.members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.point_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.announcement_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_task_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_task_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_task_assignees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_task_subtasks ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.members, public.events, public.attendance_logs,
    public.point_adjustments, public.staff_credentials, public.announcements, public.event_tasks,
    public.announcement_reactions, public.event_task_comments, public.event_task_attachments,
    public.event_task_assignees, public.event_task_subtasks FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated;
