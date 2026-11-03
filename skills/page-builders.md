---
name: page-builders
description: Where Divi, Bricks, Beaver Builder, SiteOrigin, SeedProd, Breakdance, Pagelayer and Oxygen store page content, and how to edit them safely. Load before editing non-Elementor builder pages.
---
Author: Code & Blocks by Marijan

Always confirm the storage on the actual site first: `manage_meta action=get object_id=<page> keys_only=true` shows which builder keys exist. Builder data formats change between major versions – trust what you read over this table.

| Builder | Content lives in | Notes |
|---|---|---|
| Divi 4 | `post_content` as shortcodes `[et_pb_section][et_pb_row][et_pb_column][et_pb_text]…` | `_et_pb_use_builder` = `on`. Theme Builder templates: post types `et_template`, `et_header_layout`, `et_body_layout`, `et_footer_layout`. Clear cache with flush_cache (Divi static CSS). |
| Divi 5 | `post_content` as blocks `<!-- wp:divi/section {…} -->` | Edit attributes in the JSON of the block comment. |
| Bricks | meta `_bricks_page_content_2` (array of elements), header `_bricks_page_header_2`, footer `_bricks_page_footer_2` | `_bricks_editor_mode` = `bricks`. Elements are a flat list: `{id, name, parent, children:[ids], settings}`. Keep parent/children consistent. Templates: post type `bricks_template`. |
| Beaver Builder | meta `_fl_builder_data` (published), `_fl_builder_draft` (editor draft) | `_fl_builder_enabled` = `1`. Nodes keyed by id with `type` (row/column-group/column/module), `parent`, `position`, `settings`. Update both data and draft, then flush_cache. |
| SiteOrigin Page Builder | meta `panels_data` (array: `widgets`, `grids`, `grid_cells`) | Widget text in `widgets[n]` (e.g. `text`, `title`, `panels_info.class` = widget class). SiteOrigin Widgets Bundle widgets (accordion, price table, contact form) keep their fields inside the widget array. |
| SeedProd | `post_content_filtered` (JSON layout) + rendered `post_content` | Landing pages have meta `_seedprod_page`. Coming-soon/maintenance settings are options (`seedprod_settings` JSON). Change text in the JSON and in the HTML, or edit in SeedProd after the change. |
| Breakdance | meta `_breakdance_data` (JSON, contains `tree_json_string`) | The tree is a JSON string inside JSON. Decode twice, edit, encode twice. |
| Pagelayer | `post_content` with Pagelayer block/shortcode markup | Read post_content first; attributes are inside the markup. |
| Oxygen 4 | meta `ct_builder_json` / `ct_builder_shortcodes` | Oxygen 6 is built on Breakdance – check keys. |

## General approach

1. Identify the builder (`audit_page` → `builders`, active plugins in `site_info`).
2. `duplicate_content` the page, work on the copy.
3. Read the stored data (`manage_meta` get; `outline=true` for JSON trees; `get_content` for post_content-based builders).
4. Change only the needed text/settings. Keep ids unique, keep structure valid.
5. `flush_cache`, preview, `audit_page`, then `apply_copy` after approval.

## Finding text across all pages (phone number, price, date)

- post_content builders: `db_query` `SELECT ID, post_title FROM {prefix}posts WHERE post_status IN ('publish','draft') AND post_content LIKE '%old text%'`.
- meta builders: `SELECT post_id, meta_key FROM {prefix}postmeta WHERE meta_key IN ('_elementor_data','panels_data','_bricks_page_content_2','_fl_builder_data') AND meta_value LIKE '%old text%'`.
- Then change each hit with manage_meta / update_content (not with SQL REPLACE – serialized arrays store string lengths).

## Placeholder / launch check

`audit_page` on every page (list_content type=pages) and report placeholders, dead buttons, missing alt text, H1 problems in one table.
