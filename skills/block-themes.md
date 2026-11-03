---
name: block-themes
description: Gutenberg block markup, block themes (templates, template parts, global styles, navigation, patterns) and classic theme customizer settings via the REST API. Load before editing block content or a block theme.
---
Author: Code & Blocks by Marijan

## Block markup

```html
<!-- wp:heading {"level":2} -->
<h2 class="wp-block-heading">Title</h2>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>Text</p>
<!-- /wp:paragraph -->

<!-- wp:buttons --><div class="wp-block-buttons"><!-- wp:button -->
<div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="/kontakt/">Kontakt</a></div>
<!-- /wp:button --></div><!-- /wp:buttons -->

<!-- wp:image {"id":123,"sizeSlug":"large"} -->
<figure class="wp-block-image size-large"><img src="…" alt="…" class="wp-image-123"/></figure>
<!-- /wp:image -->
```
- The HTML must match what the block's save function produces, otherwise the editor shows "invalid block". Keep classes and structure of existing blocks; copy patterns from blocks already on the site.
- Dynamic blocks are self-closing: `<!-- wp:latest-posts {"postsToShow":3} /-->`.
- Unsure? Use `<!-- wp:html -->…<!-- /wp:html -->` (always valid).

## Block theme parts (REST)

| What | Endpoint |
|---|---|
| Templates | `GET /wp/v2/templates`, `POST /wp/v2/templates/<theme>//<slug>` with `content` |
| Template parts (header, footer) | `/wp/v2/template-parts` (id `<theme>//header`) |
| Global styles (colors, fonts, spacing) | find id: `GET /wp/v2/global-styles/themes/<stylesheet>` (theme defaults) and the user styles id in `list_themes`/`GET /wp/v2/themes?status=active` → `_links["wp:user-global-styles"]` (use rest_request raw_output); update `POST /wp/v2/global-styles/<id>` with `styles` / `settings` |
| Navigation menus | `/wp/v2/navigation` (post type `wp_navigation`, block markup of navigation-link blocks) |
| Synced patterns | `/wp/v2/blocks` |
| Pattern library | `GET /wp/v2/block-patterns/patterns` |

Saving a template via REST creates a user customization (`wp_template` post) that overrides the theme file. To reset, delete that customization (`DELETE /wp/v2/templates/<id>`). Theme files themselves (themes/<theme>/templates/*.html, parts/*.html, theme.json) are edited with the file tools – but customizations in the database win over files.

## theme.json

- Palette: `settings.color.palette[]` `{slug, color, name}`; fonts: `settings.typography.fontFamilies[]`; element styles: `styles.elements.button`, `styles.elements.h1` …
- Prefer user global styles (REST) for a site owner's changes; edit theme.json only in a child/draft theme.

## Classic themes

- Customizer settings: option `theme_mods_<stylesheet>` (manage_option). Astra keeps most settings in option `astra-settings` (global palette `global-color-palette`, typography `headings-font-family`, `body-font-family`, header builder keys). Read the whole value, change keys, write back.
- Classic menus: `/wp/v2/menus`, `/wp/v2/menu-items`, `/wp/v2/menu-locations`.
- Widgets: `/wp/v2/sidebars`, `/wp/v2/widgets`.
