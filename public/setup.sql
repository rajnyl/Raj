CREATE TABLE IF NOT EXISTS public.members (
    nfc_uid TEXT PRIMARY KEY,
    custom_id TEXT UNIQUE,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('Member', 'Officer', 'Executive', 'Admin')),
    points INTEGER NOT NULL DEFAULT 0,
    tier TEXT NOT NULL DEFAULT 'Regular',
    pos_access BOOLEAN NOT NULL DEFAULT FALSE
);
ALTER TABLE public.members ADD COLUMN IF NOT EXISTS pos_access BOOLEAN NOT NULL DEFAULT FALSE;

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
    media_type TEXT,
    media_filename TEXT,
    media_data TEXT,
    author_name TEXT NOT NULL,
    author_role TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE public.announcements ADD COLUMN IF NOT EXISTS media_type TEXT;
ALTER TABLE public.announcements ADD COLUMN IF NOT EXISTS media_filename TEXT;
ALTER TABLE public.announcements ADD COLUMN IF NOT EXISTS media_data TEXT;

CREATE TABLE IF NOT EXISTS public.announcement_reactions (
    id BIGSERIAL PRIMARY KEY,
    announcement_id BIGINT NOT NULL REFERENCES public.announcements(id) ON DELETE CASCADE,
    reactor_id TEXT NOT NULL,
    reaction TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (announcement_id, reactor_id)
);
ALTER TABLE public.announcement_reactions DROP CONSTRAINT IF EXISTS announcement_reactions_reaction_check;

