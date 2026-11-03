---
name: safe-workflow
description: How to change a live WordPress site safely - draft copies, previews, backups, approvals and verification. Read before any change to published pages, themes or plugin data.
---
Author: Code & Blocks by Marijan

## Principles

1. **Read first.** Inspect the current state (get_content, manage_meta get, file_read, db_query SELECT) before changing anything. Show the user what you found when the change matters.
2. **Draft first.** Never edit a published page-builder page in place for anything bigger than a typo.
3. **Show before / after.** For settings, meta and SQL writes, state the old and new value and get a "yes" for anything that affects the live site.
4. **One change at a time** for headers, menus, global styles and theme settings. Verify after each.
5. **Verify.** flush_cache, then fetch_page or audit_page on the real URL.

## Page changes (any builder)

1. `duplicate_content id=<page>` → returns a draft copy id and `preview_url` (works without login).
2. Edit the copy (update_content for block content, manage_meta for builder data).
3. `audit_page path=<preview_url>` and give the user the preview_url.
4. After approval: `apply_copy copy_id=<copy> target_id=<page>` (creates a backup draft "[Backup …]" of the original).
5. `flush_cache`, `fetch_page` the live URL.
6. Undo: `apply_copy copy_id=<backup id> target_id=<page> keep_copy=true`.

## Theme changes

- Small CSS/PHP tweaks: prefer a child theme (`create_child_theme`) or a snippet (`manage_snippet`) over editing a parent theme (updates overwrite it).
- Bigger redesigns: `copy_theme` → edit files under themes/<slug> → `create_preview theme=<slug>` → `activate_theme` only when the user says "go live".
- Every file write keeps a backup: `file_restore action=list|restore`.
- PHP is syntax-checked before saving; still re-check the front end afterwards.

## Plugin settings and data

Order of preference for writes:
1. The plugin's ability (`list_abilities` / `run_ability`).
2. The plugin's REST namespace (`rest_request`, check `site_info.general.namespaces`).
3. Options (`manage_option`) or meta (`manage_meta`) – the plugin's own storage, backed up automatically.
4. SQL writes (`db_query allow_write=true`) only if the owner enabled CBMCP_ALLOW_DB_WRITE, with a SELECT preview of the affected rows first and a WHERE clause.

Before options/meta that hold serialized arrays: read the full current value, change only the needed keys, write the complete value back.

## Bulk work

- Work in batches of about 10 and show the batch before saving (e.g. SEO descriptions).
- Report what was done with ids and edit links.

## Ask first (always)

Publishing, deleting, theme switch, apply_copy, plugin install/activation on production, sending emails, SQL writes, changing URLs/permalinks/slugs of existing pages, maintenance/coming-soon mode on or off.

Suggest a full site backup (host backup or a backup plugin) before big or risky changes.
