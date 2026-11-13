-- People list: the couple can pre-list family and friends, group them, and decide what each person can see.
ALTER TABLE users ADD COLUMN access TEXT NOT NULL DEFAULT 'guest';   -- guest | family | inner | helper
ALTER TABLE users ADD COLUMN listed INTEGER NOT NULL DEFAULT 0;      -- 1 = added by an admin
ALTER TABLE users ADD COLUMN category TEXT;                           -- Family | Friends | Colleagues | Neighbours | Other
ALTER TABLE users ADD COLUMN subcategory TEXT;                        -- free text, e.g. "Maternal side", "College"
ALTER TABLE users ADD COLUMN relation TEXT;                           -- free text, e.g. "Mausi", "Roommate"
ALTER TABLE users ADD COLUMN closeness INTEGER;                       -- 1 very close | 2 close | 3 known
ALTER TABLE users ADD COLUMN added_by TEXT;
CREATE INDEX users_listed ON users (listed, category, subcategory);
