---
name: seo-plugins
description: Meta keys and options of Yoast SEO, Rank Math, SureRank and SiteSEO for titles, meta descriptions, noindex, social previews, cornerstone content and scores; bulk SEO workflows. Load before any SEO plugin task.
---
Author: Code & Blocks by Marijan

Verify keys on the site first: `manage_meta action=get object_id=<post> prefix=<plugin prefix>` on a post where the value was set in the plugin UI.

## Yoast SEO (post meta)

| Field | Meta key |
|---|---|
| SEO title | `_yoast_wpseo_title` (may contain variables like `%%title%% %%sep%% %%sitename%%`) |
| Meta description | `_yoast_wpseo_metadesc` |
| Focus keyphrase | `_yoast_wpseo_focuskw` |
| Noindex | `_yoast_wpseo_meta-robots-noindex`: `1` = noindex, `2` = index, empty = default |
| Canonical | `_yoast_wpseo_canonical` |
| Cornerstone | `_yoast_wpseo_is_cornerstone` = `1` |
| Social (Facebook/OG) | `_yoast_wpseo_opengraph-title`, `_yoast_wpseo_opengraph-description`, `_yoast_wpseo_opengraph-image`, `_yoast_wpseo_opengraph-image-id` |
| Social (X) | `_yoast_wpseo_twitter-title`, `_yoast_wpseo_twitter-description`, `_yoast_wpseo_twitter-image` |
| SEO / readability score | `_yoast_wpseo_linkdex`, `_yoast_wpseo_content_score` (0–100) |

- Site representation (organization or person, name, logo): option `wpseo_titles` keys `company_or_person`, `company_name`, `company_logo`, `company_logo_id`, `company_or_person_user_id`. Social profiles: option `wpseo_social`.
- Term (category/tag) SEO: option `wpseo_taxonomy_meta` → `[taxonomy][term_id]['wpseo_desc' | 'wpseo_title' | 'wpseo_noindex']`.
- Yoast keeps an index table `{prefix}yoast_indexable` (scores, focus keyphrase, robots) that is updated on save; after meta changes it can lag until the post is saved again.

## Rank Math (post meta)

| Field | Meta key |
|---|---|
| Title / description | `rank_math_title`, `rank_math_description` |
| Focus keywords | `rank_math_focus_keyword` (comma separated, first = primary) |
| Robots | `rank_math_robots` (array, e.g. `["noindex","nofollow"]`) |
| Canonical | `rank_math_canonical_url` |
| Pillar content | `rank_math_pillar_content` = `on` |
| Social | `rank_math_facebook_title`, `rank_math_facebook_description`, `rank_math_facebook_image`, `rank_math_twitter_*` |
| Score | `rank_math_seo_score` |

Options: `rank-math-options-general`, `rank-math-options-titles`, `rank-math-options-sitemap`. Term meta uses the same `rank_math_*` keys (object_type=term). Rank Math has REST routes under `rankmath/v1` (check namespaces).

## SureRank and SiteSEO

Key names differ by version. Find them: set a value in the plugin UI on one post, then `manage_meta get prefix=surerank` / `prefix=_siteseo`. Look for abilities first (`list_abilities search=seo`) – newer SEO plugins expose them.

## Workflows

**Write missing meta descriptions (bulk)**
1. `db_query`: posts without a description, e.g. Yoast:
   `SELECT p.ID, p.post_title FROM {prefix}posts p LEFT JOIN {prefix}postmeta m ON m.post_id=p.ID AND m.meta_key='_yoast_wpseo_metadesc' WHERE p.post_type IN ('post','page') AND p.post_status='publish' AND (m.meta_value IS NULL OR m.meta_value='') LIMIT 50`
2. Read each post (get_content), write 120–155 characters, in the site language, with the main keyword.
3. Show 10 at a time, save after approval (`manage_meta set`).

**Noindex utility pages** (thank-you, cart, checkout, my account, login): set the robots meta, then `audit_page` → `seo.robots` must contain noindex. Check the sitemap (`/sitemap_index.xml` Yoast/Rank Math) with fetch_page.

**Page missing from sitemap**: check post status, noindex meta, the post type/taxonomy excluded in the plugin's sitemap options, canonical pointing elsewhere, password protection.

**Social previews**: compare og:title/og:description/og:image in `audit_page` with the meta; image should be ≥1200×630.

**Competing keyphrases (Yoast)**: `SELECT meta_value, GROUP_CONCAT(post_id) ids, COUNT(*) n FROM {prefix}postmeta WHERE meta_key='_yoast_wpseo_focuskw' AND meta_value<>'' GROUP BY meta_value HAVING n>1`.

**Weakest posts**: order by `_yoast_wpseo_linkdex` / `_yoast_wpseo_content_score` ascending, or `rank_math_seo_score`.
