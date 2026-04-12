-- Add mailbox column to domains table for tenant isolation.
-- Existing rows get NULL (admin/legacy domains), new rows require mailbox.
ALTER TABLE domains ADD COLUMN mailbox TEXT;
