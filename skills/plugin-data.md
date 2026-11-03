---
name: plugin-data
description: Finding and reading data of form plugins, activity logs, EDD, AffiliateWP, cart abandonment, backups, cron and other plugins with custom tables; reports and sorting entries. Load before reading or changing plugin data.
---
Author: Code & Blocks by Marijan

## How to find a plugin's data

1. `list_abilities search=<plugin>` – use abilities if they exist.
2. `site_info` → `general.namespaces` – a REST namespace (e.g. `fluentform/v1`, `edd/v3`, `affwp/v1`) is the next best way.
3. `db_schema like=<plugin>` → tables; `db_schema table={prefix}<table>` → columns.
4. Options: `db_query SELECT option_name, LENGTH(option_value) len FROM {prefix}options WHERE option_name LIKE '%<plugin>%'`.
5. Custom post types: `list_content_types`.

Table names below are typical starting points. Always confirm with db_schema – they change between versions.

| Plugin | Typical storage |
|---|---|
| Fluent Forms | `{prefix}fluentform_forms`, `{prefix}fluentform_submissions` (`form_id`, `response` JSON, `status` unread/read/spam/trashed, `is_favourite`, `created_at`) |
| Formidable Forms | `{prefix}frm_forms`, `{prefix}frm_fields`, `{prefix}frm_items` (entries), `{prefix}frm_item_metas` (field values) |
| Ninja Forms | forms `{prefix}nf3_forms` / `{prefix}nf3_fields`; submissions = post type `nf_sub`, meta `_form_id`, `_field_<id>` |
| SureForms | forms = post type `sureforms_form`; entries table `{prefix}srfm_entries` |
| WPForms | Lite stores no entries (only emails); Pro: `{prefix}wpforms_entries`, `{prefix}wpforms_entry_fields` |
| Contact Form 7 | no storage; with Flamingo: post types `flamingo_inbound`, `flamingo_contact` |
| Otter Blocks forms | settings in block attributes/options; records as post type if enabled – check list_content_types |
| Simple History | `{prefix}simple_history` (date, logger, level, message), `{prefix}simple_history_contexts` (key/value per event) |
| Easy Digital Downloads 3 | `{prefix}edd_orders`, `{prefix}edd_order_items`, `{prefix}edd_customers`; Recurring: `{prefix}edd_subscriptions`; Software Licensing: `{prefix}edd_licenses`, `{prefix}edd_license_activations` |
| AffiliateWP | `{prefix}affiliate_wp_affiliates`, `{prefix}affiliate_wp_referrals` (status unpaid/paid/pending/rejected), `{prefix}affiliate_wp_visits`, `{prefix}affiliate_wp_payouts` |
| Cart Abandonment Recovery (CartFlows) | `{prefix}cartflows_ca_cart_abandonment` (cart contents, email, order_status, time) |
| BackWPup | jobs in option `backwpup_jobs`; logs as files in the uploads folder (not readable by file tools) |
| WP Crontrol | uses normal WP-Cron – use `manage_cron` |
| WooCommerce | use REST `wc/v3` (see woocommerce skill); HPOS orders in `{prefix}wc_orders` |

## Typical tasks

**Monthly report**: `SELECT form_id, COUNT(*) n, SUM(status='spam') spam FROM {prefix}fluentform_submissions WHERE created_at >= DATE_SUB(NOW(), INTERVAL 1 MONTH) GROUP BY form_id`; join form titles; list forms with zero entries.

**Sort entries into leads and spam**: read the last N entries, classify (real enquiry, spam, test), present a table, draft replies for leads as text. Change status only after approval, preferably via the plugin's REST/abilities; with SQL writes only if enabled.

**Form emails not arriving**: check the form's notification settings (stored in the plugin's form meta/options), the From address (`send_test_email` shows the effective From and SMTP plugins), and whether an SMTP plugin is active and configured.

**What changed before the site broke (Simple History)**: `SELECT date, logger, level, message FROM {prefix}simple_history WHERE date >= '<from>' ORDER BY date DESC LIMIT 200`, then read contexts for interesting ids. Correlate with plugin/theme updates.

**Cron health**: `manage_cron action=list` → late events, events without callback (orphaned after a plugin was removed), duplicates.

## Rules

- Personal data (names, emails, phone numbers) stays in the chat summary only as far as needed. Do not export it elsewhere unless the user asks.
- Use LIMIT, aggregate in SQL, avoid `SELECT *` on big tables.
- Never use SQL `REPLACE()` on serialized values (lengths break). Read, change in code, write back via manage_meta/manage_option.
