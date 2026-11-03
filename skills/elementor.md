---
name: elementor
description: Elementor page data, global colors/fonts (kit), headers/footers, popups and safe editing via manage_meta. Load before changing any Elementor page, template or site setting.
---
Author: Code & Blocks by Marijan

## Where Elementor stores things

| What | Where |
|---|---|
| Page layout | post meta `_elementor_data` (JSON string, array of elements) |
| Marks a page as Elementor | `_elementor_edit_mode` = `builder` |
| Page settings (hide title, padding, background) | `_elementor_page_settings` (array), e.g. `hide_title` = `yes` |
| Template type | `_elementor_template_type` (wp-page, kit, header, footer, single, section, popup …) |
| Generated CSS | `_elementor_css` (delete → regenerated; manage_meta does this automatically) |
| Templates, kit, theme-builder parts | post type `elementor_library` |
| Active kit (global styles) | option `elementor_active_kit` = post id of the kit |
| Global colors/fonts/buttons | kit post meta `_elementor_page_settings`: `system_colors`, `custom_colors`, `system_typography`, `custom_typography`, `button_*`, `body_*`, `h1_*`… |
| Pro theme-builder conditions | template meta `_elementor_conditions` and option `elementor_pro_theme_builder_conditions` |
| Header Footer Elementor (free plugin) | post type `elementor-hf`, meta `ehf_template_type` (`type_header`, `type_footer`, `type_before_footer`), display rules in `ehf_target_include_locations` |

Front-end HTML of Elementor pages is rendered from `_elementor_data`; `post_content` only holds a plain fallback. Editing post_content does not change the page.

## Element structure

```json
{"id":"3f2a9c1","elType":"container","settings":{…},"elements":[
  {"id":"8b1d0e4","elType":"widget","widgetType":"heading","settings":{"title":"Hello","header_size":"h1"},"elements":[]}
]}
```
- Older layouts: `section` → `column` → `widget`; newer: `container` (nested containers, `isInner`).
- `id` is a 7-character lowercase hex string, unique on the page. Generate new ids for every new element.
- Common widgets and their text fields: heading `title`, text-editor `editor` (HTML), button `text` + `link.url`, image `image.url` + `image.id`, icon-list `icon_list[].text`, accordion/toggle `tabs[].tab_title` / `tab_content`.
- Settings that are not set use the widget/kit defaults – only add keys you need.
- Global color reference: `"__globals__":{"title_color":"globals/colors?id=primary"}`.

## Workflow

1. `manage_meta action=get object_id=<page> key=_elementor_data outline=true` → paths, ids, types, text.
2. Read one element: `find_id=<id>` (or `json_path`).
3. Prefer working on a copy: `duplicate_content` → edit copy → preview → `apply_copy`.
4. Change one element: `manage_meta action=set key=_elementor_data find_id=<id> value=<full element object>`.
   Add a section: get the parent array via json_path, append the new element, set that array back with the same json_path.
5. `flush_cache` (clears Elementor CSS) → `fetch_page` / `audit_page`.

Never set `_elementor_data` to an object; it must stay a JSON string (manage_meta keeps the format when you use find_id/json_path; with a whole value use `encode_json=true`).

## Global colors and fonts (rebrand)

1. `manage_option action=get name=elementor_active_kit` → kit id.
2. `manage_meta action=get object_id=<kit> key=_elementor_page_settings`.
3. Change `system_colors[]` items (`_id` primary/secondary/text/accent, `color` hex) and `system_typography[]` (`typography_font_family`, `typography_font_weight`). Keep `_id` values.
4. Write the whole array back (`manage_meta set`, it is a PHP array, no encode_json). Old value is backed up.
5. `flush_cache`.

## Headers and footers

- Elementor Pro: header/footer are `elementor_library` posts with `_elementor_template_type` header/footer and display conditions.
- Free: usually "Header Footer Elementor" (`elementor-hf`) or the theme's own header (Astra, Hello, …). Check `site_info` plugins first.
- Sticky header plugins add settings on the header container/section (e.g. `sticky`, motion effects) – read them with find_id before changing.

## Popups

Pro popups are `elementor_library` with `_elementor_template_type` popup and `_elementor_popup_display_settings`. Without Pro, popups come from add-ons (Premium Addons, ElementsKit …) as widgets inside the page data.

## Duplicate page title

Theme title above an Elementor design: set `_elementor_page_settings.hide_title` = `yes` per page (read the array, add the key, write it back). Some themes also have a global "disable title" option – check the theme's settings option. Verify with audit_page (H1 count).