CREATE TABLE IF NOT EXISTS public.event_tasks (
    id BIGSERIAL PRIMARY KEY,
    event_id BIGINT REFERENCES public.events(id) ON DELETE SET NULL,
    committee TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    priority TEXT NOT NULL CHECK (priority IN ('Low', 'Medium', 'High')),
    points_reward INTEGER NOT NULL DEFAULT 1 CHECK (points_reward BETWEEN 1 AND 10000),
    progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
    status TEXT NOT NULL DEFAULT 'Not started' CHECK (status IN ('Not started', 'Open', 'Complete')),
    link_url TEXT NOT NULL DEFAULT '',
    deadline DATE,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE public.event_tasks ALTER COLUMN event_id DROP NOT NULL;
ALTER TABLE public.event_tasks DROP CONSTRAINT IF EXISTS event_tasks_event_id_fkey;
ALTER TABLE public.event_tasks ADD CONSTRAINT event_tasks_event_id_fkey
    FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE SET NULL;
ALTER TABLE public.event_tasks ADD COLUMN IF NOT EXISTS deadline DATE;
ALTER TABLE public.event_tasks ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'Not started';
ALTER TABLE public.event_tasks ADD COLUMN IF NOT EXISTS points_reward INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS public.event_task_assignees (
    task_id BIGINT NOT NULL REFERENCES public.event_tasks(id) ON DELETE CASCADE,
    guild_id TEXT NOT NULL,
    PRIMARY KEY (task_id, guild_id)
);

CREATE TABLE IF NOT EXISTS public.event_task_submissions (
    task_id BIGINT NOT NULL REFERENCES public.event_tasks(id) ON DELETE CASCADE,
    guild_id TEXT NOT NULL,
    submitted_at TIMESTAMPTZ,
    points_awarded INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (task_id, guild_id)
);
ALTER TABLE public.event_task_submissions ADD COLUMN IF NOT EXISTS points_awarded INTEGER NOT NULL DEFAULT 1;

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

CREATE TABLE IF NOT EXISTS public.project_workspaces (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE public.event_tasks ADD COLUMN IF NOT EXISTS workspace_id BIGINT REFERENCES public.project_workspaces(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS public.project_boards (
    id BIGSERIAL PRIMARY KEY,
    workspace_id BIGINT NOT NULL REFERENCES public.project_workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.project_groups (
    id BIGSERIAL PRIMARY KEY,
    board_id BIGINT NOT NULL REFERENCES public.project_boards(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.project_items (
    id BIGSERIAL PRIMARY KEY,
    group_id BIGINT NOT NULL REFERENCES public.project_groups(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Not started',
    assignee TEXT NOT NULL DEFAULT '',
    start_date DATE,
    due_date DATE,
    number_value DOUBLE PRECISION,
    text_value TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.merch_items (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'Accessories',
    price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
    cost_price_cents INTEGER NOT NULL DEFAULT 0 CHECK (cost_price_cents >= 0),
    inventory INTEGER NOT NULL DEFAULT 0 CHECK (inventory >= 0),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    low_stock_threshold INTEGER NOT NULL DEFAULT 5 CHECK (low_stock_threshold >= 0),
    image_type TEXT,
    image_filename TEXT,
    image_data TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE public.merch_items ADD COLUMN IF NOT EXISTS image_type TEXT;
ALTER TABLE public.merch_items ADD COLUMN IF NOT EXISTS image_filename TEXT;
ALTER TABLE public.merch_items ADD COLUMN IF NOT EXISTS image_data TEXT;
ALTER TABLE public.merch_items ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'Accessories';
ALTER TABLE public.merch_items ADD COLUMN IF NOT EXISTS cost_price_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.merch_items ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE public.merch_items ADD COLUMN IF NOT EXISTS low_stock_threshold INTEGER NOT NULL DEFAULT 5;

CREATE TABLE IF NOT EXISTS public.merch_item_variants (
    id BIGSERIAL PRIMARY KEY,
    item_id BIGINT NOT NULL REFERENCES public.merch_items(id) ON DELETE CASCADE,
    variant TEXT NOT NULL DEFAULT 'Standard',
    inventory INTEGER NOT NULL DEFAULT 0 CHECK (inventory >= 0),
    UNIQUE (item_id, variant)
);
INSERT INTO public.merch_item_variants (item_id, variant, inventory)
SELECT id, 'Standard', inventory FROM public.merch_items
ON CONFLICT (item_id, variant) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.merch_orders (
    id BIGSERIAL PRIMARY KEY,
    order_code TEXT NOT NULL UNIQUE,
    buyer_type TEXT NOT NULL CHECK (buyer_type IN ('member', 'walk-in')),
    buyer_id TEXT,
    buyer_name TEXT NOT NULL,
    subtotal_cents INTEGER NOT NULL CHECK (subtotal_cents >= 0),
    discount_percent INTEGER NOT NULL DEFAULT 0 CHECK (discount_percent BETWEEN 0 AND 100),
    discount_cents INTEGER NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
    total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
    payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'gcash', 'tab_utang')),
    payment_channel TEXT NOT NULL DEFAULT 'cash',
    payment_status TEXT NOT NULL CHECK (payment_status IN ('paid', 'partial', 'unpaid_tab')),
    amount_paid_cents INTEGER NOT NULL DEFAULT 0 CHECK (amount_paid_cents >= 0),
    fulfillment_status TEXT NOT NULL DEFAULT 'pending_pickup' CHECK (fulfillment_status IN ('pending_pickup', 'completed', 'cancelled')),
    due_date DATE,
    award_points BOOLEAN NOT NULL DEFAULT FALSE,
    points_awarded INTEGER NOT NULL DEFAULT 0,
    cashier_id TEXT NOT NULL,
    cashier_name TEXT NOT NULL,
    voided_at TIMESTAMPTZ,
    voided_by_id TEXT,
    voided_by_name TEXT,
    void_reason TEXT,
    refund_amount_cents INTEGER NOT NULL DEFAULT 0,
    refund_method TEXT,
    refund_reference_number TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE public.merch_orders ADD COLUMN IF NOT EXISTS payment_channel TEXT;
ALTER TABLE public.merch_orders ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ;
ALTER TABLE public.merch_orders ADD COLUMN IF NOT EXISTS voided_by_id TEXT;
ALTER TABLE public.merch_orders ADD COLUMN IF NOT EXISTS voided_by_name TEXT;
ALTER TABLE public.merch_orders ADD COLUMN IF NOT EXISTS void_reason TEXT;
ALTER TABLE public.merch_orders ADD COLUMN IF NOT EXISTS refund_amount_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.merch_orders ADD COLUMN IF NOT EXISTS refund_method TEXT;
ALTER TABLE public.merch_orders ADD COLUMN IF NOT EXISTS refund_reference_number TEXT;
UPDATE public.merch_orders SET payment_channel = payment_method WHERE payment_channel IS NULL;

CREATE TABLE IF NOT EXISTS public.merch_order_items (
    id BIGSERIAL PRIMARY KEY,
    order_id BIGINT NOT NULL REFERENCES public.merch_orders(id) ON DELETE CASCADE,
    item_id BIGINT REFERENCES public.merch_items(id) ON DELETE SET NULL,
    product_name TEXT NOT NULL,
    variant TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
    subtotal_cents INTEGER NOT NULL CHECK (subtotal_cents >= 0),
    category TEXT NOT NULL DEFAULT 'Accessories',
    unit_cost_cents INTEGER NOT NULL DEFAULT 0 CHECK (unit_cost_cents >= 0)
);
ALTER TABLE public.merch_order_items ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE public.merch_order_items ADD COLUMN IF NOT EXISTS unit_cost_cents INTEGER;
UPDATE public.merch_order_items AS item SET
    category = COALESCE(item.category, product.category, 'Accessories'),
    unit_cost_cents = COALESCE(item.unit_cost_cents, product.cost_price_cents, 0)
    FROM public.merch_items AS product
    WHERE item.item_id = product.id AND (item.category IS NULL OR item.unit_cost_cents IS NULL);
UPDATE public.merch_order_items SET
    category = COALESCE(category, 'Accessories'), unit_cost_cents = COALESCE(unit_cost_cents, 0)
    WHERE category IS NULL OR unit_cost_cents IS NULL;

CREATE TABLE IF NOT EXISTS public.merch_order_payments (
    id BIGSERIAL PRIMARY KEY,
    order_id BIGINT NOT NULL REFERENCES public.merch_orders(id) ON DELETE CASCADE,
    payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'gcash')),
    payment_channel TEXT NOT NULL DEFAULT 'cash',
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    reference_number TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE public.merch_order_payments ADD COLUMN IF NOT EXISTS payment_channel TEXT;
ALTER TABLE public.merch_order_payments ADD COLUMN IF NOT EXISTS reference_number TEXT;
UPDATE public.merch_order_payments SET payment_channel = payment_method WHERE payment_channel IS NULL;

CREATE INDEX IF NOT EXISTS idx_event_tasks_event_committee ON public.event_tasks(event_id, committee);
CREATE INDEX IF NOT EXISTS idx_event_tasks_workspace ON public.event_tasks(workspace_id);
CREATE INDEX IF NOT EXISTS idx_event_task_comments_task ON public.event_task_comments(task_id, id);
CREATE INDEX IF NOT EXISTS idx_project_boards_workspace ON public.project_boards(workspace_id, id);
CREATE INDEX IF NOT EXISTS idx_project_groups_board ON public.project_groups(board_id, position, id);
CREATE INDEX IF NOT EXISTS idx_project_items_group ON public.project_items(group_id, position, id);
CREATE INDEX IF NOT EXISTS idx_merch_orders_created ON public.merch_orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_merch_order_items_order ON public.merch_order_items(order_id);

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
ALTER TABLE public.event_task_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_task_subtasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_boards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.merch_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.merch_item_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.merch_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.merch_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.merch_order_payments ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.members, public.events, public.attendance_logs,
    public.point_adjustments, public.staff_credentials, public.announcements, public.event_tasks,
    public.announcement_reactions, public.event_task_comments, public.event_task_attachments,
    public.event_task_assignees, public.event_task_submissions, public.event_task_subtasks FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.project_workspaces, public.project_boards, public.project_groups, public.project_items
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.merch_items, public.merch_item_variants, public.merch_orders,
    public.merch_order_items, public.merch_order_payments FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated;
